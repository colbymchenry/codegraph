/**
 * The Screens view's model — the app's screens and the transitions between
 * them, laid out so that a screen sits above the screens it opens.
 *
 * The layout is the Map's (`buildMapLayout`): the same barycenter ordering,
 * the same ports, the same determinism. A screen graph is a module graph with
 * different words — nodes with names, weighted links that mostly point one
 * way — but it differs from a module graph in one thing that shapes the
 * picture: it is full of cycles. Every screen returns to Home. So this file
 * asks the layout for three things the Map leaves alone:
 *
 * - **layering by distance from the entry screen** (`entryLayering`), where
 *   "one layer above what it depends on" would put the head of the longest
 *   chain of screens above the login page;
 * - **directional ports**, so a return trip leaves the top of its source and
 *   arrives at the bottom of its target — drawn around the boxes, not through
 *   them — and a transition between two screens on one row arches over it;
 * - **room**: a wider layer gap, because the edges here carry labels, and a
 *   port pitch, because a hub with nineteen lines leaving it needs to be wide
 *   enough for a reader to follow one back.
 *
 * What is this file's own: which links share a pair (several transitions from
 * Home to Capture, each with its own condition, draw as ONE edge whose label
 * counts them), the words on that edge, where on the canvas those words sit
 * (`placeLabels`), the curve every edge draws — each with its own height
 * through the gap, so a hub's lines fan out instead of stacking
 * (`trackedCurves`) — which line is under the pointer (`nearestEdge`), and
 * the two lists the side panel shows for a selected screen.
 */

import type { WireMapLink, WireMapModule, WireScreen, WireScreenLink, WireScreensPayload } from './wire';
import { clauseWords, clauses } from './conditions';
import {
  buildMapLayout,
  linkId,
  portPoint,
  PORT_PITCH,
  type EdgeRoute,
  type MapEdgeLayout,
  type MapLayout,
  type MapNodeLayout,
} from './map-model';

/* ------------------------------------------------------------- geometry -- */

/**
 * Vertical room between two rows of screens. The Map's 74px holds hairlines;
 * this holds labels — five lanes of them (see {@link laneCount}) with their
 * margins.
 */
export const SCREEN_LAYER_GAP = 116;

/** The widest `level` arch in a fan rises this fraction of the layer gap above its row… */
const LEVEL_RISE = 0.66;
/** …and the narrowest this much less, so nested arches stay apart. */
const LEVEL_NEST = 0.26;
/** Points a curve is sampled at for hit-testing; at 116px tall, under a pixel off. */
const HIT_SAMPLES = 24;

/** IBM Plex Mono at 10.5px advances ~6.3px per character; the pill adds 6px each side. */
export const PILL_CHAR_WIDTH = 6.3;
export const PILL_PADDING = 12;
export const PILL_HEIGHT = 17;
/** From a box's edge to the centre of the first lane of pills beside it. */
export const PILL_OFFSET = 13;
/** From one lane to the next: a pill and 4px of paper. */
export const LANE_STEP = PILL_HEIGHT + 4;
/** Two pills on one lane keep this much paper between them. */
const PILL_GAP_X = 4;
/** The last lane keeps this much clear of the neighbouring row's boxes. */
const BAND_MARGIN = 2;

/**
 * The longest label a pill prints before an ellipsis; the tooltip and the
 * panel have the rest. Sized so the innermost clause of a typical guard
 * (`guide.dontShowAgain.captureGuide`, 32 characters) fits whole even as
 * `…not guide.dontShowAgain.captureGuide` — the negation is a word now.
 */
export const EDGE_LABEL_MAX = 40;

/* ---------------------------------------------------------------- model -- */

export interface ScreenNodeInfo {
  id: string;
  /** `/object-detail`, or a function name for an origin. */
  label: string;
  /** The component's name for a screen; the file for an origin. */
  sub: string;
  screen: WireScreen | null;
  /** A navigation that could not be attributed to a screen. */
  origin: boolean;
  entry: boolean;
  /** No path of transitions leads here from the entry screen. */
  unreached: boolean;
}

