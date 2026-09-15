"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Input, Label, Select, FieldError } from "@/components/ui/Input";

export interface AiConnectionData {
  id: string;
  provider: string;
  model: string;
  baseUrl: string | null;
  enabled: boolean;
  hasApiKey: boolean;
  createdAt: string;
  updatedAt: string;
}

function providerLabel(provider: string): string {
  return provider === "openai-compatible" ? "OpenAI-compatible" : "OpenAI";
}

/**
 * Section 6/27: this is the ONLY place a customer's AI credential is
 * ever handled in the browser, and even here only as a write-only
 * input - once submitted, the form never sees it again. Every
 * connection displayed comes from the "safe" API response
 * (SafeAiConnection): no key, no encrypted blob, just
 * `hasApiKey: true/false` rendered as "API key configured".
 */
export function AiConnectionsManager({ initialConnections }: { initialConnections: AiConnectionData[] }) {
  const router = useRouter();
  const [connections, setConnections] = useState(initialConnections);
  const [showForm, setShowForm] = useState(initialConnections.length === 0);
  const [provider, setProvider] = useState<"openai" | "openai-compatible">("openai");
  const [model, setModel] = useState("gpt-5.6-luna");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const response = await fetch("/api/ai-connections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider,
          model,
          apiKey,
          ...(provider === "openai-compatible" ? { baseUrl } : {}),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not save the AI connection.");
        return;
      }
      setConnections((prev) => [body.connection, ...prev]);
      setShowForm(false);
      setApiKey("");
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setIsSaving(false);
    }
  }

  async function onToggleEnabled(connection: AiConnectionData) {
    const response = await fetch(`/api/ai-connections/${connection.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !connection.enabled }),
    });
    if (response.ok) {
      const body = await response.json();
      setConnections((prev) => prev.map((c) => (c.id === connection.id ? body.connection : c)));
    }
  }

  async function onDelete(connection: AiConnectionData) {
    const response = await fetch(`/api/ai-connections/${connection.id}`, { method: "DELETE" });
    if (response.ok || response.status === 204) {
      setConnections((prev) => prev.filter((c) => c.id !== connection.id));
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-900">AI Provider</h1>
        <p className="text-sm text-slate-500">
          Configure which AI provider and model this organization uses to interpret detected changes. Your API key is
          encrypted at rest and never shown again after saving.
        </p>
      </div>

      {connections.length > 0 ? (
        <div className="space-y-3" data-testid="ai-connections-list">
          {connections.map((connection) => (
            <Card key={connection.id} data-testid="ai-connection-row">
              <CardContent className="flex items-center justify-between gap-4 py-4">
                <div className="flex items-center gap-3">
                  <Sparkles className="h-4 w-4 text-indigo-500" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-slate-900">
                      {providerLabel(connection.provider)} · {connection.model}
                    </p>
                    <p className="text-xs text-slate-500">
                      {connection.baseUrl ? `${connection.baseUrl} · ` : ""}
                      {connection.hasApiKey ? "API key configured" : "No API key"}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={connection.enabled ? "green" : "gray"}>{connection.enabled ? "Enabled" : "Disabled"}</Badge>
                  <Button size="sm" variant="secondary" onClick={() => onToggleEnabled(connection)}>
                    {connection.enabled ? "Disable" : "Enable"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => onDelete(connection)} aria-label="Delete connection">
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle>Add AI connection</CardTitle>
          </CardHeader>
          <CardContent>
            <form className="space-y-4" onSubmit={onCreate}>
              <div>
                <Label htmlFor="provider">Provider</Label>
                <Select id="provider" value={provider} onChange={(e) => setProvider(e.target.value as typeof provider)}>
                  <option value="openai">OpenAI</option>
                  <option value="openai-compatible">OpenAI-compatible endpoint</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="model">Model</Label>
                <Input id="model" value={model} onChange={(e) => setModel(e.target.value)} required />
              </div>
              {provider === "openai-compatible" ? (
                <div>
                  <Label htmlFor="baseUrl">Base URL</Label>
                  <Input
                    id="baseUrl"
                    type="url"
                    placeholder="https://provider.example/v1"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    required
                  />
                </div>
              ) : null}
              <div>
                <Label htmlFor="apiKey">API key</Label>
                <Input
                  id="apiKey"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  required
                />
              </div>
              <FieldError>{error}</FieldError>
              <div className="flex items-center gap-2">
                <Button type="submit" disabled={isSaving} data-testid="save-ai-connection-button">
                  {isSaving ? "Saving…" : "Save connection"}
                </Button>
                {connections.length > 0 ? (
                  <Button type="button" variant="ghost" onClick={() => setShowForm(false)}>
                    Cancel
                  </Button>
                ) : null}
              </div>
            </form>
          </CardContent>
        </Card>
      ) : (
        <Button variant="secondary" onClick={() => setShowForm(true)} data-testid="add-ai-connection-button">
          Add another connection
        </Button>
      )}
    </div>
  );
}
