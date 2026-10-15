import { can, whoCan } from "@cma/core";
import { listAiConnectionsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { AiConnectionsManager } from "@/components/app/AiConnectionsManager";
import { Alert } from "@/components/ui/Alert";

export default async function AiProviderSettingsPage() {
  const session = await getSession();
  if (!session) return null;

  // Phase 29 D5d (E33): holding the organization's AI credentials is for owners and admins. A member never sees
  // them; they can still ask for an AI analysis, which uses the connection that an owner or an admin set up.
  if (!can(session.role, "manage_ai_credentials")) {
    return (
      <div className="max-w-xl space-y-4">
        <h1 className="text-lg font-semibold text-slate-900">AI Provider</h1>
        <Alert tone="info">Only {whoCan("manage_ai_credentials")} can connect or change the AI provider. You can still ask for an AI analysis of a change: it uses the connection they set up.</Alert>
      </div>
    );
  }

  const connections = await listAiConnectionsForOrg(session.organizationId);

  return (
    <AiConnectionsManager
      initialConnections={connections.map((c) => ({
        id: c.id,
        provider: c.provider,
        model: c.model,
        baseUrl: c.baseUrl,
        enabled: c.enabled,
        hasApiKey: c.hasApiKey,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      }))}
    />
  );
}
