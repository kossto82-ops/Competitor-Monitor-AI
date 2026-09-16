"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

export interface NotificationSettingsData {
  dailyReportEnabled: boolean;
  reportRecipientEmail: string | null;
  ownerEmail: string | null;
  timezone: string;
}

const COMMON_TIMEZONES = [
  "UTC",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "America/New_York",
  "America/Los_Angeles",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Tokyo",
  "Australia/Sydney",
];

/** Phase 5 (Section 18): daily report enabled/disabled, recipient override, timezone - deliberately nothing more (complex alert rules are a later phase). */
export function NotificationSettingsForm({ initial }: { initial: NotificationSettingsData }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initial.dailyReportEnabled);
  const [recipient, setRecipient] = useState(initial.reportRecipientEmail ?? "");
  const [timezone, setTimezone] = useState(initial.timezone);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      const response = await fetch("/api/settings/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dailyReportEnabled: enabled, reportRecipientEmail: recipient, timezone }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not save your notification settings.");
        return;
      }
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Daily report email</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Send me a daily competitor update email
          </label>

          <div>
            <Label htmlFor="recipient">Recipient</Label>
            <Input
              id="recipient"
              type="email"
              value={recipient}
              onChange={(e) => setRecipient(e.target.value)}
              placeholder={initial.ownerEmail ?? "owner@example.com"}
            />
            <p className="mt-1 text-xs text-slate-400">
              Leave blank to send to the account owner{initial.ownerEmail ? ` (${initial.ownerEmail})` : ""}.
            </p>
          </div>

          <div>
            <Label htmlFor="timezone">Timezone</Label>
            <select
              id="timezone"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {COMMON_TIMEZONES.includes(timezone) ? null : <option value={timezone}>{timezone}</option>}
              {COMMON_TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-slate-400">Your daily report covers your calendar day in this timezone.</p>
          </div>

          <FieldError>{error}</FieldError>
          {saved ? <p className="text-sm text-emerald-600">Saved.</p> : null}

          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
