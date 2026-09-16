import { describe, expect, it, vi } from "vitest";
import { ConsoleEmailProvider, createEmailProviderFromEnv } from "./emailProvider.js";

describe("ConsoleEmailProvider", () => {
  it("resolves successfully and logs the message", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const provider = new ConsoleEmailProvider();

    const result = await provider.send({ to: "owner@example.test", subject: "Subject", text: "text", html: "<p>html</p>" });

    expect(result.providerMessageId).toBeTruthy();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("owner@example.test"));
    logSpy.mockRestore();
  });
});

describe("createEmailProviderFromEnv", () => {
  it("returns the console provider (the only implemented provider in this phase)", () => {
    expect(createEmailProviderFromEnv().name).toBe("console");
  });
});