export interface ScreenEdgeInfo {
  id: string;
  from: string;
  to: string;
  /** Every transition between the pair — one connector, several stories. */
  links: WireScreenLink[];
  /** The connector's short label: the innermost condition, or how many transitions. */
  label: string;
  synthesized: boolean;
}

export interface ScreensModel {
  layout: MapLayout;
  nodes: Map<string, ScreenNodeInfo>;
  /** Keyed by the layout edge's id (see `linkId`). */
  edges: Map<string, ScreenEdgeInfo>;
  /** Screens no chain of transitions reaches from the entry. */
  unreached: number;
  /** The vertical room between rows the layout was built with. */
  layerGap: number;
  /** Every edge's curve, keyed by edge id — see {@link trackedCurves}. */
  curves: Map<string, Curve>;
  /** The same curves sampled for hit-testing — see {@link nearestEdge}. */
  polylines: Map<string, Point[]>;
}

export interface Point {
  x: number;
  y: number;
}

/**
 * What the label placement and the pointer need from a picture: the Screens
 * view's model, or any other drawn with its machinery (the Steps view draws
 * typed steps with the same layout, curves, pills and hit-testing).
 */
export interface Picture {
  layout: MapLayout;
  layerGap: number;
  edges: Map<string, { label: string }>;
  curves: Map<string, Curve>;
  polylines: Map<string, Point[]>;
}

/* ------------------------------------------------------------- layering -- */

/**
 * Layer = distance from the entry screen: the entry on top, each row down one
 * more transition away, measured over EVERY transition — the two-cycle break
 * the Map performs for its own layering is irrelevant to a distance, so the
 * links come in through the closure rather than through the argument the
 * layout hands over.
 *
 * Origins (shared chrome, a store action after login) are not screens and
 * have no distance of their own. Each hangs one row above the shallowest
 * screen it opens, so what it opens is below it and what it opens is placed
 * by the entry, not by the chrome: a top bar rendered on ten screens must not
 * drag `/settings` up beside the home screen. An origin whose targets nothing
 * else reaches seeds them from wherever it sits, so they are still placed.
 *
 * Whatever nothing reaches sits in a band at the bottom, layered among itself
 * by the same rule from its own sources — a screen the graph cannot see
 * anyone open is a fact worth a place, not a crash.
 */
export function entryLayering(
  entry: string | null,
  origins: readonly string[],
  links: ReadonlyArray<{ source: string; target: string }>
) {
  return (ids: string[]): Map<string, number> => {
    const present = new Set(ids);
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
    for (const l of links) {
      if (!present.has(l.source) || !present.has(l.target) || l.source === l.target) continue;
      out.get(l.source)!.push(l.target);
      indeg.set(l.target, (indeg.get(l.target) ?? 0) + 1);
    }
    for (const list of out.values()) list.sort();

    const depth = new Map<string, number>();
    // Multi-source BFS whose sources may start at different depths: buckets
    // processed in ascending order, first assignment wins, so a node's depth
    // is the least over every source — and a depth already set is never
    // lowered by a later phase.
    const walk = (starts: ReadonlyArray<[string, number]>): void => {
      const buckets = new Map<number, string[]>();
      const push = (id: string, d: number): void => {
        if (depth.has(id)) return;
        depth.set(id, d);
        const list = buckets.get(d);
        if (list) list.push(id);
        else buckets.set(d, [id]);
      };
      let maxStart = 0;
      for (const [id, d] of starts) {
        push(id, d);
        maxStart = Math.max(maxStart, d);
      }
      for (let d = 0; d <= ids.length + maxStart; d++) {
        const list = buckets.get(d);
        if (!list) continue;
        for (const id of list) for (const t of out.get(id) ?? []) push(t, d + 1);
      }
    };

    // Phase 1: the screens, by distance from the entry.
    if (entry !== null && present.has(entry)) walk([[entry, 0]]);
    // Phase 2: each origin above its shallowest placed target; then whatever
    // only the origins reach, from them.
    const seeds: Array<[string, number]> = [];
    for (const origin of [...origins].filter((o) => present.has(o)).sort()) {
      const placed = (out.get(origin) ?? []).map((t) => depth.get(t)).filter((d): d is number => d !== undefined);
      seeds.push([origin, placed.length > 0 ? Math.max(0, Math.min(...placed) - 1) : 0]);
    }
    walk(seeds);

    const reachedMax = Math.max(0, ...[...depth.values()]);
    // The unreached band: its own sources first, then whatever they open.
    const rest = ids.filter((id) => !depth.has(id));
    const restDepth = new Map<string, number>();
    if (rest.length > 0) {
      const restSet = new Set(rest);
      const restSources = rest.filter((id) => (indeg.get(id) ?? 0) === 0);
      let frontier = restSources.length > 0 ? restSources : [rest[0]!];
      for (const s of frontier) restDepth.set(s, 0);
      let d = 0;
      while (frontier.length > 0) {
        d++;
        const next: string[] = [];
        for (const id of frontier) {
          for (const t of out.get(id) ?? []) {
            if (restDepth.has(t) || !restSet.has(t)) continue;
            restDepth.set(t, d);
            next.push(t);
          }
        }
        frontier = next;
      }
      for (const id of rest) if (!restDepth.has(id)) restDepth.set(id, 0);
    }
    const restMax = Math.max(0, ...[...restDepth.values()]);
    // Layer 0 is the bottom. Unreached band occupies [0, restMax]; reached
    // screens sit above it, the entry highest, with one empty row between.
    const base = rest.length > 0 ? restMax + 2 : 0;
    const layer = new Map<string, number>();
    for (const [id, d] of depth) layer.set(id, base + reachedMax - d);
    for (const [id, d] of restDepth) layer.set(id, restMax - d);
    return layer;
  };
}

