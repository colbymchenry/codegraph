/**
 * The Map's layout — deterministic, and computed here rather than by a physics
 * simulation (design spec §3.6, epic rule 2).
 *
 * Everything in this file is a pure function of the `/api/map` payload plus two
 * switches (include tests, which module is selected). That is what lets the
 * canvas re-render on a toggle without a round-trip, and what lets the layout
 * be unit-tested — a force-directed graph settles somewhere slightly different
 * every time you open it, and a diagram you cannot recognise between two visits
 * is not a map of anything.
 *
 * The pipeline, in order:
 *
 * 1. **Filter.** Drop test modules unless asked for; drop links whose ends went
 *    with them.
 * 2. **Pick a layering basis.** Prefer each link's `declared` weight — the
 *    edges resolved through an import, a qualified name, an inheritance clause
 *    or a typed receiver. Bare name matching resolves calls to `run`, `push`
 *    and `finish` across unrelated directories, and letting those set the
 *    vertical order puts the storage layer under the CLI. When too few links
 *    carry a declared edge to describe the repository (a language whose
 *    imports the resolver cannot follow), fall back to raw counts and say so.
 * 3. **Break two-cycles.** Keep the heavier direction; the lighter one becomes
 *    a mutual dependency, drawn only when one of its modules is selected.
 * 4. **Layer.** Longest path: a module sits one layer above everything it
 *    depends on. Layer 0 is the foundations, at the bottom.
 * 5. **Order.** Barycenter, three sweeps, from a stable alphabetical start.
 * 6. **Place, then port.** Boxes get x/y; each edge gets a distinct port along
 *    its endpoints' edges so a bundle fans out instead of knotting at a corner.
 *
 * An edge that points *up* after all that — a broken two-cycle, or a link with
 * no declared edge behind it — is marked `back` and drawn only when a module it
 * touches is selected. Drawing it downward would be a lie about the direction
 * of the dependency; hiding it entirely would be a lie about its existence.
 *
 * The Screens view runs the same pipeline with three options the Map leaves at
 * their defaults: its own layering (distance from the entry screen), a wider
 * layer gap (its edges carry labels), and `directional` ports — a link that
 * points up the layering leaves the TOP of its source and arrives at the
 * BOTTOM of its target, so a return trip is drawn around the boxes instead of
 * through them. In a screens graph a cycle is the normal case, not the
 * exception the Map hides at rest.
 */

import type { WireMapLink, WireMapModule, WireMapPayload } from './api';

// Geometry, from the design spec. Changing these changes the picture.
export const NODE_HEIGHT = 40;
export const LAYER_GAP = 74;
export const NODE_GAP = 34;
export const PADDING = 44;
/** Least horizontal room a layer gets per module, so a sparse row still spreads. */
const MIN_SLOT = 230;
/**
 * Room between two ports on one side of a box, when a view asks for it
 * (`portPitch`). Fifteen lines leaving a 110px box are 7px apart and read as
 * one; at 12px they are a fan a reader can follow back to its box.
 */
export const PORT_PITCH = 12;
const MIN_NODE_WIDTH = 110;
/**
 * IBM Plex Mono's real advance at 13px (0.6em), not the spec's 7.3 estimate.
 *
 * The prototype drew labels as SVG text that spilled harmlessly past the
 * rectangle, so 7.3 was close enough there. An HTML box clips instead, and at
 * 7.3 a 27-character id like `src/resolution/(root files)` lost its last
 * characters to an ellipsis — measured in the browser: 211px of text in 205px
 * of box. Padding is the box's own 9px each side plus its 1px borders.
 */
const CHAR_WIDTH = 7.81;
const LABEL_PADDING = 22;

/** Links below this weight stay hidden until a module they touch is selected. */
export const MIN_WEIGHT = 4;
/** …raised when tests are included, because a test module touches everything. */
export const MIN_WEIGHT_WITH_TESTS = 6;

