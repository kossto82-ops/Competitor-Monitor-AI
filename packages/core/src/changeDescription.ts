/**
 * Phase 4 (Section 18/19): the ONE place a ChangeEvent's deterministic
 * fact is turned into a one-line human sentence - shared by the web
 * change/report UI and the report email builder (packages/notifications)
 * so both surfaces say EXACTLY the same thing about the same evidence.
 * Contains zero AI-generated wording and never invents a price, product,
 * or reason - every value it prints comes directly from the ChangeEvent
 * fields passed in (Section 19: "report generation must never invent").
 */
export interface ChangeEventForDescription {
  changeType: string;
  oldValue: string | null;
  newValue: string | null;
  currency: string | null;
  percentageChange: number | null;
}

function formatMoney(value: string | null, currency: string | null): string {
  return value === null ? "—" : `${currency ?? ""}${value}`.trim();
}

export function describeChangeEvent(event: ChangeEventForDescription): string {
  const { changeType, oldValue, newValue, currency, percentageChange } = event;

  switch (changeType) {
    case "PRICE_CHANGE": {
      const pct = percentageChange !== null ? ` (${percentageChange > 0 ? "+" : ""}${percentageChange}%)` : "";
      return `Price changed from ${formatMoney(oldValue, currency)} to ${formatMoney(newValue, currency)}${pct}`;
    }
    case "PRODUCT_ADDED":
      return `New item detected: ${formatMoney(newValue, currency)}`;
    case "PRODUCT_REMOVED":
      return `An item is no longer listed (was ${formatMoney(oldValue, currency)})`;
    case "PROMOTION_ADDED":
      return `A new promotion appeared: ${newValue ?? "—"}`;
    case "PROMOTION_CHANGE":
      return `A promotion changed from "${oldValue ?? "—"}" to "${newValue ?? "—"}"`;
    case "PROMOTION_REMOVED":
      return `A promotion is no longer listed (was "${oldValue ?? "—"}")`;
    case "CONTENT_CHANGE":
      return "The page's visible text changed";
    default:
      return "A change was detected";
  }
}
