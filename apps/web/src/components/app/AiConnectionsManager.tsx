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
  /**
   * Phase 5 (Section 7/32 regression fix): this field MUST start empty.
   * It previously pre-filled with a specific model string, which reads
   * to the customer as an implied recommended/default model - the exact
   * "UI default" class of violation the AI-model audit forbids. The
   * customer must type their own choice; `required` below stops an
   * empty submission, so there is no path to silently saving a model
   * nobody actually chose.
   */
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  type TestOutcome = { status: string; message: string } | "loading" | null;
  const [formTestResult, setFormTestResult] = useState<TestOutcome>(null);
  const [rowTestResults, setRowTestResults] = useState<Record<string, TestOutcome>>({});

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setFormTestResult(null);
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

  /** Section 9: tests an already-saved connection - the API key is decrypted server-side only, never sent to or seen by this component. */
  async function onTestExisting(connection: AiConnectionData) {
    setRowTestResults((prev) => ({ ...prev, [connection.id]: "loading" }));
    try {
      const response = await fetch(`/api/ai-connections/${connection.id}/test`, { method: "POST" });
      const body = await response.json();
      setRowTestResults((prev) => ({
        ...prev,
        [connection.id]: response.ok ? body : { status: "INVALID_CONFIGURATION", message: body.error ?? "Could not test this connection." },
      }));
    } catch {
      setRowTestResults((prev) => ({ ...prev, [connection.id]: { status: "PROVIDER_UNAVAILABLE", message: "Could not reach the server." } }));
    }
  }

  /** Section 9: tests the form's current (not-yet-saved) values - the same apiKey the Save button would send, never persisted by the test itself. */
  async function onTestForm() {
    setFormTestResult("loading");
    try {
      const response = await fetch("/api/ai-connections/test", {
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
      setFormTestResult(response.ok ? body : { status: "INVALID_CONFIGURATION", message: body.error ?? "Could not test this configuration." });
    } catch {
      setFormTestResult({ status: "PROVIDER_UNAVAILABLE", message: "Could not reach the server." });
    }
  }

  function testResultTone(status: string): "green" | "red" | "amber" {
    if (status === "SUCCESS") return "green";
    if (status === "INVALID_CREDENTIALS" || status === "INVALID_CONFIGURATION") return "red";
    return "amber";
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
          {connections.map((connection) => {
            const testResult = rowTestResults[connection.id] ?? null;
            return (
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
                      {testResult ? (
                        testResult === "loading" ? (
                          <p className="mt-1 text-xs text-slate-400">Testing…</p>
                        ) : (
                          <p className="mt-1 text-xs" data-testid={`test-result-${connection.id}`}>
                            <Badge tone={testResultTone(testResult.status)}>{testResult.message}</Badge>
                          </p>
                        )
                      ) : null}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge tone={connection.enabled ? "green" : "gray"}>{connection.enabled ? "Enabled" : "Disabled"}</Badge>
                    <Button size="sm" variant="secondary" onClick={() => onTestExisting(connection)} disabled={testResult === "loading"} data-testid={`test-connection-${connection.id}`}>
                      Test connection
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => onToggleEnabled(connection)}>
                      {connection.enabled ? "Disable" : "Enable"}
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => onDelete(connection)} aria-label="Delete connection">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
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
                <Input
                  id="model"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="e.g. gpt-4o-mini, gpt-4.1, llama-3.3-70b"
                  required
                />
                <p className="mt-1 text-xs text-slate-400">Enter the exact model name your provider/API key can call. There is no default - you choose it.</p>
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
              {formTestResult ? (
                formTestResult === "loading" ? (
                  <p className="text-xs text-slate-400">Testing…</p>
                ) : (
                  <p data-testid="form-test-result">
                    <Badge tone={testResultTone(formTestResult.status)}>{formTestResult.message}</Badge>
                  </p>
                )
              ) : null}
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onTestForm}
                  disabled={formTestResult === "loading" || !provider || !model || !apiKey || (provider === "openai-compatible" && !baseUrl)}
                  data-testid="test-ai-connection-button"
                >
                  Test connection
                </Button>
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
