import { afterEach, describe, expect, it } from "vitest";
import { privateTargetsAllowedForTesting, resolveAndValidateHost } from "./resolveHost.js";

const ORIGINAL_NODE_ENV = process.env["NODE_ENV"];
const ORIGINAL_FLAG = process.env["CMA_ALLOW_PRIVATE_TARGETS"];

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env["NODE_ENV"];
  else process.env["NODE_ENV"] = ORIGINAL_NODE_ENV;
  if (ORIGINAL_FLAG === undefined) delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
  else process.env["CMA_ALLOW_PRIVATE_TARGETS"] = ORIGINAL_FLAG;
});

describe("privateTargetsAllowedForTesting - double gate", () => {
  it("is false when neither env var is set", () => {
    delete process.env["NODE_ENV"];
    delete process.env["CMA_ALLOW_PRIVATE_TARGETS"];
    expect(privateTargetsAllowedForTesting()).toBe(false);
  });

  it("is false when only the opt-in flag is set (NODE_ENV defaults to production-like/unset is fine, but explicit production must still win)", () => {
    process.env["NODE_ENV"] = "production";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
    expect(privateTargetsAllowedForTesting()).toBe(false);
  });

  it("is false when NODE_ENV is non-production but the opt-in flag is not exactly 'true'", () => {
    process.env["NODE_ENV"] = "development";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "1";
    expect(privateTargetsAllowedForTesting()).toBe(false);
  });

  it("is true only when NODE_ENV is non-production AND the flag is exactly 'true'", () => {
    process.env["NODE_ENV"] = "development";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
    expect(privateTargetsAllowedForTesting()).toBe(true);
  });

  it("production ALWAYS blocks loopback even with the flag set - the critical safety property", async () => {
    process.env["NODE_ENV"] = "production";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
    await expect(resolveAndValidateHost("127.0.0.1")).rejects.toThrow();
    await expect(resolveAndValidateHost("localhost")).rejects.toThrow();
  });

  it("with the gate open, a loopback literal is allowed through", async () => {
    process.env["NODE_ENV"] = "development";
    process.env["CMA_ALLOW_PRIVATE_TARGETS"] = "true";
    await expect(resolveAndValidateHost("127.0.0.1")).resolves.toBe("127.0.0.1");
  });
});
