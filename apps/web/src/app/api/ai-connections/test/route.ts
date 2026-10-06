import { NextResponse } from "next/server";
import { createAiConnectionInputSchema } from "@cma/core";
import { testAiConnection } from "@cma/ai";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";
import { readLimits } from "@/lib/limits";
import { checkLimit } from "@/lib/limitResponse";

/**
 * Phase 5 (Section 9): tests NOT-YET-SAVED credentials, exactly what the
 * "Add AI connection" form's own POST body already contains (apiKey has
 * always traveled from browser -> this server in that flow - this adds
 * no new exposure). The key is used for exactly one outbound provider
 * call and is never persisted or logged by this route.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const session = await requireSession(); // any authenticated member may test a configuration before saving it
    const limited = await checkLimit(`ai-test:${session.organizationId}`, readLimits().aiTestPerHour, 3600, "Too many connection tests. Please try again later.");
    if (limited) return limited;
    const body = createAiConnectionInputSchema.parse(await request.json());
    const result = await testAiConnection({
      provider: body.provider,
      model: body.model,
      baseUrl: body.baseUrl ?? null,
      apiKey: body.apiKey,
    });
    return NextResponse.json(result);
  } catch (err) {
    return toErrorResponse(err);
  }
}
