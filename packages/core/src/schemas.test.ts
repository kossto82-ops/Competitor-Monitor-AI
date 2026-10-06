import { describe, expect, it } from "vitest";
import {
  competitorInputSchema,
  createAiConnectionInputSchema,
  httpUrlSchema,
  updateAiConnectionInputSchema,
  updateCompetitorInputSchema,
} from "./schemas.js";

const DANGEROUS = [
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "ftp://files.example.test/x",
  "file:///etc/passwd",
  "vbscript:msgbox(1)",
];

describe("httpUrlSchema", () => {
  it.each(["http://example.test", "https://example.test/pricing?x=1#top", "https://sub.example.test:8443/a"])("accepts %s", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(true);
  });

  it.each([...DANGEROUS, "not a url", "", "example.test"])("rejects %j", (url) => {
    expect(httpUrlSchema.safeParse(url).success).toBe(false);
  });
});

describe("every stored/used URL field is http(s)-only", () => {
  it.each(DANGEROUS)("competitor website rejects %s on create and update", (website) => {
    expect(competitorInputSchema.safeParse({ name: "Acme", website }).success).toBe(false);
    expect(updateCompetitorInputSchema.safeParse({ website }).success).toBe(false);
  });

  it("competitor website still accepts a normal URL, an omitted value, and null when updating", () => {
    expect(competitorInputSchema.safeParse({ name: "Acme", website: "https://acme.test" }).success).toBe(true);
    expect(competitorInputSchema.safeParse({ name: "Acme" }).success).toBe(true);
    expect(updateCompetitorInputSchema.safeParse({ website: null }).success).toBe(true);
  });

  it.each(DANGEROUS)("AI connection baseUrl rejects %s on create and update", (baseUrl) => {
    expect(createAiConnectionInputSchema.safeParse({ provider: "openai-compatible", model: "m", baseUrl, apiKey: "k" }).success).toBe(false);
    expect(updateAiConnectionInputSchema.safeParse({ baseUrl }).success).toBe(false);
  });

  it("AI connection baseUrl still accepts https and the openai-compatible requirement still applies", () => {
    expect(createAiConnectionInputSchema.safeParse({ provider: "openai-compatible", model: "m", baseUrl: "https://llm.example.test/v1", apiKey: "k" }).success).toBe(true);
    expect(createAiConnectionInputSchema.safeParse({ provider: "openai-compatible", model: "m", apiKey: "k" }).success).toBe(false);
    expect(updateAiConnectionInputSchema.safeParse({ baseUrl: null }).success).toBe(true);
  });
});
