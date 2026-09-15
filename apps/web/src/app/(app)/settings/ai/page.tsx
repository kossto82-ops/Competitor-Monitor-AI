import { listAiConnectionsForOrg } from "@cma/db";
import { getSession } from "@/lib/currentSession";
import { AiConnectionsManager } from "@/components/app/AiConnectionsManager";

export default async function AiProviderSettingsPage() {
  const session = await getSession();
  if (!session) return null;

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
