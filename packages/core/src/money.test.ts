import { describe, expect, it } from "vitest";
import { comparePrices, detectCurrency, normalizeCurrencyCode, parseAmount, parseAmountDetailed } from "./money.js";

describe("parseAmount", () => {
  it.each([
    ["10", 10],
    ["10.5", 10.5],
    ["10,50", 10.5],
    ["49.00", 49],
    ["1,299.00", 1299],
    ["1.299,00", 1299],
    ["1 299,00", 1299],
    ["1 299,00", 1299],
    ["1 299,00", 1299],
    ["1'299.00", 1299],
    ["1,234,567.89", 1234567.89],
    ["1.234.567,89", 1234567.89],
    ["1,23,456.00", 123456],
    ["0.99", 0.99],
    ["0,99", 0.99],
    ["€ 1.299,00 / mo", 1299],
    ["$19.99 per month", 19.99],
    ["US$ 12", 12],
    ["From 1,299", 1299],
    ["10.", 10],
  ])("%s -> %s", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it("returns null when there is no usable number", () => {
    expect(parseAmount("")).toBeNull();
    expect(parseAmount(null)).toBeNull();
    expect(parseAmount(undefined)).toBeNull();
    expect(parseAmount("Contact sales")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
    expect(parseAmount("12,34,5")).toBeNull();
  });

  it("reads a leading minus as negative", () => {
    expect(parseAmount("-10.50")).toBe(-10.5);
  });

  it("flags the genuinely ambiguous reading, and only that one", () => {
    expect(parseAmountDetailed("1.299")).toEqual({ value: 1299, ambiguous: true });
    expect(parseAmountDetailed("1,299")).toEqual({ value: 1299, ambiguous: true });
    expect(parseAmountDetailed("0.999")).toEqual({ value: 0.999, ambiguous: false });
    expect(parseAmountDetailed("1.2999")).toEqual({ value: 1.2999, ambiguous: false });
    expect(parseAmountDetailed("1.299,00")?.ambiguous).toBe(false);
    expect(parseAmountDetailed("19.99")?.ambiguous).toBe(false);
  });
});

describe("detectCurrency", () => {
  it.each([
    ["€19", "EUR", false],
    ["19 €", "EUR", false],
    ["£9.99", "GBP", false],
    ["₹499", "INR", false],
    ["US$ 12", "USD", false],
    ["CA$12", "CAD", false],
    ["R$ 99,00", "BRL", false],
    ["EUR 19.00", "EUR", false],
    ["19 usd", "USD", false],
    ["$19", "USD", true],
    ["¥1,000", "JPY", true],
    ["199 zł", "PLN", false],
  ])("%s -> %s (ambiguous: %s)", (input, code, ambiguous) => {
    expect(detectCurrency(input)).toEqual({ code, ambiguous });
  });

  it("returns null when no currency is written", () => {
    expect(detectCurrency("19.00")).toBeNull();
    expect(detectCurrency("")).toBeNull();
    expect(detectCurrency(null)).toBeNull();
  });

  it("does not mistake an ordinary three-letter word for a currency", () => {
    expect(detectCurrency("Pro plan for you")).toBeNull();
  });
});

describe("normalizeCurrencyCode", () => {
  it("accepts known ISO codes in any case and rejects the rest", () => {
    expect(normalizeCurrencyCode("eur")).toBe("EUR");
    expect(normalizeCurrencyCode(" USD ")).toBe("USD");
    expect(normalizeCurrencyCode("XYZ")).toBeNull();
    expect(normalizeCurrencyCode("$")).toBeNull();
    expect(normalizeCurrencyCode(null)).toBeNull();
  });
});

describe("comparePrices", () => {
  it("treats 10 and 10.00 as the same price (the old string comparison called it a change)", () => {
    expect(comparePrices({ value: "10", currency: "USD" }, { value: "10.00", currency: "USD" }).kind).toBe("same");
  });

  it("treats the same amount written in two locales as the same price", () => {
    expect(comparePrices({ value: "1.299,00", currency: "EUR" }, { value: "1299.00", currency: "EUR" }).kind).toBe("same");
  });

  it("computes the percentage across a European-format change correctly (not 1000x off)", () => {
    const result = comparePrices({ value: "1.299,00", currency: "EUR" }, { value: "1.499,00", currency: "EUR" });
    expect(result).toMatchObject({ kind: "changed", amountChanged: true, currencyChanged: false, percentageChange: 15.4 });
  });

  it("reports a currency change with an unchanged number as a change without a percentage", () => {
    const result = comparePrices({ value: "10", currency: "USD" }, { value: "10", currency: "EUR" });
    expect(result).toMatchObject({ kind: "changed", amountChanged: false, currencyChanged: true, percentageChange: null });
  });

  it("gives no percentage when both the amount and the currency changed", () => {
    const result = comparePrices({ value: "10", currency: "USD" }, { value: "12", currency: "EUR" });
    expect(result).toMatchObject({ kind: "changed", amountChanged: true, currencyChanged: true, percentageChange: null });
  });

  it("does not call a missing currency a change", () => {
    expect(comparePrices({ value: "10", currency: null }, { value: "10", currency: "USD" }).kind).toBe("same");
    expect(comparePrices({ value: "10", currency: "USD" }, { value: "12", currency: null })).toMatchObject({ kind: "changed", currencyChanged: false, percentageChange: 20 });
  });

  it("gives no percentage from a zero price", () => {
    expect(comparePrices({ value: "0", currency: "USD" }, { value: "9", currency: "USD" })).toMatchObject({ kind: "changed", percentageChange: null });
  });

  it("is unparseable when either side has no number", () => {
    expect(comparePrices({ value: null, currency: null }, { value: "10", currency: null }).kind).toBe("unparseable");
    expect(comparePrices({ value: "Contact us", currency: null }, { value: "10", currency: null }).kind).toBe("unparseable");
  });

  it("marks a result ambiguous when a number has two readings", () => {
    expect(comparePrices({ value: "1.299", currency: "EUR" }, { value: "1.499", currency: "EUR" })).toMatchObject({ kind: "changed", ambiguous: true });
  });
});