/**
 * Share of links that must carry a declared edge for the declared basis to be
 * used. Below this the declared graph is too sparse to describe the repository
 * — most modules would land on layer 0 with nothing explaining why — and the
 * layout falls back to raw counts, announced in the side panel, never silent.
 *
 * Two thirds of this repository's links are declared at every depth, and the
 * same holds for any language whose imports the resolver can follow; the
 * fallback exists for the ones where it cannot.
 */
const DECLARED_BASIS_COVERAGE = 0.4;

/** Approximate advance of the 11px sans meta line, measured against Archivo. */
const META_CHAR_WIDTH = 5.9;
const META_PADDING = 24;

/**
 * A box wide enough for BOTH of its lines.
 *
 * The spec sizes a node from its label (`label.length x 7.3 + 28`); the
 * prototype's SVG let the "N symbols · M files" line spill outside the
 * rectangle, which an HTML box cannot do without looking broken. So the width
 * is the wider of the two lines. Same formula for the label, same determinism,
 * and `src/bin` now says "63 symbols · 5 files" instead of "5 fi…" — a count
 * clipped to an ellipsis is worse than a slightly wider box.
 */
export function nodeWidth(label: string, meta = ''): number {
  return Math.max(
    MIN_NODE_WIDTH,
    label.length * CHAR_WIDTH + LABEL_PADDING,
    meta.length * META_CHAR_WIDTH + META_PADDING
  );
}

/**
 * The second line of a module box — and the string {@link nodeWidth} sizes for.
 *
 * An island says so INSTEAD of counting itself. "Nothing depends on this" is
 * the only fact about such a module a reader needs from twenty boxes away, and
 * the counts are still one click away in the side panel. Both callers — the
 * width calculation and the box itself — must pass the same `island`, or the
 * text will not fit the box that was sized for it.
 */
export function moduleMetaLabel(module: WireMapModule, island = false): string {
  if (island) return 'nothing depends on this';
  const symbols = `${module.symbols} symbol${module.symbols === 1 ? '' : 's'}`;
  const files = `${module.files} file${module.files === 1 ? '' : 's'}`;
  return `${symbols} · ${files}`;
}

/** One port on a box's edge: the link it belongs to, and which end of it this is. */
export interface PortRef {
  id: string;
  type: 'source' | 'target';
}

export interface MapNodeLayout {
  id: string;
  module: WireMapModule;
  /**
   * No link in the payload arrives here — an island (task CG-59).
   *
   * Computed from the WHOLE link set, not the filtered one, so hiding test
   * modules or raising the weight threshold cannot manufacture an island that
   * the index does not agree is one.
   */
  island: boolean;
  /** Every file in it is tool-generated, so it draws in ink-4. */
  generated: boolean;
  layer: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Link ids leaving from the BOTTOM of this node, left to right — one hidden handle each. */
  sourceHandles: string[];
  /** Link ids arriving at the TOP of this node, left to right. */
  targetHandles: string[];
  /**
   * Every port on the box, by side, left to right — what a node component
   * draws its handles from. Under the Map's `layered` ports this is exactly
   * `targetHandles` on top and `sourceHandles` below. Under `directional`
   * ports a side mixes the two: an edge routed `up` leaves the top of its
   * source and arrives at the bottom of its target, and a `level` edge leaves
   * and arrives at the top, arching over the row.
   */
  ports: { top: PortRef[]; bottom: PortRef[] };
}

export interface MapEdgeLayout {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  link: WireMapLink;
  /** Stroke width, from the spec's `min(6, 1 + log2(count) x 0.7)`. */
  width: number;
  /** Points up the layering: a mutual dependency or a link with nothing declared. */
  back: boolean;
  /** Below the weight threshold — drawn only when a touching module is selected. */
  thin: boolean;
  /**
   * Which way the link runs through the layering: `down` to a lower layer,
   * `up` to a higher one, `level` along its own. Under `directional` ports
   * this decides the sides the edge uses and the curve it draws.
   */
  route: EdgeRoute;
}

