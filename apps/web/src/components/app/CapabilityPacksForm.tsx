"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CAPABILITY_PACKS, type CapabilityPack } from "@cma/core";
import { Button } from "@/components/ui/Button";
import { FieldError } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

const PACK_DISPLAY: Record<CapabilityPack, { label: string; description: string }> = {
  general: { label: "General", description: "Free trial, no commitment, 24/7, languages, API, integrations, mobile app, AI assistant." },
  "call-answering": { label: "Call answering", description: "Telephone secretarial services: answering in your name, transfer, screening, messages, appointments, urgent calls, human or AI agents." },
};

/** Which lists of capabilities are looked for on the competitors' pages. At least one must stay on. */
export function CapabilityPacksForm({ initialPacks }: { initialPacks: CapabilityPack[] }) {
  const router = useRouter();
  const [packs, setPacks] = useState<CapabilityPack[]>(initialPacks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  function toggle(pack: CapabilityPack) {
    setSaved(false);
    setPacks((current) => (current.includes(pack) ? current.filter((p) => p !== pack) : [...current, pack]));
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (packs.length === 0) {
      setError("Keep at least one list on.");
      return;
    }
    setSaving(true);
    try {
      const response = await fetch("/api/settings/organization", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capabilityPacks: packs }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not save the capability lists.");
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
        <CardTitle>What to look for on competitors&apos; pages</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="space-y-3">
            {CAPABILITY_PACKS.map((pack) => (
              <label key={pack} className="flex items-start gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={packs.includes(pack)} onChange={() => toggle(pack)} className="mt-0.5 h-4 w-4 rounded border-slate-300" />
                <span>
                  <span className="font-medium text-slate-900">{PACK_DISPLAY[pack].label}</span>
                  <span className="block text-xs text-slate-500">{PACK_DISPLAY[pack].description}</span>
                </span>
              </label>
            ))}
          </div>
          <FieldError>{error}</FieldError>
          {saved ? <p className="text-sm text-emerald-600">Saved. The Features page uses these lists from the next scan.</p> : null}
          <Button type="submit" disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
