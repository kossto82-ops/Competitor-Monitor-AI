import { z } from "zod";

/**
 * A URL that may only ever be http(s). `z.string().url()` alone accepts any scheme that parses
 * (`javascript:`, `data:`, `ftp:`, `file:`), and some of these values are rendered back as links
 * or used as an outbound request target, so the scheme is restricted at the input boundary.
 */
export const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (value) => {
      try {
        const protocol = new URL(value).protocol;
        return protocol === "http:" || protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use http or https" },
  );

/**
 * Format-level validation only. This does NOT establish that a URL is
 * safe to fetch (private IPs, localhost, etc.) - that is the job of
 * packages/security, which runs at fetch time (including on every
 * redirect hop), not just at creation time. A URL can pass this schema
 * and still be rejected by the SSRF guard.
 */
export const monitoredUrlInputSchema = z.object({
  url: z
    .string()
    .url()
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: "URL must use http or https",
    }),
  label: z.string().min(1).max(200).optional(),
  category: z.enum(["PRODUCT_PAGE", "PRICING_PAGE", "GENERAL"]).default("GENERAL"),
});
export type MonitoredUrlInput = z.infer<typeof monitoredUrlInputSchema>;

export const competitorInputSchema = z.object({
  name: z.string().min(1).max(200),
  website: httpUrlSchema.optional(),
  notes: z.string().max(2000).optional(),
});
export type CompetitorInput = z.infer<typeof competitorInputSchema>;

/** Phase 5 (Section 3): editing an existing competitor. `isActive` is how deactivate/reactivate is expressed - never a destructive delete of history. */
export const updateCompetitorInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  website: httpUrlSchema.optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  isActive: z.boolean().optional(),
});
export type UpdateCompetitorInput = z.infer<typeof updateCompetitorInputSchema>;

/** Phase 5 (Section 4/5): editing an existing monitored URL. `scanFrequencyMinutes` is genuinely enforced by the scheduler (see apps/worker/src/enqueueAll.ts's due-only filtering), not a decorative setting. */
export const updateMonitoredUrlInputSchema = z.object({
  label: z.string().min(1).max(200).optional().nullable(),
  category: z.enum(["PRODUCT_PAGE", "PRICING_PAGE", "GENERAL"]).optional(),
  scanFrequencyMinutes: z.number().int().min(15).max(43200).optional(),
  isActive: z.boolean().optional(),
});
export type UpdateMonitoredUrlInput = z.infer<typeof updateMonitoredUrlInputSchema>;

/** Phase 5 (Section 18): email/report preferences. All optional/independently settable - no complex notification rules yet (deferred per Section 18). */
export const updateOrganizationSettingsInputSchema = z.object({
  timezone: z.string().min(1).max(100).optional(),
  dailyReportEnabled: z.boolean().optional(),
  /** Empty string clears the override, reverting to the OWNER's email. */
  reportRecipientEmail: z.union([z.string().email(), z.literal("")]).optional(),
});
export type UpdateOrganizationSettingsInput = z.infer<typeof updateOrganizationSettingsInputSchema>;

export const signupInputSchema = z.object({
  organizationName: z.string().min(1).max(200),
  email: z.string().email(),
  password: z.string().min(10).max(200),
});
export type SignupInput = z.infer<typeof signupInputSchema>;

export const loginInputSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});
export type LoginInput = z.infer<typeof loginInputSchema>;

/**
 * Phase 3.1: customer-selectable AI provider kinds. Deliberately
 * duplicated here (not imported from @cma/ai's SELECTABLE_AI_PROVIDER_KINDS)
 * to avoid a new cross-package dependency for two string literals -
 * @cma/core has none today. "fake" is never selectable - it exists only
 * for local development and automated tests.
 */
export const SELECTABLE_AI_CONNECTION_PROVIDERS = ["openai", "openai-compatible"] as const;

export const createAiConnectionInputSchema = z
  .object({
    provider: z.enum(SELECTABLE_AI_CONNECTION_PROVIDERS),
    model: z.string().min(1).max(200),
    baseUrl: httpUrlSchema.optional(),
    apiKey: z.string().min(1).max(2000),
    enabled: z.boolean().optional(),
  })
  .refine((value) => value.provider !== "openai-compatible" || !!value.baseUrl, {
    message: "baseUrl is required when provider is 'openai-compatible'",
    path: ["baseUrl"],
  });
export type CreateAiConnectionInput = z.infer<typeof createAiConnectionInputSchema>;

/** apiKey is optional on update - omitting it leaves the stored credential unchanged. */
export const updateAiConnectionInputSchema = z.object({
  provider: z.enum(SELECTABLE_AI_CONNECTION_PROVIDERS).optional(),
  model: z.string().min(1).max(200).optional(),
  baseUrl: httpUrlSchema.optional().nullable(),
  apiKey: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAiConnectionInput = z.infer<typeof updateAiConnectionInputSchema>;

/**
 * Phase 29 / A2b: an organization's own outgoing-email (SMTP) account.
 *
 * The host is customer-supplied, so the server will connect to an address
 * the customer chose. Two limits keep that from becoming a port scanner:
 * only the standard submission ports are accepted (the host itself is
 * SSRF-validated again, at connect time, in @cma/notifications), and only
 * encrypted transports exist - there is deliberately no "none" option, so
 * a password is never sent in clear text.
 */
export const SMTP_ALLOWED_PORTS = [25, 465, 587, 2525] as const;
export const SMTP_SECURITY_MODES = ["ssl", "starttls"] as const;

const smtpHostSchema = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[?[0-9A-Fa-f:.]+\]?$/, "host must be a hostname or IP address (no scheme or path)");

const smtpFromNameSchema = z
  .string()
  .trim()
  .max(100)
  .refine((v) => !/["\r\n<>]/.test(v), "name cannot contain quotes, angle brackets or line breaks");

export const upsertSmtpConnectionInputSchema = z
  .object({
    host: smtpHostSchema,
    port: z.number().int().refine((p): p is (typeof SMTP_ALLOWED_PORTS)[number] => (SMTP_ALLOWED_PORTS as readonly number[]).includes(p), {
      message: `port must be one of ${SMTP_ALLOWED_PORTS.join(", ")}`,
    }),
    security: z.enum(SMTP_SECURITY_MODES),
    username: z.string().trim().min(1).max(320).optional().nullable(),
    /** Omit to keep the stored password; send null to remove it; a string replaces it. */
    password: z.string().min(1).max(1000).optional().nullable(),
    fromAddress: z.string().trim().email().max(320),
    fromName: smtpFromNameSchema.optional().nullable(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => !(v.password && !v.username), { message: "username is required when a password is set", path: ["username"] });
export type UpsertSmtpConnectionInput = z.infer<typeof upsertSmtpConnectionInputSchema>;
