import { describe, expect, it } from "vitest";
import { resolveAndValidateHost, SsrfBlockedError } from "./resolveHost.js";

function fakeResolver(map: Record<string, { address: string; family: number }[]>) {
  return async (hostname: string) => {
    const records = map[hostname];
    if (!records) throw new Error(`no fake DNS entry for ${hostname}`);
    return records;
  };
}

describe("resolveAndValidateHost", () => {
  it("rejects the literal hostname 'localhost' without doing DNS at all", async () => {
    await expect(resolveAndValidateHost("localhost", fakeResolver({}))).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects .local / .internal / .localdomain suffixes", async () => {
    await expect(resolveAndValidateHost("printer.local", fakeResolver({}))).rejects.toThrow(SsrfBlockedError);
    await expect(resolveAndValidateHost("service.internal", fakeResolver({}))).rejects.toThrow(SsrfBlockedError);
  });

  it("validates a literal public IP directly, skipping DNS", async () => {
    const result = await resolveAndValidateHost("93.184.216.34", fakeResolver({}));
    expect(result).toBe("93.184.216.34");
  });

  it("rejects a literal private/loopback IP directly, skipping DNS", async () => {
    await expect(resolveAndValidateHost("127.0.0.1", fakeResolver({}))).rejects.toThrow(SsrfBlockedError);
    await expect(resolveAndValidateHost("169.254.169.254", fakeResolver({}))).rejects.toThrow(SsrfBlockedError);
  });

  it("resolves a normal hostname to a public address and returns it", async () => {
    const resolve = fakeResolver({
      "good.example.com": [{ address: "93.184.216.34", family: 4 }],
    });
    const result = await resolveAndValidateHost("good.example.com", resolve);
    expect(result).toBe("93.184.216.34");
  });

  it("rejects a hostname when ANY resolved address is private (not just the first)", async () => {
    const resolve = fakeResolver({
      "rebinding.example.com": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.1", family: 4 },
      ],
    });
    await expect(resolveAndValidateHost("rebinding.example.com", resolve)).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a hostname that resolves to the cloud metadata address", async () => {
    const resolve = fakeResolver({
      "attacker.example.com": [{ address: "169.254.169.254", family: 4 }],
    });
    await expect(resolveAndValidateHost("attacker.example.com", resolve)).rejects.toThrow(SsrfBlockedError);
  });

  it("rejects a hostname that resolves to nothing", async () => {
    const resolve = fakeResolver({ "empty.example.com": [] });
    await expect(resolveAndValidateHost("empty.example.com", resolve)).rejects.toThrow(SsrfBlockedError);
  });
});
