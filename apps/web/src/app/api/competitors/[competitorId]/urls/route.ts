import { NextResponse } from "next/server";
import { monitoredUrlInputSchema } from "@cma/core";
import { createMonitoredUrl, listMonitoredUrlsForOrg } from "@cma/db";
import { resolveAndValidateHost, SsrfBlockedError } from "@cma/security";
import { requireSession } from "@/lib/currentSession";
import { toErrorResponse } from "@/lib/apiError";

interface RouteParams {
  params: Promise<{ competitorId: string }>;
}

export async function GET(_request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { competitorId } = await params;
    const urls = await listMonitoredUrlsForOrg(session.organizationId, competitorId);
    return NextResponse.json({ monitoredUrls: urls });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request, { params }: RouteParams): Promise<NextResponse> {
  try {
    const session = await requireSession();
    const { competitorId } = await params;
    const body = monitoredUrlInputSchema.parse(await request.json());

    // Eager, best-effort SSRF check at creation time for fast user
    // feedback ("that's localhost, rejected") - this is NOT the
    // enforcement point. The real, non-bypassable gate is inside
    // safeGet(), run again on every scan and on every redirect hop, so
    // a URL that starts safe and later resolves somewhere unsafe (DNS
    // rebinding, a DNS record changed after creation) is still caught.
    try {
      const url = new URL(body.url);
      await resolveAndValidateHost(url.hostname);
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        return NextResponse.json({ error: `This URL cannot be monitored: ${err.message}` }, { status: 400 });
      }
      // A transient DNS failure at creation time should not permanently
      // block adding the URL - the fetch-time check is the real gate.
    }

    const monitoredUrl = await createMonitoredUrl(session.organizationId, competitorId, body);
    return NextResponse.json({ monitoredUrl }, { status: 201 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
