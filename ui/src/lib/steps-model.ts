/**
 * The Steps view's model — what happens from an anchor, as typed steps laid
 * out so that a step sits above the steps it sets in motion.
 *
 * Everything geometric is the Screens view's (`screens-model.ts`): the Map's
 * layout with directional ports, a curve per edge on a track of its own, the
 * pills that label a selected step's links at the far end of each line, and
 * the nearest-line pointer. What is this file's own is small: the row a step
 * sits on is its distance from the anchor, which the server already counted
 * (`WireStep.depth`), so the layering is a lookup rather than a search; the
 * words in a box come from the step's kind; and the side panel's two lists
 * are the links into and out of the selected step.
 */

import { whenWords } from './conditions';
import type { WireMapLink, WireMapModule, WireStep, WireStepDecision, WireStepLink, WireStepTrigger, WireStepsPayload } from './wire';
import {
  buildMapLayout,
  linkId,
  nodeWidth,
  strokeWidthFor,
  NODE_GAP,
  NODE_HEIGHT,
  PADDING,
  PORT_PITCH,
  type EdgeRoute,
  type MapEdgeLayout,
  type MapLayout,
  type MapNodeLayout,
  type PortRef,
} from './map-model';
import {
  edgeLabel,
  samplePolyline,
  trackedCurves,
  SCREEN_LAYER_GAP,
  type Curve,
  type Picture,
  type Point,
} from './screens-model';

export interface StepNodeInfo {
  id: string;
  step: WireStep;
  /** What the box prints on its first line. */
  label: string;
  /** …and on its second. */
  sub: string;
}

export interface StepEdgeInfo {
  id: string;
  from: string;
  to: string;
  /** Every link between the pair — one connector, several stories. */
  links: WireStepLink[];
  /** The connector's short label: the innermost condition, or how many links. */
  label: string;
  /** Every link behind it was synthesized (a dynamic-dispatch bridge). */
  synthesized: boolean;
  /** The kind the links agree on, or `calls` when they differ. */
  kind: WireStepLink['kind'];
  /**
   * The one way of a decision this connector is — `yes`, `no`, a case's
   * value — when it and a sibling out of the same box are arms of one fork.
   * The condition itself is said once, under the box ({@link StepDecision}).
   */
  arm?: string;
}

/**
 * A decision drawn where it is made: the condition said ONCE, under the box
 * that decides it, while each line out of that box says only which way it is.
 */
export interface StepDecision {
  id: string;
  /** The condition as a reader says it, asking: `await hasSeenWelcome(…)?`. */
  label: string;
  x: number;
  y: number;
  width: number;
}

export interface StepsModel extends Picture {
  layout: MapLayout;
  nodes: Map<string, StepNodeInfo>;
  edges: Map<string, StepEdgeInfo>;
  layerGap: number;
  curves: Map<string, Curve>;
  polylines: Map<string, Point[]>;
  /** Steps per kind, for the panel's summary. */
  counts: Record<WireStep['kind'], number>;
  /**
   * A screen's picture only: the regions its boxes are laid out by, for the
   * captions. Null when the steps carry no regions — an endpoint's or a
   * function's picture, and the order reading — and the rows are distance.
   */
  regions: StepRegionZone[] | null;
  /** The first box of each region — where the anchor's at-rest line arrives. */
  regionEntries: ReadonlySet<string> | null;
  /**
   * The order reading only: its decisions, each drawn as a point of its own
   * where the arms diverge (`fork:N` in the layout). Null on the tree, whose
   * decisions are made INSIDE a box and drawn under it ({@link decisions}).
   */
  forks: Map<string, StepForkInfo> | null;
  /**
   * The tree reading's decisions: a condition said once under the box that
   * decides it, its arms labelled on the lines out. Empty when the picture
   * holds none.
   */
  decisions: StepDecision[];
}

/**
 * A decision on the order reading's canvas — a fork of the code with two or
 * more arms that lead somewhere. The condition is said ONCE, on the point,
 * and each line out answers it (`yes`, `no`, a case's value): two lines that
 * each carried the whole predicate, one of them negated, never said they were
 * the same choice.
 */
