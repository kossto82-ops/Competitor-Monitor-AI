import { describe, expect, it } from "vitest";
import { checkApiRequestOrigin, factsFromRequest, type RequestFacts } from "./originCheck";

const SITE = "https://app.example.com";
const facts = (overrides: Partial<RequestFacts> = {}): RequestFacts => ({
  method: "POST",
  requestOrigin: SITE,
  origin: SITE,
  secFetchSite: "same-origin",
  contentType: "application/json",
  hasBody: true,
  ...overrides,
});

describe("checkApiRequestOrigin (Phase 29 D5c, E16)", () => {
  it("accepts a same-origin JSON request", () => {
    expect(checkApiRequestOrigin(facts())).toEqual({ ok: true });
    expect(checkApiRequestOrigin(facts({ contentType: "application/json; charset=utf-8" }))).toEqual({ ok: true });
  });

  it("refuses a state-changing request from another origin, including sandboxed frames", () => {
    for (const origin of ["https://evil.example", "http://app.example.com", "https://app.example.com.evil.example", "null"]) {
      const result = checkApiRequestOrigin(facts({ origin }));
      expect(result).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("refuses a cross-site request that carries no Origin when the browser says so, and allows the user's own navigation", () => {
    expect(checkApiRequestOrigin(facts({ origin: null, secFetchSite: "cross-site" }))).toMatchObject({ ok: false, status: 403 });
    expect(checkApiRequestOrigin(facts({ origin: null, secFetchSite: "same-site" }))).toMatchObject({ ok: false, status: 403 });
    expect(checkApiRequestOrigin(facts({ origin: null, secFetchSite: "same-origin" }))).toEqual({ ok: true });
    expect(checkApiRequestOrigin(facts({ origin: null, secFetchSite: "none" }))).toEqual({ ok: true });
  });

  it("does not stand in the way of clients that are not browser pages (no Origin, no Sec-Fetch-Site)", () => {
    expect(checkApiRequestOrigin(facts({ origin: null, secFetchSite: null }))).toEqual({ ok: true });
  });

  it("never blocks reads", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      expect(checkApiRequestOrigin(facts({ method, origin: "https://evil.example", hasBody: false }))).toEqual({ ok: true });
    }
  });

  it("requires JSON for a request with a body, so a cross-site HTML form cannot send one", () => {
    for (const contentType of ["application/x-www-form-urlencoded", "text/plain", "multipart/form-data; boundary=x", null, "application/jsonp"]) {
      expect(checkApiRequestOrigin(facts({ contentType }))).toMatchObject({ ok: false, status: 415 });
    }
    expect(checkApiRequestOrigin(facts({ hasBody: false, contentType: null }))).toEqual({ ok: true }); // e.g. DELETE or logout
  });

  it("checks PUT, PATCH and DELETE like POST", () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(checkApiRequestOrigin(facts({ method, origin: "https://evil.example" }))).toMatchObject({ ok: false, status: 403 });
    }
  });

  it("reads the facts from a Request", () => {
    const request = new Request("https://app.example.com/api/x", { method: "POST", headers: { origin: SITE, "content-type": "application/json", "content-length": "17" }, body: "{}" });
    expect(factsFromRequest(request, SITE)).toMatchObject({ method: "POST", origin: SITE, contentType: "application/json", hasBody: true });
    const empty = new Request("https://app.example.com/api/x", { method: "DELETE" });
    expect(factsFromRequest(empty, SITE).hasBody).toBe(false);
  });
});
