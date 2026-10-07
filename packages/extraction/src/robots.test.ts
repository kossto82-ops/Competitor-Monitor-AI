import { describe, expect, it, vi } from "vitest";
import { isPathAllowed, parseRobots, RobotsChecker } from "./robots.js";

const allowed = (txt: string, path: string) => isPathAllowed(parseRobots(txt), path);

describe("parseRobots / isPathAllowed", () => {
  it("allows everything when there are no rules", () => {
    expect(allowed("", "/pricing")).toBe(true);
    expect(allowed("User-agent: *\nDisallow:", "/pricing")).toBe(true);
  });

  it("applies the * group by prefix", () => {
    const txt = "User-agent: *\nDisallow: /private\n";
    expect(allowed(txt, "/private/page")).toBe(false);
    expect(allowed(txt, "/pricing")).toBe(true);
  });

  it("prefers the group that names our product over *", () => {
    const txt = "User-agent: *\nDisallow: /\n\nUser-agent: CompetitorMonitorAI\nAllow: /\n";
    expect(allowed(txt, "/pricing")).toBe(true);
    const blocked = "User-agent: *\nAllow: /\n\nUser-agent: competitormonitorai\nDisallow: /\n";
    expect(allowed(blocked, "/pricing")).toBe(false);
  });

  it("lets the longest matching rule decide, with Allow winning a tie", () => {
    const txt = "User-agent: *\nDisallow: /docs\nAllow: /docs/public\n";
    expect(allowed(txt, "/docs/secret")).toBe(false);
    expect(allowed(txt, "/docs/public/a")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /x\nAllow: /x\n", "/x")).toBe(true);
  });

  it("supports * wildcards and the $ end anchor, and matches the query string", () => {
    const txt = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?session=\n";
    expect(allowed(txt, "/files/a.pdf")).toBe(false);
    expect(allowed(txt, "/files/a.pdf.html")).toBe(true);
    expect(allowed(txt, "/pricing?session=1")).toBe(false);
    expect(allowed(txt, "/pricing?plan=pro")).toBe(true);
  });

  it("merges consecutive User-agent lines into one group and ignores comments and unknown fields", () => {
    const txt = "# hi\nUser-agent: googlebot\nUser-agent: *\nCrawl-delay: 10\nDisallow: /a # note\n";
    expect(allowed(txt, "/a")).toBe(false);
    expect(allowed(txt, "/b")).toBe(true);
  });

  it("does not let regex metacharacters in a rule break matching", () => {
    expect(allowed("User-agent: *\nDisallow: /a+b(c)\n", "/a+b(c)/x")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a+b(c)\n", "/aab(c)")).toBe(true);
  });
});

describe("RobotsChecker", () => {
  it("fetches robots.txt once per origin within the TTL", async () => {
    const fetchRobots = vi.fn().mockResolvedValue({ status: 200, body: "User-agent: *\nDisallow: /private\n" });
    const checker = new RobotsChecker(fetchRobots);
    expect(await checker.isAllowed("https://a.test/pricing")).toBe(true);
    expect(await checker.isAllowed("https://a.test/private/x")).toBe(false);
    expect(fetchRobots).toHaveBeenCalledTimes(1);
    expect(fetchRobots).toHaveBeenCalledWith("https://a.test/robots.txt");
    await checker.isAllowed("https://b.test/");
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it("refetches after the TTL", async () => {
    let now = 0;
    const fetchRobots = vi.fn().mockResolvedValue({ status: 200, body: "" });
    const checker = new RobotsChecker(fetchRobots, { ttlMs: 1000, now: () => now });
    await checker.isAllowed("https://a.test/");
    now = 2000;
    await checker.isAllowed("https://a.test/");
    expect(fetchRobots).toHaveBeenCalledTimes(2);
  });

  it("fails open on 404, 5xx and network errors", async () => {
    for (const fetchRobots of [
      vi.fn().mockResolvedValue({ status: 404, body: "User-agent: *\nDisallow: /" }),
      vi.fn().mockResolvedValue({ status: 503, body: "User-agent: *\nDisallow: /" }),
      vi.fn().mockRejectedValue(new Error("timeout")),
    ]) {
      expect(await new RobotsChecker(fetchRobots).isAllowed("https://a.test/pricing")).toBe(true);
    }
  });

  it("allows an unparseable URL instead of throwing", async () => {
    expect(await new RobotsChecker(vi.fn()).isAllowed("not a url")).toBe(true);
  });
});