export type EdgeRoute = 'down' | 'up' | 'level';

export interface MapLayerLayout {
  index: number;
  y: number;
  /** Only the top and bottom layers are named. */
  label: string | null;
}

export interface MutualPair {
  /** The heavier direction. */
  forward: WireMapLink;
  /** The lighter one — the back-reference. */
  back: WireMapLink;
}

export interface MapLayout {
  nodes: MapNodeLayout[];
  edges: MapEdgeLayout[];
  layers: MapLayerLayout[];
  width: number;
  height: number;
  /** What set the vertical order, and how thin the evidence was. */
  basis: {
    kind: 'declared' | 'all';
    declaredLinks: number;
    totalLinks: number;
  };
  minWeight: number;
  /** Links hidden for being thin, at rest. */
  hiddenLinks: number;
  mutual: MutualPair[];
  /** Module-level cycles of three or more, in the drawn graph. */
  moduleCycles: string[][];
}

export interface MapLayoutOptions {
  includeTests: boolean;
  /** Override the hidden-link floor; 0 draws every link (the Screens view). */
  minWeight?: number;
  /**
   * The two lines a box is sized for. The Map's boxes show the module id and
   * its counts; a view that shows something else (a screen's path and its
   * component) must size for what it draws, or an opaque id decides the width.
   */
  sizing?: (module: WireMapModule, island: boolean) => { label: string; meta: string };
  /**
   * Replace longest-path layering. Receives every module id and the acyclic
   * links (mutual pairs already broken); returns each id's layer, 0 at the
   * BOTTOM. The Screens view lays out by distance from the entry screen,
   * where "one layer above what it depends on" would put the head of the
   * longest chain of screens above the login page.
   */
  layering?: (ids: string[], links: ReadonlyArray<{ source: string; target: string }>) => Map<string, number>;
  /**
   * A row order the view already knows — the Steps view's rows read in the
   * code's order. It is the initial order, and the sweeps then move a box
   * only to sit under its parents (a barycenter over parents alone, not
   * children), tie-broken by this order rather than by id.
   */
  order?: (id: string) => number;
  /**
   * Vertical room between two layers; {@link LAYER_GAP} unless a view says
   * otherwise. The Screens view widens it because its edges carry labels, and
   * a label needs a lane the Map's hairlines never did.
   */
  layerGap?: number;
  /**
   * Least distance between two ports on one side of a box; a box widens to
   * keep it. 0 (the default) sizes a box by its text alone.
   */
  portPitch?: number;
  /**
   * `layered` (the default): every link leaves a bottom and arrives at a top,
   * whichever way it points. `directional`: see {@link MapNodeLayout.ports}.
   */
  ports?: 'layered' | 'directional';
}

export function strokeWidthFor(count: number): number {
  return Math.min(6, 1 + Math.log2(Math.max(1, count)) * 0.7);
}

/**
 * A link's stable identity, and the id Svelte Flow keys its edge on.
 *
 * NUL is the separator because a module id is a path and a path may contain
 * anything else — including the spaces, arrows and colons that read nicer.
 */
export function linkId(link: { source: string; target: string }): string {
  return `${link.source}\u0000${link.target}`;
}

