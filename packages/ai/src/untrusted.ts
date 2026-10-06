/**
 * Phase 29 / A5: everything that originates from a monitored page is
 * untrusted data. Two defences live here, applied at the last step of
 * prompt assembly so no caller can forget them:
 *
 *  1. The page cannot forge the `<UNTRUSTED_WEB_CONTENT>` delimiters.
 *     Rather than hunting for that one tag (and its case/whitespace
 *     variants), every angle bracket is escaped, so no tag-shaped text
 *     can exist inside the block at all. The only real tags in a prompt
 *     are the ones the application writes.
 *  2. Invisible characters are removed. Zero-width and bidirectional
 *     control characters let text look benign to a human reviewing the
 *     evidence while reading differently to the model.
 */

// Zero-width / formatting / bidi controls (U+200B-U+200F, U+202A-U+202E, U+2060-U+2064, U+2066-U+206F, U+FEFF)
// plus C0/C1 control characters other than tab and newline.
const INVISIBLE_AND_CONTROL = /[​-‏‪-‮⁠-⁤⁦-⁯﻿\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

/** Makes arbitrary page text safe to place inside the untrusted block. */
export function neutralizeUntrusted(text: string): string {
  return text.replace(INVISIBLE_AND_CONTROL, "").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * For fields that must stay on one line (labels, values): also collapses
 * every line break, so a value cannot start a new line that looks like
 * another "Field: value" entry of the prompt.
 */
export function neutralizeUntrustedLine(text: string): string {
  return neutralizeUntrusted(text).replace(/\s+/g, " ").trim();
}

export const UNTRUSTED_OPEN_TAG = "<UNTRUSTED_WEB_CONTENT>";
export const UNTRUSTED_CLOSE_TAG = "</UNTRUSTED_WEB_CONTENT>";