export interface StepForkInfo {
  id: string;
  /** The condition in positive words — a switch's subject; '' when the arms share none. */
  on: string;
  form: 'if' | 'switch' | 'ternary' | 'try';
  /** The point's words: the condition, asked — `user AND (await …)?`. */
  label: string;
}

/** One region of a screen's picture: its caption, and the space its boxes hold. */
export interface StepRegionZone {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** The region's first box, in the walk's order. */
  entry: string;
}

/** Points a curve is sampled at for hit-testing (as the Screens view's). */
const HIT_SAMPLES = 24;

/* ---------------------------------------------------------------- words -- */

/** What the index is a picture of; the server decides it from the routes (`WireStepsPayload.project`). */
export type ProjectKind = WireStepsPayload['project'];

/**
 * A short word for a step's kind, as the panel and the legend say it — in the
 * project's own vocabulary. The same box is a screen in an app, a page in a
 * web app and an endpoint in an API; a route that leads with an HTTP verb is
 * an endpoint wherever it is. One place decides, so the legend, the panel
 * and the tooltip never disagree.
 */
export function kindWord(kind: WireStep['kind'], project: ProjectKind = 'app', step?: WireStep): string {
  return kindWords(kind, project, step)[0];
}

/** The singular and the plural, for counts: `1 endpoint`, `3 outside the index`. */
export function kindWords(kind: WireStep['kind'], project: ProjectKind = 'app', step?: WireStep): [string, string] {
  switch (kind) {
    case 'screen':
      if (step?.screen?.endpoint) return ['endpoint', 'endpoints'];
      return project === 'api' ? ['endpoint', 'endpoints'] : project === 'web' ? ['page', 'pages'] : ['screen', 'screens'];
    case 'trigger':
      return ['handler', 'handlers'];
    case 'bridge':
      // An endpoint reached across a tier is a call to the server wherever it is.
      if (step?.screen?.endpoint) return ['call to the server', 'calls to the server'];
      return project === 'app' ? ['native call', 'native calls'] : project === 'web' ? ['call to the server', 'calls to the server'] : ['call to another tier', 'calls to another tier'];
    case 'event':
      return project === 'app' ? ['native event', 'native events'] : project === 'web' ? ['arrives from the server', 'arrive from the server'] : ['arrives from a queue or bus', 'arrive from a queue or bus'];
    case 'store':
      return project === 'api' ? ['data call', 'data calls'] : ['store action', 'store actions'];
    case 'effect':
      return ['outside the index', 'outside the index'];
    default:
      return ['start', 'start'];
  }
}

