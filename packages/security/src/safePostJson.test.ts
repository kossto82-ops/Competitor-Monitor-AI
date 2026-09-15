import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestJsonViaIp, safePostJson } from "./safeFetch.js";
import { SsrfBlockedError } from "./resolveHost.js";

describe("requestJsonViaIp (HTTP mechanics against a local test server)", () => {
  let server: http.Server;
  let port: number;
  let lastRequest: { method?: string; headers: http.IncomingHttpHeaders; body: string } | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        lastRequest = { method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString("utf-8") };
        if (req.url === "/redirect") {
          res.writeHead(302, { Location: "/target" });
          res.end();
          return;
        }
        if (req.url === "/error") {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: { message: "Invalid API key" } }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("sends the JSON body and custom headers (e.g. Authorization) to the server", async () => {
    const url = new URL(`http://127.0.0.1:${port}/`);
    const result = await requestJsonViaIp(url, "127.0.0.1", JSON.stringify({ hello: "world" }), {
      timeoutMs: 2000,
      maxBodyBytes: 1_000_000,
      headers: { Authorization: "Bearer sk-test-value" },
    });
    expect(result.status).toBe(200);
    expect(lastRequest?.headers["authorization"]).toBe("Bearer sk-test-value");
    expect(lastRequest?.body).toBe(JSON.stringify({ hello: "world" }));
    expect(lastRequest?.method).toBe("POST");
  });

  it("reports a non-2xx status with the response body, without throwing", async () => {
    const url = new URL(`http://127.0.0.1:${port}/error`);
    const result = await requestJsonViaIp(url, "127.0.0.1", "{}", { timeoutMs: 2000, maxBodyBytes: 1_000_000, headers: {} });
    expect(result.status).toBe(401);
    expect(result.body).toContain("Invalid API key");
  });
});

describe("safePostJson", () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === "/redirect") {
        res.writeHead(302, { Location: "/target" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("rejects a loopback baseUrl by default (Section 20: SSRF protection)", async () => {
    await expect(safePostJson(`http://127.0.0.1:${port}/`, {}, { headers: {} })).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a hostname that resolves to a private/link-local address, including the cloud metadata endpoint", async () => {
    const resolveFn = async (hostname: string) => {
      if (hostname === "attacker.example.com") return [{ address: "169.254.169.254", family: 4 }];
      throw new Error("unexpected hostname");
    };
    await expect(safePostJson("http://attacker.example.com/v1/chat", {}, { headers: {}, resolveFn })).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a non-http(s) scheme", async () => {
    await expect(safePostJson("file:///etc/passwd", {}, { headers: {} })).rejects.toThrow(SsrfBlockedError);
  });

  it("refuses to follow a redirect response", async () => {
    // Isolated from the SSRF check itself (already covered above): opt
    // into the same dev/test escape hatch resolveAndValidateHost uses
    // elsewhere, purely so this test can reach the local server and
    // exercise redirect-refusal in isolation.
    const originalNodeEnv = process.env["NODE_ENV"];
    const originalAllowPrivate = process.env["CMA_ALLOW_PRIVATE_TARGETS"];
    process.env["NODE_ENV"] = "development";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
    try {
      await expect(safePostJson(`http://127.0.0.1:${port}/redirect`, {}, { headers: {} })).rejects.toThrow(/redirect/i);
    } finally {
      if (originalNodeEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = originalNodeEnv;
      if (originalAllowPrivate === undefined) delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
      else process.env["CMA_ALLOW_PRIVATE_TARGETS"] = originalAllowPrivate;
    }
  });
});
