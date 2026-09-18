/**
 * Walking the graph — the one place a symbol navigation is performed.
 *
 * Every step records its DIRECTION before it navigates, because the direction
 * is not recoverable afterwards. "I stepped down into a call" and "I stepped up
 * to a caller" produce the same pair of symbols; only the act distinguishes
 * them, and the Symbol view needs it twice over: the trail bar draws `→` or `←`
 * between hops, and the arrival rail tints the row you came from ("you came
 * from here") — which is the LEFT rail after stepping down, and the RIGHT rail
 * after stepping up.
 *
 * The trail is pushed first and travels in the URL, so a reload or a shared
 * link reproduces the walk rather than starting a fresh one at the same symbol.
 */

import { fileHref, navigate, symbolHref } from './navigation';
import { encodeTrail, trail, type HopDirection } from './trail.svelte';
import type { EntryTarget } from './entry-model';

export interface WalkTarget {
  id: string;
  name?: string | null;
  kind?: string | null;
}

/**
 * Move to a symbol, recording how you got there.
 *
 * @param dir  'down' following a call, 'up' going to a caller, 'start' for a
 *             jump that is neither (search, a breadcrumb, a members outline).
 * @param line a line to highlight and scroll to in the destination.
 */
export function walkTo(target: WalkTarget, dir: HopDirection, line?: number): void {
  trail.push({ id: target.id, name: target.name ?? null, kind: target.kind ?? null, dir });
  const href = symbolHref(target.id, { trail: encodeTrail(trail.hops), ...(line ? { line } : {}) });
  navigate(href);
}

/**
 * Where the reader arrived from, and which rail should show it.
 *
 * A hop marked `up` means the reader stepped from a callee to this symbol, so
 * the symbol they left is one of THIS symbol's callees — the right rail. A
 * `down` hop is the mirror. A `start` hop came from nowhere on screen.
 */
export function arrivedFrom(): { id: string; rail: 'left' | 'right' } | null {
  const hops = trail.hops;
  if (hops.length < 2) return null;
  const current = hops[hops.length - 1];
  const previous = hops[hops.length - 2];
  if (!current || !previous) return null;
  if (current.dir === 'down') return { id: previous.id, rail: 'left' };
  if (current.dir === 'up') return { id: previous.id, rail: 'right' };
  return null;
}

/**
 * Open whatever an entry-point row points at.
 *
 * A file goes to the File view rather than to the file node's Symbol view —
 * the outline is on both, but only the File view carries the import rails —
 * and it does NOT join the trail: a trail is a path through calls, and "I
 * opened a file" is not a call. A symbol is a `start` hop, like any other jump
 * that nothing on screen was stepped through to reach.
 */
export function openEntryTarget(target: EntryTarget): void {
  if (!target) return;
  if (target.type === 'file') {
    navigate(fileHref(target.path));
    return;
  }
  walkTo({ id: target.id, name: target.name, kind: target.kind }, 'start');
}
