/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