/* --------------------------------------------------------------- labels -- */

export { clauses } from './conditions';

/**
 * What the connector says. Empty when unconditional and single.
 *
 * A single transition is labelled with its innermost condition — the one
 * checked right at the navigation call — with an ellipsis in front when outer
 * guards precede it. The whole chain is often seventy characters and its
 * first thirty are usually shared with a sibling (`!loading && !(!objectId
 * …` on both arms of a fork); the last clause is the one that tells the two
 * apart, and the full text is a hover away.
 */
export function edgeLabel(links: ReadonlyArray<{ when: string; sites?: ReadonlyArray<{ when: string }> }>): string {
  // A link with several call sites is several scenarios: count them as ways.
  const ways = links.flatMap((l) => (l.sites && l.sites.length > 1 ? l.sites.map((s) => s.when) : [l.when]));
  if (ways.length === 1) {
    const when = ways[0]!;
    if (!when) return '';
    const parts = clauses(when);
    const last = clauseWords(parts[parts.length - 1] ?? when);
    const text = parts.length > 1 ? `…${last}` : last;
    return text.length > EDGE_LABEL_MAX ? `${text.slice(0, EDGE_LABEL_MAX - 1)}…` : text;
  }
  const conditional = ways.filter((w) => w).length;
  return conditional > 0 ? `${ways.length} ways · ${conditional} conditional` : `${ways.length} ways`;
}

/* ---------------------------------------------------------------- build -- */

