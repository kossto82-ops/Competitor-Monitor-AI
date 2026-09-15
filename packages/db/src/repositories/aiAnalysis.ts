import { Prisma } from "../../generated/client/index.js";
import { prisma } from "../client.js";

function isUniqueConstraintViolation(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

/**
 * Section 10 (idempotency): findFirst-then-create has a race window
 * under concurrent triggers of the same ChangeEvent (two near-
 * simultaneous "Analyze" clicks, or a duplicate API request retry).
 * The `changeEventId @unique` constraint on AiAnalysis is the actual
 * safety net - if two callers race past the findFirst check, only one
 * `create` wins and the other's unique-violation is caught here and
 * turned into a normal "return the existing row" outcome instead of a
 * 500. Callers should never see AiAnalysis creation fail with a raw
 * Prisma error because two requests happened to overlap.
 */
export async function getOrCreatePendingAiAnalysis(organizationId: string, changeEventId: string, promptVersion: string) {
  const existing = await prisma.aiAnalysis.findFirst({ where: { organizationId, changeEventId } });
  if (existing) return existing;

  try {
    return await prisma.aiAnalysis.create({
      data: { organizationId, changeEventId, promptVersion, status: "PENDING" },
    });
  } catch (err) {
    if (isUniqueConstraintViolation(err)) {
      const racedRow = await prisma.aiAnalysis.findFirst({ where: { organizationId, changeEventId } });
      if (racedRow) return racedRow;
    }
    throw err;
  }
}

export async function getAiAnalysisForChangeEvent(organizationId: string, changeEventId: string) {
  return prisma.aiAnalysis.findFirst({ where: { organizationId, changeEventId } });
}

/**
 * Only transitions out of PENDING - a duplicate BullMQ delivery that
 * lands after the first delivery already moved the row to RUNNING (or
 * beyond) is a no-op here rather than resetting `startedAt`.
 */
export async function markAiAnalysisRunning(id: string) {
  await prisma.aiAnalysis.updateMany({
    where: { id, status: "PENDING" },
    data: { status: "RUNNING", startedAt: new Date() },
  });
  return prisma.aiAnalysis.findUniqueOrThrow({ where: { id } });
}

export interface CompleteAiAnalysisInput {
  provider: string;
  model: string;
  summary: string;
  facts: string[];
  interpretations: string[];
  speculation: string[];
  confidence: string;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
  durationMs: number;
}

/**
 * Only transitions rows still in PENDING/RUNNING to COMPLETED - a
 * second attempt at completing an already-COMPLETED row (duplicate
 * delivery racing behind a first successful run) is a no-op, so it can
 * never overwrite a completed analysis with a second, possibly
 * different, paid-for result.
 */
export async function markAiAnalysisCompleted(id: string, input: CompleteAiAnalysisInput) {
  await prisma.aiAnalysis.updateMany({
    where: { id, status: { in: ["PENDING", "RUNNING"] } },
    data: {
      status: "COMPLETED",
      provider: input.provider,
      model: input.model,
      summary: input.summary,
      facts: input.facts,
      interpretations: input.interpretations,
      speculation: input.speculation,
      confidence: input.confidence,
      inputTokens: input.inputTokens ?? null,
      outputTokens: input.outputTokens ?? null,
      costUsd: input.costUsd ?? null,
      durationMs: input.durationMs,
      completedAt: new Date(),
    },
  });
  return prisma.aiAnalysis.findUniqueOrThrow({ where: { id } });
}

/**
 * Same non-overwrite guarantee as markAiAnalysisCompleted: never
 * downgrades an already-COMPLETED row to FAILED just because a
 * duplicate/late delivery of the same job also ran and failed.
 */
export async function markAiAnalysisFailed(id: string, errorMessage: string) {
  await prisma.aiAnalysis.updateMany({
    where: { id, status: { in: ["PENDING", "RUNNING"] } },
    data: { status: "FAILED", errorMessage, completedAt: new Date() },
  });
  return prisma.aiAnalysis.findUniqueOrThrow({ where: { id } });
}
