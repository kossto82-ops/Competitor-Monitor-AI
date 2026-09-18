import { describeChangeEvent } from "@cma/core";
import type { BadgeTone } from "@/components/ui/Badge";

/**
 * Central place for turning backend enum values into UI labels/colors.
 * Kept separate from the components so the FAILED_TO_VERIFY-vs-NO_CHANGE
 * distinction the product brief requires (Section 6 of the Phase 2 spec)
 * is defined once, not re-invented per page.
 */

export function verificationStateDisplay(state: string): { label: string; tone: BadgeTone; description: string } {
  switch (state) {
    case "CHANGED":
      return { label: "Change detected", tone: "purple", description: "A meaningful difference was found and recorded as evidence below." };
    case "NO_CHANGE":
      return { label: "No changes detected", tone: "green", description: "The page was checked successfully and nothing meaningful changed." };
    case "FAILED_TO_VERIFY":
      return {
        label: "Could not verify this page",
        tone: "amber",
        description: "The fetch failed or returned unusable content. This is NOT the same as \"no changes\" - the system could not confirm the page's current state.",
      };
    default:
      return { label: state, tone: "gray", description: "" };
  }
}

export function aiAnalysisStatusDisplay(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "PENDING":
      return { label: "Queued", tone: "blue" };
    case "RUNNING":
      return { label: "Analysing…", tone: "blue" };
    case "COMPLETED":
      return { label: "Analysis ready", tone: "green" };
    case "FAILED":
      return { label: "Analysis unavailable", tone: "red" };
    default:
      return { label: status, tone: "gray" };
  }
}

export function aiConfidenceDisplay(confidence: string): { label: string; tone: BadgeTone } {
  switch (confidence) {
    case "high":
      return { label: "High confidence", tone: "green" };
    case "medium":
      return { label: "Medium confidence", tone: "amber" };
    case "low":
      return { label: "Low confidence", tone: "gray" };
    default:
      return { label: confidence, tone: "gray" };
  }
}

export function reportStatusDisplay(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "GENERATING":
      return { label: "Generating…", tone: "blue" };
    case "COMPLETED":
      return { label: "Ready", tone: "green" };
    case "FAILED":
      return { label: "Failed", tone: "red" };
    default:
      return { label: status, tone: "gray" };
  }
}

export function jobStatusDisplay(status: string): { label: string; tone: BadgeTone } {
  switch (status) {
    case "PENDING":
      return { label: "Queued", tone: "blue" };
    case "RUNNING":
      return { label: "Scanning…", tone: "blue" };
    case "COMPLETED":
      return { label: "Completed", tone: "green" };
    case "FAILED":
      return { label: "Failed", tone: "red" };
    default:
      return { label: status, tone: "gray" };
  }
}

export function changeTypeDisplay(changeType: string): { label: string; tone: BadgeTone } {
  switch (changeType) {
    case "PRICE_CHANGE":
      return { label: "Price change", tone: "purple" };
    case "PRODUCT_ADDED":
      return { label: "Product added", tone: "green" };
    case "PRODUCT_REMOVED":
      return { label: "Product removed", tone: "red" };
    case "PROMOTION_ADDED":
      return { label: "Promotion added", tone: "green" };
    case "PROMOTION_CHANGE":
      return { label: "Promotion changed", tone: "blue" };
    case "PROMOTION_REMOVED":
      return { label: "Promotion removed", tone: "red" };
    case "CONTENT_CHANGE":
      return { label: "Content change", tone: "gray" };
    default:
      return { label: changeType, tone: "gray" };
  }
}

export function severityDisplay(severity: string): { label: string; tone: BadgeTone } {
  switch (severity) {
    case "HIGH":
      return { label: "High", tone: "red" };
    case "MEDIUM":
      return { label: "Medium", tone: "amber" };
    case "LOW":
      return { label: "Low", tone: "gray" };
    default:
      return { label: severity, tone: "gray" };
  }
}

/**
 * One-line human summary for a change-feed row. Delegates to
 * `@cma/core`'s `describeChangeEvent` (Phase 4, Section 18/19) so the
 * dashboard, change detail page, report pages, and the report email all
 * describe the same deterministic fact with identical wording - never
 * two slightly different sentences about the same ChangeEvent.
 */
export const summarizeChangeEvent = describeChangeEvent;
