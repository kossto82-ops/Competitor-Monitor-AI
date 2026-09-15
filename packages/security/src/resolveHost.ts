import { promises as dns } from "node:dns";
import ipaddr from "ipaddr.js";
import { isBlockedIp, explainBlockedIp } from "./ipBlocklist.js";

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

export type ResolveFn = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolve: ResolveFn = (hostname) => dns.lookup(hostname, { all: true, verbatim: true });

const DISALLOWED_HOSTNAME_SUFFIXES = [".local", ".internal", ".localdomain"];

/**
 * A narrow, double-gated escape hatch so a developer can point the
 * monitoring pipeline at their own local fixture server (every local
 * test server is, by definition, loopback/private - without this,
 * nobody could ever dev-test the pipeline end-to-end). It requires
 * BOTH `NODE_ENV` to not be "production" AND an explicit opt-in env
 * var - never one alone. This function, not a scattered inline check,
 * is what every call site tests against, so there is exactly one place
 * to audit for "can production ever hit this".
 */
export function privateTargetsAllowedForTesting(): boolean {
  return process.env["NODE_ENV"] !== "production" && process.env["CMA_ALLOW_PRIVATE_TARGETS"] === "true";
}

function assertHostnameFormatAllowed(hostname: string): void {
  if (privateTargetsAllowedForTesting()) return;

  const lower = hostname.toLowerCase();
  if (lower === "localhost") {
    throw new SsrfBlockedError(`Hostname "${hostname}" is localhost, which is never allowed.`);
  }
  for (const suffix of DISALLOWED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      throw new SsrfBlockedError(`Hostname "${hostname}" uses the disallowed suffix "${suffix}".`);
    }
  }
}

/**
 * Resolves `hostname` and validates every returned address against the
 * IP allowlist, then returns exactly one validated address to connect
 * to. Callers MUST use the returned address for the actual TCP
 * connection (not re-resolve the hostname themselves) - re-resolving
 * after this check passes is what reopens the DNS-rebinding window this
 * function exists to close.
 *
 * If the hostname is itself a literal IP address, DNS is skipped and
 * the literal is validated directly.
 */
export async function resolveAndValidateHost(
  hostname: string,
  resolveFn: ResolveFn = defaultResolve,
): Promise<string> {
  assertHostnameFormatAllowed(hostname);
  const allowPrivate = privateTargetsAllowedForTesting();

  if (ipaddr.isValid(hostname)) {
    if (!allowPrivate && isBlockedIp(hostname)) {
      throw new SsrfBlockedError(explainBlockedIp(hostname));
    }
    return hostname;
  }

  const records = await resolveFn(hostname);
  if (records.length === 0) {
    throw new SsrfBlockedError(`Hostname "${hostname}" did not resolve to any address.`);
  }

  if (!allowPrivate) {
    for (const record of records) {
      if (isBlockedIp(record.address)) {
        throw new SsrfBlockedError(
          `Hostname "${hostname}" resolved to ${record.address}, which is blocked: ${explainBlockedIp(record.address)}`,
        );
      }
    }
  }

  // All candidates were safe at the moment of resolution; pin the connection
  // to the first one so the socket that is actually opened is guaranteed to
  // be one of the addresses just validated.
  const first = records[0];
  if (!first) {
    throw new SsrfBlockedError(`Hostname "${hostname}" did not resolve to any address.`);
  }
  return first.address;
}
