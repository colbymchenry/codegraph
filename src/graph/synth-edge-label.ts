import type { Edge } from '../types';

/** One interpretation of author-provided labels across engine and viewer. */
export function synthEdgeLabel(edge: Pick<Edge, 'metadata'>): string | undefined {
  const label = edge.metadata?.label;
  if (typeof label === 'string' && label.trim()) return label;
  return undefined;
}
