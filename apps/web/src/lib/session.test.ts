import { beforeAll, describe, expect, it } from "vitest";
import { createSessionToken, verifySessionToken } from "./session.js";

beforeAll(() => {
  process.env["AUTH_SECRET"] = "test-secret-at-least-32-characters-long!!";
});

describe("session tokens", () => {
  it("round-trips a valid session payload", async () => {
    const token = await createSessionToken({ userId: "user-1", organizationId: "org-1" });
    const payload = await verifySessionToken(token);
    expect(payload).toEqual({ userId: "user-1", organizationId: "org-1" });
  });

  it("rejects a tampered token", async () => {
    const token = await createSessionToken({ userId: "user-1", organizationId: "org-1" });
    const tampered = token.slice(0, -2) + "xx";
    const payload = await verifySessionToken(tampered);
    expect(payload).toBeNull();
  });

  it("rejects a garbage string instead of throwing", async () => {
    const payload = await verifySessionToken("not-a-real-jwt");
    expect(payload).toBeNull();
  });
});
