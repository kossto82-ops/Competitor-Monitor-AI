"use client";

import { useEffect, useState } from "react";

/**
 * True only after the client has hydrated. Every form's submit button
 * stays disabled until this flips - without it, a fast click (a real
 * user on a slow device, or an automated test) can land on the
 * server-rendered <button type="submit"> before React's onSubmit
 * handler attaches, triggering a native browser form submission
 * instead. For a login/signup form that means the password gets sent
 * as a GET query string - a real bug, not just test flakiness (caught
 * by a real Playwright/Chromium run during Phase 2, not assumed).
 */
export function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}
