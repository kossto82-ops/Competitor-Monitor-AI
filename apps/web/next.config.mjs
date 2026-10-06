const isDev = process.env.NODE_ENV !== "production";

/**
 * Content-Security-Policy.
 *
 * KNOWN LIMITATION: `script-src` allows 'unsafe-inline' because Next.js emits inline bootstrap /
 * hydration scripts, and a nonce-based policy needs per-request nonces (dynamic rendering for
 * every page). So this CSP does NOT stop an injected inline <script>; what it does enforce is
 * everything around it - no framing (clickjacking), no plugins, no <base> hijack, forms and
 * XHR/fetch only to this origin, images only from this origin or data:, and no scripts or
 * styles from other origins. React's escaping is the primary XSS defence (no
 * dangerouslySetInnerHTML anywhere in the app); this is the second layer. Moving to nonces is a
 * tracked follow-up.
 *
 * No `upgrade-insecure-requests`: it forces https on every sub-resource, which breaks any
 * http-only run of a production build (local checks, internal staging). Strict-Transport-Security
 * already covers real https deployments.
 *
 * Development additionally needs 'unsafe-eval' (React Refresh) and ws: (HMR).
 */
const contentSecurityPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: contentSecurityPolicy },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  // HSTS only in production: sending it over plain-http localhost would pin the browser to https there.
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Local dev/E2E (Playwright, curl) reach this app via 127.0.0.1 rather
  // than "localhost" - without this, Next's dev server blocks the HMR
  // websocket as a cross-origin request, which (discovered during Phase 2
  // E2E testing) silently prevented client-side hydration entirely: pages
  // rendered their initial server HTML but no React event handler ever
  // attached, so a real user's (or a test's) click on a submit button fell
  // through to the browser's native form submission instead of our
  // onSubmit handler.
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
