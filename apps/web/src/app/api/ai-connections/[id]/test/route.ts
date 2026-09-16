import { NextResponse } from "next/server";
import { getDecryptedAiConnectionForOrg } from "@cma/db";
import { testAiConnection, isAiProviderKind, UnsupportedAiProviderError } from "@cma/ai";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Tests an EXISTING saved connection. Decrypts the stored credential
 * server-side (packages/db's getDecryptedAiConnectionForOrg,
 * tenant-scoped) for exactly one outbound provider call - the decrypted
 * value never leaves this function, is never logged, and is never
 * included in the JSON response (only `testAiConnection`'s classified
 * {status, message} is returned).
 */
export async function POST(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { id } = await params;
    const config = await getDecryptedAiConnectionForOrg(session.organizationId, id);

    if (!isAiProviderKind(config.provider)) {
      throw new UnsupportedAiProviderError(config.provider);
    }

    const result = await testAiConnection({
      provider: config.provider,
      model: config.model,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