export function buildMapLayout(
  payload: Pick<WireMapPayload, 'modules' | 'links'>,
  options: MapLayoutOptions
): MapLayout {
  const modules = payload.modules.filter((m) => options.includeTests || !m.test);
  const present = new Set(modules.map((m) => m.id));
  // Islands come off the UNFILTERED link set: a module a hidden test module
  // depends on is depended on, whatever this screen is currently showing.
  const depended = new Set(payload.links.map((l) => l.target));
  const links = payload.links.filter((l) => present.has(l.source) && present.has(l.target));
  const minWeight = options.minWeight ?? (options.includeTests ? MIN_WEIGHT_WITH_TESTS : MIN_WEIGHT);
  const layerGap = options.layerGap ?? LAYER_GAP;
  const portPitch = options.portPitch ?? 0;
  const directional = options.ports === 'directional';

  const declaredLinks = links.filter((l) => l.declared > 0);
  const useDeclared =
    links.length > 0 && declaredLinks.length >= links.length * DECLARED_BASIS_COVERAGE;
  const weightOf = (link: WireMapLink): number => (useDeclared ? link.declared : link.count);
  const layeringLinks = useDeclared ? declaredLinks : links;

  // --- 2-cycle break, on the layering graph only ---------------------------
  const byPair = new Map(layeringLinks.map((l) => [linkId(l), l]));
  const acyclic: WireMapLink[] = [];
  const mutual: MutualPair[] = [];
  for (const link of layeringLinks) {
    const back = byPair.get(linkId({ source: link.target, target: link.source }));
    if (!back) {
      acyclic.push(link);
      continue;
    }
    const mine = weightOf(link);
    const theirs = weightOf(back);
    // Ties broken by id so two runs over one payload agree.
    if (theirs > mine || (theirs === mine && link.source > link.target)) {
      mutual.push({ forward: back, back: link });
      continue;
    }
    acyclic.push(link);
  }

  // --- longest-path layering ----------------------------------------------
  const out = new Map<string, string[]>(modules.map((m) => [m.id, []]));
  for (const link of acyclic) out.get(link.source)?.push(link.target);
  for (const list of out.values()) list.sort();

  const layer = new Map<string, number>();
  if (options.layering) {
    for (const [id, value] of options.layering(modules.map((m) => m.id), acyclic)) layer.set(id, value);
    for (const module of modules) if (!layer.has(module.id)) layer.set(module.id, 0);
  } else {
    for (const module of modules) longestPath(module.id, out, layer, new Set());
  }

  const layerCount = Math.max(1, ...[...layer.values()].map((v) => v + 1));
  const rows: string[][] = Array.from({ length: layerCount }, () => []);
  for (const module of modules) rows[layer.get(module.id) ?? 0]!.push(module.id);
  const given = options.order;
  for (const row of rows) row.sort(given ? (a, b) => given(a) - given(b) || a.localeCompare(b) : undefined);

  // --- barycenter ordering, three sweeps -----------------------------------
  // With an order given, a box's barycenter is over its parents alone, so
  // siblings under one parent keep the order they came in.
  const neighbours = new Map<string, string[]>(modules.map((m) => [m.id, []]));
  for (const link of acyclic) {
    neighbours.get(link.target)?.push(link.source);
    if (!given) neighbours.get(link.source)?.push(link.target);
  }
  const position = new Map<string, number>();
  for (const row of rows) row.forEach((id, i) => position.set(id, i));
  for (let sweep = 0; sweep < 3; sweep += 1) {
    for (const row of rows) {
      const bary = new Map(row.map((id) => [id, barycenter(id, neighbours, position)]));
      // Sort by barycenter, then by the previous position, then by id: three
      // total-order tiebreaks so the sweep cannot depend on sort stability.
      // Infinity minus Infinity is NaN, so the unconnected modules — which all
      // carry Infinity — are compared by the later keys instead.
      row.sort((a, b) => {
        const ba = bary.get(a) ?? 0;
        const bb = bary.get(b) ?? 0;
        if (ba !== bb && Number.isFinite(ba - bb)) return ba - bb;
        if (ba !== bb) return ba < bb ? -1 : 1;
        return (position.get(a) ?? 0) - (position.get(b) ?? 0) || (given ? given(a) - given(b) : 0) || a.localeCompare(b);
      });
      row.forEach((id, i) => position.set(id, i));
    }
  }

  // --- placement -----------------------------------------------------------
  // Which side of each box a link's two ports land on is settled by the
  // layers alone, so it is known before any box has a width — and a view
  // that asked for a port pitch needs it now: a hub with nineteen lines
  // leaving its bottom edge is widened to hold them.
  const routeOf = (link: { source: string; target: string }): EdgeRoute => {
    const from = layer.get(link.source) ?? 0;
    const to = layer.get(link.target) ?? 0;
    return from > to ? 'down' : from < to ? 'up' : 'level';
  };
  const sidesOf = (route: EdgeRoute): { source: 'top' | 'bottom'; target: 'top' | 'bottom' } => {
    if (!directional || route === 'down') return { source: 'bottom', target: 'top' };
    if (route === 'up') return { source: 'top', target: 'bottom' };
    return { source: 'top', target: 'top' };
  };
  const portCount = new Map<string, { top: number; bottom: number }>(
    modules.map((m) => [m.id, { top: 0, bottom: 0 }])
  );
  for (const link of links) {
    const sides = sidesOf(routeOf(link));
    portCount.get(link.source)![sides.source] += 1;
    portCount.get(link.target)![sides.target] += 1;
  }

  const islands = new Set(modules.filter((m) => !depended.has(m.id)).map((m) => m.id));
  const widths = new Map(
    modules.map((m) => {
      const island = islands.has(m.id);
      const lines = options.sizing?.(m, island) ?? { label: m.id, meta: moduleMetaLabel(m, island) };
      const count = portCount.get(m.id) ?? { top: 0, bottom: 0 };
      const forPorts = (Math.max(count.top, count.bottom) + 1) * portPitch;
      return [m.id, Math.max(nodeWidth(lines.label, lines.meta), forPorts)];
    })
  );
  const rowSums = rows.map((row) => row.reduce((sum, id) => sum + (widths.get(id) ?? 0), 0));
  // Natural span = the boxes shoulder to shoulder. The content width is the
  // widest of those, and NOTHING may exceed it — a row of forty leaf modules
  // must not stretch the canvas to `40 x MIN_SLOT` and shrink every other row
  // to a thumbnail. MIN_SLOT only breathes a row out INSIDE that width.
  const naturalSpans = rows.map(
    (row, i) => (rowSums[i] ?? 0) + Math.max(0, row.length - 1) * NODE_GAP
  );
  const contentWidth = Math.max(1, ...naturalSpans);
  const rowSpans = rows.map((row, i) =>
    Math.min(contentWidth, Math.max(naturalSpans[i] ?? 0, row.length * MIN_SLOT))
  );
  const width = contentWidth + PADDING * 2;
  const height = layerCount * (NODE_HEIGHT + layerGap) - layerGap + PADDING * 2;

  const nodesById = new Map<string, MapNodeLayout>();
  const byId = new Map(modules.map((m) => [m.id, m]));
  rows.forEach((row, index) => {
    const span = rowSpans[index] ?? 0;
    const sum = rowSums[index] ?? 0;
    const gap = row.length > 1 ? (span - sum) / (row.length - 1) : 0;
    // A single box centres in the content width instead of clinging to the
    // left edge — the common case for the entry point at the top.
    let x = PADDING + (contentWidth - span) / 2 + (row.length === 1 ? (span - sum) / 2 : 0);
    const y = PADDING + (layerCount - 1 - index) * (NODE_HEIGHT + layerGap);
    for (const id of row) {
      const w = widths.get(id) ?? MIN_NODE_WIDTH;
      const module = byId.get(id)!;
      nodesById.set(id, {
        id,
        module,
        island: islands.has(id),
        // Every file generated, not merely some: a module with one `.pb.go` in
        // it is still a module somebody writes by hand.
        generated: module.files > 0 && module.generated === module.files,
        layer: index,
        x,
        y,
        width: w,
        height: NODE_HEIGHT,
        sourceHandles: [],
        targetHandles: [],
        ports: { top: [], bottom: [] },
      });
      x += w + gap;
    }
  });

  // --- edges and ports -----------------------------------------------------
  // EVERY link is laid out, including the ones the layering ignored: a link
  // that survives the filter exists in the code, and the map's job is to say
  // where it goes, not to pretend it is absent.
  const edges: MapEdgeLayout[] = [];
  // Every port, by box and side, with the x of the link's other end.
  const sidePorts = new Map<string, { top: SidePort[]; bottom: SidePort[] }>();
  for (const link of links) {
    const from = nodesById.get(link.source);
    const to = nodesById.get(link.target);
    if (!from || !to) continue;
    const id = linkId(link);
    const route = routeOf(link);
    const edge: MapEdgeLayout = {
      id,
      source: link.source,
      target: link.target,
      sourceHandle: `s:${id}`,
      targetHandle: `t:${id}`,
      link,
      width: strokeWidthFor(link.count),
      back: from.layer <= to.layer,
      thin: link.count < minWeight,
      route,
    };
    edges.push(edge);
    const sides = sidesOf(route);
    (sidePorts.get(link.source) ?? setDefault(sidePorts, link.source))[sides.source].push({
      id,
      type: 'source',
      other: xOf(nodesById, link.target),
    });
    (sidePorts.get(link.target) ?? setDefault(sidePorts, link.target))[sides.target].push({
      id,
      type: 'target',
      other: xOf(nodesById, link.source),
    });
  }
  // Ports spread in the order the other end appears left-to-right, so bundles
  // between two layers stay untangled instead of crossing inside the gap.
  const byOther = (a: SidePort, b: SidePort) => a.other - b.other || a.id.localeCompare(b.id);
  for (const [id, sides] of sidePorts) {
    const node = nodesById.get(id);
    if (!node) continue;
    sides.top.sort(byOther);
    sides.bottom.sort(byOther);
    node.ports = {
      top: sides.top.map((p) => ({ id: p.id, type: p.type })),
      bottom: sides.bottom.map((p) => ({ id: p.id, type: p.type })),
    };
    node.sourceHandles = sides.bottom.filter((p) => p.type === 'source').map((p) => p.id);
    node.targetHandles = sides.top.filter((p) => p.type === 'target').map((p) => p.id);
  }

  const layers: MapLayerLayout[] = rows.map((_, index) => ({
    index,
    y: PADDING + (layerCount - 1 - index) * (NODE_HEIGHT + layerGap) + NODE_HEIGHT / 2,
    label:
      layerCount === 1
        ? null
        : index === layerCount - 1
          ? 'entry points'
          : index === 0
            ? 'foundations — depend on nothing below'
            : null,
  }));

  return {
    nodes: [...nodesById.values()],
    edges,
    layers,
    width,
    height,
    basis: {
      kind: useDeclared ? 'declared' : 'all',
      declaredLinks: declaredLinks.length,
      totalLinks: links.length,
    },
    minWeight,
    hiddenLinks: edges.filter((e) => e.thin || e.back).length,
    mutual: mutual.sort((a, b) => b.back.count - a.back.count || a.back.source.localeCompare(b.back.source)),
    moduleCycles: moduleCycles(modules.map((m) => m.id), edges),
  };
}

