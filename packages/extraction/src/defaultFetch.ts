import { safeGet } from "@cma/security";
import type { FetchFn } from "./types.js";

export const defaultFetch: FetchFn = async (url) => {
  const result = await safeGet(url);
  return { status: result.status, body: result.body, finalUrl: result.finalUrl };
};
