import type { Job, Queue } from "bullmq";

/**
 * Enqueues `data` under `jobId`, first removing a previous job with that
 * same id if (and only if) it already reached a terminal state.
 *
 * Why this exists: the AI queues (ai-analysis-jobs,
 * digest-interpretation-jobs) key each job on its row's own, permanent
 * id so that a double-click while a job is waiting/active collapses into
 * one job. But BullMQ keeps completed (7d) and failed (30d) jobs, and
 * `queue.add` with an id that still exists is silently a no-op - so a
 * digest "Refresh", or a retry after a FAILED analysis, left the row
 * PENDING with no job behind it and the UI polled forever. This is the
 * same failure monitoringQueue.ts's monitoringJobId documents; here the
 * id must stay stable (exact dedup of in-flight jobs), so the stale
 * terminal job is removed instead of bucketing the id.
 *
 * Waiting, delayed and active jobs are never removed: their dedup is
 * exactly what protects against a second paid provider call.
 */
export async function addJobReplacingTerminal<DataType>(
  queue: Queue<DataType>,
  name: string,
  data: DataType,
  jobId: string,
): Promise<Job<DataType>> {
  const existing = await queue.getJob(jobId);
  if (existing) {
    const state = await existing.getState();
    if (state === "completed" || state === "failed") {
      await existing.remove();
    }
  }
  // BullMQ's ExtractNameType conditional type cannot be satisfied by a
  // plain string for a generic DataType; every queue here uses string names.
  return (queue as unknown as Queue).add(name, data, { jobId }) as Promise<Job<DataType>>;
}