export function buildScreensModel(payload: WireScreensPayload): ScreensModel {
  const nodes = new Map<string, ScreenNodeInfo>();
  const modules: WireMapModule[] = [];

  for (const screen of payload.screens) {
    const info: ScreenNodeInfo = {
      id: screen.id,
      label: screen.path,
      sub: screen.component?.name ?? screen.file,
      screen,
      origin: false,
      entry: payload.entry === screen.id,
      unreached: false,
    };
    nodes.set(screen.id, info);
    modules.push(moduleFor(info, screen.incoming + screen.outgoing));
  }
  for (const origin of payload.origins) {
    const info: ScreenNodeInfo = {
      id: origin.id,
      label: origin.node.kind === 'component' ? `<${origin.node.name}>` : `${origin.node.name}()`,
      sub: origin.sharedBy ? `on ${origin.sharedBy} screens` : origin.node.file,
      screen: null,
      origin: true,
      entry: false,
      unreached: false,
    };
    nodes.set(origin.id, info);
    modules.push(moduleFor(info, origin.outgoing));
  }

  // One layout link per (from, to); the transitions behind it stay listed.
  const byPair = new Map<string, WireScreenLink[]>();
  for (const link of payload.links) {
    const key = linkId({ source: link.from, target: link.to });
    const list = byPair.get(key) ?? [];
    list.push(link);
    byPair.set(key, list);
  }
  const links: WireMapLink[] = [];
  const edges = new Map<string, ScreenEdgeInfo>();
  for (const [key, group] of byPair) {
    const first = group[0]!;
    if (!nodes.has(first.from) || !nodes.has(first.to)) continue;
    // A screen that reopens itself (a retry) is a fact for the panel, not an
    // arrow the layout can draw.
    if (first.from === first.to) continue;
    links.push({
      source: first.from,
      target: first.to,
      count: group.length,
      declared: group.length,
      byKind: [{ kind: 'navigates', count: group.length }],
      topPairs: [],
    });
    edges.set(key, {
      id: key,
      from: first.from,
      to: first.to,
      links: group,
      label: edgeLabel(group),
      synthesized: group.every((l) => l.synthesized),
    });
  }

  // Reachability from the entry (and from the origins, which are entries of
  // a kind: chrome is on the screen the user is on).
  const seeds = payload.origins.map((o) => o.id);
  const reachable = new Set<string>();
  {
    const out = new Map<string, string[]>();
    for (const l of payload.links) out.set(l.from, [...(out.get(l.from) ?? []), l.to]);
    const stack = [payload.entry, ...seeds].filter((s): s is string => s !== null);
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (reachable.has(id)) continue;
      reachable.add(id);
      for (const t of out.get(id) ?? []) stack.push(t);
    }
  }
  let unreached = 0;
  for (const info of nodes.values()) {
    if (!info.origin && !reachable.has(info.id)) {
      info.unreached = true;
      unreached++;
    }
  }

  const layout = buildMapLayout(
    { modules, links },
    {
      includeTests: true,
      minWeight: 0,
      sizing: (m) => {
        const info = nodes.get(m.id);
        return { label: info?.label ?? m.id, meta: info?.sub ?? '' };
      },
      layering: entryLayering(payload.entry, seeds, links),
      layerGap: SCREEN_LAYER_GAP,
      portPitch: PORT_PITCH,
      ports: 'directional',
    }
  );
  const curves = trackedCurves(layout, SCREEN_LAYER_GAP);
  const polylines = new Map<string, Point[]>();
  for (const [id, curve] of curves) polylines.set(id, samplePolyline(curve, HIT_SAMPLES));
  return { layout, nodes, edges, unreached, layerGap: SCREEN_LAYER_GAP, curves, polylines };
}

function moduleFor(info: ScreenNodeInfo, symbols: number): WireMapModule {
  return {
    id: info.id,
    label: info.label,
    files: 1,
    symbols,
    languages: [],
    test: false,
    generated: 0,
    generatedFiles: [],
    facade: false,
    fileList: { total: 1, shown: 1, truncated: false, items: [info.screen?.file ?? info.sub] },
  };
}

/** The side panel's two lists for a selected node. */
export function neighbourhood(
  payload: WireScreensPayload,
  id: string
): { opensFrom: WireScreenLink[]; goesTo: WireScreenLink[] } {
  const opensFrom = payload.links.filter((l) => l.to === id);
  const goesTo = payload.links.filter((l) => l.from === id);
  return { opensFrom, goesTo };
}

/** `ItemCard → openObjectDetail`, or '' when the screen's own component navigates. */
export function viaText(link: WireScreenLink): string {
  return link.via.map((v) => v.name).join(' → ');
}

/** The layout edge a transition draws as, or null when it is a self-loop. */
export function pairId(link: WireScreenLink): string | null {
  return link.from === link.to ? null : linkId({ source: link.from, target: link.to });
}

/* ---------------------------------------------------------------- curve -- */

/** A cubic Bézier: the point it leaves, two controls, the point it reaches. */
export interface Curve {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  x3: number;
  y3: number;
}

