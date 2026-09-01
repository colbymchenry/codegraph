/**
 * The trail — the path of symbols the reader walked to get here.
 *
 * Hops live in memory (they carry names and kinds, which the URL cannot),
 * and are mirrored into the `t` query param so a reload or a shared link
 * still reproduces the walk. On a cold load only the ids survive; names are
 * filled in by `resolve()` as each hop's node is fetched. The wire format
 * itself lives in `trail-codec.ts`, where it can be tested without a runtime.
 */

import { fetchNodeRefs } from './api';
import { encodeTrail, decodeTrail, type HopDirection, type TrailHop } from './trail-codec';

export { encodeTrail, decodeTrail, hopLabel } from './trail-codec';
export type { HopDirection, TrailHop } from './trail-codec';

let hops = $state<TrailHop[]>([]);

/**
 * Every name this session has learned, by id.
 *
 * The hop objects cannot carry it: truncating the trail throws them away, and
 * walking back through history rebuilds the dropped hops from the URL, which
 * holds ids and nothing else. Without this cache the bar would re-fetch — or,
 * worse, redraw a hash for a symbol it had already named a second ago.
 */
const known = new Map<string, { name: string | null; kind: string | null }>();

function remember(id: string, info: { name?: string | null; kind?: string | null }): void {
  // Nothing to remember is not an entry: an empty one would read as "already
  // known" and stop the bar from ever asking for the name.
  if (!info.name && !info.kind) return;
  const at = known.get(id) ?? { name: null, kind: null };
  if (info.name) at.name = info.name;
  if (info.kind) at.kind = info.kind;
  known.set(id, at);
}

export const trail = {
  get hops(): readonly TrailHop[] {
    return hops;
  },
  get current(): TrailHop | null {
    return hops.length > 0 ? (hops[hops.length - 1] as TrailHop) : null;
  },
  get encoded(): string {
    return encodeTrail(hops);
  },

  /**
   * Walk to `id`. Re-visiting a symbol already on the trail truncates back to
   * it rather than appending, so stepping up and back down does not grow a
   * loop — the trail is a path, not a history.
   */
  push(hop: { id: string; name?: string | null; kind?: string | null; dir?: HopDirection }): void {
    remember(hop.id, hop);
    const existing = hops.findIndex((h) => h.id === hop.id);
    if (existing >= 0) {
      hops = hops.slice(0, existing + 1);
      const at = hops[existing] as TrailHop;
      if (hop.name) at.name = hop.name;
      if (hop.kind) at.kind = hop.kind;
      return;
    }
    hops = [
      ...hops,
      {
        id: hop.id,
        name: hop.name ?? null,
        kind: hop.kind ?? null,
        dir: hop.dir ?? (hops.length === 0 ? 'start' : 'down'),
      },
    ];
  },

  /**
   * The same symbol, under a new id.
   *
   * A node's id contains its start LINE (`generateNodeId`), so any edit above a
   * symbol gives it a different id at the next sync — while it is the same
   * symbol, in the same place in the reader's path. Swapping it in place keeps
   * the trail a path; pushing the new id would draw a hop that describes no
   * call, and dropping the trail would lose the walk that got here.
   */
  rename(oldId: string, next: { id: string; name?: string | null; kind?: string | null }): void {
    const at = hops.findIndex((h) => h.id === oldId);
    if (at < 0) return;
    remember(next.id, next);
    const hop = hops[at] as TrailHop;
    hops = [
      ...hops.slice(0, at),
      { ...hop, id: next.id, name: next.name ?? hop.name, kind: next.kind ?? hop.kind },
      ...hops.slice(at + 1),
    ];
  },

  /** Drop every hop after `index`, making it the current one. */
  truncateTo(index: number): void {
    if (index < 0 || index >= hops.length) return;
    hops = hops.slice(0, index + 1);
  },

  /** Fill in the name/kind of a hop once its node has been fetched. */
  resolve(id: string, info: { name?: string | null; kind?: string | null }): void {
    remember(id, info);
    const hop = hops.find((h) => h.id === id);
    if (!hop) return;
    if (info.name) hop.name = info.name;
    if (info.kind) hop.kind = info.kind;
  },

  clear(): void {
    hops = [];
  },

  /** Adopt the hops encoded in a URL (cold load / back navigation). */
  hydrate(encoded: string | null): void {
    const decoded = decodeTrail(encoded);
    if (encodeTrail(decoded) === encodeTrail(hops)) return;
    // Names survive the change — including for hops this trail dropped earlier
    // and history has just brought back.
    hops = decoded.map((h) => {
      const seen = known.get(h.id);
      return seen ? { ...h, name: seen.name, kind: seen.kind } : h;
    });
  },
};

/**
 * Give the hops restored from a URL their names back.
 *
 * A trail travels as ids, so a shared or reloaded link arrives with every hop
 * but the one on screen unnamed — and `hopLabel` then draws a hash. One batched
 * request fixes the whole bar. Ids that name nothing are marked resolved with
 * the label they already had, so a stale link asks once and not on every
 * re-render.
 */
const nameless = new Set<string>();

export async function resolveTrailNames(): Promise<void> {
  const unknown = hops
    .filter((hop) => !hop.name && !known.get(hop.id)?.name && !nameless.has(hop.id))
    .map((hop) => hop.id);
  if (unknown.length === 0) return;
  try {
    const { items, missing } = await fetchNodeRefs(unknown);
    for (const node of items) {
      trail.resolve(node.id, {
        name: node.kind === 'file' ? node.file : node.name,
        kind: node.kind,
      });
    }
    // An id this index does not hold is a stale link. Recorded so the bar asks
    // once rather than on every redraw.
    for (const id of missing) nameless.add(id);
  } catch {
    // A name is a nicety; the hop still navigates without one.
  }
}
