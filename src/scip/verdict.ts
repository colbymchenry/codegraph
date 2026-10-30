/**
 * How the merge's verdicts sit on an edge: `provenance = 'scip'` for a
 * compiler-verified edge, plus flags in its JSON `metadata` (what each means:
 * merge.ts). Every statement that writes or reads a flag builds it here, so the
 * writers' encoding and the readers' patterns can't drift apart.
 */

export type EdgeFlag = 'scipSilent' | 'scipStale' | 'scipDispatch';

/** SET clause: raise `flag` (json_set writes `"flag":true`, no spaces — what hasFlag matches). */
export function setFlag(flag: EdgeFlag): string {
  return `metadata = json_set(COALESCE(metadata, '{}'), '$.${flag}', json('true'))`;
}

/** SET clause: drop `flag`. */
export function clearFlag(flag: EdgeFlag): string {
  return `metadata = json_remove(metadata, '$.${flag}')`;
}

/**
 * An edge carrying `flag`. COALESCE so `NOT (…)` stays true when metadata is NULL —
 * SQLite's `NOT (NULL LIKE …)` is unknown and would drop verified scip edges from
 * status counts (playwright: ~24k null-meta edges).
 */
function hasFlag(flag: EdgeFlag): string {
  return `COALESCE(metadata,'') LIKE '%"${flag}":true%'`;
}

/**
 * A loose match for `flag` in `column`, as a cheap filter before an UPDATE. Not
 * SILENT_EDGE's expression on purpose: that one would let the planner scan its
 * partial index once per file.
 */
export function mentionsFlag(flag: EdgeFlag, column = 'metadata'): string {
  return `${column} LIKE '%${flag}%'`;
}

/** A heuristic edge the compiler could not confirm. The partial index scip_silent_edges is defined by this exact text. */
export const SILENT_EDGE = hasFlag('scipSilent');

/** A SCIP edge whose ends changed since it was verified. */
export const STALE_EDGE = hasFlag('scipStale');

/** Compiler-verified: a SCIP edge neither silent nor stale. */
export const VERIFIED_EDGE = `provenance = 'scip' AND NOT (${SILENT_EDGE}) AND NOT (${STALE_EDGE})`;
