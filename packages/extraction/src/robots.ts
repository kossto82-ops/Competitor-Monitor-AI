/**
 * Phase 29 B3: a small, conservative robots.txt implementation (RFC 9309 subset).
 *
 * The monitor identifies itself with a User-Agent, so it should honour the rules sites publish for
 * automated clients. Supported: `User-agent` groups (the group naming our product token wins over
 * `*`), `Allow` / `Disallow` with the longest matching rule deciding (Allow wins a tie), `*`
 * wildcards and a trailing `$`. Not supported (ignored): `Crawl-delay`, `Sitemap`, other directives.
 *
 * Failure policy is fail-OPEN on purpose: a missing robots.txt (4xx), a server error or a network
 * failure means "no restrictions known", so a flaky robots.txt cannot take a monitored page down.
 */
export interface RobotsRule {
  allow: boolean;
  pattern: string;
}

export interface RobotsRules {
  rules: RobotsRule[];
}

export const ALLOW_ALL: RobotsRules = { rules: [] };

/** The product token of our User-Agent ("CompetitorMonitorAI/0.1 (+monitoring bot)"). */
export const ROBOTS_PRODUCT_TOKEN = "competitormonitorai";

export function parseRobots(text: string, productToken: string = ROBOTS_PRODUCT_TOKEN): RobotsRules {
  const token = productToken.toLowerCase();
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if (field === "allow" || field === "disallow") {
      lastWasAgent = false;
      // A rule before any User-agent line belongs to no group; ignore it.
      if (!current) continue;
      // An empty Disallow means "nothing is disallowed"; an empty Allow is meaningless.
      if (value === "") continue;
      current.rules.push({ allow: field === "allow", pattern: value });
    } else {
      lastWasAgent = false;
    }
  }

  const named = groups.filter((g) => g.agents.some((a) => a !== "*" && a !== "" && token.includes(a)));
  const chosen = named.length > 0 ? named : groups.filter((g) => g.agents.includes("*"));
  return { rules: chosen.flatMap((g) => g.rules) };
}

function patternToRegExp(pattern: string): RegExp {
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}${anchored ? "$" : ""}`);
}

export function isPathAllowed(robots: RobotsRules, pathWithQuery: string): boolean {
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of robots.rules) {
    if (!patternToRegExp(rule.pattern).test(pathWithQuery)) continue;
    const length = rule.pattern.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best ? best.allow : true;
}

export type RobotsFetchFn = (robotsUrl: string) => Promise<{ status: number; body: string }>;

interface CacheEntry {
  rules: RobotsRules;
  expiresAt: number;
}

export interface RobotsCheckerOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Checks URLs against their site's robots.txt, caching one parsed result per origin. */
export class RobotsChecker {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly fetchRobots: RobotsFetchFn,
    options: RobotsCheckerOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 60 * 60_000;
    this.maxEntries = options.maxEntries ?? 500;
    this.now = options.now ?? Date.now;
  }

  async isAllowed(url: string): Promise<boolean> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return true;
    }
    const rules = await this.rulesFor(parsed.origin);
    return isPathAllowed(rules, `${parsed.pathname}${parsed.search}`);
  }

  private async rulesFor(origin: string): Promise<RobotsRules> {
    const cached = this.cache.get(origin);
    if (cached && cached.expiresAt > this.now()) return cached.rules;

    let rules = ALLOW_ALL;
    try {
      const response = await this.fetchRobots(`${origin}/robots.txt`);
      if (response.status >= 200 && response.status < 300) rules = parseRobots(response.body);
    } catch {
      // Fail open: see the file header.
    }

    if (this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(origin, { rules, expiresAt: this.now() + this.ttlMs });
    return rules;
  }
}
