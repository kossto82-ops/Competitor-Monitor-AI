import * as cheerio from "cheerio";
import { describe, expect, it } from "vitest";
import { extractMainContent, scrubVolatileText } from "./structuredData.js";
import { CheerioExtractor } from "./cheerioExtractor.js";
import type { FetchFn } from "./types.js";

const text = (html: string) => extractMainContent(cheerio.load(html)).text;
const LONG = "Pro plan 49 EUR per month includes unlimited projects and priority support for every team member. ".repeat(3);

describe("extractMainContent (Phase 29 C2)", () => {
  it("uses <main> and drops nav, site header and footer around it", () => {
    const html = `<body>
      <header><a>Home</a> <a>Login</a></header>
      <nav>Products Pricing Docs</nav>
      <main><h1>Pricing</h1><p>${LONG}</p></main>
      <footer>Terms Privacy © 2026 Acme</footer></body>`;
    const out = text(html);
    expect(out).toContain("Pro plan 49 EUR");
    expect(out).not.toContain("Login");
    expect(out).not.toContain("Products Pricing Docs");
    expect(out).not.toContain("Terms Privacy");
    expect(extractMainContent(cheerio.load(html)).strategy).toBe("main");
  });

  it("is not changed by a rotating banner, cookie notice or footer year (the false-change sources)", () => {
    const page = (banner: string, year: string) => `<body>
      <div class="cookie-consent">${banner}</div>
      <div id="promo-popup">Webinar #${banner.length}</div>
      <main><p>${LONG}</p></main><footer>© ${year} Acme</footer></body>`;
    expect(text(page("We use cookies", "2026"))).toBe(text(page("Accept all cookies now!!", "2027")));
  });

  it("keeps a <header> that sits inside the page content (a pricing hero is often a <header>)", () => {
    const html = `<body><main><section><header><h2>Pro: 49 EUR</h2></header><p>${LONG}</p></section></main></body>`;
    expect(text(html)).toContain("Pro: 49 EUR");
  });

  it("falls back to the whole cleaned body when there is no <main>", () => {
    const html = `<body><nav>Menu</nav><div><h1>Plans</h1><p>Starter 9 EUR</p></div><footer>Legal</footer></body>`;
    const result = extractMainContent(cheerio.load(html));
    expect(result.strategy).toBe("body");
    expect(result.text).toContain("Starter 9 EUR");
    expect(result.text).not.toContain("Menu");
    expect(result.text).not.toContain("Legal");
  });

  it("does not trust a tiny <main> that holds a small share of the page", () => {
    const html = `<body><main>Loading…</main><div>${LONG}${LONG}</div></body>`;
    const result = extractMainContent(cheerio.load(html));
    expect(result.strategy).toBe("body");
    expect(result.text).toContain("Pro plan 49 EUR");
  });

  it("still sees a real price change inside <main>", () => {
    const before = text(`<body><main><p>${LONG}</p></main></body>`);
    const after = text(`<body><main><p>${LONG.replace("49 EUR", "59 EUR")}</p></main></body>`);
    expect(before).not.toBe(after);
  });

  it("falls back to the whole body when cleaning would leave almost nothing (content hidden inside chrome)", () => {
    const links = Array.from({ length: 60 }, (_, i) => `<a href="/l${i}">Language number ${i}</a>`).join(" ");
    const html = `<body><main>Hi</main><nav>${links}</nav></body>`;
    const result = extractMainContent(cheerio.load(html));
    expect(result.strategy).toBe("whole-body");
    expect(result.text).toContain("Language number 59");
  });

  it("removes dialogs and chat widgets by role or by name, and never script/style content", () => {
    const html = `<body><div role="dialog">Subscribe!</div><div class="intercom-lightweight-app">Chat with us</div>
      <script>var x = "secret"</script><style>.a{}</style><main><p>${LONG}</p></main></body>`;
    const out = text(html);
    expect(out).not.toContain("Subscribe");
    expect(out).not.toContain("Chat with us");
    expect(out).not.toContain("secret");
  });
});

describe("scrubVolatileText", () => {
  it("neutralizes timestamps, relative times and copyright years, and nothing else", () => {
    expect(scrubVolatileText("Updated 3 hours ago")).toBe("Updated [time]");
    expect(scrubVolatileText("Sync 2026-10-07T12:30:45Z done")).toBe("Sync [time] done");
    expect(scrubVolatileText("© 2024-2026 Acme Inc")).toBe("[copyright] Acme Inc");
    expect(scrubVolatileText("Copyright 2026 Acme")).toBe("[copyright] Acme");
    expect(scrubVolatileText("Last updated yesterday")).toBe("[time]");
  });

  it("leaves prices, plan names and ordinary numbers untouched", () => {
    const original = "Pro 49 EUR/mo, 20% off until 2026-12-31, 3 seats, 2026 roadmap";
    expect(scrubVolatileText(original)).toBe(original);
  });
});

describe("CheerioExtractor with main-content hashing", () => {
  it("gives the same contentHash for a page whose only difference is banner and footer noise", async () => {
    const make = (banner: string, year: string): FetchFn => async () => ({
      status: 200,
      finalUrl: "https://a.test/pricing",
      body: `<html><body><div class="cookie-banner">${banner}</div><main><p>${LONG}</p></main><footer>© ${year}</footer></body></html>`,
    });
    const a = await new CheerioExtractor(make("one", "2026")).extract({ url: "https://a.test/pricing" });
    const b = await new CheerioExtractor(make("two!", "2027")).extract({ url: "https://a.test/pricing" });
    expect(a.contentHash).not.toBeNull();
    expect(a.contentHash).toBe(b.contentHash);
    expect(a.extractorVersion).toBe(2);
  });

  it("changes the hash when the pricing content itself changes", async () => {
    const make = (price: string): FetchFn => async () => ({
      status: 200,
      finalUrl: "https://a.test/pricing",
      body: `<html><body><main><p>${LONG.replace("49 EUR", price)}</p></main></body></html>`,
    });
    const a = await new CheerioExtractor(make("49 EUR")).extract({ url: "https://a.test/pricing" });
    const b = await new CheerioExtractor(make("59 EUR")).extract({ url: "https://a.test/pricing" });
    expect(a.contentHash).not.toBe(b.contentHash);
  });
});
