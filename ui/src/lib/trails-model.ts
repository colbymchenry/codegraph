/**
 * What a saved trail says about itself, without a browser.
 *
 * `/api/trails` hands back each trail with every hop already re-resolved
 * against the current index — so all this module does is turn that into the
 * sentences the rows print. It is pure for the usual reason (it can be tested,
 * and a host building its own trail list gets the shipped arithmetic rather
 * than its own), and because the interesting decisions here are *wording*
 * decisions, which is exactly the kind of thing that drifts when it is spread
 * across two components.
 *
 * The one rule it keeps: **a trail that has decayed never reads as intact.**
 * A saved trail is somebody's explanation of a codebase, and the codebase moves
 * underneath it. Showing "6 hops" for a trail where two hops no longer resolve
 * would make it a lie by omission at exactly the moment it needs to be fixed.
 *
 * Tested in `__tests__/ui-trails-model.test.ts`.
 */

import type { WireTrail, WireTrailHop, WireTrailHopStatus } from './wire';
import { plural } from './symbol-model';

/** Hops named in the decay line before it stops naming them. */
export const MAX_NAMED_DECAYED = 3;

/**
 * The row's second line: how long the walk is, and who wrote it.
 *
 * The hop count is the SAVED length, always — the trail is six hops whatever
 * became of them. What became of them is {@link trailDecay}'s job, on its own
 * line, so the two facts cannot be read as one.
 */
export function trailMeta(trail: WireTrail): string {
  const hops = plural(trail.hops.length, 'hop');
  return trail.author ? `${hops} · ${trail.author}` : hops;
}

/** The verdict a decayed hop carries, in the words a row uses. */
export function hopStatusWord(status: WireTrailHopStatus): string {
  switch (status) {
    case 'ok':
      return 'still here';
    case 'moved':
      return 'moved';
    case 'ambiguous':
      return 'ambiguous';
    case 'missing':
      return 'gone';
  }
}

export interface TrailDecay {
  /** `warn` when something is unopenable, `note` when it merely moved. */
  tone: 'warn' | 'note';
  text: string;
}

/**
 * What has happened to this trail since it was saved, or null when nothing has.
 *
 * Two tones, because they call for different things from the reader: a hop that
 * MOVED still opens and only wants acknowledging, while a hop that is gone (or
 * that now names several symbols) means the trail no longer says what its author
 * meant it to say.
 */
export function trailDecay(trail: WireTrail): TrailDecay | null {
  const missing = trail.hops.filter((hop) => hop.status === 'missing');
  const ambiguous = trail.hops.filter((hop) => hop.status === 'ambiguous');
  const moved = trail.hops.filter((hop) => hop.status === 'moved');

  if (missing.length > 0) {
    return {
      tone: 'warn',
      text:
        `${plural(missing.length, 'hop')} moved or renamed since this was saved — ` +
        `${nameList(missing)} no longer in the index.`,
    };
  }
  if (ambiguous.length > 0) {
    return {
      tone: 'warn',
      text: `${nameList(ambiguous)} now ${ambiguous.length === 1 ? 'names' : 'name'} more than one symbol — showing the closest match.`,
    };
  }
  if (moved.length > 0) {
    return {
      tone: 'note',
      text: `${nameList(moved)} moved to another file since this was saved.`,
    };
  }
  return null;
}

/**
 * How much of the trail can actually be opened, or null when all of it can.
 *
 * The payload carries the longest run of CONSECUTIVE resolved hops rather than
 * every resolved hop, because the trail is a path: skipping a broken hop would
 * encode a step from one symbol to another that nothing joins. When that run is
 * shorter than the trail, the row has to say so before somebody opens it and
 * wonders where the first two hops went.
 */
export function trailOpens(trail: WireTrail): string | null {
  if (trail.encoded === null) return 'None of this trail resolves in the current index.';
  if (trail.openCount === trail.hops.length) return null;
  const last = trail.openFrom + trail.openCount - 1;
  const range = trail.openCount === 1 ? `hop ${trail.openFrom}` : `hops ${trail.openFrom}–${last}`;
  return `Opens ${range} of ${trail.hops.length}.`;
}

/** Can this row be opened at all? */
export function isOpenable(trail: WireTrail): boolean {
  return trail.encoded !== null && trail.openId !== null;
}

/** Hover text: the whole walk, in order, with its arrows. */
export function trailTitle(trail: WireTrail): string {
  const path = trail.hops
    .map((hop, index) => (index === 0 ? hop.name : `${arrow(hop)} ${hop.name}`))
    .join(' ');
  const when = trail.updatedAt ? ` — saved ${trail.updatedAt.slice(0, 10)}` : '';
  return `${path}${when}`;
}

function arrow(hop: WireTrailHop): string {
  return hop.dir === 'up' ? '←' : hop.dir === 'down' ? '→' : '·';
}

function nameList(hops: readonly WireTrailHop[]): string {
  const names = hops.slice(0, MAX_NAMED_DECAYED).map((hop) => hop.name);
  const rest = hops.length - names.length;
  const listed =
    names.length === 1
      ? (names[0] as string)
      : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return rest > 0 ? `${listed} and ${rest} more` : listed;
}

/* ------------------------------------------------------------- saving -- */

/**
 * Why this name cannot be saved, or null when it can.
 *
 * Only the two things the server would refuse anyway; everything else about a
 * name is the reader's business. Checked here as well so the form can disable
 * its own button rather than teaching by round-trip.
 */
export function trailNameProblem(name: string, maxLength: number): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'Give the trail a name.';
  if (trimmed.length > maxLength) return `That name is too long (max ${maxLength} characters).`;
  return null;
}

/**
 * The trail this name would replace, or null when it would be a new one.
 *
 * Saving under an existing name overwrites it — that is what a reader means by
 * pressing Save twice — but they should be told before, not after.
 */
export function replacedTrail(name: string, trails: readonly WireTrail[]): WireTrail | null {
  const trimmed = name.trim().replace(/\s+/g, ' ');
  return trails.find((trail) => trail.name === trimmed) ?? null;
}

/**
 * A saved trail as the file it is, ready to be written somewhere a repository
 * will keep it.
 *
 * The trails directory is inside `.codegraph/`, which is gitignored wholesale —
 * that is the right default for a scratch walk and the wrong one for a tour
 * worth committing. Exporting is therefore a copy the reader makes on purpose,
 * and this is the same shape the viewer writes: each hop's saved IDENTITY —
 * qualified name, kind, the file it was in — so dropping the file into another
 * checkout re-runs the same resolution rather than baking today's answer in.
 * Only the id hint is refreshed to whatever the symbol's id is now, since that
 * is all an id has ever been here.
 */
export function trailExport(trail: WireTrail): string {
  return `${JSON.stringify(
    {
      version: 1,
      id: trail.id,
      name: trail.name,
      note: trail.note,
      author: trail.author,
      createdAt: trail.createdAt,
      updatedAt: trail.updatedAt,
      hops: trail.hops.map((hop) => ({
        dir: hop.dir,
        name: hop.name,
        qualifiedName: hop.qualifiedName,
        kind: hop.kind,
        file: hop.savedFile,
        line: hop.savedLine,
        id: hop.id ?? '',
      })),
    },
    null,
    2
  )}\n`;
}
