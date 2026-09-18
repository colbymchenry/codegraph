import type { WireMapPayload } from './wire';
import { selectEligibleMapGraph } from './map-eligibility';

/** The direction that owns traversal semantics, not URL serialization. */
export type MapFocusDirection = 'depends-on' | 'used-by';

/** The resolved aggregation identity that Focus must retain across refreshes. */
export interface MapFocusGrouping {
  readonly root: string;
  readonly depth: number;
}

/**
 * Keep a module and its complete transitive relationship closure. This operates
 * before layout's visual thinning, so a thin link cannot sever a focused path.
 */
export function focusMapPayload(
  payload: WireMapPayload,
  anchor: string,
  direction: MapFocusDirection,
  includeTests: boolean
): WireMapPayload | null {
  const { ids, links } = selectEligibleMapGraph(payload, includeTests);
  if (!ids.has(anchor)) return null;
  const visited = new Set([anchor]);
  const work = [anchor];
  while (work.length > 0) {
    const current = work.pop();
    if (current === undefined) break;
    for (const link of links) {
      const next = direction === 'depends-on'
        ? (link.source === current ? link.target : null)
        : (link.target === current ? link.source : null);
      if (next !== null && !visited.has(next)) {
        visited.add(next);
        work.push(next);
      }
    }
  }

  return {
    ...payload,
    modules: payload.modules.filter((module) => visited.has(module.id)),
    links: links.filter((link) => visited.has(link.source) && visited.has(link.target)),
  };
}