/**
 * Which edges are drawn, given the selection.
 *
 * At rest the map shows the layering: downward links carrying real weight.
 * Selecting a module says "show me everything about this one", so its thin
 * links and its back-references come out — for that module only.
 */
export function isEdgeVisible(edge: MapEdgeLayout, selected: string | null): boolean {
  if (selected !== null) return edge.source === selected || edge.target === selected;
  return !edge.thin && !edge.back;
}

/**
 * Where a link's port sits on a box: `x = left + width x (i+1)/(n+1)` along
 * the side that holds it, at the top or bottom edge. The same arithmetic the
 * node components place their hidden handles with, so a view that needs the
 * point before anything is rendered — to put a label on the curve — gets the
 * one the browser will measure.
 */
export function portPoint(node: MapNodeLayout, id: string, type: 'source' | 'target'): { x: number; y: number } {
  const top = node.ports.top.findIndex((p) => p.id === id && p.type === type);
  if (top >= 0) return { x: node.x + (node.width * (top + 1)) / (node.ports.top.length + 1), y: node.y };
  const bottom = node.ports.bottom.findIndex((p) => p.id === id && p.type === type);
  if (bottom >= 0) {
    return {
      x: node.x + (node.width * (bottom + 1)) / (node.ports.bottom.length + 1),
      y: node.y + node.height,
    };
  }
  return { x: node.x + node.width / 2, y: type === 'source' ? node.y + node.height : node.y };
}

