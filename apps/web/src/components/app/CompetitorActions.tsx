"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

export interface CompetitorActionsData {
  id: string;
  name: string;
  website: string | null;
  notes: string | null;
  isActive: boolean;
}

/**
 * Phase 5 (Section 3): the customer-facing competitor management
 * workflow - edit, deactivate/reactivate, delete-where-safe. A
 * competitor with any monitored URL can only be deactivated (the API
 * returns 409 for delete in that case) - deactivating never touches
 * historical ChangeEvents/Reports, it only stops future scheduling.
 */
export function CompetitorActions({ competitor }: { competitor: CompetitorActionsData }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(competitor.name);
  const [website, setWebsite] = useState(competitor.website ?? "");
  const [notes, setNotes] = useState(competitor.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSaveEdit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/competitors/${competitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, website: website || null, notes: notes || null }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        setError(body.error ?? "Could not save changes.");
        return;
      }
      setEditing(false);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function onToggleActive() {
    setBusy(true);
    try {
      await fetch(`/api/competitors/${competitor.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !competitor.isActive }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  async function onDelete() {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch(`/api/competitors/${competitor.id}`, { method: "DELETE" });
      if (response.status === 204) {
        router.push("/competitors");
        router.refresh();
        return;
      }
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not delete this competitor.");
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Edit competitor</CardTitle>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onSaveEdit}>
            <div>
              <Label htmlFor="edit-name">Name</Label>
              <Input id="edit-name" required value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="edit-website">Website</Label>
              <Input id="edit-website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://acme.com" />
            </div>
            <div>
              <Label htmlFor="edit-notes">Description / notes</Label>
              <Input id="edit-notes" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What makes this competitor relevant?" />
            </div>
            <FieldError>{error}</FieldError>
            <div className="flex items-center gap-2">
              <Button type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save"}
              </Button>
              <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          Edit
        </Button>
        <Button size="sm" variant="secondary" onClick={onToggleActive} disabled={busy}>
          {competitor.isActive ? "Deactivate" : "Reactivate"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDelete} disabled={busy} aria-label="Delete competitor">
          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      {error ? <p className="max-w-xs text-right text-xs text-red-600">{error}</p> : null}
      {!competitor.isActive ? (
        <p className="text-xs text-amber-700">Deactivated - no new scans will run. History remains visible.</p>
      ) : null}
    </div>
  );
}
