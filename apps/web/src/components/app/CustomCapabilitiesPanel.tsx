"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FieldError, Input, Label } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

export interface CustomCapabilityView {
  id: string;
  label: string;
  description: string;
  phrases: string[];
}

/** Phase 29 F3: capabilities this organization cares about that no built-in list has. Phrases are matched literally; the description guides the AI check. */
export function CustomCapabilitiesPanel({ capabilities, canManage }: { capabilities: CustomCapabilityView[]; canManage: boolean }) {
  const router = useRouter();
  const [label, setLabel] = useState("");
  const [description, setDescription] = useState("");
  const [phrases, setPhrases] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/capabilities/custom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label, description, phrases: phrases.split("\n").map((p) => p.trim()).filter(Boolean) }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.details?.fieldErrors ? "Check the fields: a name (2+ characters), a description (5+), phrases of 3+ characters." : (body.error ?? "Could not add it."));
        return;
      }
      setLabel("");
      setDescription("");
      setPhrases("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/capabilities/custom/${id}`, { method: "DELETE" });
      if (!response.ok) setError("Could not remove it.");
      else router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Capabilities of your own</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs leading-relaxed text-slate-500">
          Add something specific to your market that the built-in lists do not cover. The phrases are looked for word for word on every scan (no AI); the description is what the AI check is asked. A capability with no phrases is only found by the AI check.
        </p>
        {capabilities.length > 0 ? (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200">
            {capabilities.map((c) => (
              <li key={c.id} className="flex items-start justify-between gap-3 px-3 py-2">
                <div className="min-w-0 text-sm">
                  <p className="font-medium text-slate-900">{c.label}</p>
                  <p className="text-xs text-slate-500">{c.description}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">{c.phrases.length > 0 ? `Phrases: ${c.phrases.join(" · ")}` : "No phrases: found by the AI check only"}</p>
                </div>
                {canManage ? (
                  <Button size="sm" variant="secondary" onClick={() => remove(c.id)} disabled={busy} aria-label={`Remove ${c.label}`}>
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        ) : null}

        {canManage ? (
          <form className="space-y-3" onSubmit={add}>
            <div>
              <Label htmlFor="cap-label">Name</Label>
              <Input id="cap-label" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} placeholder="Answers in Catalan" required />
            </div>
            <div>
              <Label htmlFor="cap-description">What it means</Label>
              <Input id="cap-description" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={240} placeholder="The service takes calls in Catalan, not only Spanish" required />
            </div>
            <div>
              <Label htmlFor="cap-phrases">Phrases to look for (one per line, optional)</Label>
              <textarea
                id="cap-phrases"
                value={phrases}
                onChange={(e) => setPhrases(e.target.value)}
                rows={3}
                className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                placeholder={"en catalán\nen catala"}
              />
            </div>
            <FieldError>{error}</FieldError>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Add capability"}
            </Button>
          </form>
        ) : (
          <p className="text-xs text-slate-500">Only an owner or an admin can add or remove capabilities.</p>
        )}
        {!canManage && error ? <p className="text-xs text-red-600">{error}</p> : null}
      </CardContent>
    </Card>
  );
}
