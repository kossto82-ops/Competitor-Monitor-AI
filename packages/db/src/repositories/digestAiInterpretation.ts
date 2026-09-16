import { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

/**
 * Phase 11 (Tier 4 - Evidence-Grounded AI Interpretation): pure CRUD for
 * the DigestAiInterpretation cache-slot table (schema.prisma's doc
 * comment on that model has the full rationale for why this is NOT
 * modeled like AiAnalysis's `changeEventId @unique`). Mirrors
 * aiAnalysis.ts's shape deliberately - this file has NO dependency on
 * @cma/ai and makes NO provider call; the actual AI orchestration lives
 * in apps/worker/src/digestInterpretationPipeline.ts, exactly like
 * aiPipeline.ts is where AiAnalysis rows are actually resolved to a
 * provider and completed.
 */

export async function getDigestAiInterpretationForOrg(organizationId: string, days: number) {
  return prisma.digestAiInterpretation.findFirst({ where: { organizationId, days } });
}

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Idempotent "get-or-create-or-reset" slot resolution (Section 10-style
 * idempotency, adapted for a moving-window target):
 *
 * - No row yet for (organizationId, days) -> create one, PENDING.
 * - Row exists and is PENDING or RUNNING -> return it UNCHANGED (an
 *   in-flight interpretation is never reset/duplicated by a second
 *   near-simultaneous request - the caller's queue-enqueue step is what
 *   decides whether to actually start a job, based on this returned
 *   status).
 * - Row exists and is COMPLETED or FAILED -> this IS the "user explicitly
 *   asked to (re-)interpret the digest" trigger path (unlike AiAnalysis,
 *   a completed Digest interpretation is expected to go stale as new
 *   ChangeEvents accumulate) - reset it back to PENDING, clearing every
 *   terminal field, so the caller enqueues exactly one fresh job.
 *
 * The `@@unique([organizationId, days])` constraint is the actual race
 * safety net, same pattern as getOrCreatePendingAiAnalysis: two
 * near-simultaneous first-time requests can both pass the initial
 * findFirst check, but only one `create` wins - the loser's unique-
 * violation is caught and re-read here instead of surfacing as a raw
 * Prisma error.
 */
export async function getOrCreateDigestAiInterpretationSlot(organizationId: string, days: number, promptVersion: string) {
  const existing = await prisma.digestAiInterpretation.findUnique({ where: { organizationId_days: { organizationId, days } } });

  if (!existing) {
    try {
      return await prisma.digestAiInterpretation.create({
        data: { organizationId, days, promptVersion, status: "PENDING" },
      });
    } catch (err) {
      if (isUniqueConstraintViolation(err)) {
        const racedRow = await prisma.digestAiInterpretation.findUnique({ where: { organizationId_days: { organizationId, days } } });
        if (racedRow) return racedRow;
      }
      throw err;
    }
  }

  if (existing.status === "PENDING" || existing.status === "RUNNING") return existing;

  // existing.status is COMPLETED or FAILED: reset to PENDING for a fresh,
  // explicitly user-triggered interpretation over the (now more recent)
  // digest window. Only transitions rows still in a terminal state - a
  // duplicate call racing behind another reset is a no-op here.
  await prisma.digestAiInterpretation.updateMany({
    where: { id: existing.id, status: { in: ["COMPLETED", "FAILED"] } },
    data: {
      status: "PENDING",
      promptVersion,
      provider: null,
      model: null,
      windowStart: null,
      windowEnd: null,
      summary: null,
      observations: [],
      interpretations: [],
      hypotheses: [],
      inputTokens: null,
      outputTokens: null,
      costUsd: null,
      durationMs: null,
      providerMetadata: Prisma.JsonNull,
      errorMessage: null,
      startedAt: null,
      completedAt: null,
    },
  });
  return prisma.digestAiInterpretation.findUniqueOrThrow({ where: { id: existing.id } });
}

export async function getDigestAiInterpretationForOrgOrThrow(organizationId: string, id: string) {
  const row = await prisma.digestAiInterpretation.findFirst({ where: { id, organizationId } });
  if (!row) throw new NotFoundError("DigestAiInterpretation");
  return row;
}

/** Only transitions out of PENDING - a duplicate BullMQ delivery landing after the first already moved the row to RUNNING (or beyond) is a no-op, same guarantee as markAiAnalysisRunning. */
export async function markDigestAiInterpretationRunning(id: string) {
  await prisma.digestAiInterpretation.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return prisma.digestAiInterpretation.findUniqueOrThrow({ where: { id } });
}

export interface CompleteDigestAiInterpretationInput {
  provider: string;
  model: string;
  windowStart: Date;
  windowEnd: Date;
  summary: string;
  observations: unknown;
  interpretations: unknown;
  hypotheses: unknown;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
  providerMetadata?: Record<string, unknown>;
}

/** Only transitions rows still in PENDING/RUNNING to COMPLETED - never overwrites an already-COMPLETED row with a second, possibly different, paid-for result (same non-destructive guarantee as markAiAnalysisCompleted). */
export async function markDigestAiInterpretationCompleted(id: string, input: CompleteDigestAiInterpretationInput) {
  await prisma.digestAiInterpretation.updateMany({
    where: { id, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "COMPLETED",
      provider: input.provider,
      model: input.model,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      summary: input.summary,
      observations: input.observations as Prisma.InputJsonValue,
      interpretations: input.interpretations as Prisma.InputJsonValue,
      hypotheses: input.hypotheses as Prisma.InputJsonValue,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      durationMs: input.durationMs,
      providerMetadata: (input.providerMetadata as Prisma.InputJsonValue | undefined) ?? Prisma.JsonNull,
      completedAt: new Date(),
    },
  });
  return prisma.digestAiInterpretation.findUniqueOrThrow({ where: { id } });
}

/** Same non-overwrite guarantee as markAiAnalysisFailed. */
export async function markDigestAiInterpretationFailed(id: string, errorMessage: string) {
  await prisma.digestAiInterpretation.updateMany({
    where: { id, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "FAILED", errorMessage, completedAt: new Date() },
  });
  return prisma.digestAiInterpretation.findUniqueOrThrow({ where: { id } });
}
