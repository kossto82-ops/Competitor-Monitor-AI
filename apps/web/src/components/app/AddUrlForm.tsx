"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { useHydrated } from "@/lib/useHydrated";

const CATEGORIES = [
  { value: "PRICING_PAGE", label: "Pricing page" },
  { value: "PRODUCT_PAGE", label: "Product page" },
  { value: "GENERAL", label: "General" },
];

export function AddUrlForm({ competitorId }: { competitorId: string }) {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [category, setCategory] = useState("PRICING_PAGE");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch(`/api/competitors/${competitorId}/urls`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, label: label || undefined, category }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not add this URL.");
        return;
      }
      setUrl("");
      setLabel("");
      setOpen(false);
      router.refresh();
    } catch {
      setError("Could not reach the server. Please try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add URL
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-lg rounded-xl border border-slate-200 bg-white p-4 shadow-sm" noValidate>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">Add a monitored URL</h3>
        <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-slate-600" aria-label="Close">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <div>
          <Label htmlFor="url">URL</Label>
          <Input
            id="url"
            type="url"
            required
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://competitor.com/pricing"
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <Label htmlFor="label">Label (optional)</Label>
            <Input id="label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Pricing" />
          </div>
          <div>
            <Label htmlFor="category">Category</Label>
            <Select id="category" value={category} onChange={(e) => setCategory(e.target.value)}>
              {CATEGORIES.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>
        </div>

        <Button type="submit" disabled={submitting || !hydrated} className="w-full">
          {submitting ? "Adding…" : "Add URL"}
        </Button>
      </div>
    </form>
  );
}
