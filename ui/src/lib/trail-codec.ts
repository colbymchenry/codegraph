/**
 * The trail's wire format — the part with no state in it.
 *
 * Split out of `trail.svelte.ts` so it can be tested without a Svelte runtime:
 * the round-trip through the URL is the whole reason the trail is shareable,
 * and it is the one part of the trail that can be silently wrong.
 *
 * Encoding: comma-separated tokens, each `<dir><encoded id>` where dir is
 * `s` (start) | `d` (stepped down, into a call) | `u` (stepped up, to a
 * caller). The dir char is ALWAYS present — an id may itself begin with 'd'
 * or 'u' (`union:…`), so an optional prefix would be ambiguous.
 */

export type HopDirection = 'start' | 'down' | 'up';

export interface TrailHop {
  id: string;
  /** null until the node is fetched; render `hopLabel()` rather than this. */
  name: string | null;
  kind: string | null;
  dir: HopDirection;
}

const DIR_TO_CHAR: Record<HopDirection, string> = { start: 's', down: 'd', up: 'u' };
const CHAR_TO_DIR: Record<string, HopDirection> = { s: 'start', d: 'down', u: 'up' };

/**
 * A readable stand-in for a hop whose name has not been resolved yet.
 *
 * Only ever seen for a moment: a cold load asks `/api/nodes` for the names of
 * every hop it restored from the URL. It still has to be readable, because a
 * slow answer would otherwise put a 32-character hash in the trail bar.
 */
export function hopLabel(hop: TrailHop): string {
  if (hop.name) return hop.name;
  const body = hop.id.includes(':') ? hop.id.slice(hop.id.indexOf(':') + 1) : hop.id;
  // Path-shaped ids (`file:src/mcp/tools.ts`) read best as their basename.
  const basename = body.slice(body.lastIndexOf('/') + 1);
  if (basename.length === 0 || basename.length > 40) return `${body.slice(0, 8)}…`;
  // A content hash is not a name: shown whole it is a wall of hex wide enough
  // to push the rest of the trail off screen.
  if (/^[0-9a-f]{16,}$/.test(basename)) return `${basename.slice(0, 8)}…`;
  return basename;
}

export function encodeTrail(hops: readonly TrailHop[]): string {
  return hops.map((h) => DIR_TO_CHAR[h.dir] + encodeURIComponent(h.id)).join(',');
}

export function decodeTrail(encoded: string | null): TrailHop[] {
  if (!encoded) return [];
  const hops: TrailHop[] = [];
  for (const token of encoded.split(',')) {
    if (token.length < 2) continue;
    const dir = CHAR_TO_DIR[token[0] as string];
    if (!dir) continue;
    let id: string;
    try {
      id = decodeURIComponent(token.slice(1));
    } catch {
      id = token.slice(1);
    }
    if (id) hops.push({ id, name: null, kind: null, dir });
  }
  return hops;
}

