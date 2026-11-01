/** Text rendering for symbol-grouped indexed searches. */
import type { GrepGroup, GrepResult } from './grep';

/** `N in-edges`, plus ` (Q questionable)` when some of them are questionable calls. */
function inEdges(g: GrepGroup): string {
  const q = g.questionableInDegree ?? 0;
  return q > 0 ? `${g.inDegree} in-edges (${q} questionable)` : `${g.inDegree} in-edges`;
}

function groupHeader(g: GrepGroup): string {
  if (g.symbol) return `${g.symbol.name} · ${g.symbol.kind} · ${g.symbol.path}:${g.symbol.span} · ${inEdges(g)}`;
  return `${g.path} (module level) · ${inEdges(g)}`;
}

function formatGroup(g: GrepGroup): string {
  return [groupHeader(g), ...g.hits.map((h) => `  L${h.line}: ${h.text}`)].join('\n');
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `"<pattern>" — N hits in G symbols across F files (searched T indexed files)`; F counts distinct group paths. */
export function formatGrepHeader(r: GrepResult): string {
  const filesHit = new Set(r.groups.map((g) => g.path)).size;
  return `"${r.pattern}" — ${r.totalHits} hits in ${r.groups.length} symbols across ${filesHit} files (searched ${r.filesSearched} indexed files)`;
}

/** The truncation note, or null when nothing was dropped. Dropped counts are never silent. */
function truncationNote(r: GrepResult): string | null {
  const { files, hits } = r.truncated;
  const parts: string[] = [];
  if (hits > 0) parts.push(`${plural(hits, 'more hit')} beyond the cap`);
  if (files > 0) parts.push(`${plural(files, 'indexed file')} unreadable`);
  return parts.length > 0 ? `(truncated: ${parts.join(', ')} — narrow with --in or refine the pattern)` : null;
}

/**
 * Header (plus the truncation note directly under it, so it survives a
 * `head`), a blank line, then one block per group separated by blank lines.
 * Ends with exactly one newline.
 */
export function formatGrepResult(r: GrepResult): string {
  const note = truncationNote(r);
  const head = note ? `${formatGrepHeader(r)}\n${note}` : formatGrepHeader(r);
  const blocks = [head, '', ...r.groups.map((g) => formatGroup(g) + '\n')];
  return blocks.join('\n').replace(/\n+$/, '\n');
}

/**
 * The loud zero-hit note (never a bare empty result). It also names files
 * that could not be read, so a zero-hit answer on a stale index does not read
 * as "no matches anywhere". The wording also applies to a selected path prefix.
 */
export function zeroHitNote(r: GrepResult): string {
  const base =
    `no hits for "${r.pattern}" in ${r.filesSearched} indexed files. The pattern may be too specific — retry with a bare ` +
    'symbol name or short substring (drop the receiver, full signature, and regex anchors). All selected indexed code was ' +
    'searched; use a raw grep only for unindexed files (docs, configs, brand-new files)';
  const { files } = r.truncated;
  if (files === 0) return base;
  return `${base} — note: ${plural(files, 'indexed file')} could not be read (stale index? run codegraph sync)`;
}
