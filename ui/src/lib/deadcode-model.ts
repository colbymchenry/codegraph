/**
 * The dead code list's arithmetic and its sentences (design spec §3.11).
 *
 * Pure functions over the `/api/deadcode` payload: no DOM, no fetch. The
 * screen's whole job is to be believed, and everything that decides whether it
 * should be lives here — the caveat that never goes away, the headline that
 * says how much of the index is behind the list, and the sentence that names
 * every reason a candidate was left off.
 *
 * The rule this file exists to enforce: **the list and its caveats are one
 * thing.** A screen that draws the rows and leaves the exclusions to a
 * collapsed panel is a screen that gets somebody to delete a route handler.
 */

import { plural } from './symbol-model';
import { kindWord } from './kinds';
import type { WireDeadCode, WireDeadCodeGroup, WireDeadCodeRow } from './wire';

/**
 * The line that is always on screen, whatever the list says.
 *
 * Not a dismissible note and not a tooltip: the claim this screen makes is
 * "no static reference in the index", which is a strictly weaker claim than
 * "unused", and the difference is the whole risk of acting on it.
 */
export const DEAD_CODE_CAVEAT =
  'No static reference in the index — dynamic use is possible.';

/** "symbol" / "symbols" — the noun without its count, for sentences that count twice. */
function noun(count: number, one: string): string {
  return count === 1 ? one : `${one}s`;
}

/** The one-line summary above the list. */
export function deadCodeHeadline(payload: WireDeadCode | null): string {
  if (!payload) return '';
  const { rows } = payload;
  if (rows.total === 0) return 'Nothing on this list.';
  const lines = payload.groups.reduce((sum, group) => sum + group.lines, 0);
  const shown = rows.truncated
    ? `${rows.shown} of ${rows.total} ${noun(rows.total, 'symbol')}`
    : plural(rows.total, 'symbol');
  return `${shown} in ${plural(payload.groups.length, 'file')} · ${plural(lines, 'line')}`;
}

/**
 * "2 478 of 2 498 candidates were left off" — the number that gives the list
 * its scale.
 *
 * Twenty rows drawn from twenty candidates and twenty drawn from two and a half
 * thousand are different screens, and only this sentence tells them apart.
 */
export function deadCodeScale(payload: WireDeadCode | null): string {
  if (!payload || payload.candidates === 0) return '';
  return `${payload.candidates.toLocaleString()} ${noun(payload.candidates, 'symbol')} in this index carry no incoming reference at all; ${payload.excludedTotal.toLocaleString()} of them were left off this list.`;
}

/** Each exclusion as "N <label>", biggest first — the sentence under the list. */
export function exclusionPhrases(payload: WireDeadCode | null): string[] {
  if (!payload) return [];
  return payload.excluded.map((entry) => `${entry.count.toLocaleString()} ${entry.label}`);
}

/** The row's second line: what it is, and what deleting it would remove. */
export function deadCodeRowMeta(row: WireDeadCodeRow): string {
  const parts = [kindWord(row.kind), plural(row.lines, 'line')];
  if (row.members.total > 0) {
    parts.push(`${plural(row.members.total, 'member')} unreachable with it`);
  }
  return parts.join(' · ');
}

/** The group header's right-hand count. */
export function groupMeta(group: WireDeadCodeGroup): string {
  const parts = [plural(group.rows.length, 'symbol'), plural(group.lines, 'line')];
  if (group.generated) parts.push('generated');
  return parts.join(' · ');
}

/**
 * What the screen says when the list is empty.
 *
 * An empty list is a real answer and never an error — but "nothing found" and
 * "nothing survived the filters" are different answers, and the second one
 * points at the toggle that would widen it.
 */
export function emptyMessage(payload: WireDeadCode): string {
  if (payload.candidates === 0) {
    return 'Every symbol in this index is referenced by something. Nothing to show.';
  }
  if (payload.includeExported) {
    return `Every one of the ${payload.candidates.toLocaleString()} symbols with no incoming reference has a reason to be reachable anyway — see the list of exclusions below.`;
  }
  return `All ${payload.candidates.toLocaleString()} symbols with no incoming reference are either reachable from outside this repository or excluded for the reasons below. Turn on "including exported" to see the ones the index cannot check.`;
}
