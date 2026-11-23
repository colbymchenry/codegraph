/**
 * How a caller's call sites read, wherever callers are listed: `codegraph
 * callers`, codegraph_callers and the trail of codegraph_node (#2909). Each
 * site is a line to edit when the symbol changes, so the list says them all,
 * up to a cap that keeps one busy caller from crowding out the rest.
 */
import type { Edge } from '../types';

/** The lines `edges` sit on, ascending, once each. An edge with no line adds none. */
export function callSiteLines(edges: readonly Edge[]): number[] {
  const lines = new Set<number>();
  for (const edge of edges) {
    if (typeof edge.line === 'number' && edge.line > 0) lines.add(edge.line);
  }
  return [...lines].sort((a, b) => a - b);
}

/** `9, 10, 14`, or past `max` lines `9, 10, 14, +7 more`. */
export function formatCallSiteLines(lines: readonly number[], max: number): string {
  const shown = lines.slice(0, max).join(', ');
  return lines.length > max ? `${shown}, +${lines.length - max} more` : shown;
}

/**
 * `rows` with the ones that aren't test code first, each half in its own
 * order. Callers come back in id order, so a symbol called mostly from tests
 * can fill a capped list with tests while the callers that run in production
 * sit past the cap, and an agent reads the page as the whole answer.
 */
export function nonTestFirst<T>(rows: readonly T[], isTest: (row: T) => boolean): T[] {
  const tests: T[] = [];
  const rest: T[] = [];
  for (const row of rows) (isTest(row) ? tests : rest).push(row);
  return [...rest, ...tests];
}
