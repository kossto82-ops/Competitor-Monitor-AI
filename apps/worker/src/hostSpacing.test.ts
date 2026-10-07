import { describe, expect, it } from "vitest";
import { hostOfUrl } from "@cma/db";
import { planHostDelays } from "./hostSpacing.js";

const noJitter = { spacingMs: 30_000, jitterMs: 0 };

describe("planHostDelays", () => {
  it("runs the first URL of a host immediately and spaces the rest", () => {
    const delays = planHostDelays(
      [{ url: "https://a.test/1" }, { url: "https://a.test/2" }, { url: "https://a.test/3" }],
      hostOfUrl,
      noJitter,
    );
    expect(delays).toEqual([0, 30_000, 60_000]);
  });

  it("does not delay different hosts against each other", () => {
    const delays = planHostDelays([{ url: "https://a.test/1" }, { url: "https://b.test/1" }, { url: "https://c.test/1" }], hostOfUrl, noJitter);
    expect(delays).toEqual([0, 0, 0]);
  });

  it("treats the host case-insensitively and ignores the path", () => {
    const delays = planHostDelays([{ url: "https://A.test/x" }, { url: "https://a.TEST/y?z=1" }], hostOfUrl, noJitter);
    expect(delays).toEqual([0, 30_000]);
  });

  it("adds jitter below the configured bound, never to the first URL", () => {
    const delays = planHostDelays([{ url: "https://a.test/1" }, { url: "https://a.test/2" }], hostOfUrl, {
      spacingMs: 30_000,
      jitterMs: 10_000,
      random: () => 0.5,
    });
    expect(delays).toEqual([0, 35_000]);
  });

  it("caps the delay so jobs cannot outlive the scheduler tick", () => {
    const urls = Array.from({ length: 50 }, (_, i) => ({ url: `https://a.test/${i}` }));
    const delays = planHostDelays(urls, hostOfUrl, { ...noJitter, maxDelayMs: 600_000 });
    expect(Math.max(...delays)).toBe(600_000);
  });

  it("gives an unparseable URL no delay instead of throwing", () => {
    expect(planHostDelays([{ url: "not a url" }, { url: "" }], hostOfUrl, noJitter)).toEqual([0, 0]);
  });
});
