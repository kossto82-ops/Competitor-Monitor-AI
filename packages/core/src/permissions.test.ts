import { describe, expect, it } from "vitest";
import { can, permissionsOf, PERMISSIONS, USER_ROLES, whoCan } from "./permissions.js";

describe("permissions (Phase 29 D5d, E33)", () => {
  it("lets only owners and admins hold credentials and change settings or rules", () => {
    for (const permission of ["manage_ai_credentials", "manage_smtp", "manage_org_settings", "manage_alert_rules"] as const) {
      expect(can("OWNER", permission)).toBe(true);
      expect(can("ADMIN", permission)).toBe(true);
      expect(can("MEMBER", permission)).toBe(false);
    }
  });

  it("keeps the membership with the owner alone", () => {
    expect(can("OWNER", "manage_members")).toBe(true);
    expect(can("ADMIN", "manage_members")).toBe(false);
    expect(can("MEMBER", "manage_members")).toBe(false);
  });

  it("leaves the daily work to every role, and spending the organization's quota is not holding a credential", () => {
    for (const role of USER_ROLES) {
      for (const permission of ["manage_competitors", "run_scans_and_ai", "handle_alerts"] as const) expect(can(role, permission)).toBe(true);
    }
    expect(can("MEMBER", "run_scans_and_ai")).toBe(true);
    expect(can("MEMBER", "manage_ai_credentials")).toBe(false);
  });

  it("denies an unknown, missing or misspelled role everything", () => {
    for (const role of [undefined, null, "", "owner", "SUPERUSER", "VIEWER"]) {
      for (const permission of PERMISSIONS) expect(can(role, permission)).toBe(false);
    }
  });

  it("lists what each role holds, from the most to the least trusted", () => {
    expect(permissionsOf("OWNER")).toEqual([...PERMISSIONS]);
    expect(permissionsOf("ADMIN")).not.toContain("manage_members");
    expect(permissionsOf("MEMBER")).toEqual(["manage_competitors", "run_scans_and_ai", "handle_alerts"]);
    expect(permissionsOf(undefined)).toEqual([]);
  });

  it("says who can do a thing, in words", () => {
    expect(whoCan("manage_members")).toBe("the owner");
    expect(whoCan("manage_smtp")).toBe("an owner or an admin");
    expect(whoCan("manage_competitors")).toBe("any member");
  });
});