interface SidePort extends PortRef {
  /** Centre x of the link's other end — the sort key along the side. */
  other: number;
}

function setDefault(
  map: Map<string, { top: SidePort[]; bottom: SidePort[] }>,
  key: string
): { top: SidePort[]; bottom: SidePort[] } {
  const sides = { top: [], bottom: [] };
  map.set(key, sides);
  return sides;
}

function xOf(nodes: Map<string, MapNodeLayout>, id: string): number {
  const node = nodes.get(id);
  return node ? node.x + node.width / 2 : 0;
}

/**
 * A module's horizontal pull: the mean position of everything it connects to.
 *
 * A module connected to nothing has no pull, and giving it its own position
 * back leaves it wherever the alphabet dropped it — which on a repository with
 * forty leaf directories means forty unconnected boxes interleaved through the
 * drawing, pushing the parts that DO connect apart. Infinity parks them at the
 * right-hand end of their layer instead, so the connected picture stays
 * contiguous. They are still drawn, and still counted.
 */
function barycenter(
  id: string,
  neighbours: Map<string, string[]>,
  position: Map<string, number>
): number {
  const list = neighbours.get(id) ?? [];
  if (list.length === 0) return Number.POSITIVE_INFINITY;
  let sum = 0;
  for (const other of list) sum += position.get(other) ?? 0;
  return sum / list.length;
}

