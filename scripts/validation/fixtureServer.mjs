// Deterministic local "competitor website" used ONLY for Phase 1 validation.
// Not part of the shipped product - a stand-in for a real competitor page so
// the end-to-end monitoring test does not depend on any external website.
//
// Usage: node fixtureServer.mjs [port]
// Sites are independent, keyed by path: GET /site/:key/product
// Control plane: POST /site/:key/admin/state  { mode, products: [...] }
//   mode: "normal" | "403" | "429" | "malformed" | "timeout"
//   products: [{ name, price, currency, availability }]  (single-product
//   pages just use a one-element array)

import http from "node:http";

const port = Number(process.argv[2] ?? 4100);

const DEFAULT_PRODUCTS = [
  { name: "Example Pro", price: "49.00", currency: "EUR", availability: "Available" },
];

const sites = new Map();

function getSite(key) {
  if (!sites.has(key)) {
    sites.set(key, { mode: "normal", products: DEFAULT_PRODUCTS.map((p) => ({ ...p })) });
  }
  return sites.get(key);
}

function renderProductPage(site) {
  const jsonLdBlocks = site.products
    .map((p) =>
      JSON.stringify({
        "@context": "https://schema.org",
        "@type": "Product",
        name: p.name,
        offers: {
          "@type": "Offer",
          price: p.price,
          priceCurrency: p.currency,
          availability: p.availability === "Available" ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        },
      }),
    )
    .map((json) => `<script type="application/ld+json">${json}</script>`)
    .join("\n");

  const visibleBlocks = site.products
    .map((p) => `<div><h2>${p.name}</h2><p class="price">${p.currency === "EUR" ? "€" : p.currency}${p.price}</p><p>${p.availability}</p></div>`)
    .join("\n");

  return `<!doctype html>
<html>
<head><title>Example Competitor</title>${jsonLdBlocks}</head>
<body>${visibleBlocks}</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  const match = req.url.match(/^\/site\/([a-zA-Z0-9_-]+)\/(admin\/state|product)$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
    return;
  }
  const [, key, action] = match;
  const site = getSite(key);

  if (req.method === "POST" && action === "admin/state") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8") || "{}");
    Object.assign(site, body);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, site }));
    return;
  }

  if (action === "product") {
    if (site.mode === "403") {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }
    if (site.mode === "429") {
      res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "1" });
      res.end("Too Many Requests");
      return;
    }
    if (site.mode === "timeout") {
      return; // never respond
    }
    if (site.mode === "malformed") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><head></head><body></body></html>");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderProductPage(site));
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[fixture-server] listening on http://127.0.0.1:${port}/site/<key>/product`);
});
