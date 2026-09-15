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

  it("rejects a response body larger than maxBodyBytes", async () => {
    const url = new URL(`http://127.0.0.1:${port}/big`);
    await expect(
      requestViaIp(url, "127.0.0.1", { timeoutMs: 2000, maxBodyBytes: 100, userAgent: "test" }),
    ).rejects.toThrow(/exceeded/);
  });
});
