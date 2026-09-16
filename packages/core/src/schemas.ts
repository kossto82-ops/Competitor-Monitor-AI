import { z } from "zod";

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
  website: z.string().url().optional(),
  notes: z.string().max(2000).optional(),
});
export type CompetitorInput = z.infer<typeof competitorInputSchema>;

/** Phase 5 (Section 3): editing an existing competitor. `isActive` is how deactivate/reactivate is expressed - never a destructive delete of history. */
export const updateCompetitorInputSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  website: z.string().url().optional().nullable(),
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
    baseUrl: z.string().url().optional(),
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
  baseUrl: z.string().url().optional().nullable(),
  apiKey: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
});
export type UpdateAiConnectionInput = z.infer<typeof updateAiConnectionInputSchema>;
