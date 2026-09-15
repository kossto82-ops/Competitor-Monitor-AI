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
