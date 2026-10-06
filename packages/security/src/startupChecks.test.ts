import { describe, expect, it, vi } from "vitest";
import { InsecureConfigurationError, assertStartupConfig, checkStartupConfig, describeSecretProblem } from "./startupChecks.js";

const STRONG_A = "9f3c1d7a5b2e48c6a0d1f7e3b9c24a68d5e0f1a2b3c4d5e6f708192a3b4c5d6e";
const STRONG_B = "0a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f9";
const WEB = { needsAuthSecret: true };
const WORKER = { needsAuthSecret: false };

describe("describeSecretProblem", () => {
  it("accepts a random 64-char hex secret", () => {
    expect(describeSecretProblem("S", STRONG_A)).toBeNull();
  });

  it.each([
    [undefined, "not set"],
    ["", "not set"],
    ["replace-with-a-random-64-char-hex-string", "placeholder"],
    ["REPLACE_WITH_SOMETHING_LONG_ENOUGH_TO_PASS_LENGTH", "placeholder"],
    ["changeme-changeme-changeme-changeme-changeme", "placeholder"],
    ["your-secret-goes-here-and-it-is-long-enough", "placeholder"],
    ["<paste-a-secret-here-it-is-long-enough-ok>", "placeholder"],
    ["a".repeat(64), "placeholder"],
    ["short-secret", "at least 32"],
    ["abababababababababababababababababababab", "repetitive"],
  ])("rejects %j", (value, expected) => {
    expect(describeSecretProblem("MY_SECRET", value)).toContain(expected);
  });

  it("names the variable so the operator knows what to fix", () => {
    expect(describeSecretProblem("AUTH_SECRET", "x")).toContain("AUTH_SECRET");
  });
});

describe("checkStartupConfig", () => {
  const good = { AUTH_SECRET: STRONG_A, CMA_AI_ENCRYPTION_KEY: STRONG_B };

  it("passes a proper web configuration with no errors or warnings", () => {
    expect(checkStartupConfig(good, WEB)).toEqual({ errors: [], warnings: [] });
  });

  it("reports EVERY problem at once, not just the first", () => {
    const { errors } = checkStartupConfig({ AUTH_SECRET: "replace-with-a-random-64-char-hex-string", CMA_AI_ENCRYPTION_KEY: "short" }, WEB);
    expect(errors).toHaveLength(2);
    expect(errors.join("\n")).toContain("AUTH_SECRET");
    expect(errors.join("\n")).toContain("CMA_AI_ENCRYPTION_KEY");
  });

  it("the worker does not need AUTH_SECRET", () => {
    expect(checkStartupConfig({ CMA_AI_ENCRYPTION_KEY: STRONG_B }, WORKER).errors).toEqual([]);
  });

  it("the web app requires AUTH_SECRET", () => {
    expect(checkStartupConfig({ CMA_AI_ENCRYPTION_KEY: STRONG_B }, WEB).errors.join()).toContain("AUTH_SECRET is not set");
  });

  it("refuses the same value used for both secrets", () => {
    const { errors } = checkStartupConfig({ AUTH_SECRET: STRONG_A, CMA_AI_ENCRYPTION_KEY: STRONG_A }, WEB);
    expect(errors.join()).toContain("must be different");
  });

  it("a missing encryption key is a warning in development but an error in production", () => {
    const dev = checkStartupConfig({ AUTH_SECRET: STRONG_A }, WEB);
    expect(dev.errors).toEqual([]);
    expect(dev.warnings.join()).toContain("CMA_AI_ENCRYPTION_KEY is not set");

    const prod = checkStartupConfig({ AUTH_SECRET: STRONG_A, NODE_ENV: "production" }, WEB);
    expect(prod.errors.join()).toContain("CMA_AI_ENCRYPTION_KEY is not set");
  });

  describe("production-only checks", () => {
    const prod = { ...good, NODE_ENV: "production" };

    it.each(["postgres", "password", "admin", "changeme", ""])("rejects a default database password (%j)", (password) => {
      const url = `postgresql://cma:${password}@db.internal:5432/app`;
      expect(checkStartupConfig({ ...prod, DATABASE_URL: url }, WEB).errors.join()).toContain("default or empty database password");
    });

    it("accepts a real database password, and does not apply the rule outside production", () => {
      expect(checkStartupConfig({ ...prod, DATABASE_URL: "postgresql://cma:Zr8!k2Qw9@db.internal:5432/app" }, WEB).errors).toEqual([]);
      expect(checkStartupConfig({ ...good, DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app" }, WEB).errors).toEqual([]);
    });

    it("warns about a remote Redis without a password, but not a local one or one with a password", () => {
      expect(checkStartupConfig({ ...prod, REDIS_URL: "redis://cache.internal:6379" }, WEB).warnings.join()).toContain("no password");
      expect(checkStartupConfig({ ...prod, REDIS_URL: "redis://localhost:6379" }, WEB).warnings).toEqual([]);
      expect(checkStartupConfig({ ...prod, REDIS_URL: "redis://:s3cr3tpw@cache.internal:6379" }, WEB).warnings).toEqual([]);
    });
  });

  describe("CMA_ALLOW_PRIVATE_TARGETS", () => {
    it("warns loudly when active outside production with an unrecognised NODE_ENV", () => {
      const { warnings } = checkStartupConfig({ ...good, CMA_ALLOW_PRIVATE_TARGETS: "true" }, WORKER);
      expect(warnings.join()).toContain("ACTIVE");
    });

    it("is quiet in development/test, and tells the operator it is ignored in production", () => {
      expect(checkStartupConfig({ ...good, CMA_ALLOW_PRIVATE_TARGETS: "true", NODE_ENV: "development" }, WORKER).warnings).toEqual([]);
      expect(checkStartupConfig({ ...good, CMA_ALLOW_PRIVATE_TARGETS: "true", NODE_ENV: "production" }, WORKER).warnings.join()).toContain("ignored");
    });
  });
});

describe("assertStartupConfig", () => {
  it("throws one error listing every problem", () => {
    expect(() => assertStartupConfig({ AUTH_SECRET: "x", CMA_AI_ENCRYPTION_KEY: "y" }, WEB, () => undefined)).toThrow(InsecureConfigurationError);
    try {
      assertStartupConfig({ AUTH_SECRET: "x", CMA_AI_ENCRYPTION_KEY: "y" }, WEB, () => undefined);
    } catch (err) {
      expect((err as InsecureConfigurationError).problems).toHaveLength(2);
      expect((err as Error).message).toContain("AUTH_SECRET");
    }
  });

  it("logs warnings through the injected logger and does not throw", () => {
    const log = vi.fn();
    assertStartupConfig({ AUTH_SECRET: STRONG_A }, WEB, log);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("WARNING"));
  });
});
