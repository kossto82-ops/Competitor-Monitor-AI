/**
 * Phase 29 / A4: refuse to start with a configuration that looks secure
 * but is not. A copied `.env.example` placeholder, a short or repetitive
 * string, or the same value reused for two different secrets all pass a
 * "non-empty" test and leave the system effectively unprotected.
 *
 * Pure functions over an env object, so they are unit-testable; the
 * apps call `assertStartupConfig` once at boot.
 */
export class InsecureConfigurationError extends Error {
  constructor(readonly problems: string[]) {
    super(`Insecure or invalid configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "InsecureConfigurationError";
  }
}

export const MIN_SECRET_LENGTH = 32;
const MIN_DISTINCT_CHARACTERS = 10;

/** Text that only ever appears in a template someone forgot to fill in. */
const PLACEHOLDER_PATTERN = /replace[-_ ]?with|change[-_ ]?me|your[-_ ](?:secret|key|password)|placeholder|<[^>]*>|xxxx|^(.)\1+$/i;

/** Returns why `value` is not an acceptable secret, or null when it is fine. */
export function describeSecretProblem(name: string, value: string | undefined): string | null {
  if (value === undefined || value === "") return `${name} is not set.`;
  if (PLACEHOLDER_PATTERN.test(value)) {
    return `${name} still has a placeholder value. Generate a random one, e.g. \`openssl rand -hex 32\`.`;
  }
  if (value.length < MIN_SECRET_LENGTH) {
    return `${name} must be at least ${MIN_SECRET_LENGTH} characters long (it has ${value.length}). Generate one with \`openssl rand -hex 32\`.`;
  }
  if (new Set(value).size < MIN_DISTINCT_CHARACTERS) {
    return `${name} is too repetitive to be random (fewer than ${MIN_DISTINCT_CHARACTERS} distinct characters).`;
  }
  return null;
}

const DEFAULT_DB_PASSWORDS = new Set(["", "postgres", "password", "admin", "root", "changeme", "secret"]);

function databasePassword(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return null;
  }
}

export interface StartupCheckResult {
  /** The process must not start. */
  errors: string[];
  /** The process can start, but an operator should read this. */
  warnings: string[];
}

export interface StartupCheckOptions {
  /** AUTH_SECRET signs session cookies; only the web app needs it. */
  needsAuthSecret: boolean;
}

export function checkStartupConfig(env: Record<string, string | undefined>, options: StartupCheckOptions): StartupCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = env["NODE_ENV"] === "production";

  if (options.needsAuthSecret) {
    const problem = describeSecretProblem("AUTH_SECRET", env["AUTH_SECRET"]);
    if (problem) errors.push(problem);
  }

  const encryptionKey = env["CMA_AI_ENCRYPTION_KEY"];
  if (encryptionKey === undefined || encryptionKey === "") {
    // Customers' AI and SMTP credentials cannot be stored or used without it.
    const message = "CMA_AI_ENCRYPTION_KEY is not set: AI provider keys and SMTP passwords cannot be stored or used.";
    if (production) errors.push(message);
    else warnings.push(message);
  } else {
    const problem = describeSecretProblem("CMA_AI_ENCRYPTION_KEY", encryptionKey);
    if (problem) errors.push(problem);
  }

  if (options.needsAuthSecret && env["AUTH_SECRET"] && encryptionKey && env["AUTH_SECRET"] === encryptionKey) {
    errors.push("AUTH_SECRET and CMA_AI_ENCRYPTION_KEY must be different values: leaking one must not expose the other's protection.");
  }

  if (production) {
    const dbPassword = databasePassword(env["DATABASE_URL"]);
    if (dbPassword !== null && DEFAULT_DB_PASSWORDS.has(dbPassword.toLowerCase())) {
      errors.push("DATABASE_URL uses a default or empty database password. Set a strong one (POSTGRES_PASSWORD).");
    }
    const redisUrl = env["REDIS_URL"];
    if (redisUrl) {
      try {
        const parsed = new URL(redisUrl);
        const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(parsed.hostname);
        if (!parsed.password && !local) {
          warnings.push("REDIS_URL has no password and Redis is not on localhost. Anyone who can reach it can inject jobs; set REDIS_PASSWORD.");
        }
      } catch {
        errors.push("REDIS_URL is not a valid URL.");
      }
    }
  }

  if (env["CMA_ALLOW_PRIVATE_TARGETS"] === "true") {
    const mode = env["NODE_ENV"];
    if (production) {
      warnings.push("CMA_ALLOW_PRIVATE_TARGETS=true is set but ignored because NODE_ENV=production. Remove it from the production environment.");
    } else if (mode !== "development" && mode !== "test") {
      warnings.push(
        "CMA_ALLOW_PRIVATE_TARGETS=true is ACTIVE and NODE_ENV is not 'production': this process can fetch localhost and private networks. " +
          "Never run a deployment like this; set NODE_ENV=production.",
      );
    }
  }

  return { errors, warnings };
}

/** Logs warnings, and throws InsecureConfigurationError listing every error at once. */
export function assertStartupConfig(
  env: Record<string, string | undefined>,
  options: StartupCheckOptions,
  log: (message: string) => void = (message) => console.warn(message),
): void {
  const { errors, warnings } = checkStartupConfig(env, options);
  for (const warning of warnings) log(`[config] WARNING: ${warning}`);
  if (errors.length > 0) throw new InsecureConfigurationError(errors);
}
