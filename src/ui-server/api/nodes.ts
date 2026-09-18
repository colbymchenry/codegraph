/**
 * `GET /api/nodes?id=…&id=…` — names for ids you already have.
 *
 * The trail is the reason this exists. It travels in the URL, and a URL can
 * only carry ids, so a shared or reloaded six-hop trail arrives as six opaque
 * `method:<hash>` strings with nothing to draw. Every other screen learns a
 * symbol's name as a side effect of asking for the symbol; the trail never
 * asks, because it draws hops it is not looking at.
 *
 * Deliberately the ref shape (`WireNodeRef`) and not the Symbol view payload:
 * six of those would ship six rail sets and six blast radiuses to render six
 * words. Ids arrive as repeated `id` parameters rather than one comma-joined
 * list — a node id can be a file path, and a file path can contain a comma.
 */

import type { CodeGraph } from '../../index';
import { badRequest } from './respond';
import { toNodeRef, type WireNodeRef } from './wire';

/** Ids per request. A trail long enough to exceed this is not a trail. */
export const MAX_NODE_REFS = 60;

export interface WireNodeRefs {
  items: WireNodeRef[];
  /** Ids that name nothing in this index — a stale link, not an error. */
  missing: string[];
}

export function buildNodeRefs(cg: CodeGraph, query: URLSearchParams): WireNodeRefs {
  const ids = query.getAll('id').filter((id) => id !== '');
  if (ids.length === 0) {
    throw badRequest(
      'No ids were given.',
      'Use /api/nodes?id=<id>&id=<id> — one `id` parameter per symbol.'
    );
  }
  if (ids.length > MAX_NODE_REFS) {
    throw badRequest(`Too many ids: ${ids.length}. At most ${MAX_NODE_REFS} per request.`);
  }

  const unique = [...new Set(ids)];
  const byId = cg.getNodesByIds(unique);

  const items: WireNodeRef[] = [];
  const missing: string[] = [];
  // Answer in the order asked, so the caller never has to re-sort.
  for (const id of unique) {
    const node = byId.get(id);
    if (node) items.push(toNodeRef(node));
    else missing.push(id);
  }

  return { items, missing };
}
