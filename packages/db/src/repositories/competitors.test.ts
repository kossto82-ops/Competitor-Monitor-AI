import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../client.js";
import { createOrganizationWithOwner } from "./organizations.js";
import { createMonitoredUrl } from "./monitoredUrls.js";
import { ConflictError, NotFoundError } from "./errors.js";
import { createCompetitor, deleteCompetitorIfSafe, getCompetitorForOrg, updateCompetitor } from "./competitors.js";

async function databaseIsReachable(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}

const reachable = await databaseIsReachable();
const createdOrgIds: string[] = [];

describe.skipIf(!reachable)("competitors repository (Phase 5)", () => {
  const runId = Date.now();
  let counter = 0;

  async function makeOrg(label: string) {
    counter += 1;
    const { organization } = await createOrganizationWithOwner({
      organizationName: `Competitor CRUD ${label} ${runId}-${counter}`,
      email: `competitor-crud-${label.toLowerCase()}-${runId}-${counter}@example.test`,
      passwordHash: "not-a-real-hash",
    });
    createdOrgIds.push(organization.id);
    return organization;
  }

  afterAll(async () => {
    for (const id of createdOrgIds) {
      await prisma.organization.delete({ where: { id } }).catch(() => undefined);
    }
  });

  it("updates name/website/notes", async () => {
    const org = await makeOrg("update");
    const competitor = await createCompetitor(org.id, { name: "Old Name" });

    const updated = await updateCompetitor(org.id, competitor.id, { name: "New Name", website: "https://new.example.test", notes: "updated notes" });
    expect(updated.name).toBe("New Name");
    expect(updated.website).toBe("https://new.example.test");
    expect(updated.notes).toBe("updated notes");
  });

  it("deactivates and reactivates a competitor without touching its monitored URLs", async () => {
    const org = await makeOrg("deactivate");
    const competitor = await createCompetitor(org.id, { name: "Deactivate Me" });
    await createMonitoredUrl(org.id, competitor.id, { url: "https://deactivate.example.test/pricing", category: "PRICING_PAGE" });

    const deactivated = await updateCompetitor(org.id, competitor.id, { isActive: false });
    expect(deactivated.isActive).toBe(false);
    expect(await prisma.monitoredUrl.count({ where: { competitorId: competitor.id } })).toBe(1);

    const reactivated = await updateCompetitor(org.id, competitor.id, { isActive: true });
    expect(reactivated.isActive).toBe(true);
  });

  it("tenant isolation: organization B cannot update organization A's competitor", async () => {
    const a = await makeOrg("update-tenant-a");
    const b = await makeOrg("update-tenant-b");
    const competitor = await createCompetitor(a.id, { name: "A's competitor" });

    await expect(updateCompetitor(b.id, competitor.id, { name: "hacked" })).rejects.toThrow(NotFoundError);
    const stillA = await getCompetitorForOrg(a.id, competitor.id);
    expect(stillA.name).toBe("A's competitor");
  });

  it("deletes a competitor with zero monitored URLs", async () => {
    const org = await makeOrg("delete-safe");
    const competitor = await createCompetitor(org.id, { name: "No URLs" });

    await deleteCompetitorIfSafe(org.id, competitor.id);
    await expect(getCompetitorForOrg(org.id, competitor.id)).rejects.toThrow(NotFoundError);
  });

  it("refuses to delete a competitor with monitored URLs - ConflictError, not a silent cascade", async () => {
    const org = await makeOrg("delete-unsafe");
    const competitor = await createCompetitor(org.id, { name: "Has URLs" });
    await createMonitoredUrl(org.id, competitor.id, { url: "https://has-urls.example.test/pricing", category: "PRICING_PAGE" });

    await expect(deleteCompetitorIfSafe(org.id, competitor.id)).rejects.toThrow(ConflictError);
    // Unaffected - still exists.
    await expect(getCompetitorForOrg(org.id, competitor.id)).resolves.toMatchObject({ id: competitor.id });
  });

  it("tenant isolation: organization B cannot delete organization A's competitor", async () => {
    const a = await makeOrg("delete-tenant-a");
    const b = await makeOrg("delete-tenant-b");
    const competitor = await createCompetitor(a.id, { name: "A's competitor" });

    await expect(deleteCompetitorIfSafe(b.id, competitor.id)).rejects.toThrow(NotFoundError);
    await expect(getCompetitorForOrg(a.id, competitor.id)).resolves.toMatchObject({ id: competitor.id });
  });
});
