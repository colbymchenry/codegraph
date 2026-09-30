/**
 * How an edge's SCIP standing reads in MCP answers (fork).
 *
 * Only edges in files a SCIP index covers carry a verdict; everything else
 * renders exactly as upstream.
 */

import type { Edge } from '../types';

export type ScipVerdict = 'verified' | 'unverified';

export function scipVerdict(edge: Edge | null | undefined): ScipVerdict | null {
  if (!edge) return null;
  const m = edge.metadata as Record<string, unknown> | undefined;
  if (m?.scipStale === true || m?.scipSilent === true) return 'unverified';
  return edge.provenance === 'scip' ? 'verified' : null;
}

/** Suffix for a Flow step's edge label. */
export function scipFlowNote(edge: Edge | null | undefined): string {
  const v = scipVerdict(edge);
  if (v === 'verified' && (edge?.metadata as Record<string, unknown> | undefined)?.scipDispatch === true) {
    return ' (compiler-verified, through the interface it implements)';
  }
  if (v === 'verified') return ' (compiler-verified)';
  if (v === 'unverified') return ' (unverified: the type checker could not confirm this call)';
  return '';
}

/** Suffix for a trail entry — only the exception is worth the tokens there. */
export function scipTrailNote(edge: Edge | null | undefined): string {
  return scipVerdict(edge) === 'unverified' ? ' [unverified]' : '';
}
