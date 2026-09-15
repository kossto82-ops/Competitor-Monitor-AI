import { prisma } from "../client.js";
import { NotFoundError } from "./errors.js";

/**
 * The last snapshot whose extraction was actually verified - a
 * FAILED_TO_VERIFY row (403/timeout/empty response) is skipped, so a
 * transient failure can never silently become the new "previous state"
 * that the next successful scan is diffed against.
 */
export async function getLatestVerifiedSnapshot(monitoredUrlId: string) {
  return prisma.snapshot.findFirst({
    where: { monitoredUrlId, verificationState: { not: "FAILED_TO_VERIFY" } },
    orderBy: { fetchedAt: "desc" },
    include: { extractedEntities: true },
  });
}

export async function getSnapshotForOrg(organizationId: string, snapshotId: string) {
  const snapshot = await prisma.snapshot.findFirst({
    where: { id: snapshotId, organizationId },
    include: { extractedEntities: true },
  });
  if (!snapshot) throw new NotFoundError("Snapshot");
  return snapshot;
}
