import { describe, expect, it, vi } from "vitest";
import { AiProviderRequestError, createFakeAiProvider } from "@cma/ai";
import type { CapabilityAiPage } from "@cma/db";
import { runCapabilityAiJob, type CapabilityAiDeps } from "./capabilityAiPipeline.js";

const payload = { organizationId: "org-1", capabilityAiRunId: "run-1" };

function page(n: number, text = "Atendemos las llamadas durante todo el día y toda la noche, incluso en festivos."): CapabilityAiPage {
  return { monitoredUrlId: `url-${n}`, competitorId: "c-1", url: `https://rival.test/${n}`, snapshotId: `snap-${n}`, text, candidates: [{ key: "support_24_7", label: "Support or availability 24/7", description: null }] };
}

function setup(options: { pages?: CapabilityAiPage[]; remaining?: number; status?: string; provider?: ReturnType<typeof createFakeAiProvider>; resolveFails?: boolean } = {}) {
  const provider = options.provider ?? createFakeAiProvider({ respondCapabilities: () => JSON.stringify({ findings: [{ key: "support_24_7", quote: "durante todo el día y toda la noche", confidence: "high" }] }) });
  const calls = { running: 0, failed: [] as string[], completed: [] as unknown[], recorded: [] as unknown[] };
  const deps: CapabilityAiDeps = {
    resolveProvider: async () => {
      if (options.resolveFails) throw new Error("No AI provider is configured for organization org-1.");
      return { provider, config: { provider: "fake", model: "fake" } };
    },
    getRun: async () => ({ id: "run-1", status: options.status ?? "PENDING" }),
    markRunning: async () => {
      calls.running += 1;
    },
    markFailed: async (_id, message) => {
      calls.failed.push(message);
    },
    markCompleted: async (_id, input) => {
      calls.completed.push(input);
    },
    selectPages: async () => ({ pages: options.pages ?? [page(1)], remaining: options.remaining ?? 0 }),
    recordFindings: (async (input: { page: Pick<CapabilityAiPage, "monitoredUrlId">; accepted: unknown[] }) => {
      calls.recorded.push(input);
      return { stored: input.accepted.length };
    }) as unknown as CapabilityAiDeps["recordFindings"],
  };
  return { deps, calls, provider };
}

describe("runCapabilityAiJob (Phase 29 F3)", () => {
  it("reads each page once with the organization's provider and stores the findings that quote the page", async () => {
    const { deps, calls, provider } = setup({ pages: [page(1), page(2)], remaining: 3 });
    expect(await runCapabilityAiJob(payload, deps)).toEqual({ capabilityAiRunId: "run-1", status: "COMPLETED" });
    expect(provider.capabilityCallCount).toBe(2);
    expect(calls.recorded).toHaveLength(2);
    expect(calls.completed[0]).toMatchObject({ provider: "fake", pagesChecked: 2, findings: 2, rejectedCount: 0, failedPages: 0, pagesRemaining: 3, inputTokens: 600, outputTokens: 120 });
  });

  it("drops a finding whose quote is not on the page, and says so in the run", async () => {
    const provider = createFakeAiProvider({ respondCapabilities: () => JSON.stringify({ findings: [{ key: "support_24_7", quote: "disponibles las veinticuatro horas del día", confidence: "high" }] }) });
    const { deps, calls } = setup({ provider });
    await runCapabilityAiJob(payload, deps);
    expect(calls.completed[0]).toMatchObject({ findings: 0, rejectedCount: 1 });
    expect((calls.recorded[0] as { accepted: unknown[] }).accepted).toEqual([]); // the page is still marked as read
  });

  it("leaves a page whose answer was unusable unmarked so the next run reads it again, and finishes the others", async () => {
    let n = 0;
    const provider = createFakeAiProvider({ respondCapabilities: () => (++n === 1 ? "not json at all" : JSON.stringify({ findings: [] })) });
    const { deps, calls } = setup({ pages: [page(1), page(2)], provider });
    expect(await runCapabilityAiJob(payload, deps)).toMatchObject({ status: "COMPLETED" });
    expect(calls.recorded).toHaveLength(1);
    expect(calls.completed[0]).toMatchObject({ pagesChecked: 1, failedPages: 1 });
  });

  it("stops after the first page when the key itself is refused instead of paying for every page", async () => {
    const provider = createFakeAiProvider({ throwErrorCapabilities: () => new AiProviderRequestError("fake", "invalid api key", false) });
    const { deps, calls } = setup({ pages: [page(1), page(2), page(3)], provider });
    expect(await runCapabilityAiJob(payload, deps)).toMatchObject({ status: "FAILED" });
    expect(provider.capabilityCallCount).toBe(1);
    expect(calls.failed[0]).toContain("invalid api key");
  });

  it("fails cleanly, without a provider call, when no AI connection is configured", async () => {
    const { deps, calls, provider } = setup({ resolveFails: true });
    expect(await runCapabilityAiJob(payload, deps)).toMatchObject({ status: "FAILED" });
    expect(provider.capabilityCallCount).toBe(0);
    expect(calls.failed[0]).toContain("No AI provider");
  });

  it("never spends a second paid call on a run that already finished", async () => {
    const { deps, provider } = setup({ status: "COMPLETED" });
    const select = vi.spyOn(deps, "selectPages");
    expect(await runCapabilityAiJob(payload, deps)).toEqual({ capabilityAiRunId: "run-1", status: "COMPLETED" });
    expect(select).not.toHaveBeenCalled();
    expect(provider.capabilityCallCount).toBe(0);
  });

  it("completes without calling the model when there is nothing to read", async () => {
    const { deps, calls, provider } = setup({ pages: [] });
    expect(await runCapabilityAiJob(payload, deps)).toMatchObject({ status: "COMPLETED" });
    expect(provider.capabilityCallCount).toBe(0);
    expect(calls.completed[0]).toMatchObject({ pagesChecked: 0 });
  });
});
