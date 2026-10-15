import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, sessionCookieOptions, verifySessionToken } from "./session.js";

beforeAll(() => {
  process.env["AUTH_SECRET"] = "test-secret-at-least-32-characters-long!!";
});

describe("session tokens", () => {
  it("round-trips a valid session payload", async () => {
    const token = await createSessionToken({ userId: "user-1", organizationId: "org-1", sessionId: "sess-1" });
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ userId: "user-1", organizationId: "org-1", sessionId: "sess-1" });
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({ userId: "user-1", organizationId: "org-1", sessionId: "sess-1" });
    const tampered = token.slice(0, -2) + "xx";
    const payload = await verifySessionToken(tampered);
    expect(payload).toBeNull();
  });

  it("rejects a token without a session id, such as one issued before sessions were kept on the server", async () => {
    const { SignJWT } = await import("jose");
    const old = await new SignJWT({ userId: "user-1", organizationId: "org-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(process.env["AUTH_SECRET"]!));
    expect(await verifySessionToken(old)).toBeNull();
  });

  it("sets and clears the cookie with the same attributes", () => {
    const set = sessionCookieOptions(1000);
    const clear = sessionCookieOptions(0);
    expect({ ...clear, maxAge: set.maxAge }).toEqual(set);
    expect(set).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });

  it("rejects a garbage string instead of throwing", async () => {
    const payload = await verifySessionToken("not-a-real-jwt");
    expect(payload).toBeNull();
  });
});
