import { prisma } from "../client.js";
import { listChangeEventsForOrg } from "./changeEvents.js";

/**
 * The one aggregate query the dashboard home page needs. Kept as a
 * single function (rather than composed ad-hoc in the route handler)
 * so the set of counts/recent-activity shown is defined in one place.
 */
export async function getDashboardSummaryForOrg(organizationId: string) {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const since7d = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const [totalCompetitors, totalMonitoredUrls, scansLast24h, changesLast7d, recentChangeEvents, recentJobs] =
    await Promise.all([
      prisma.competitor.count({ where: { organizationId } }),
      prisma.monitoredUrl.count({ where: { organizationId } }),
      prisma.monitoringJob.count({ where: { organizationId, createdAt: { gte: since24h } } }),
      prisma.changeEvent.count({ where: { organizationId, detectedAt: { gte: since7d } } }),
      listChangeEventsForOrg(organizationId, { limit: 5 }),
      prisma.monitoringJob.findMany({
        where: { organizationId },
        orderBy: { createdAt: "desc" },
        take: 10,
        include: { monitoredUrl: { select: { url: true, label: true, competitorId: true } } },
      }),
    ]);

  return {
    totalCompetitors,
    totalMonitoredUrls,
    scansLast24h,
    changesLast7d,
    recentChangeEvents,
    recentJobs,
  };
}
