/**
 * Cross-call source dedup for `codegraph_explore` (CG-18).
 *
 * The session record (CG-17) knows what earlier calls already sent. This module
 * is the algebra that turns that record into a decision for the call being
 * rendered: of the line ranges this call WOULD emit, which does the agent
 * already hold, and what is genuinely new.
 *
 * Three rules shape everything here, and all three come from the same place —
 * an insufficient-feeling response is what sends an agent to Read, and one or
 * two of those early in a session teach it to abandon codegraph entirely
 * (CLAUDE.md):
 *
 *   1. **A pointer, never a bare omission.** Removed source is replaced by a
 *      back-reference naming the file, the symbols, and the line span, worded so
 *      it is unmistakable that the source was already delivered IN THIS
 *      CONVERSATION and is still current. Silence reads as "codegraph didn't
 *      find it".
 *   2. **Only prove-it dedup.** A span is withheld only when the file's bytes
 *      are byte-identical to what was served (a content fingerprint, not an
 *      mtime and not the index's drift flag). An edit between calls means the
 *      agent's copy is wrong, so the source is re-emitted in full.
 *   3. **Cut chunks, not slivers.** Only a covered run of at least
 *      {@link EXPLORE_DEDUP.MIN_COVERED_LINES} lines is worth replacing. Below
 *      that the pointer costs more than the source, and shattering a block into
 *      one-line fragments produces exactly the ragged output that reads as a
 *      failure. Everything not withheld is emitted — where the algebra is
 *      unsure, it re-serves.
 *
 * Which way to be wrong, restated for this layer: re-serving something the agent
 * has is a few hundred wasted chars; withholding something it never saw is a
 * Read. Every threshold below leans to the first.
 */

import { createHash } from 'crypto';
import type { ExploreLineRange, ExploreProjectState } from './explore-session-state';

export const EXPLORE_DEDUP = {
  /**
   * Shortest already-served run that may be replaced by a back-reference.
   *
   * Sized against what dedup is actually FOR — a later call re-serving a whole
   * method or file it already sent. A shorter covered run is either a signature
   * line in a skeleton render or the ±3 lines of context padding around a
   * cluster, and swapping either for a pointer trades bytes for noise: the
   * pointer sentence is itself ~140 chars, so under this length dedup would
   * make the response BIGGER while making it read as full of holes.
   */
  MIN_COVERED_LINES: 8,
  /**
   * Below this many chars of NEW source, a file's remainder is folded into its
   * back-reference instead of being fenced on its own.
   *
   * The shape this exists for, seen on the CG-17 fixture: a third call whose
   * only unheld line was the file's trailing blank one, rendered as a code fence
   * containing `228\t`. A fence holding two lines of nothing reads as a broken
   * response, and reading as broken is the expensive failure — it is the thing
   * that sends an agent to Read and keeps it there. So a remainder this small is
   * dropped rather than shown. It is the one place this module withholds
   * something the agent has not seen, and it is bounded to ~two lines that sit
   * directly against source the agent does hold; the file is still named, with
   * its symbols, so one follow-up explore fetches it whole.
   */
  MIN_DELTA_CHARS: 160,
  /** Line spans named in one pointer before it summarises the rest. */
  MAX_SPANS_IN_POINTER: 4,
  /** Symbols named in one pointer before it summarises the rest. */
  MAX_SYMBOLS_IN_POINTER: 5,
} as const;

const OFF = new Set(['0', 'false', 'off', 'no']);

/**
 * Kill switch: `CODEGRAPH_EXPLORE_DEDUP=0` renders every call as if the session
 * had no history. Read per call (not memoized) so a test can toggle it.
 */
export function exploreDedupEnabled(): boolean {
  const raw = process.env.CODEGRAPH_EXPLORE_DEDUP;
  if (raw === undefined) return true;
  return !OFF.has(raw.trim().toLowerCase());
}

/**
 * Identity of the bytes a call served for one file.
 *
 * This — not the index's drift flag — is what gates dedup. `isFileStaleOnDisk`
 * answers "did the file change since the last INDEX SYNC", which is a different
 * question with a different answer: two calls inside one drift window served the
 * same current bytes (dedup is correct), while a file edited and re-synced
 * between two calls is never "stale" and yet the agent's copy is now wrong
 * (dedup would be actively harmful). Length is prefixed so a hash prefix
 * collision cannot alias two files of different size.
 */
export function fileFingerprint(content: string): string {
  return `${content.length}:${createHash('sha1').update(content).digest('hex').slice(0, 16)}`;
}

