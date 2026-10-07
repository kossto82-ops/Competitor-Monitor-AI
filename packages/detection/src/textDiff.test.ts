import { describe, expect, it } from "vitest";
import { diffText } from "./textDiff.js";

describe("diffText (Phase 29 C4)", () => {
  it("finds no hunks for identical text", () => {
    expect(diffText("a b c", "a b c")).toEqual({ hunks: [], truncated: false });
    expect(diffText("", "")).toEqual({ hunks: [], truncated: false });
  });

  it("reports a single replaced word with its surrounding context", () => {
    const { hunks } = diffText("Pro plan costs 29 per month for teams", "Pro plan costs 39 per month for teams");
    expect(hunks).toEqual([{ removed: "29", added: "39", before: "Pro plan costs", after: "per month for teams" }]);
  });

  it("reports pure additions and pure removals", () => {
    const added = diffText("alpha beta", "alpha beta gamma delta").hunks;
    expect(added).toEqual([{ removed: "", added: "gamma delta", before: "alpha beta", after: "" }]);
    const removed = diffText("alpha beta gamma", "alpha gamma").hunks;
    expect(removed).toEqual([{ removed: "beta", added: "", before: "alpha", after: "gamma" }]);
  });

  it("separates distant changes into distinct hunks and merges close ones", () => {
    const filler = Array.from({ length: 20 }, (_, i) => `w${i}`).join(" ");
    const distant = diffText(`one ${filler} two`, `1 ${filler} 2`).hunks;
    expect(distant).toHaveLength(2);
    const close = diffText("a x b y c", "a X b Y c").hunks;
    expect(close).toHaveLength(1);
    expect(close[0]).toMatchObject({ removed: "x b y", added: "X b Y" });
  });

  it("does not report a moved block as the whole page changing", () => {
    const { hunks, truncated } = diffText("intro Starter $9 Pro $29 outro", "intro Pro $29 Starter $9 outro");
    expect(truncated).toBe(false);
    expect(hunks.length).toBeGreaterThan(0);
    // Every word is still on the page; the hunk only covers the shuffled region, never "intro" or "outro".
    expect(hunks.every((h) => !h.removed.includes("intro") && !h.added.includes("outro"))).toBe(true);
  });

  it("stays fast and bounded on a page that was completely rewritten", () => {
    const a = Array.from({ length: 3000 }, (_, i) => `old${i}`).join(" ");
    const b = Array.from({ length: 3000 }, (_, i) => `new${i}`).join(" ");
    const started = Date.now();
    const result = diffText(a, b);
    expect(Date.now() - started).toBeLessThan(2000);
    expect(result.truncated).toBe(true);
    expect(result.hunks).toHaveLength(1);
  });

  it("is exact on a large page with a few small edits", () => {
    const base = Array.from({ length: 5000 }, (_, i) => `word${i}`);
    const changed = [...base];
    changed[1200] = "EDITED";
    changed.splice(3000, 0, "INSERTED");
    const { hunks, truncated } = diffText(base.join(" "), changed.join(" "));
    expect(truncated).toBe(false);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ removed: "word1200", added: "EDITED" });
    expect(hunks[1]).toMatchObject({ removed: "", added: "INSERTED" });
  });
});
