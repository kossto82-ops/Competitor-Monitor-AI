import { describe, expect, it } from "vitest";
import { HttpExtractor } from "./httpExtractor.js";
import type { FetchFn } from "./types.js";

describe("HttpExtractor", () => {
  it("returns a successful result with a content hash for a 200 response", async () => {
    const fetchFn: FetchFn = async () => ({ status: 200, body: "<html>hi</html>", finalUrl: "https://x.test/" });
    const result = await new HttpExtractor(fetchFn).extract({ url: "https://x.test/" });

    expect(result.errorMessage).toBeNull();
    expect(result.httpStatus).toBe(200);
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.confidence).toBe(1);
  });

  it("does not throw and reports FAILED-material on a 403", async () => {
    const fetchFn: FetchFn = async () => ({ status: 403, body: "Forbidden", finalUrl: "https://x.test/" });
    const result = await new HttpExtractor(fetchFn).extract({ url: "https://x.test/" });

    expect(result.errorMessage).toContain("403");
    expect(result.contentHash).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("does not throw and reports FAILED-material when the fetch itself throws", async () => {
    const fetchFn: FetchFn = async () => {
      throw new Error("boom: SSRF blocked");
    };
    const result = await new HttpExtractor(fetchFn).extract({ url: "https://x.test/" });

    expect(result.errorMessage).toContain("boom");
    expect(result.httpStatus).toBeNull();
    expect(result.confidence).toBe(0);
  });

  it("flags an empty 200 body with a warning instead of pretending success", async () => {
    const fetchFn: FetchFn = async () => ({ status: 200, body: "", finalUrl: "https://x.test/" });
    const result = await new HttpExtractor(fetchFn).extract({ url: "https://x.test/" });

    expect(result.warnings).toContain("Response body was empty");
    expect(result.confidence).toBeLessThan(1);
  });
});
