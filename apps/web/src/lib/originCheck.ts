/**
 * Phase 29 D5c (E16): CSRF defence for the JSON API. The session cookie is SameSite=Lax, which already stops
 * most cross-site POSTs, but nothing else did: a same-site sibling or an older browser could still send one.
 * A state-changing request from a browser must therefore name this site as its origin, and a request that
 * carries a body must say it is JSON (a cross-site HTML form cannot).
 *
 * Requests with neither an Origin nor a Sec-Fetch-Site header are not coming from a browser page (curl, a
 * server, a test), and a cross-site attack needs a browser page, so they are not refused here.
 */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export type OriginCheckResult = { ok: true } | { ok: false; status: 403 | 415; error: string };

export interface RequestFacts {
  method: string;
  /** The origin the request was sent to (scheme and host), e.g. "https://app.example.com". */
  requestOrigin: string;
  origin: string | null;
  secFetchSite: string | null;
  contentType: string | null;
  /** True when the request carries a body. */
  hasBody: boolean;
}

export function checkApiRequestOrigin(facts: RequestFacts): OriginCheckResult {
  if (SAFE_METHODS.has(facts.method.toUpperCase())) return { ok: true };

  if (facts.origin !== null) {
    if (facts.origin !== facts.requestOrigin) return { ok: false, status: 403, error: "Cross-site requests are not allowed." };
  } else if (facts.secFetchSite !== null && facts.secFetchSite !== "same-origin" && facts.secFetchSite !== "none") {
    // No Origin, but the browser says the request came from another site.
    return { ok: false, status: 403, error: "Cross-site requests are not allowed." };
  }

  if (facts.hasBody && !/^application\/json\s*(;|$)/i.test(facts.contentType ?? "")) {
    return { ok: false, status: 415, error: "Requests with a body must be sent as application/json." };
  }
  return { ok: true };
}

/** "null" is what a browser sends from a sandboxed frame or a redirect chain: never the site itself. */
export function factsFromRequest(request: Request, requestOrigin: string): RequestFacts {
  const length = request.headers.get("content-length");
  return {
    method: request.method,
    requestOrigin,
    origin: request.headers.get("origin"),
    secFetchSite: request.headers.get("sec-fetch-site"),
    contentType: request.headers.get("content-type"),
    hasBody: (length !== null && length !== "0") || request.headers.has("transfer-encoding"),
  };
}
