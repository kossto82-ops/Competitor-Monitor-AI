import { NextResponse } from "next/server";
import { loginInputSchema } from "@cma/core";
import { findUserByEmail } from "@cma/db";
import { verifyPassword } from "@/lib/password";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS } from "@/lib/session";
import { toErrorResponse } from "@/lib/apiError";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = loginInputSchema.parse(await request.json());
    const user = await findUserByEmail(body.email);

    // Same generic message whether the email doesn't exist or the
    // password is wrong - never reveal which part failed.
    const genericFailure = () => NextResponse.json({ error: "Invalid email or password." }, { status: 401 });

    if (!user) return genericFailure();
    const passwordOk = await verifyPassword(body.password, user.passwordHash);
    if (!passwordOk) return genericFailure();

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
