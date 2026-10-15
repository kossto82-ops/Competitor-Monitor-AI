/**
 * Phase 29 D5d (E33): who may do what inside an organization. Until now every member could edit the AI
 * credentials, the mail account and every setting. The rules live here, in one table, so the API, the pages and
 * the tests all read the same answer.
 *
 * - OWNER  : everything, including who belongs to the organization.
 * - ADMIN  : everything about how the product is configured: AI credentials, the mail account, settings, alert
 *            and importance rules; but not the membership.
 * - MEMBER : the daily work: competitors and monitored pages, scans, AI analysis, alerts; no credentials, no
 *            settings, no rules.
 *
 * Reading is open to every role. An action that spends the organization's money (scans, AI analysis) needs the
 * daily-work permission, never a credential permission: using a key is not the same as holding it.
 */
export const USER_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type UserRoleName = (typeof USER_ROLES)[number];

export const PERMISSIONS = [
  "manage_ai_credentials",
  "manage_smtp",
  "manage_org_settings",
  "manage_alert_rules",
  "manage_members",
  "manage_competitors",
  "run_scans_and_ai",
  "handle_alerts",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL: readonly UserRoleName[] = ["OWNER", "ADMIN", "MEMBER"];
const ADMINS: readonly UserRoleName[] = ["OWNER", "ADMIN"];

const GRANTS: Record<Permission, readonly UserRoleName[]> = {
  manage_ai_credentials: ADMINS,
  manage_smtp: ADMINS,
  manage_org_settings: ADMINS,
  manage_alert_rules: ADMINS,
  manage_members: ["OWNER"],
  manage_competitors: ALL,
  run_scans_and_ai: ALL,
  handle_alerts: ALL,
};

export function can(role: string | null | undefined, permission: Permission): boolean {
  return GRANTS[permission].includes(role as UserRoleName);
}

/** The permissions a role holds, for showing what a person can and cannot do. */
export function permissionsOf(role: string | null | undefined): Permission[] {
  return PERMISSIONS.filter((p) => can(role, p));
}

/** What to tell somebody who cannot do a thing: who can, in plain words. */
export function whoCan(permission: Permission): string {
  const roles = GRANTS[permission];
  if (roles.length === 1) return "the owner";
  if (roles.length === 2) return "an owner or an admin";
  return "any member";
}
