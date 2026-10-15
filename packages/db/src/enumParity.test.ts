import { describe, expect, it } from "vitest";
import { ALERT_LEVELS, ALERT_STATUSES, CHANGE_TYPES, ENTITY_TYPES, EPISTEMIC_LEVELS, SIGNAL_KINDS, EXTRACTION_METHODS, JOB_STATUSES, PLANS, REPORT_STATUSES, SEVERITIES, VERIFICATION_STATES } from "@cma/core";
import { AlertLevel, AlertStatus, ChangeType, EntityType, EpistemicLevel, SignalKind, ExtractionMethod, JobStatus, Plan, ReportStatus, Severity, VerificationState } from "../generated/client/index.js";

/**
 * Phase 29 C5 (E37): `@cma/core` and the Prisma schema each declare these enums by hand. Nothing tied
 * them together, so adding a value to one and forgetting the other would compile and then fail at
 * runtime (a Postgres enum rejects an unknown value) or silently drop a case in a `switch`. This test
 * makes the drift a build failure instead.
 */
describe("core enums match the Prisma schema", () => {
  const same = (core: readonly string[], prisma: Record<string, string>) => expect([...core].sort()).toEqual(Object.values(prisma).sort());

  it("ChangeType", () => same(CHANGE_TYPES, ChangeType));
  it("Severity", () => same(SEVERITIES, Severity));
  it("EntityType", () => same(ENTITY_TYPES, EntityType));
  it("SignalKind", () => same(SIGNAL_KINDS, SignalKind));
  it("AlertLevel", () => same(ALERT_LEVELS, AlertLevel));
  it("AlertStatus", () => same(ALERT_STATUSES, AlertStatus));
  it("EpistemicLevel", () => same(EPISTEMIC_LEVELS, EpistemicLevel));
  it("ExtractionMethod", () => same(EXTRACTION_METHODS, ExtractionMethod));
  it("VerificationState", () => same(VERIFICATION_STATES, VerificationState));
  it("JobStatus", () => same(JOB_STATUSES, JobStatus));
  it("Plan", () => same(PLANS, Plan));
  it("ReportStatus", () => same(REPORT_STATUSES, ReportStatus));
});
