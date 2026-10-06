"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input, Label, FieldError, Select } from "@/components/ui/Input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";

export interface SmtpSettingsData {
  host: string;
  port: number;
  security: "ssl" | "starttls";
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
  enabled: boolean;
}

interface TestResult {
  status: "SUCCESS" | "FAILED";
  message: string;
}

/** Ports the server accepts - keep in sync with SMTP_ALLOWED_PORTS in @cma/core. */
const PORT_OPTIONS = [587, 465, 2525, 25];

/**
 * Phase 29 / A2b: lets an organization send its daily report from its own
 * mailbox or company mail server. The password is write-only: the form
 * never receives it back, only whether one is stored. Leaving the field
 * blank keeps the stored one.
 */
export function SmtpSettingsForm({ initial, serverDefaultConfigured }: { initial: SmtpSettingsData | null; serverDefaultConfigured: boolean }) {
  const router = useRouter();
  const [host, setHost] = useState(initial?.host ?? "");
  const [port, setPort] = useState(initial?.port ?? 587);
  const [security, setSecurity] = useState<"ssl" | "starttls">(initial?.security ?? "starttls");
  const [username, setUsername] = useState(initial?.username ?? "");
  const [password, setPassword] = useState("");
  const [removePassword, setRemovePassword] = useState(false);
  const [fromAddress, setFromAddress] = useState(initial?.fromAddress ?? "");
  const [fromName, setFromName] = useState(initial?.fromName ?? "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  const saved_ = initial !== null;
  const dirtyHint = "Save your changes before sending a test email - the test uses the saved settings.";

  function deliverySummary(): string {
    if (initial?.enabled) return `Reports are sent from your own account (${initial.fromAddress}).`;
    if (serverDefaultConfigured) return "Reports are sent from the default account provided by this installation.";
    return "No email account is configured, so daily report emails are not sent. Reports remain available in the app.";
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    setTestResult(null);
    setSaving(true);
    try {
      const response = await fetch("/api/settings/smtp", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          host,
          port,
          security,
          username: username.trim() === "" ? null : username,
          // undefined = keep the stored password, null = remove it, string = replace it.
          ...(removePassword ? { password: null } : password !== "" ? { password } : {}),
          fromAddress,
          fromName: fromName.trim() === "" ? null : fromName,
          enabled,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.details?.fieldErrors ? "Please check the highlighted values: " + Object.keys(body.details.fieldErrors).join(", ") : (body.error ?? "Could not save your email settings."));
        return;
      }
      setPassword("");
      setRemovePassword(false);
      setSaved(true);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setSaving(false);
    }
  }

  async function onTest() {
    setError(null);
    setTestResult(null);
    setTesting(true);
    try {
      const response = await fetch("/api/settings/smtp/test", { method: "POST" });
      const body = await response.json();
      setTestResult({ status: body.status === "SUCCESS" ? "SUCCESS" : "FAILED", message: body.message ?? "The test could not be completed." });
    } catch {
      setTestResult({ status: "FAILED", message: "Could not reach the server." });
    } finally {
      setTesting(false);
    }
  }

  async function onRemove() {
    if (!window.confirm("Remove your SMTP account? Reports will use the default account, if one exists.")) return;
    setError(null);
    setRemoving(true);
    try {
      const response = await fetch("/api/settings/smtp", { method: "DELETE" });
      if (!response.ok) {
        setError("Could not remove the SMTP account.");
        return;
      }
      setHost("");
      setUsername("");
      setPassword("");
      setFromAddress("");
      setFromName("");
      setTestResult(null);
      router.refresh();
    } catch {
      setError("Could not reach the server.");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Send reports from your own email account</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="mb-4 text-sm text-slate-600" data-testid="smtp-delivery-summary">
          {deliverySummary()}
        </p>

        <form className="space-y-4" onSubmit={onSubmit}>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="sm:col-span-2">
              <Label htmlFor="smtp-host">SMTP server</Label>
              <Input id="smtp-host" value={host} onChange={(e) => setHost(e.target.value)} placeholder="smtp.yourcompany.com" required />
            </div>
            <div>
              <Label htmlFor="smtp-port">Port</Label>
              <Select id="smtp-port" value={port} onChange={(e) => setPort(Number(e.target.value))}>
                {PORT_OPTIONS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="smtp-security">Encryption</Label>
            <Select id="smtp-security" value={security} onChange={(e) => setSecurity(e.target.value as "ssl" | "starttls")}>
              <option value="starttls">STARTTLS (usually port 587)</option>
              <option value="ssl">SSL/TLS (usually port 465)</option>
            </Select>
            <p className="mt-1 text-xs text-slate-400">Unencrypted connections are not supported, so your password is never sent in clear text.</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="smtp-username">Username</Label>
              <Input id="smtp-username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" placeholder="you@yourcompany.com" />
            </div>
            <div>
              <Label htmlFor="smtp-password">Password</Label>
              <Input
                id="smtp-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                disabled={removePassword}
                placeholder={initial?.hasPassword ? "Stored - leave blank to keep" : ""}
              />
              {initial?.hasPassword ? (
                <label className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                  <input type="checkbox" checked={removePassword} onChange={(e) => setRemovePassword(e.target.checked)} className="h-3.5 w-3.5 rounded border-slate-300" />
                  Remove the stored password
                </label>
              ) : null}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="smtp-from-address">From address</Label>
              <Input id="smtp-from-address" type="email" value={fromAddress} onChange={(e) => setFromAddress(e.target.value)} placeholder="alerts@yourcompany.com" required />
            </div>
            <div>
              <Label htmlFor="smtp-from-name">From name (optional)</Label>
              <Input id="smtp-from-name" value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="Competitor Monitor" maxLength={100} />
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 rounded border-slate-300" />
            Use this account to send my reports
          </label>

          <FieldError>{error}</FieldError>
          {saved ? <p className="text-sm text-emerald-600">Saved.</p> : null}
          {testResult ? (
            <p role="status" className={testResult.status === "SUCCESS" ? "text-sm text-emerald-600" : "text-sm text-red-600"} data-testid="smtp-test-result">
              {testResult.message}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={onTest} disabled={testing || !saved_} title={saved_ ? dirtyHint : "Save your settings first"}>
              {testing ? "Sending…" : "Send test email"}
            </Button>
            {saved_ ? (
              <Button type="button" variant="ghost" onClick={onRemove} disabled={removing}>
                {removing ? "Removing…" : "Remove"}
              </Button>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
