import http from "node:http";
import https from "node:https";
import { resolveAndValidateHost, SsrfBlockedError, type ResolveFn } from "./resolveHost.js";

export { SsrfBlockedError };

export class SafeFetchError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxRedirects?: number;
  maxBodyBytes?: number;
  userAgent?: string;
  /** Test seam - defaults to a real DNS lookup. */
  resolveFn?: ResolveFn;
}

export interface SafeFetchResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  finalUrl: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB - a competitor page is not a video file
const DEFAULT_USER_AGENT = "CompetitorMonitorAI/0.1 (+monitoring bot)";

export function assertProtocolAllowed(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SsrfBlockedError(`Protocol "${url.protocol}" is not allowed - only http/https.`);
  }
  if (url.username || url.password) {
    throw new SsrfBlockedError("URLs with embedded credentials are not allowed.");
  }
}

export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

/**
 * Performs a single GET request against `url`, following redirects
 * manually (validating every hop through the same SSRF checks) and
 * connecting to a DNS-resolved-and-validated IP address rather than
 * letting the HTTP client re-resolve the hostname itself.
 *
 * This is the only place in the codebase that should ever issue an
 * outbound request to a customer-supplied URL. Extractors must go
 * through this function, never call `fetch`/`http.request` directly.
 */
export async function safeGet(inputUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
    userAgent = DEFAULT_USER_AGENT,
    resolveFn,
  } = options;

  let currentUrl = new URL(inputUrl);
  let redirectsLeft = maxRedirects;

  for (;;) {
    assertProtocolAllowed(currentUrl);
    const validatedIp = await resolveAndValidateHost(currentUrl.hostname, resolveFn);

    const response = await requestViaIp(currentUrl, validatedIp, { timeoutMs, maxBodyBytes, userAgent });

    if (isRedirectStatus(response.status) && response.headers.location) {
      if (redirectsLeft <= 0) {
        throw new SafeFetchError(`Too many redirects fetching "${inputUrl}".`);
      }
      redirectsLeft -= 1;
      const location = Array.isArray(response.headers.location)
        ? response.headers.location[0]
        : response.headers.location;
      currentUrl = new URL(location as string, currentUrl);
      continue;
    }

    return { ...response, finalUrl: currentUrl.toString() };
  }
}

/**
 * Low-level requester that connects directly to `connectIp` rather than
 * resolving `url.hostname` itself. Exported so tests can exercise the
 * HTTP mechanics (headers, redirects, body-size capping) against a
 * local test server without needing to defeat the SSRF allowlist in
 * `resolveAndValidateHost` - callers in production code must always go
 * through `safeGet`, which is what actually validates `connectIp`.
 */
export function requestViaIp(
  url: URL,
  connectIp: string,
  opts: { timeoutMs: number; maxBodyBytes: number; userAgent: string },
): Promise<Omit<SafeFetchResult, "finalUrl">> {
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        // Connect directly to the address we already validated, instead of
        // letting the transport re-resolve `url.hostname` itself - that
        // second resolution is exactly the gap a DNS-rebinding attack needs.
        host: connectIp,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: {
          Host: url.hostname,
          "User-Agent": opts.userAgent,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        // Preserve TLS validation against the real hostname even though we
        // connected via IP.
        ...(isHttps ? { servername: url.hostname } : {}),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBodyBytes) {
            aborted = true;
            res.destroy();
            reject(new SafeFetchError(`Response for "${url.toString()}" exceeded ${opts.maxBodyBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });

        res.on("error", (err) => {
          if (aborted) return;
          reject(new SafeFetchError(`Response stream error for "${url.toString()}": ${err.message}`, err));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new SafeFetchError(`Request to "${url.toString()}" timed out after ${opts.timeoutMs}ms.`));
    });

    req.on("error", (err) => {
      reject(new SafeFetchError(`Request to "${url.toString()}" failed: ${err.message}`, err));
    });

    req.end();
  });
}

export interface SafePostJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  maxBodyBytes?: number;
  resolveFn?: ResolveFn;
}

/**
 * Phase 3.1 (Section 20): a customer-supplied `baseUrl` (the
 * OpenAI-compatible AI provider) is exactly as untrusted a destination
 * as a monitored competitor URL - this is the same SSRF boundary as
 * `safeGet`, just for a single JSON POST with custom headers instead of
 * a GET. Deliberately does NOT follow redirects (unlike `safeGet`): a
 * legitimate AI API endpoint has no reason to redirect a POST, and
 * transparently following one would reopen exactly the DNS-rebinding/
 * private-target gap `resolveAndValidateHost` exists to close. A 3xx
 * response is surfaced to the caller as an error instead.
 */
export async function safePostJson(inputUrl: string, body: unknown, options: SafePostJsonOptions = {}): Promise<SafeFetchResult> {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, maxBodyBytes = DEFAULT_MAX_BODY_BYTES, headers = {}, resolveFn } = options;

  const url = new URL(inputUrl);
  assertProtocolAllowed(url);
  const validatedIp = await resolveAndValidateHost(url.hostname, resolveFn);

  const payload = JSON.stringify(body);
  const response = await requestJsonViaIp(url, validatedIp, payload, { timeoutMs, maxBodyBytes, headers });

  if (isRedirectStatus(response.status)) {
    throw new SafeFetchError(`Refusing to follow a redirect from "${inputUrl}" (POST requests are not redirected).`);
  }

  return { ...response, finalUrl: url.toString() };
}

/**
 * POST counterpart to `requestViaIp` - connects directly to
 * `connectIp` (never re-resolving the hostname) with a JSON body and
 * caller-supplied headers (e.g. `Authorization`). Exported for the same
 * reason `requestViaIp` is: so tests can exercise HTTP mechanics
 * against a local server without needing to defeat the SSRF allowlist.
 * Production code must always go through `safePostJson`.
 */
export function requestJsonViaIp(
  url: URL,
  connectIp: string,
  jsonBody: string,
  opts: { timeoutMs: number; maxBodyBytes: number; headers: Record<string, string> },
): Promise<Omit<SafeFetchResult, "finalUrl">> {
  const isHttps = url.protocol === "https:";
  const transport = isHttps ? https : http;
  const bodyBuffer = Buffer.from(jsonBody, "utf-8");

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        host: connectIp,
        port: url.port ? Number(url.port) : isHttps ? 443 : 80,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          Host: url.hostname,
          "Content-Type": "application/json",
          "Content-Length": bodyBuffer.byteLength,
          ...opts.headers,
        },
        ...(isHttps ? { servername: url.hostname } : {}),
        timeout: opts.timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let received = 0;
        let aborted = false;

        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > opts.maxBodyBytes) {
            aborted = true;
            res.destroy();
            reject(new SafeFetchError(`Response for "${url.toString()}" exceeded ${opts.maxBodyBytes} bytes.`));
            return;
          }
          chunks.push(chunk);
        });

        res.on("end", () => {
          if (aborted) return;
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          });
        });

        res.on("error", (err) => {
          if (aborted) return;
          reject(new SafeFetchError(`Response stream error for "${url.toString()}": ${err.message}`, err));
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new SafeFetchError(`Request to "${url.toString()}" timed out after ${opts.timeoutMs}ms.`));
    });

    req.on("error", (err) => {
      reject(new SafeFetchError(`Request to "${url.toString()}" failed: ${err.message}`, err));
    });

    req.write(bodyBuffer);
    req.end();
  });
}
