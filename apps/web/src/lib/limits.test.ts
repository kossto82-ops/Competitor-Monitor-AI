import { describe, expect, it } from "vitest";
import { readLimits } from "./limits";

describe("readLimits", () => {
  it("uses the documented defaults when nothing is set", () => {
    expect(readLimits({})).toEqual({
      loginAttempts: 10,
      loginWindowMinutes: 15,
      signupPerHour: 5,
      manualScansPerHour: 20,
      aiAnalysesPerDay: 30,
      aiDigestsPerDay: 10,
      aiTestPerHour: 10,
      smtpTestPerHour: 10,
      competitorsPerOrg: 25,
      urlsPerOrg: 100,
      minScanIntervalMinutes: 60,
    });
  });

  it("lets every limit be overridden by its CMA_LIMIT_* variable", () => {
    const limits = readLimits({
      CMA_LIMIT_LOGIN_ATTEMPTS: "3",
      CMA_LIMIT_SIGNUP_PER_HOUR: "1000",
      CMA_LIMIT_AI_DIGESTS_PER_DAY: " 2 ",
      CMA_LIMIT_URLS_PER_ORG: "7",
      CMA_LIMIT_MIN_SCAN_INTERVAL_MIN: "15",
    });
    expect(limits).toMatchObject({ loginAttempts: 3, signupPerHour: 1000, aiDigestsPerDay: 2, urlsPerOrg: 7, minScanIntervalMinutes: 15 });
  });

  it.each(["", "abc", "0", "-5", "1.5", "NaN", "Infinity"])("a bad value (%j) falls back to the default - a typo never disables a limit", (bad) => {
    expect(readLimits({ CMA_LIMIT_LOGIN_ATTEMPTS: bad, CMA_LIMIT_COMPETITORS_PER_ORG: bad }).loginAttempts).toBe(10);
    expect(readLimits({ CMA_LIMIT_COMPETITORS_PER_ORG: bad }).competitorsPerOrg).toBe(25);
  });
});
