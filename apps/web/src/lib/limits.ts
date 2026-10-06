/**
 * Phase 29 / A3: abuse and cost limits. Every value has a conservative
 * default and can be raised or lowered per deployment with a
 * CMA_LIMIT_* environment variable (see .env.example). Pure and
 * env-injectable so it is unit-testable; a missing, non-numeric or
 * non-positive value silently falls back to the default - a typo must
 * never turn a limit off.
 */
export interface Limits {
  /** Failed logins allowed per IP+email in the window. */
  loginAttempts: number;
  loginWindowMinutes: number;
  signupPerHour: number;
  manualScansPerHour: number;
  aiAnalysesPerDay: number;
  aiDigestsPerDay: number;
  aiTestPerHour: number;
  smtpTestPerHour: number;
  competitorsPerOrg: number;
  urlsPerOrg: number;
  /** Shortest allowed scan interval for a monitored URL. */
  minScanIntervalMinutes: number;
}

const DEFINITIONS: Record<keyof Limits, { env: string; fallback: number }> = {
  loginAttempts: { env: "CMA_LIMIT_LOGIN_ATTEMPTS", fallback: 10 },
  loginWindowMinutes: { env: "CMA_LIMIT_LOGIN_WINDOW_MIN", fallback: 15 },
  signupPerHour: { env: "CMA_LIMIT_SIGNUP_PER_HOUR", fallback: 5 },
  manualScansPerHour: { env: "CMA_LIMIT_MANUAL_SCANS_PER_HOUR", fallback: 20 },
  aiAnalysesPerDay: { env: "CMA_LIMIT_AI_ANALYSES_PER_DAY", fallback: 30 },
  aiDigestsPerDay: { env: "CMA_LIMIT_AI_DIGESTS_PER_DAY", fallback: 10 },
  aiTestPerHour: { env: "CMA_LIMIT_AI_TEST_PER_HOUR", fallback: 10 },
  smtpTestPerHour: { env: "CMA_LIMIT_SMTP_TEST_PER_HOUR", fallback: 10 },
  competitorsPerOrg: { env: "CMA_LIMIT_COMPETITORS_PER_ORG", fallback: 25 },
  urlsPerOrg: { env: "CMA_LIMIT_URLS_PER_ORG", fallback: 100 },
  minScanIntervalMinutes: { env: "CMA_LIMIT_MIN_SCAN_INTERVAL_MIN", fallback: 60 },
};

export function readLimits(env: Record<string, string | undefined> = process.env): Limits {
  const result = {} as Limits;
  for (const key of Object.keys(DEFINITIONS) as (keyof Limits)[]) {
    const { env: name, fallback } = DEFINITIONS[key];
    const parsed = Number(env[name]?.trim());
    result[key] = Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  }
  return result;
}
