import { describe, expect, it } from "vitest";
import { monitoredUrlInputSchema, signupInputSchema } from "@cma/core";

describe("monitoredUrlInputSchema", () => {
  it("accepts a well-formed https URL", () => {
    const result = monitoredUrlInputSchema.safeParse({ url: "https://competitor.test/pricing" });
    expect(result.success).toBe(true);
  });

  it("rejects a non-http(s) protocol at the format level", () => {
    const result = monitoredUrlInputSchema.safeParse({ url: "ftp://competitor.test/pricing" });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed URL string", () => {
    const result = monitoredUrlInputSchema.safeParse({ url: "not a url" });
    expect(result.success).toBe(false);
  });

  it("defaults category to GENERAL when omitted", () => {
    const result = monitoredUrlInputSchema.parse({ url: "https://competitor.test/" });
    expect(result.category).toBe("GENERAL");
  });
});

describe("signupInputSchema", () => {
  it("rejects a password shorter than 10 characters", () => {
    const result = signupInputSchema.safeParse({
      organizationName: "Acme",
      email: "a@example.com",
      password: "short1",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a well-formed signup payload", () => {
    const result = signupInputSchema.safeParse({
      organizationName: "Acme",
      email: "a@example.com",
      password: "a-long-enough-password",
    });
    expect(result.success).toBe(true);
  });
});
