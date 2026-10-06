import { NextResponse } from "next/server";
import { hit, type RateLimitResult } from "./rateLimit";

/**
 * Best-effort client address for rate-limit keys. Behind a reverse proxy
 * the left-most X-Forwarded-For entry is the client; without one the
 * header is attacker-controlled, which is why login is ALSO limited per
 * email (see the login route) and never by IP alone.
 */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

export function tooManyRequests(result: Pick<RateLimitResult, "retryAfterSeconds">, message: string): NextResponse {
  const retryAfter = Math.max(1, Math.ceil(result.retryAfterSeconds));
  return NextResponse.json(
    { error: message, code: "RATE_LIMITED", retryAfterSeconds: retryAfter },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

/** Records a hit; returns a 429 response when over the limit, otherwise null. */
export async function checkLimit(key: string, limit: number, windowSeconds: number, message: string): Promise<NextResponse | null> {
  const result = await hit(key, limit, windowSeconds);
  return result.allowed ? null : tooManyRequests(result, message);
}

export function quotaExceeded(message: string): NextResponse {
  return NextResponse.json({ error: message, code: "QUOTA_EXCEEDED" }, { status: 403 });
}