/** Sort + merge overlapping/adjacent spans into the smallest equivalent set. */
export function mergeRanges(ranges: ReadonlyArray<ExploreLineRange>): ExploreLineRange[] {
  const valid = ranges
    .filter((r) => Number.isFinite(r.start) && Number.isFinite(r.end) && r.end >= r.start && r.start >= 1)
    .map((r) => ({ start: Math.floor(r.start), end: Math.floor(r.end) }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out: ExploreLineRange[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}

/** The parts of `range` that `served` covers. */
export function intersectRange(
  range: ExploreLineRange,
  served: ReadonlyArray<ExploreLineRange>,
): ExploreLineRange[] {
  const out: ExploreLineRange[] = [];
  for (const s of served) {
    const start = Math.max(range.start, s.start);
    const end = Math.min(range.end, s.end);
    if (end >= start) out.push({ start, end });
  }
  return mergeRanges(out);
}

/** The parts of `range` that `cut` does NOT cover. */
export function subtractRange(
  range: ExploreLineRange,
  cut: ReadonlyArray<ExploreLineRange>,
): ExploreLineRange[] {
  const out: ExploreLineRange[] = [];
  let cursor = range.start;
  for (const c of mergeRanges(cut)) {
    if (c.end < cursor) continue;
    if (c.start > range.end) break;
    if (c.start > cursor) out.push({ start: cursor, end: Math.min(c.start - 1, range.end) });
    cursor = Math.max(cursor, c.end + 1);
    if (cursor > range.end) break;
  }
  if (cursor <= range.end) out.push({ start: cursor, end: range.end });
  return out;
}

/** What one intended span becomes once the session's history is applied. */
export interface RangeDedup {
  /** Spans to render now — everything not proven-already-held. */
  emit: ExploreLineRange[];
  /** Spans replaced by a back-reference. */
  covered: ExploreLineRange[];
}

/**
 * Split one intended span into what to emit and what to point back at.
 *
 * Covered runs shorter than {@link EXPLORE_DEDUP.MIN_COVERED_LINES} are left in
 * the emit set on purpose (rule 3 above) — so a span the agent holds "almost
 * all of" still comes back whole rather than as a stutter of fragments around
 * pointers.
 */
export function dedupeRange(
  range: ExploreLineRange,
  served: ReadonlyArray<ExploreLineRange>,
  minCovered: number = EXPLORE_DEDUP.MIN_COVERED_LINES,
): RangeDedup {
  if (served.length === 0 || range.end < range.start) return { emit: [range], covered: [] };
  const covered = intersectRange(range, served).filter((r) => r.end - r.start + 1 >= minCovered);
  if (covered.length === 0) return { emit: [range], covered: [] };
  return { emit: subtractRange(range, covered), covered };
}

/**
 * Every line span this session has already served for one file, but ONLY from
 * calls that served the SAME BYTES.
 *
 * A record with no fingerprint is ignored rather than trusted: it cannot prove
 * the agent's copy matches the file on disk now, and an unprovable match is
 * exactly the case where re-serving is right.
 */
export function servedRangesForFile(
  prior: ExploreProjectState | null,
  filePath: string,
  fingerprint: string,
): ExploreLineRange[] {
  if (!prior) return [];
  const spans: ExploreLineRange[] = [];
  for (const call of prior.calls) {
    for (const file of call.files) {
      if (file.path !== filePath) continue;
      if (!file.fingerprint || file.fingerprint !== fingerprint) continue;
      spans.push(...file.ranges);
    }
  }
  return mergeRanges(spans);
}

/** `L12`, `L12-40`, capped with a `+N more` tail. */
export function formatSpans(spans: ReadonlyArray<ExploreLineRange>): string {
  const shown = spans.slice(0, EXPLORE_DEDUP.MAX_SPANS_IN_POINTER)
    .map((r) => (r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`))
    .join(', ');
  const more = spans.length - EXPLORE_DEDUP.MAX_SPANS_IN_POINTER;
  return more > 0 ? `${shown}, +${more} more span${more === 1 ? '' : 's'}` : shown;
}

/**
 * The line that replaces withheld source.
 *
 * It has one job: make the agent reach into its own context instead of into
 * Read. So it carries the three things needed to find the source it already has
 * — path, symbols, line spans — plus the two facts that make using it safe:
 * that it came from THIS conversation, and that the file has not changed since
 * (which is checked, not asserted — see {@link fileFingerprint}). It never says
 * "omitted", and it never steers to Read.
 */
export function formatBackReference(
  filePath: string,
  covered: ReadonlyArray<ExploreLineRange>,
  symbols: ReadonlyArray<string>,
  opts: { partial: boolean },
): string {
  const names = symbols.slice(0, EXPLORE_DEDUP.MAX_SYMBOLS_IN_POINTER);
  const moreNames = symbols.length - names.length;
  const symbolPart = names.length > 0
    ? ` (${names.join(', ')}${moreNames > 0 ? `, +${moreNames} more` : ''})`
    : '';
  const head = `> **Already sent earlier in this conversation:** \`${filePath}\` ${formatSpans(covered)}${symbolPart}`;
  const tail = opts.partial
    ? ' — unchanged on disk since, so that copy is still exact. Only the NEW lines are shown below; scroll back for the rest. Do NOT Read this file.'
    : ' — unchanged on disk since, so that copy is still exact and is not repeated here. Use it from your context; do NOT Read this file.';
  return head + tail;
}

/** Symbol names whose definitions fall inside the withheld spans. */
export function symbolsInSpans(
  nodes: ReadonlyArray<{ name: string; kind: string; startLine: number; endLine: number }>,
  spans: ReadonlyArray<ExploreLineRange>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.kind === 'import' || n.kind === 'export') continue;
    if (!spans.some((s) => n.startLine <= s.end && (n.endLine || n.startLine) >= s.start)) continue;
    if (seen.has(n.name)) continue;
    seen.add(n.name);
    out.push(n.name);
  }
  return out;
}