/**
 * A module's layer: one above the deepest thing it depends on.
 *
 * `visiting` guards a cycle the two-cycle break did not catch (a three-module
 * loop). Returning 0 there is not an answer, it is a floor — the module still
 * gets placed above whatever else it depends on, and the loop itself is
 * reported separately in {@link MapLayout.moduleCycles}.
 */
function longestPath(
  id: string,
  out: Map<string, string[]>,
  layer: Map<string, number>,
  visiting: Set<string>
): number {
  const known = layer.get(id);
  if (known !== undefined) return known;
  if (visiting.has(id)) return 0;
  visiting.add(id);
  let value = 0;
  for (const next of out.get(id) ?? []) {
    value = Math.max(value, longestPath(next, out, layer, visiting) + 1);
  }
  visiting.delete(id);
  layer.set(id, value);
  return value;
}

/** Strongly connected components of three or more modules, in the drawn graph. */
function moduleCycles(ids: readonly string[], edges: readonly MapEdgeLayout[]): string[][] {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const edge of edges) out.get(edge.source)?.push(edge.target);
  for (const list of out.values()) list.sort();

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const found: string[][] = [];
  let counter = 0;

  const strongconnect = (id: string): void => {
    index.set(id, counter);
    low.set(id, counter);
    counter += 1;
    stack.push(id);
    onStack.add(id);
    for (const next of out.get(id) ?? []) {
      if (!index.has(next)) {
        strongconnect(next);
        low.set(id, Math.min(low.get(id) ?? 0, low.get(next) ?? 0));
      } else if (onStack.has(next)) {
        low.set(id, Math.min(low.get(id) ?? 0, index.get(next) ?? 0));
      }
    }
    if (low.get(id) === index.get(id)) {
      const component: string[] = [];
      for (;;) {
        const popped = stack.pop();
        if (popped === undefined) break;
        onStack.delete(popped);
        component.push(popped);
        if (popped === id) break;
      }
      if (component.length > 2) found.push(component.sort());
    }
  };

  for (const id of [...ids].sort()) if (!index.has(id)) strongconnect(id);
  return found.sort((a, b) => b.length - a.length || (a[0] ?? '').localeCompare(b[0] ?? ''));
}