/**
 * The curve an edge draws, from its source port to its target port.
 *
 * `down` and `up` are the Map's cubic: it leaves and arrives vertically, with
 * both control points at one height — the midpoint unless a `track` says
 * otherwise (see {@link trackedCurves}). `level` joins two boxes on one row
 * from top to top, arching over the row — the only shape that touches neither
 * box on the way; `track` is then how far the arch rises. The same arithmetic
 * places the labels and answers the pointer, so a pill sits on the line the
 * browser draws and the line under the cursor is the one that lights.
 */
export function screenCurve(
  route: EdgeRoute,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  layerGap = SCREEN_LAYER_GAP,
  track?: number
): Curve {
  if (route === 'level') {
    const rise = track ?? Math.round(layerGap * LEVEL_RISE);
    return { x0: sx, y0: sy, x1: sx, y1: sy - rise, x2: tx, y2: ty - rise, x3: tx, y3: ty };
  }
  const midY = track ?? (sy + ty) / 2;
  return { x0: sx, y0: sy, x1: sx, y1: midY, x2: tx, y2: midY, x3: tx, y3: ty };
}

/** The SVG path of a curve. */
export function pathOf(c: Curve): string {
  return `M${c.x0},${c.y0} C${c.x1},${c.y1} ${c.x2},${c.y2} ${c.x3},${c.y3}`;
}

/** The SVG path of {@link screenCurve}. */
export function screenEdgePath(
  route: EdgeRoute,
  sx: number,
  sy: number,
  tx: number,
  ty: number,
  layerGap = SCREEN_LAYER_GAP
): string {
  return pathOf(screenCurve(route, sx, sy, tx, ty, layerGap));
}

/* --------------------------------------------------------------- tracks -- */

/**
 * Every edge's curve, each with its own height through the gap.
 *
 * Drawn through one midpoint, every line between two rows crosses that height
 * at its middle, and a line to a screen far to the side is nearly horizontal
 * there — so a hub's lines run stacked within a few pixels for hundreds, and
 * no pointer can pick one. Instead each line in a fan takes a track of its
 * own. A fan is the set of lines leaving one side of one box towards one
 * side; a line belongs to the bigger of the two fans at its ends (the upper
 * one on a tie). Within a fan the line whose far end is farthest out runs on
 * the track nearest the fan's own row, the next one a track further out, and
 * so on: nested, in the same order the ports along the box are, so no line in
 * a fan crosses another. A line spanning several rows keeps its track inside
 * the gap beside its fan and drops the rest of the way vertically. Level
 * arches nest the same way — the wider arch rises higher.
 */
