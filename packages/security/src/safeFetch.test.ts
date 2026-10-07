import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertProtocolAllowed, isRedirectStatus, requestViaIp } from "./safeFetch.js";
import { SsrfBlockedError } from "./resolveHost.js";

describe("assertProtocolAllowed", () => {
  it("allows http and https", () => {
    expect(() => assertProtocolAllowed(new URL("http://example.com"))).not.toThrow();
    expect(() => assertProtocolAllowed(new URL("https://example.com"))).not.toThrow();
  });

  it("rejects other protocols", () => {
    expect(() => assertProtocolAllowed(new URL("file:///etc/passwd"))).toThrow(SsrfBlockedError);
    expect(() => assertProtocolAllowed(new URL("ftp://example.com"))).toThrow(SsrfBlockedError);
    expect(() => assertProtocolAllowed(new URL("gopher://example.com"))).toThrow(SsrfBlockedError);
  });

  it("rejects URLs with embedded credentials", () => {
    expect(() => assertProtocolAllowed(new URL("http://user:pass@example.com"))).toThrow(SsrfBlockedError);
  });
});

describe("isRedirectStatus", () => {
  it("classifies 3xx as redirect, everything else as not", () => {
    expect(isRedirectStatus(301)).toBe(true);
    expect(isRedirectStatus(302)).toBe(true);
    expect(isRedirectStatus(200)).toBe(false);
    expect(isRedirectStatus(404)).toBe(false);
    expect(isRedirectStatus(500)).toBe(false);
  });
});

describe("requestViaIp (HTTP mechanics against a local test server)", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/big") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("x".repeat(1000));
        return;
      }
      if (req.url === "/pdf") {
        res.writeHead(200, { "Content-Type": "application/pdf" });
        res.end("%PDF-1.4 fake");
        return;
      }
      if (req.url === "/no-type") {
        res.writeHead(200);
        res.end("<html>untyped</html>");
        return;
      }
      if (req.url === "/forbidden-json") {
        res.writeHead(403, { "Content-Type": "application/json" });
        res.end('{"error":"blocked"}');
        return;
      }
      if (req.url === "/chunked") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.write("x".repeat(600));
        res.end("x".repeat(600));
        return;
      }
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/target" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>hello</body></html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("returns status, headers and body for a normal response", async () => {
    const url = new URL(`http://127.0.0.1:${port}/`);
    const result = await requestViaIp(url, "127.0.0.1", { timeoutMs: 2000, maxBodyBytes: 1_000_000, userAgent: "test" });
    expect(result.status).toBe(200);
    expect(result.body).toContain("hello");
  });

  it("reports a redirect status and Location header without following it itself", async () => {
    const url = new URL(`http://127.0.0.1:${port}/redirect`);
    const result = await requestViaIp(url, "127.0.0.1", { timeoutMs: 2000, maxBodyBytes: 1_000_000, userAgent: "test" });
    expect(result.status).toBe(302);
    expect(result.headers.location).toBe("/target");
  });

  const HTML_ONLY = /^(text\/html|application\/xhtml\+xml)/i;
  const opts = { timeoutMs: 2000, maxBodyBytes: 1_000_000, userAgent: "test" };

  it("rejects a non-HTML 2xx response before downloading it when allowedContentTypes is set", async () => {
    const url = new URL(`http://127.0.0.1:${port}/pdf`);
    await expect(requestViaIp(url, "127.0.0.1", { ...opts, allowedContentTypes: HTML_ONLY })).rejects.toThrow(/Unsupported content type "application\/pdf"/);
  });

  it("accepts HTML, a missing Content-Type, and non-2xx responses of any type", async () => {
    const ok = await requestViaIp(new URL(`http://127.0.0.1:${port}/`), "127.0.0.1", { ...opts, allowedContentTypes: HTML_ONLY });
    expect(ok.status).toBe(200);
    const untyped = await requestViaIp(new URL(`http://127.0.0.1:${port}/no-type`), "127.0.0.1", { ...opts, allowedContentTypes: HTML_ONLY });
    expect(untyped.body).toContain("untyped");
    const blocked = await requestViaIp(new URL(`http://127.0.0.1:${port}/forbidden-json`), "127.0.0.1", { ...opts, allowedContentTypes: HTML_ONLY });
    expect(blocked.status).toBe(403);
  });

  it("does not filter content types when allowedContentTypes is not set (other callers unaffected)", async () => {
    const result = await requestViaIp(new URL(`http://127.0.0.1:${port}/pdf`), "127.0.0.1", opts);
    expect(result.status).toBe(200);
  });

  it("enforces the size cap on a streamed body that declares no Content-Length", async () => {
    await expect(requestViaIp(new URL(`http://127.0.0.1:${port}/chunked`), "127.0.0.1", { ...opts, maxBodyBytes: 1000 })).rejects.toThrow(/exceeded/);
  });

  it("rejects a response body larger than maxBodyBytes", async () => {
    const url = new URL(`http://127.0.0.1:${port}/big`);
    await expect(
      requestViaIp(url, "127.0.0.1", { timeoutMs: 2000, maxBodyBytes: 100, userAgent: "test" }),
    ).rejects.toThrow(/exceeded/);
  });
});
