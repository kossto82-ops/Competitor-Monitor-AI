"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { useHydrated } from "@/lib/useHydrated";

export function NewCompetitorForm() {
  const router = useRouter();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const response = await fetch("/api/competitors", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, website: website || undefined }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not create competitor.");
        return;
      }
      setName("");
      setWebsite("");
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
      <Button onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" aria-hidden="true" />
        Add competitor
      </Button>
    );
  }

  return (
    <form onSubmit={onSubmit} className="w-full max-w-md rounded-xl border border-slate-200 bg-white p-4 shadow-sm" noValidate>
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-semibold text-slate-900">New competitor</h3>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-slate-400 hover:text-slate-600"
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-3">
        {error ? <Alert tone="error">{error}</Alert> : null}

        <div>
          <Label htmlFor="competitor-name">Name</Label>
          <Input id="competitor-name" required value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc." />
        </div>

        <div>
          <Label htmlFor="competitor-website">Website (optional)</Label>
          <Input
            id="competitor-website"
            type="url"
            value={website}
            onChange={(e) => setWebsite(e.target.value)}
            placeholder="https://acme.com"
          />
        </div>

        <Button type="submit" disabled={submitting || !hydrated} className="w-full">
          {submitting ? "Adding…" : "Add competitor"}
        </Button>
      </div>
    </form>
  );
}
