import { NextResponse } from "next/server";
import { loginInputSchema } from "@cma/core";
import { findUserByEmail } from "@cma/db";
import { verifyPassword } from "@/lib/password";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS } from "@/lib/session";
import { toErrorResponse } from "@/lib/apiError";
import { readLimits } from "@/lib/limits";
import { hit, peek, reset } from "@/lib/rateLimit";
import { clientIp, tooManyRequests } from "@/lib/limitResponse";

/**
 * Failed-login throttling (Phase 29 / A3). Only FAILED attempts count, and
 * a success clears the counter, so a legitimate user is never penalised for
 * logging in correctly. Two keys:
 *   - ip+email: the normal brake on guessing one account from one address;
 *   - email alone, at 5x the allowance: X-Forwarded-For is client-controlled
 *     unless a trusted proxy sets it, so rotating the header must not make
 *     guessing free. The wider allowance keeps a stranger from easily
 *     locking a real user out.
 * Unknown emails are counted exactly like known ones, so the throttle
 * itself reveals nothing about which accounts exist.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = loginInputSchema.parse(await request.json());
    const limits = readLimits();
    const windowSeconds = limits.loginWindowMinutes * 60;
    const email = body.email.trim().toLowerCase();
    const ipKey = `login:${clientIp(request)}:${email}`;
    const emailKey = `login-email:${email}`;
    const message = "Too many failed sign-in attempts. Please wait before trying again.";

    const [ipState, emailState] = await Promise.all([peek(ipKey, limits.loginAttempts), peek(emailKey, limits.loginAttempts * 5)]);
    if (!ipState.allowed) return tooManyRequests(ipState, message);
    if (!emailState.allowed) return tooManyRequests(emailState, message);

    const user = await findUserByEmail(body.email);

    // Same generic message whether the email doesn't exist or the
    // password is wrong - never reveal which part failed.
    const genericFailure = async () => {
      await Promise.all([hit(ipKey, limits.loginAttempts, windowSeconds), hit(emailKey, limits.loginAttempts * 5, windowSeconds)]);
      return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
    };

    if (!user) return genericFailure();
    const passwordOk = await verifyPassword(body.password, user.passwordHash);
    if (!passwordOk) return genericFailure();

    await reset(ipKey);

    const token = await createSessionToken({ userId: user.id, organizationId: user.organizationId });
    const response = NextResponse.json({ userId: user.id, organizationId: user.organizationId });
    response.cookies.set(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: process.env["NODE_ENV"] === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_DURATION_SECONDS,
    });
    return response;
  } catch (err) {
    return toErrorResponse(err);
  }
}