/** `3 handlers`, `1 endpoint`, `11 outside the index`. */
export function countWords(n: number, kind: WireStep['kind'], project: ProjectKind = 'app'): string {
  const [one, many] = kindWords(kind, project);
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * What fires something, in a few characters: `onPress · <Button>`,
 * `onSubmit · useFormik(…)`, `addListener('onZipComplete')`, `useEffect`;
 * for a server, `POST /users · after authenticate, validate(…)`,
 * `@Process('email')`, `page load · /blog/[slug]`.
 */
export function triggerWords(t: WireStepTrigger): string {
  const after = t.after && t.after.length > 0 ? ` · after ${t.after.join(', ')}` : '';
  switch (t.kind) {
    case 'prop':
      return t.of ? `${t.name} · <${t.of}>` : t.name;
    case 'option':
      return t.of ? `${t.name} · ${t.of}(…)` : t.name;
    case 'request':
      return `${t.name} ${t.of ?? ''}`.trim() + after;
    case 'decorator':
      return `@${t.name}(${t.of ?? ''})` + after;
    case 'load':
      return `page load · ${t.of ?? t.name}` + after;
    default:
      return t.of ? `${t.name}(${t.of})` : t.name;
  }
}

/** The first line of a step's box. Boundary crossings carry an arrow for which way the code goes. */
export function stepLabel(step: WireStep): string {
  switch (step.kind) {
    case 'bridge':
      return `⇢ ${step.label}`;
    case 'event': {
      const events = step.events ?? (step.event ? [step.event] : []);
      if (events.length === 0) return `⇠ ${step.label}`;
      return events.length === 1 ? `⇠ ${events[0]}` : `⇠ ${events[0]} +${events.length - 1}`;
    }
    default:
      return step.label;
  }
}

/** The second line: what the step is, then where it is. */
export function stepSub(step: WireStep, project: ProjectKind = 'app'): string {
  const file = step.node ? step.node.file.slice(step.node.file.lastIndexOf('/') + 1) : '';
  switch (step.kind) {
    case 'screen':
      return step.sub;
    case 'trigger':
      // The event before the file: `onPress · <Button> · index.tsx`.
      return step.trigger ? `${triggerWords(step.trigger)} · ${file}` : `handler · ${file}`;
    case 'bridge':
      // An endpoint the code crosses to says its handler, as an endpoint box does.
      if (step.screen) return step.sub;
      return `${project === 'app' ? 'native' : project === 'web' ? 'server' : 'another tier'} · ${file}`;
    case 'event':
      return `${step.label} · ${file}`;
    case 'store':
      return `${project === 'api' ? 'data' : 'store'} · ${file}`;
    case 'effect':
      return step.sub;
    default:
      // The anchor: its file, at the size of a box; the panel prints the whole path.
      return step.node && step.sub === step.node.file ? file : step.sub;
  }
}

/* ------------------------------------------------------------- decisions -- */

/** A case value longer than this is cut on the line; the whole condition is a hover away. */
const ARM_WORD_MAX = 24;
/** Room for one line of a decision's caption under its box. */
const DECISION_LINE = 15;
/** Advance of the caption's 10.5px mono, and the room it may take past its box. */
const DECISION_CHAR = 6.3;
const DECISION_MAX_WIDTH = 320;

/**
 * The word a line out of a decision says — the ONE place that decides it, so
 * the two readings can never word an arm differently. `yes` / `no` for an
 * `if` or a ternary; a case's own value for a switch, with the subject the
 * decision already asks stripped off (`status === 'expired'` → `'expired'`),
 * and `else` for its default; a `try`'s arms keep their own words.
 */
export function armWords(d: { on: string; arm: string; form: 'if' | 'switch' | 'ternary' | 'try'; not?: true }): string {
  if (d.form === 'if' || d.form === 'ternary') return d.not ? 'no' : 'yes';
  if (d.not) return 'else';
  let text = d.arm;
  if (d.on && text.startsWith(d.on)) text = text.slice(d.on.length).trim().replace(/^===?\s*/, '');
  if (!text) return 'yes';
  return text.length > ARM_WORD_MAX ? `${text.slice(0, ARM_WORD_MAX - 1)}…` : text;
}

/**
 * The one arm of one decision a connector is, when EVERY site behind it
 * agrees. A connector with a site that runs under no condition is not
 * exclusively an arm — the step happens either way — and one whose sites
 * disagree is several stories; both stay plain lines rather than claim a side.
 */
function edgeArm(info: StepEdgeInfo): WireStepDecision | null {
  let found: WireStepDecision | null = null;
  for (const link of info.links) {
    for (const site of link.sites) {
      if (!site.decision) return null;
      if (found === null) found = site.decision;
      else if (found.branch !== site.decision.branch || found.arm !== site.decision.arm) return null;
    }
  }
  return found;
}

/**
 * Sibling connectors out of one box that are arms of ONE fork, marked as the
 * choice they are: each line says only which way it is, and the condition is
 * said once under the box that decides it. Two lines that each carried the
 * whole predicate — one of them the other's negation, both truncated to the
 * same forty characters — never said they were the same choice, and at rest
 * the tree drew them with no label at all.
 *
 * A fork with ONE drawn arm is a guard clause, not a choice, and keeps its
 * condition on the line: the decision has to have at least two ways drawn
 * before it is worth a caption.
 */
function markDecisions(edges: Map<string, StepEdgeInfo>, layout: MapLayout): StepDecision[] {
  const groups = new Map<string, Array<{ info: StepEdgeInfo; decision: WireStepDecision }>>();
  for (const info of edges.values()) {
    const decision = edgeArm(info);
    if (decision === null) continue;
    const key = `${info.from} ${decision.branch}`;
    const list = groups.get(key) ?? [];
    list.push({ info, decision });
    groups.set(key, list);
  }

  const boxes = new Map(layout.nodes.map((n) => [n.id, n]));
  const out: StepDecision[] = [];
  /** Two decisions made in one box stack under it rather than sitting on each other. */
  const perBox = new Map<string, number>();
  for (const [key, group] of groups) {
    if (new Set(group.map((g) => g.decision.arm)).size < 2) continue;
    const box = boxes.get(group[0]!.info.from);
    if (!box) continue;
    for (const { info, decision } of group) {
      info.arm = armWords(decision);
      // The connector's label IS the arm now: the decision says the rest.
      info.label = info.arm;
    }
    const nth = perBox.get(box.id) ?? 0;
    perBox.set(box.id, nth + 1);
    const on = group[0]!.decision.on;
    const label = `${whenWords(on) || on}?`;
    // The condition is the whole point of the caption, so it may take a
    // little more room than the box it sits under — centred on it, and capped
    // so a long predicate cannot reach across its neighbours.
    const width = Math.max(box.width, Math.min(label.length * DECISION_CHAR + 8, DECISION_MAX_WIDTH));
    out.push({
      id: key,
      label,
      x: box.x + (box.width - width) / 2,
      y: box.y + box.height + 4 + nth * DECISION_LINE,
      width,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- build -- */

export function buildStepsModel(payload: WireStepsPayload): StepsModel {
  const nodes = new Map<string, StepNodeInfo>();
  const modules: WireMapModule[] = [];
  const counts: Record<WireStep['kind'], number> = {
    anchor: 0,
    screen: 0,
    trigger: 0,
    bridge: 0,
    event: 0,
    store: 0,
    effect: 0,
  };
  const degree = new Map<string, number>();
  for (const link of payload.links) {
    degree.set(link.from, (degree.get(link.from) ?? 0) + 1);
    degree.set(link.to, (degree.get(link.to) ?? 0) + 1);
  }
  for (const step of payload.steps) {
    counts[step.kind]++;
    const info: StepNodeInfo = { id: step.id, step, label: stepLabel(step), sub: stepSub(step, payload.project) };
    nodes.set(step.id, info);
    modules.push({
      id: step.id,
      label: info.label,
      files: 1,
      symbols: degree.get(step.id) ?? 0,
      languages: [],
      test: false,
      generated: 0,
      generatedFiles: [],
      facade: false,
      fileList: { total: 1, shown: 1, truncated: false, items: [step.node?.file ?? step.sub] },
    });
  }

  // One layout link per (from, to); the links behind it stay listed.
  const byPair = new Map<string, WireStepLink[]>();
  for (const link of payload.links) {
    if (!nodes.has(link.from) || !nodes.has(link.to) || link.from === link.to) continue;
    const key = linkId({ source: link.from, target: link.to });
    const list = byPair.get(key) ?? [];
    list.push(link);
    byPair.set(key, list);
  }
  const links: WireMapLink[] = [];
  const edges = new Map<string, StepEdgeInfo>();
  for (const [key, group] of byPair) {
    const first = group[0]!;
    links.push({
      source: first.from,
      target: first.to,
      count: group.length,
      declared: group.length,
      byKind: [{ kind: 'calls', count: group.length }],
      topPairs: [],
    });
    // A link into a handler says the EVENT — `onPress · <Button>` — not the
    // conditions; those are one hover away, and the event is what a reader
    // asking "at what point does this run" came for.
    const trigger = group.length === 1 && first.kind === 'handler' && first.trigger ? first.trigger : null;
    edges.set(key, {
      id: key,
      from: first.from,
      to: first.to,
      links: group,
      label: trigger ? triggerWords(trigger) : edgeLabel(group),
      synthesized: group.every((l) => l.synthesized),
      kind: group.every((l) => l.kind === first.kind) ? first.kind : 'calls',
    });
  }

  // A screen's picture is laid out by its REGIONS when the server named them
  // (`WireStep.region`): a screen is a set of handlers with no order between
  // them, so distance alone put ninety boxes on one enormous row. An
  // endpoint's or a function's picture keeps the rows: there, distance IS the
  // reading.
  const regioned = payload.steps.some((s) => s.region !== undefined);
  let layout: MapLayout;
  let zones: StepRegionZone[] | null = null;
  if (regioned) {
    const packed = packRegions(payload.steps, nodes, modules, links);
    layout = packed.layout;
    zones = packed.zones;
  } else {
    // Layer = distance from the anchor, counted by the server. Layer 0 is the
    // bottom, so the deepest row is 0 and the anchor is on top.
    const depthOf = new Map(payload.steps.map((s) => [s.id, s.depth]));
    const deepest = Math.max(0, ...payload.steps.map((s) => s.depth));
    const layering = (ids: string[]): Map<string, number> =>
      new Map(ids.map((id) => [id, deepest - (depthOf.get(id) ?? deepest)]));

    layout = buildMapLayout(
      { modules, links },
      {
        includeTests: true,
        minWeight: 0,
        sizing: (m) => {
          const info = nodes.get(m.id);
          // Size for the ` …` a cut step wears and the anchor's ● mark, as `packRegions` does.
          const cut = info?.step.cut != null ? ' …' : '';
          const mark = info?.step.anchor ? '● ' : '';
          return { label: mark + (info?.label ?? m.id) + cut, meta: info?.sub ?? '' };
        },
        layering,
        // The server ordered each row the way the code reads; keep it.
        order: (id) => nodes.get(id)?.step.order ?? Number.MAX_SAFE_INTEGER,
        layerGap: SCREEN_LAYER_GAP,
        portPitch: PORT_PITCH,
        ports: 'directional',
      }
    );
  }
  const layerGap = regioned ? REGION_GAP_Y : SCREEN_LAYER_GAP;
  const curves = trackedCurves(layout, layerGap);
  const polylines = new Map<string, Point[]>();
  for (const [id, curve] of curves) polylines.set(id, samplePolyline(curve, HIT_SAMPLES));
  return {
    layout,
    nodes,
    edges,
    layerGap,
    curves,
    polylines,
    counts,
    regions: zones,
    regionEntries: zones === null ? null : new Set(zones.map((z) => z.entry)),
    forks: null,
    // Placed against the finished layout: a decision is drawn under the box
    // that makes it, so it needs to know where that box ended up.
    decisions: markDecisions(edges, layout),
  };
}

/* --------------------------------------------------------------- regions -- */

/**
 * The gap under a line of boxes within a region — tighter than the row gap of
 * an unregioned picture, whose gaps carry every line of a whole row's fan-out;
 * here a gap holds a few local hops, and a screen's picture is tall enough
 * already. The tracked curves take the same number, so a level arch stays
 * inside it.
 */
const REGION_GAP_Y = 72;
/** The vertical rhythm of a regioned picture: one line of boxes and the gap under it. */
const REGION_PITCH = NODE_HEIGHT + REGION_GAP_Y;
/** A region's line of boxes wraps past this natural width. */
const REGION_LINE_MAX = 720;
/** Between two regions side by side. */
const REGION_GUTTER = 72;
/** Extra room between two rows of regions — the captions of the next row live in it. */
const BAND_GAP = 84;
/** Bands may run this wide: enough for the widest region, aiming at a readable aspect. */
function bandBudget(area: number, widest: number): number {
  return Math.max(widest, Math.min(3400, Math.max(1440, Math.ceil(Math.sqrt(area * 2.4)))));
}

/**
 * The layout of a screen's picture: each region a small column of lines —
 * a box above what it sets in motion, a line wrapping when it grows past
 * {@link REGION_LINE_MAX} — and the regions tiled left to right, wrapping
 * into bands, in the order the walk met them: the screen's own source order.
 * The anchor sits alone on top. Everything downstream — the tracked curves,
 * the pills, the pointer — is the same machinery over the same shapes.
 */
function packRegions(
  steps: WireStep[],
  infos: Map<string, StepNodeInfo>,
  modules: WireMapModule[],
  links: WireMapLink[]
): { layout: MapLayout; zones: StepRegionZone[] } {
  const anchor = steps.find((s) => s.anchor)!;
  const members = steps.filter((s) => !s.anchor);
  const moduleOf = new Map(modules.map((m) => [m.id, m]));

  // A box is wide enough for its words and for its ports — the anchor touches
  // most of the picture, and its lines need somewhere to leave from.
  const degree = new Map<string, number>();
  for (const l of links) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }
  const widthOf = (id: string): number => {
    const info = infos.get(id);
    // A cut step wears ` …` after its name and the anchor its ● mark before
    // it; size for both, or the CSS ellipsis eats the name's tail instead
    // (`/scan-to-verif…` for `/scan-to-verify …`).
    const cut = info?.step.cut != null ? ' …' : '';
    const mark = info?.step.anchor ? '● ' : '';
    return Math.max(
      nodeWidth(mark + (info?.label ?? id) + cut, info?.sub ?? ''),
      ((degree.get(id) ?? 0) + 1) * PORT_PITCH
    );
  };

  // Regions in the order the walk met them — the screen's own source order.
  interface Region {
    id: string;
    label: string;
    members: WireStep[];
  }
  const regions = new Map<string, Region>();
  for (const s of members) {
    const id = s.region?.id ?? anchor.id;
    const region = regions.get(id) ?? { id, label: s.region?.label ?? anchor.label, members: [] };
    region.members.push(s);
    regions.set(id, region);
  }

  // Within a region, a step goes under the steps that lead to it.
  const regionOf = new Map(members.map((s) => [s.id, s.region?.id ?? anchor.id]));
  const parentsOf = new Map<string, string[]>();
  for (const l of links) {
    if (l.source === anchor.id || l.target === anchor.id) continue;
    if (regionOf.get(l.source) !== regionOf.get(l.target)) continue;
    const list = parentsOf.get(l.target) ?? [];
    list.push(l.source);
    parentsOf.set(l.target, list);
  }

  interface Packed {
    lines: string[][];
    width: number;
  }
  const packed = new Map<string, Packed>();
  for (const region of regions.values()) {
    // A step goes under the steps that lead to it — rows from the region's OWN
    // links, never from distance to the anchor, which is flat inside a region:
    // a handler and the store it calls are both one hop from the screen, and
    // side by side their line was a level arch, hidden at rest, so the store
    // looked wired to nothing. Longest lead-to path, settled by relaxation as
    // the order reading settles its rows; a cycle stops moving at the bound.
    const rowOf = new Map<string, number>(region.members.map((m) => [m.id, 0]));
    for (let pass = 0; pass < region.members.length; pass++) {
      let moved = false;
      for (const m of region.members) {
        const above = (parentsOf.get(m.id) ?? [])
          .map((p) => rowOf.get(p))
          .filter((x): x is number => x !== undefined);
        if (above.length === 0) continue;
        const next = Math.max(...above) + 1;
        if (next > rowOf.get(m.id)!) {
          rowOf.set(m.id, next);
          moved = true;
        }
      }
      if (!moved) break;
    }
    const rows = new Map<number, WireStep[]>();
    for (const m of region.members) {
      const d = rowOf.get(m.id)!;
      rows.set(d, [...(rows.get(d) ?? []), m]);
    }
    const lines: string[][] = [];
    // The order a step was placed in, for putting its children near it.
    const placedAt = new Map<string, number>();
    let width = 0;
    for (const d of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(d)!;
      const near = (s: WireStep): number => {
        const placed = (parentsOf.get(s.id) ?? []).map((p) => placedAt.get(p)).filter((x): x is number => x !== undefined);
        if (placed.length === 0) return Number.MAX_SAFE_INTEGER;
        return placed.reduce((a, b) => a + b, 0) / placed.length;
      };
      row.sort(
        (a, b) => near(a) - near(b) || (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id)
      );
      let line: string[] = [];
      let w = 0;
      for (const m of row) {
        const bw = widthOf(m.id);
        if (line.length > 0 && w + NODE_GAP + bw > REGION_LINE_MAX) {
          lines.push(line);
          width = Math.max(width, w);
          line = [];
          w = 0;
        }
        line.push(m.id);
        w += (line.length > 1 ? NODE_GAP : 0) + bw;
        placedAt.set(m.id, placedAt.size);
      }
      if (line.length > 0) {
        lines.push(line);
        width = Math.max(width, w);
      }
    }
    packed.set(region.id, { lines, width });
  }

  // Tile the regions into bands under a width budget.
  interface Band {
    regions: Region[];
    lines: number;
    width: number;
  }
  let area = 0;
  let widest = 0;
  for (const region of regions.values()) {
    const p = packed.get(region.id)!;
    area += p.width * p.lines.length * REGION_PITCH;
    widest = Math.max(widest, p.width);
  }
  const budget = bandBudget(area, widest);
  const bands: Band[] = [];
  let band: Band | null = null;
  for (const region of regions.values()) {
    const p = packed.get(region.id)!;
    if (band === null || band.width + REGION_GUTTER + p.width > budget) {
      band = { regions: [], lines: 0, width: -REGION_GUTTER };
      bands.push(band);
    }
    band.regions.push(region);
    band.lines = Math.max(band.lines, p.lines.length);
    band.width += REGION_GUTTER + p.width;
  }
  const contentWidth = Math.max(widthOf(anchor.id), ...bands.map((b) => b.width));

  // Place everything. The anchor is alone on top; each band's regions centre
  // as a row of columns; a region's lines centre within its own width.
  const at = new Map<string, { x: number; y: number; line: number }>();
  const zones: StepRegionZone[] = [];
  const anchorY = PADDING;
  let y = anchorY + NODE_HEIGHT + SCREEN_LAYER_GAP + BAND_GAP;
  let globalLine = 0;
  for (const b of bands) {
    let x = PADDING + (contentWidth - b.width) / 2;
    for (const region of b.regions) {
      const p = packed.get(region.id)!;
      p.lines.forEach((line, j) => {
        const lw = line.reduce((a, id) => a + widthOf(id), 0) + NODE_GAP * (line.length - 1);
        let lx = x + (p.width - lw) / 2;
        for (const id of line) {
          at.set(id, { x: lx, y: y + j * REGION_PITCH, line: globalLine + j });
          lx += widthOf(id) + NODE_GAP;
        }
      });
      zones.push({
        id: region.id,
        label: region.label,
        x,
        y,
        width: p.width,
        height: (p.lines.length - 1) * REGION_PITCH + NODE_HEIGHT,
        entry: p.lines[0]![0]!,
      });
      x += p.width + REGION_GUTTER;
    }
    y += b.lines * REGION_PITCH + BAND_GAP;
    globalLine += b.lines;
  }
  const height = y - REGION_PITCH - BAND_GAP + NODE_HEIGHT + PADDING;

  // Layers count from the bottom, as the Map's do: the route of an edge and
  // which sides it uses fall out of the comparison alone.
  const layerOf = (id: string): number =>
    id === anchor.id ? globalLine + 1 : globalLine - (at.get(id)?.line ?? 0);

  const nodesById = new Map<string, MapNodeLayout>();
  const place = (id: string, x: number, yy: number): void => {
    nodesById.set(id, {
      id,
      module: moduleOf.get(id)!,
      island: false,
      generated: false,
      layer: layerOf(id),
      x,
      y: yy,
      width: widthOf(id),
      height: NODE_HEIGHT,
      sourceHandles: [],
      targetHandles: [],
      ports: { top: [], bottom: [] },
    });
  };
  place(anchor.id, PADDING + (contentWidth - widthOf(anchor.id)) / 2, anchorY);
  for (const [id, p] of at) place(id, p.x, p.y);

  // Edges and ports, exactly as the Map lays them: the route from the layers,
  // the sides from the route, the ports spread in the order the other end
  // appears left to right.
  const edges: MapEdgeLayout[] = [];
  interface SidePort extends PortRef {
    other: number;
  }
  const sidePorts = new Map<string, { top: SidePort[]; bottom: SidePort[] }>();
  const centreOf = (id: string): number => {
    const n = nodesById.get(id);
    return n ? n.x + n.width / 2 : 0;
  };
  for (const link of links) {
    const from = nodesById.get(link.source);
    const to = nodesById.get(link.target);
    if (!from || !to) continue;
    const id = linkId(link);
    const route: EdgeRoute = from.layer > to.layer ? 'down' : from.layer < to.layer ? 'up' : 'level';
    edges.push({
      id,
      source: link.source,
      target: link.target,
      sourceHandle: `s:${id}`,
      targetHandle: `t:${id}`,
      link,
      width: strokeWidthFor(link.count),
      back: from.layer <= to.layer,
      thin: false,
      route,
    });
    const sides =
      route === 'down'
        ? { source: 'bottom' as const, target: 'top' as const }
        : route === 'up'
          ? { source: 'top' as const, target: 'bottom' as const }
          : { source: 'top' as const, target: 'top' as const };
    const bySide = (node: string): { top: SidePort[]; bottom: SidePort[] } => {
      const found = sidePorts.get(node) ?? { top: [], bottom: [] };
      sidePorts.set(node, found);
      return found;
    };
    bySide(link.source)[sides.source].push({ id, type: 'source', other: centreOf(link.target) });
    bySide(link.target)[sides.target].push({ id, type: 'target', other: centreOf(link.source) });
  }
  const byOther = (a: SidePort, b: SidePort): number => a.other - b.other || a.id.localeCompare(b.id);
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

  const layout: MapLayout = {
    nodes: [...nodesById.values()],
    edges,
    layers: [],
    width: contentWidth + PADDING * 2,
    height,
    basis: { kind: 'all', declaredLinks: links.length, totalLinks: links.length },
    minWeight: 0,
    hiddenLinks: 0,
    mutual: [],
    moduleCycles: [],
  };
  return { layout, zones };
}

/**
 * The selection, extended through decisions: a fork's point is not a step —
 * it belongs to the steps around it — so selecting the step before a fork, or
 * one of its arms, reaches the point and, through it, the fork's other lines.
 * The set holds the selected id and every point connected to it through
 * points alone; a picture without forks is just the selection.
 */
export function selectionReach(model: StepsModel, selected: string): ReadonlySet<string> {
  const reach = new Set([selected]);
  if (model.forks === null || model.forks.size === 0) return reach;
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of model.layout.edges) {
      const from = reach.has(e.source);
      const to = reach.has(e.target);
      if (from === to) continue;
      const other = from ? e.target : e.source;
      if (model.forks.has(other) && !reach.has(other)) {
        reach.add(other);
        grew = true;
      }
    }
  }
  return reach;
}

/**
 * Which edges draw, given the selection. Selecting a step says "show me
 * everything about this one" — every line touching it comes out, a decision's
 * lines through its point ({@link selectionReach}). At rest a regioned
 * picture hides exactly two things: the anchor's own fan — the anchor leads
 * to everything by definition, and a hundred and four ways of saying so were
 * the whole canvas, so one line into each region stands in for it — and, as
 * everywhere, what points back up the layering. Every other lead-to draws, a
 * line between two regions included: the empty state's prompt firing the same
 * handler as the header's is the picture, and hiding it made a box that leads
 * three places read as wired to nothing. A shared step fed from below (the
 * toast every handler calls) stays quiet through the back rule alone. An
 * unregioned picture keeps the Map's rule.
 */
export function stepEdgeVisible(
  model: StepsModel,
  edge: MapEdgeLayout,
  selected: string | null,
  reach?: ReadonlySet<string>
): boolean {
  if (selected !== null) {
    const r = reach ?? selectionReach(model, selected);
    return r.has(edge.source) || r.has(edge.target);
  }
  if (edge.thin || edge.back) return false;
  if (model.regions === null) return true;
  const from = model.nodes.get(edge.source)?.step;
  if (from?.anchor) return model.regionEntries?.has(edge.target) ?? true;
  return true;
}

/** The side panel's two lists for a selected step. */
export function stepNeighbourhood(
  payload: WireStepsPayload,
  id: string
): { arrivesFrom: WireStepLink[]; leadsTo: WireStepLink[] } {
  return {
    arrivesFrom: payload.links.filter((l) => l.to === id),
    leadsTo: payload.links.filter((l) => l.from === id),
  };
}

/** `useReviewHandlers → handleApproveAllImages`, or '' when nothing was folded. */
export function stepViaText(link: WireStepLink): string {
  return link.via.map((v) => v.name).join(' → ');
}

/** The layout edge a link draws as, or null when it is a self-loop. */
export function stepPairId(link: WireStepLink): string | null {
  return link.from === link.to ? null : linkId({ source: link.from, target: link.to });
}
