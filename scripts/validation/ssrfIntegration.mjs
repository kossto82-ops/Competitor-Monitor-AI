// Phase 1 validation - Section 7 SSRF integration tests.
// Deliberately run WITHOUT CMA_ALLOW_PRIVATE_TARGETS - this proves the
// real, production-mode code path (no dev escape hatch) blocks every
// category, using the actual default DNS resolver, not an injected fake.

import { safeGet } from "../../packages/security/dist/index.js";
import http from "node:http";

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`PASS: ${message}`);
  }
}

async function expectBlocked(url, label) {
  try {
    await safeGet(url, { timeoutMs: 5000 });
    assert(false, `${label} (${url}) should have been blocked but a connection succeeded`);
  } catch (err) {
    const isSsrf = err?.name === "SsrfBlockedError";
    assert(isSsrf, `${label} (${url}) blocked with SsrfBlockedError (got: ${err?.name}: ${err?.message})`);
  }
}

async function main() {
  console.log("=== Direct destinations that must never be connected to ===");
  await expectBlocked("http://localhost/", "localhost");
  await expectBlocked("http://127.0.0.1/", "127.0.0.1 loopback");
  await expectBlocked("http://10.1.2.3/", "private IPv4 (10/8)");
  await expectBlocked("http://192.168.1.1/", "private IPv4 (192.168/16)");
  await expectBlocked("http://172.16.5.5/", "private IPv4 (172.16/12)");
  await expectBlocked("http://[::1]/", "private IPv6 loopback");
  await expectBlocked("http://[fc00::1]/", "private IPv6 (unique local fc00::/7)");
  await expectBlocked("http://[fe80::1]/", "IPv6 link-local (fe80::/10)");
  await expectBlocked("http://[::ffff:127.0.0.1]/", "IPv4-mapped IPv6 loopback");
  await expectBlocked("http://[::ffff:10.0.0.5]/", "IPv4-mapped IPv6 private");
  await expectBlocked("http://169.254.169.254/", "cloud metadata address (AWS/GCP/Azure)");
  await expectBlocked("http://169.254.1.1/", "IPv4 link-local (169.254/16)");
  await expectBlocked("http://printer.local/", "internal hostname (.local suffix)");
  await expectBlocked("http://foo.internal/", "internal hostname (.internal suffix)");

  console.log("\n=== A local listener proves blocked destinations get ZERO connection attempts ===");
  let hitCount = 0;
  const sentinel = http.createServer((_req, res) => {
    hitCount += 1;
    res.writeHead(200);
    res.end("should never be seen");
  });
  await new Promise((resolve) => sentinel.listen(0, "127.0.0.1", resolve));
  const sentinelPort = sentinel.address().port;
  await expectBlocked(`http://127.0.0.1:${sentinelPort}/`, "loopback listener that IS actually up and reachable");
  assert(hitCount === 0, `the sentinel server received ${hitCount} requests (must be 0 - blocked before any TCP connect)`);
  await new Promise((resolve) => sentinel.close(resolve));

  console.log("\n=== Real redirect chains via a public test service (httpbin.org) ===");
  try {
    await expectBlocked(
      "https://httpbin.org/redirect-to?url=http://169.254.169.254/latest/meta-data/",
      "public URL redirecting to cloud metadata address",
    );
    await expectBlocked(
      "https://httpbin.org/redirect-to?url=http://127.0.0.1/",
      "public URL redirecting to localhost",
    );
    await expectBlocked(
      "https://httpbin.org/redirect-to?url=http://192.168.1.1/",
      "public URL redirecting to private IPv4",
    );
    // httpbin's /redirect/3 does 3 internal hops then lands on /get (a safe
    // public page) - used here to prove multi-hop redirects are each
    // re-validated and a SAFE multi-hop chain is allowed through.
    const multiHop = await safeGet("https://httpbin.org/redirect/3", { timeoutMs: 10000 });
    assert(multiHop.status === 200, `multi-hop (3x) redirect to a SAFE final destination succeeds (status ${multiHop.status})`);
    // Chain a safe multi-hop redirect that ends on a private target.
    await expectBlocked(
      "https://httpbin.org/redirect-to?url=" + encodeURIComponent("https://httpbin.org/redirect-to?url=http://169.254.169.254/"),
      "double-hop redirect (public -> public -> cloud metadata) still blocked on the final hop",
    );
  } catch (err) {
    console.warn(
      `\nNOTE: httpbin.org-based redirect tests could not run (${err?.message}). ` +
        "This affects only the external-service-dependent tests below; all local/direct SSRF tests above already ran for real.",
    );
  }

  console.log("\nDONE");
}

main().catch((err) => {
  console.error("VALIDATION SCRIPT CRASHED:", err);
  process.exit(1);
});
