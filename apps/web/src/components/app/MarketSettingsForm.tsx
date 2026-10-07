"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { MARKET_LOCALES } from "@cma/core";
import { Button } from "@/components/ui/Button";
import { Label, FieldError, Select } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

const NONE = "";

/**
 * The market competitors' pages are read in. Sent to every site as the preferred language, so sites that
 * pick their language (and some, their currency) from it answer in the customer's market. It cannot force
 * a country: many sites choose the currency from the monitoring server's address alone - the help text
 * says so, because a customer who believes otherwise would trust prices that are for another market.
 */
export function MarketSettingsForm({ initialLocale }: { initialLocale: string | null }) {
  const router = useRouter();
  const [locale, setLocale] = useState(initialLocale ?? NONE);
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
        body: JSON.stringify({ marketLocale: locale }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not save the market setting.");
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
        <CardTitle>Monitoring market</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-1.5">
            <Label htmlFor="market-locale">Read competitors&apos; pages in</Label>
            <Select id="market-locale" value={locale} onChange={(e) => setLocale(e.target.value)}>
              <option value={NONE}>No preference (each site&apos;s own default)</option>
              {MARKET_LOCALES.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </Select>
            <p className="text-xs text-slate-500">
              This language is requested from every competitor site, so pages that adapt to it answer in your market. It does
              not choose a country: some sites pick the currency from the monitoring server&apos;s location alone, and a
              language preference does not change that. When you change this, the next scan of each page becomes a new baseline
              (no changes are reported for it).
            </p>
          </div>

          <FieldError>{error}</FieldError>
          {saved ? <p className="text-sm text-emerald-600">Saved.</p> : null}

          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save market"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