export function trackedCurves(layout: MapLayout, layerGap: number): Map<string, Curve> {
  const nodes = new Map(layout.nodes.map((n) => [n.id, n]));
  const fanSize = (node: MapNodeLayout, side: 'top' | 'bottom'): number => node.ports[side].length;
  interface Member {
    edge: MapEdgeLayout;
    s: Point;
    t: Point;
    /** How far out the far end sits from the fan's box; the nesting order. */
    reach: number;
    /** For a `down`/`up` edge: the fan is at the upper end. */
    pivotUpper: boolean;
    up: Point;
    lo: Point;
  }
  const groups = new Map<string, Member[]>();
  for (const edge of layout.edges) {
    const from = nodes.get(edge.source);
    const to = nodes.get(edge.target);
    if (!from || !to) continue;
    const s = portPoint(from, edge.id, 'source');
    const t = portPoint(to, edge.id, 'target');
    let pivot: MapNodeLayout;
    let side: 'top' | 'bottom';
    let other: Point;
    let pivotUpper = true;
    let up = s;
    let lo = t;
    if (edge.route === 'level') {
      pivot = fanSize(to, 'top') > fanSize(from, 'top') ? to : from;
      side = 'top';
      other = pivot === from ? t : s;
    } else {
      const upperIsSource = edge.route === 'down';
      const upper = upperIsSource ? from : to;
      const lower = upperIsSource ? to : from;
      up = upperIsSource ? s : t;
      lo = upperIsSource ? t : s;
      pivotUpper = fanSize(upper, 'bottom') >= fanSize(lower, 'top');
      pivot = pivotUpper ? upper : lower;
      side = pivotUpper ? 'bottom' : 'top';
      other = pivotUpper ? lo : up;
    }
    const centre = pivot.x + pivot.width / 2;
    const key = `${pivot.id}\u0000${side}\u0000${other.x < centre ? 'L' : 'R'}`;
    const list = groups.get(key) ?? [];
    list.push({ edge, s, t, reach: Math.abs(other.x - centre), pivotUpper, up, lo });
    groups.set(key, list);
  }

  const curves = new Map<string, Curve>();
  for (const members of groups.values()) {
    members.sort((a, b) => b.reach - a.reach || a.edge.id.localeCompare(b.edge.id));
    const n = members.length;
    members.forEach((m, k) => {
      const { edge, s, t } = m;
      if (edge.route === 'level') {
        const rise = Math.round(layerGap * (LEVEL_RISE - (LEVEL_NEST * k) / Math.max(1, n - 1)));
        curves.set(edge.id, screenCurve('level', s.x, s.y, t.x, t.y, layerGap, rise));
        return;
      }
      const f = (k + 1) / (n + 1);
      const span = Math.min(m.lo.y - m.up.y, layerGap);
      const track = m.pivotUpper ? m.up.y + span * f : m.lo.y - span * f;
      curves.set(edge.id, screenCurve(edge.route, s.x, s.y, t.x, t.y, layerGap, track));
    });
  }
  return curves;
}

/* ------------------------------------------------------------ pointing -- */

/** The curve as `count` points from source to target, for distance tests. */
export function samplePolyline(c: Curve, count = HIT_SAMPLES): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < count; i++) out.push(pointAt(c, i / (count - 1)));
  return out;
}

function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  const x = a.x + t * dx - p.x;
  const y = a.y + t * dy - p.y;
  return Math.sqrt(x * x + y * y);
}

export function distanceToPolyline(p: Point, line: readonly Point[]): number {
  let best = Infinity;
  for (let i = 1; i < line.length; i++) best = Math.min(best, distanceToSegment(p, line[i - 1]!, line[i]!));
  return best;
}

export interface EdgeHit {
  id: string;
  distance: number;
}

/**
 * The edge nearest `point` within `reach`, among the ids given (every edge
 * when null). This is what hovering means on the canvas: not "the topmost hit
 * path under the pointer", which in a bundle of eight lines four pixels apart
 * is whichever one the DOM drew last, but the line the pointer is closest to
 * — so moving three pixels moves to the next line, predictably. Ties go to
 * the smaller id, so two visits agree.
 */
export function nearestEdge(
  model: Picture,
  point: Point,
  among: ReadonlySet<string> | null,
  reach: number
): EdgeHit | null {
  let best: EdgeHit | null = null;
  for (const [id, line] of model.polylines) {
    if (among !== null && !among.has(id)) continue;
    const distance = distanceToPolyline(point, line);
    if (distance > reach) continue;
    if (best === null || distance < best.distance || (distance === best.distance && id < best.id)) {
      best = { id, distance };
    }
  }
  return best;
}

/** The point at `t` on the curve, 0 = source, 1 = target. */
export function pointAt(c: Curve, t: number): { x: number; y: number } {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return { x: a * c.x0 + b * c.x1 + d * c.x2 + e * c.x3, y: a * c.y0 + b * c.y1 + d * c.y2 + e * c.y3 };
}

/**
 * The parameter at which the curve passes height `y`, or null when it never
 * does. A `down`/`up` curve is monotonic in y end to end; a `level` arch
 * rises and falls, so it is searched on the half nearest `end`.
 */
