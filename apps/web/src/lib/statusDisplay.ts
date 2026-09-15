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
    case "PROMOTION_CHANGE":
      return { label: "Promotion change", tone: "blue" };
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

/** One-line human summary for a change-feed row. */
export function summarizeChangeEvent(event: {
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
}): string {
  const { changeType, oldValue, newValue, currency, percentageChange } = event;
  const money = (v: string | null) => (v === null ? "—" : `${currency ?? ""}${v}`.trim());

  switch (changeType) {
    case "PRICE_CHANGE": {
      const pct = percentageChange !== null ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange}%)` : "";
      return `Price changed from ${money(oldValue)} to ${money(newValue)}${pct}`;
    }
    case "PRODUCT_ADDED":
      return `New item detected: ${money(newValue)}`;
    case "PRODUCT_REMOVED":
      return `An item is no longer listed (was ${money(oldValue)})`;
    case "PROMOTION_CHANGE":
      return "A promotion changed";
    case "CONTENT_CHANGE":
      return "The page's visible text changed";
    default:
      return "A change was detected";
  }
}
