import { describe, expect, it } from "vitest";
import { acceptLanguageFor, isMarketLocale, MARKET_LOCALES } from "./market.js";
import { updateOrganizationSettingsInputSchema } from "./schemas.js";

describe("market locale (Phase 29)", () => {
  it("builds an Accept-Language value that prefers the market and falls back sensibly", () => {
    expect(acceptLanguageFor("es-ES")).toBe("es-ES,es;q=0.9,en;q=0.5");
    expect(acceptLanguageFor("en-GB")).toBe("en-GB,en;q=0.9");
    expect(acceptLanguageFor("pt-BR")).toBe("pt-BR,pt;q=0.9,en;q=0.5");
  });

  it("sends nothing when no market is set or the value is not a known locale", () => {
    expect(acceptLanguageFor(null)).toBeNull();
    expect(acceptLanguageFor(undefined)).toBeNull();
    expect(acceptLanguageFor("")).toBeNull();
    expect(acceptLanguageFor("xx-YY")).toBeNull();
    expect(acceptLanguageFor("es-ES\r\nX-Evil: 1")).toBeNull();
  });

  it("every listed locale is recognised and produces a header", () => {
    for (const { code } of MARKET_LOCALES) {
      expect(isMarketLocale(code)).toBe(true);
      expect(acceptLanguageFor(code)).toContain(code);
    }
  });

  it("the settings schema accepts a listed locale, an empty string (clear) and omission, and rejects anything else", () => {
    expect(updateOrganizationSettingsInputSchema.parse({ marketLocale: "de-DE" }).marketLocale).toBe("de-DE");
    expect(updateOrganizationSettingsInputSchema.parse({ marketLocale: "" }).marketLocale).toBe("");
    expect(updateOrganizationSettingsInputSchema.parse({}).marketLocale).toBeUndefined();
    expect(() => updateOrganizationSettingsInputSchema.parse({ marketLocale: "klingon" })).toThrow();
    expect(() => updateOrganizationSettingsInputSchema.parse({ marketLocale: "en-US, x" })).toThrow();
  });
});