export function tAtY(c: Curve, y: number, end: 'source' | 'target'): number | null {
  const arch = c.y0 === c.y3;
  let lo = arch && end === 'target' ? 0.5 : 0;
  let hi = arch && end === 'source' ? 0.5 : 1;
  const yLo = pointAt(c, lo).y;
  const yHi = pointAt(c, hi).y;
  if (y < Math.min(yLo, yHi) - 1e-6 || y > Math.max(yLo, yHi) + 1e-6) return null;
  const rising = yHi > yLo;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (pointAt(c, mid).y < y === rising) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/* ---------------------------------------------------------------- pills -- */

export interface PillPlacement {
  edge: string;
  text: string;
  /** Centre of the pill, in canvas coordinates. */
  x: number;
  y: number;
  /** Estimated from the text; what the lane arithmetic reserved. */
  width: number;
  lane: number;
  /** The end of the edge the pill sits at. */
  end: 'source' | 'target';
}

export interface PillLayout {
  pills: Map<string, PillPlacement>;
  /** Labels that found no lane; the panel says so. */
  hidden: number;
}

export function pillWidth(text: string): number {
  return text.length * PILL_CHAR_WIDTH + PILL_PADDING;
}

/** How many lanes of pills fit between two rows `layerGap` apart. */
export function laneCount(layerGap: number): number {
  return Math.max(1, Math.floor((layerGap - BAND_MARGIN - PILL_HEIGHT / 2 - PILL_OFFSET) / LANE_STEP) + 1);
}

/**
 * The words on a pill: an arrow for which way the transition runs relative to
 * the selected screen — `→` leaving it, `←` arriving — and the edge's label.
 * Empty when the edge has nothing to say (a single, unconditional transition).
 */
export function pillText(info: { label: string }, edge: MapEdgeLayout, selected: string | null): string {
  if (!info.label) return '';
  const arriving = selected !== null && edge.target === selected && edge.source !== selected;
  return `${arriving ? '←' : '→'} ${info.label}`;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function intersects(a: Rect, b: Rect, gapX: number): boolean {
  return a.x < b.x + b.w + gapX && b.x < a.x + a.w + gapX && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Lay a pill beside the box at `end` of the edge: the first lane whose pill
 * would overlap nothing already placed, walking away from the box one lane
 * at a time, each pill centred on its own line at that height. Null when no
 * lane is free — or when `lanes` is 1 and that lane is taken.
 */
function layPill(
  model: Picture,
  edge: MapEdgeLayout,
  end: 'source' | 'target',
  text: string,
  nodes: Map<string, MapNodeLayout>,
  lanes: number,
  taken: Rect[],
  bounds: { width: number; height: number }
): { pill: PillPlacement; rect: Rect } | null {
  const curve = model.curves.get(edge.id);
  const box = nodes.get(end === 'source' ? edge.source : edge.target);
  if (!curve || !box) return null;
  const port = end === 'source' ? { x: curve.x0, y: curve.y0 } : { x: curve.x3, y: curve.y3 };
  const above = port.y === box.y;
  const width = pillWidth(text);
  for (let lane = 0; lane < lanes; lane++) {
    const off = PILL_OFFSET + lane * LANE_STEP;
    const y = above ? port.y - off : port.y + off;
    const t = tAtY(curve, y, end);
    if (t === null) return null;
    const x = pointAt(curve, t).x;
    const rect = { x: x - width / 2, y: y - PILL_HEIGHT / 2, w: width, h: PILL_HEIGHT };
    if (rect.y < 0 || rect.y + rect.h > bounds.height) return null;
    if (taken.some((r) => intersects(r, rect, PILL_GAP_X))) continue;
    return { pill: { edge: edge.id, text, x, y, width, lane, end }, rect };
  }
  return null;
}

/**
 * Where the selected screen's labels go.
 *
 * Every pill sits at the FAR end of its line — beside the other screen, where
 * the lines are apart — never beside the selected one, where fifteen of them
 * share a box's width and no label can belong to one of them. Pills are laid
 * left to right, each in the first free lane walking away from its box, and
 * a pill that finds no lane is not drawn but counted, so the panel can say
 * so. The boxes themselves are obstacles, so a lane in the margin above the
 * top row cannot land a pill on a screen.
 *
 * A pure function of the model and the selection, so hovering never moves a
 * pill: the pill for a hovered edge that is not the selected screen's is
 * placed separately by {@link hoverPill}.
 */
export function placeLabels(
  model: Picture,
  selected: string | null,
  atRest: boolean | ReadonlySet<string> = false
): PillLayout {
  const pills = new Map<string, PillPlacement>();
  // `true` labels every line (the code's order, where the conditions ARE the
  // picture); a SET labels only those lines (the tree, where the arms of a
  // decision are the one thing worth saying before anything is selected).
  const restLabels = (id: string): boolean => (atRest === true ? true : atRest !== false && atRest.has(id));
  const anyAtRest = atRest === true || (atRest !== false && atRest.size > 0);
  if (selected === null && !anyAtRest) return { pills, hidden: 0 };
  const nodes = new Map(model.layout.nodes.map((n) => [n.id, n]));
  const lanes = laneCount(model.layerGap);
  const bounds = { width: model.layout.width, height: model.layout.height };
  const taken: Rect[] = model.layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));

  // At rest, only the selected screen's lines are labelled — a picture with a
  // label on every line is unreadable, and the reader has asked about one box.
  // A picture whose labels ARE its content says so (`atRest`): the Steps view
  // in the code's order, where the conditions on the lines are the flow.
  const candidates = model.layout.edges
    .filter((e) => restLabels(e.id) || e.source === selected || e.target === selected)
    .map((edge) => {
      const end: 'source' | 'target' = selected !== null && edge.target === selected ? 'source' : 'target';
      const far = nodes.get(end === 'source' ? edge.source : edge.target);
      const anchor = far ? portPoint(far, edge.id, end) : { x: 0, y: 0 };
      return { edge, end, anchor };
    })
    .sort((a, b) => a.anchor.x - b.anchor.x || a.anchor.y - b.anchor.y || a.edge.id.localeCompare(b.edge.id));

  let hidden = 0;
  for (const { edge, end } of candidates) {
    const info = model.edges.get(edge.id);
    if (!info) continue;
    const text = pillText(info, edge, selected);
    if (!text) continue;
    const laid = layPill(model, edge, end, text, nodes, lanes, taken, bounds);
    if (laid === null) {
      hidden++;
      continue;
    }
    pills.set(edge.id, laid.pill);
    taken.push(laid.rect);
  }
  return { pills, hidden };
}

/**
 * The pill for a hovered edge that has no place in {@link placeLabels} —
 * nothing is selected, or the edge has nothing to say at rest. It sits at the
 * edge's target end (its source end when the selected screen is the target),
 * in the first lane clear of the pills in `avoid` and of every box; when
 * there is none it takes the first lane anyway, on top of whatever is there —
 * it is transient, and the line under the pointer is the one the reader is
 * asking about. `text` overrides the pill's words — the panel hovers a row
 * with the whole condition, not the connector's short label.
 */
export function hoverPill(
  model: Picture,
  edgeId: string,
  selected: string | null,
  text?: string,
  avoid?: PillLayout
): PillPlacement | null {
  const edge = model.layout.edges.find((e) => e.id === edgeId);
  const info = edge ? model.edges.get(edge.id) : undefined;
  if (!edge || !info) return null;
  const words = text ?? pillText(info, edge, selected);
  if (!words) return null;
  const nodes = new Map(model.layout.nodes.map((n) => [n.id, n]));
  const end: 'source' | 'target' = selected !== null && edge.target === selected && edge.source !== selected ? 'source' : 'target';
  const bounds = { width: model.layout.width, height: model.layout.height };
  const taken: Rect[] = model.layout.nodes.map((n) => ({ x: n.x, y: n.y, w: n.width, h: n.height }));
  for (const pill of avoid?.pills.values() ?? []) {
    if (pill.edge === edgeId) continue;
    taken.push({ x: pill.x - pill.width / 2, y: pill.y - PILL_HEIGHT / 2, w: pill.width, h: PILL_HEIGHT });
  }
  return (
    layPill(model, edge, end, words, nodes, laneCount(model.layerGap), taken, bounds)?.pill ??
    layPill(model, edge, end, words, nodes, 1, [], bounds)?.pill ??
    null
  );
}
