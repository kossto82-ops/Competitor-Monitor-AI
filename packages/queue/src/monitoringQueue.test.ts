import { describe, expect, it } from "vitest";
import { monitoringJobId } from "./monitoringQueue.js";

describe("monitoringJobId", () => {
  it("is deterministic for the same monitored URL id", () => {
    expect(monitoringJobId("url-123")).toBe(monitoringJobId("url-123"));
  });

  it("differs across monitored URL ids", () => {
    expect(monitoringJobId("url-123")).not.toBe(monitoringJobId("url-456"));
  });
});
