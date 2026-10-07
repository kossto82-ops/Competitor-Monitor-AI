import { safeGet } from "@cma/security";
import { RobotsChecker } from "./robots.js";
import type { FetchFn } from "./types.js";

/** Only web pages are monitorable; a PDF, image or JSON behind a URL is refused before it is downloaded. */
export const HTML_CONTENT_TYPES = /^(text\/html|application\/xhtml\+xml)/i;

const DEFAULT_MAX_BODY_BYTES = 3 * 1024 * 1024; // 3MB: bounds the memory and CPU one parse can take

/** CMA_FETCH_MAX_BODY_BYTES (positive integer); invalid values fall back to the default. */
export function monitoringMaxBodyBytes(): number {
  const n = Number(process.env.CMA_FETCH_MAX_BODY_BYTES);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BODY_BYTES;
}

export const defaultFetch: FetchFn = async (url) => {
  const result = await safeGet(url, { maxBodyBytes: monitoringMaxBodyBytes(), allowedContentTypes: HTML_CONTENT_TYPES });
  return { status: result.status, body: result.body, finalUrl: result.finalUrl };
};

/**
 * CMA_ROBOTS_MODE=respect (default) | off. In "respect" mode the monitor honours each site's
 * robots.txt; "off" is for sources the customer owns or has permission to monitor regardless.
 * robots.txt itself goes through the same SSRF-safe fetch, capped at 512KB.
 */
export function createRobotsCheckerFromEnv(): RobotsChecker | undefined {
  if ((process.env.CMA_ROBOTS_MODE ?? "respect").toLowerCase() === "off") return undefined;
  return new RobotsChecker(async (robotsUrl) => {
    const result = await safeGet(robotsUrl, { maxBodyBytes: 512 * 1024, timeoutMs: 10_000, maxRedirects: 3 });
    return { status: result.status, body: result.body };
  });
}
