import type { Edge } from '../types';

/**
 * A transport edge (`metadata.transportOnly: true`) records a real ABI hop into
 * a shared entry point that runs a different operation per call; the operation
 * edges beside it record which handler each source call selects. Through the
 * shared entry every caller would reach every operation, so walks show a
 * transport hop as a boundary and never pass through it:
 *
 * - forward, it ends a path at the entry;
 * - backward, only a walk that starts at the entry crosses it, so the entry's
 *   callers and impact include its transport sites, while code behind the
 *   entry reaches the entry and stops there;
 * - an undirected walk keeps the edge but does not expand its far end.
 *
 * Raw edge queries keep every edge. Only the explicit boolean marker makes an
 * edge transport.
 */
export function isTransportEdge(edge: Edge): boolean {
  return edge.metadata?.transportOnly === true;
}
