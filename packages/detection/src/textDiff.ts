/**
 * Phase 29 C4: a word-level text diff, so a CONTENT_CHANGE can say WHAT changed instead of showing
 * the first 300 characters of the page before and after (which is nearly always the same header).
 *
 * Myers' O(ND) algorithm on words. It is bounded: when two texts differ by more than MAX_EDIT_DISTANCE
 * words the diff gives up on precision and reports the whole differing middle as one hunk (flagged
 * `truncated`), rather than burning CPU on a page that was completely rewritten.
 */
export interface TextHunk {
  /** Words that were in the previous text and are gone. */
  removed: string;
  /** Words that are new. */
  added: string;
  /** A few unchanged words immediately before the change, for orientation. */
  before: string;
  /** A few unchanged words immediately after. */
  after: string;
}

export interface TextDiff {
  hunks: TextHunk[];
  /** True when the edit distance exceeded the bound and the middle was reported as a single hunk. */
  truncated: boolean;
}

const MAX_EDIT_DISTANCE = 1500;
const CONTEXT_WORDS = 6;
/** Two changes separated by this many unchanged words or fewer are reported as one hunk. */
const MERGE_GAP_WORDS = 2;

type Op = { kind: "eq" | "del" | "ins"; word: string };

function words(text: string): string[] {
  const trimmed = text.trim();
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/);
}

export function diffText(previous: string, current: string): TextDiff {
  const a = words(previous);
  const b = words(current);

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;

  const midA = a.slice(prefix, a.length - suffix);
  const midB = b.slice(prefix, b.length - suffix);
  if (midA.length === 0 && midB.length === 0) return { hunks: [], truncated: false };

  const ops = myers(midA, midB, MAX_EDIT_DISTANCE);
  const truncated = ops === null;
  const middle: Op[] = ops ?? [...midA.map((word) => ({ kind: "del" as const, word })), ...midB.map((word) => ({ kind: "ins" as const, word }))];

  const all: Op[] = [
    ...a.slice(0, prefix).map((word) => ({ kind: "eq" as const, word })),
    ...middle,
    ...a.slice(a.length - suffix).map((word) => ({ kind: "eq" as const, word })),
  ];
  return { hunks: toHunks(all), truncated };
}

function toHunks(ops: Op[]): TextHunk[] {
  const hunks: TextHunk[] = [];
  let i = 0;
  while (i < ops.length) {
    if (ops[i]!.kind === "eq") {
      i += 1;
      continue;
    }
    const start = i;
    let end = i; // exclusive end of the changed region, extended while gaps are small
    for (;;) {
      while (end < ops.length && ops[end]!.kind !== "eq") end += 1;
      let gap = 0;
      while (end + gap < ops.length && ops[end + gap]!.kind === "eq") gap += 1;
      if (end + gap < ops.length && gap <= MERGE_GAP_WORDS) {
        end += gap;
        continue;
      }
      break;
    }

    const slice = ops.slice(start, end);
    const before = ops.slice(Math.max(0, start - CONTEXT_WORDS), start).filter((o) => o.kind === "eq");
    const after = ops.slice(end, end + CONTEXT_WORDS).filter((o) => o.kind === "eq");
    hunks.push({
      // Unchanged words swallowed by a merge belong to both sides.
      removed: slice.filter((o) => o.kind !== "ins").map((o) => o.word).join(" "),
      added: slice.filter((o) => o.kind !== "del").map((o) => o.word).join(" "),
      before: before.map((o) => o.word).join(" "),
      after: after.map((o) => o.word).join(" "),
    });
    i = end;
  }
  return hunks;
}

/** Myers' shortest edit script; null when more than `maxD` edits are needed. */
function myers(a: string[], b: string[], maxD: number): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, maxD);
  const offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];

  for (let d = 0; d <= max; d += 1) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
      else x = v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, d, offset);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], a: string[], b: string[], dFinal: number, offset: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = dFinal; d > 0; d -= 1) {
    const v = trace[d]!;
    const k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "eq", word: a[x - 1]! });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) ops.push({ kind: "ins", word: b[y - 1]! });
    else ops.push({ kind: "del", word: a[x - 1]! });
    x = prevX;
    y = prevY;
  }
  while (x > 0 && y > 0) {
    ops.push({ kind: "eq", word: a[x - 1]! });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}
