import { NextResponse } from "next/server";
import { signupInputSchema } from "@cma/core";
import { createOrganizationWithOwner, findUserByEmail } from "@cma/db";
import { hashPassword } from "@/lib/password";
import { createSessionToken, SESSION_COOKIE_NAME, SESSION_DURATION_SECONDS } from "@/lib/session";
import { toErrorResponse } from "@/lib/apiError";

export async function POST(request: Request): Promise<NextResponse> {
  try {
    const body = signupInputSchema.parse(await request.json());

    const existing = await findUserByEmail(body.email);
    if (existing) {
      return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
    }

    const passwordHash = await hashPassword(body.password);
    const { organization, user } = await createOrganizationWithOwner({
      organizationName: body.organizationName,
      email: body.email,
      passwordHash,
    });

    const token = await createSessionToken({ userId: user.id, organizationId: organization.id });
    const response = NextResponse.json(
      { organizationId: organization.id, userId: user.id },
      { status: 201 },
    );
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
