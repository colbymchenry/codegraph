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
  /**
   * Per box, the links it does NOT draw a line for at rest, said in words on
   * it instead ({@link StepStub}). Empty for a picture whose every line is
   * local.
   */
  stubs: Map<string, StepStub[]>;
  /** The edges drawn as stubs rather than lines — what {@link stepEdgeVisible} keeps back. */
  stubbed: ReadonlySet<string>;
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

/**
 * One end of a link said in WORDS on its box instead of drawn as a line across
 * the canvas.
 *
 * A line is a good drawing of a hop between two boxes a reader can see at
 * once. It is a bad drawing of a hop across two thousand pixels: on one real
 * screen the hundred and thirteen lines drawn at rest crossed each other six
 * hundred and fifty-two times and each ran over five other boxes' names, so
 * no single line could be followed and the boxes could not be read either.
 * The link is not dropped — it is stated at BOTH ends, `→ resumeInference` on
 * the box that leads there and `← CaptureView` on the box it arrives at, which
 * says more than a line disappearing off the edge of the screen does. Select
 * the box and every one of its real lines draws, exactly as before.
 */
export interface StepStub {
  /** The layout edge this stands for, so selecting draws the real line. */
  edge: string;
  /** The box at the other end. */
  other: string;
  /** What that box calls itself. */
  label: string;
  /** `out` — this box leads there; `in` — it arrives from there. */
  dir: 'out' | 'in';
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
      // Not the Map: a step has no dependent count and draws no weight bar.
      dependents: { files: 0, modules: 0 },
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
  const entries = zones === null ? null : new Set(zones.map((z) => z.entry));
  const { stubs, stubbed } = packStubs(layout, nodes, layerGap, entries);
  return {
    layout,
    nodes,
    edges,
    layerGap,
    curves,
    polylines,
    counts,
    regions: zones,
    regionEntries: entries,
    forks: null,
    stubs,
    stubbed,
    // Placed against the finished layout: a decision is drawn under the box
    // that makes it, so it needs to know where that box ended up.
    decisions: markDecisions(edges, layout),
  };
}

/* ----------------------------------------------------------------- stubs -- */

/**
 * How far apart two boxes may be, in lines, for the hop between them to still
 * read as a line. Three lines is about as far as an eye follows a curve
 * through other boxes without losing which one it left.
 */
const STUB_SPAN_LINES = 3;

/**
 * Which links are said in words rather than drawn, and the words for each box.
 *
 * A link is drawn when both its boxes are close enough to take it in at once —
 * within {@link STUB_SPAN_LINES} lines, and no further across than a region's
 * own lines start out running ({@link REGION_LINE_MIN}), so a drawn line stays
 * inside one column of reading — and it runs down the layering. Everything else becomes a
 * {@link StepStub} at both ends — the one link into each region included, so a
 * region tiled into a lower band no longer reaches back up to the start with a
 * line across the whole picture. Those 96 lines were 17% of what a real app's
 * 51 screens drew and 79% of everything they crossed.
 */
/**
 * The name a stub points at, without the mark its box wears for its kind: the
 * stub already leads with a direction, and `← ⇠ onCaptureProgress` reads as
 * two arrows arguing. The box itself keeps its mark, where nothing competes.
 */
function stubLabel(label: string): string {
  return label.startsWith('⇢ ') || label.startsWith('⇠ ') ? label.slice(2) : label;
}

function packStubs(
  layout: MapLayout,
  infos: Map<string, StepNodeInfo>,
  layerGap: number,
  entries: ReadonlySet<string> | null
): { stubs: Map<string, StepStub[]>; stubbed: ReadonlySet<string> } {
  const stubs = new Map<string, StepStub[]>();
  const stubbed = new Set<string>();
  const nodeById = new Map(layout.nodes.map((n) => [n.id, n]));
  const pitch = NODE_HEIGHT + layerGap;
  const add = (id: string, stub: StepStub): void => {
    stubs.set(id, [...(stubs.get(id) ?? []), stub]);
  };
  for (const edge of layout.edges) {
    const from = nodeById.get(edge.source);
    const to = nodeById.get(edge.target);
    if (!from || !to) continue;
    // On a regioned picture the anchor's fan is already stood in for by one
    // link into each region ({@link StepsModel.regionEntries}); only THAT link
    // is a line worth keeping or words worth saying, and the rest of the fan
    // stays quiet as it was. An unregioned picture has no stand-in, so its
    // anchor's links follow the same rule as every other.
    if (entries !== null && infos.get(edge.source)?.step.anchor && !entries.has(edge.target)) continue;
    const lines = Math.abs(to.y - from.y) / pitch;
    const across = Math.abs(to.x + to.width / 2 - (from.x + from.width / 2));
    // A back edge points up the layering: it is not a local hop however near
    // it is, and it was already drawing nothing at rest — now it says so.
    const near = !edge.back && !edge.thin && lines <= STUB_SPAN_LINES + 0.01 && across <= REGION_LINE_MIN;
    if (near) continue;
    stubbed.add(edge.id);
    add(edge.source, {
      edge: edge.id,
      other: edge.target,
      label: stubLabel(infos.get(edge.target)?.label ?? edge.target),
      dir: 'out',
    });
    add(edge.target, {
      edge: edge.id,
      other: edge.source,
      label: stubLabel(infos.get(edge.source)?.label ?? edge.source),
      dir: 'in',
    });
  }
  // What a box leads to reads before what reaches it, and each side in the
  // order the picture puts the other end — down the page, then across.
  const place = (id: string): number => {
    const n = nodeById.get(id);
    return n ? n.y * 100000 + n.x : 0;
  };
  for (const list of stubs.values()) {
    list.sort((a, b) => (a.dir === b.dir ? place(a.other) - place(b.other) : a.dir === 'out' ? -1 : 1));
  }
  return { stubs, stubbed };
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
/** The least width a region's line of boxes runs to before it wraps. */
const REGION_LINE_MIN = 720;
/**
 * The widths a region's lines are tried at, narrowest first — a tie keeps the
 * narrowest, so a small region never sprawls. A fixed 720 was the whole reason
 * a big screen came out a 6,500px ribbon.
 */
const REGION_WIDTHS = [REGION_LINE_MIN, 1000, 1300, 1600, 1900, 2200, 2600, 3000];
/**
 * The shape the whole picture is aimed at: a little wider than tall. Boxes are
 * wide and short, and so is the window a reader has, so a landscape picture
 * wastes less of both than a square one — and a reader scrolls a tall picture
 * far more than they pan a wide one.
 */
const CANVAS_ASPECT = 1.4;
/** How far a finished canvas is from {@link CANVAS_ASPECT}, in log space so wide and tall cost alike. */
function canvasCost(laid: { width: number; height: number }): number {
  return Math.abs(Math.log(Math.max(1, laid.width) / Math.max(1, laid.height) / CANVAS_ASPECT));
}
/** How far a cluster's boxes sit in from the step that fires them. */
const CLUSTER_INDENT = 26;
/** Clusters stop stepping in past this depth, so a long chain stays on screen. */
const CLUSTER_DEPTH_MAX = 6;
/** Between two regions side by side. */
const REGION_GUTTER = 72;
/** Extra room between two rows of regions — the captions of the next row live in it. */
const BAND_GAP = 84;
/** Bands may run this wide: enough for the widest region, aiming at a readable aspect. */
function bandBudget(area: number, widest: number): number {
  return Math.max(widest, Math.min(3400, Math.max(1440, Math.ceil(Math.sqrt(area * 2.4)))));
}

/**
 * The links minus the ones that close a cycle — those whose end is still open
 * on the way in, found by one walk from every link's source in order, so the
 * walk's own order decides which way round a cycle is the forward one. The
 * twin of the order reading's `withoutBackEdges`, over map links.
 */
function forwardLinks(links: readonly WireMapLink[]): WireMapLink[] {
  const out = new Map<string, WireMapLink[]>();
  const nodes = new Set<string>();
  for (const l of links) {
    nodes.add(l.source);
    nodes.add(l.target);
    const list = out.get(l.source);
    if (list) list.push(l);
    else out.set(l.source, [l]);
  }
  /** 1 = open on the way in, 2 = done with. */
  const state = new Map<string, number>();
  const closes = new Set<WireMapLink>();
  const visit = (root: string): void => {
    const stack: { id: string; next: number }[] = [{ id: root, next: 0 }];
    state.set(root, 1);
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      const list = out.get(top.id) ?? [];
      if (top.next >= list.length) {
        state.set(top.id, 2);
        stack.pop();
        continue;
      }
      const link = list[top.next++]!;
      const seen = state.get(link.target) ?? 0;
      if (seen === 1) {
        closes.add(link);
        continue;
      }
      if (seen === 2) continue;
      state.set(link.target, 1);
      stack.push({ id: link.target, next: 0 });
    }
  };
  for (const id of nodes) if (!state.has(id)) visit(id);
  return links.filter((l) => !closes.has(l));
}

/**
 * The layout of a screen's picture: each region a small column of lines —
 * a box above what it sets in motion, a line wrapping when it grows past the
 * width its shape earns ({@link REGION_WIDTHS}) — and the regions tiled left to right, wrapping
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

  // Within a region, a step goes under the steps that lead to it — minus the
  // links that close a cycle. Relaxation over a cyclic graph never settles: it
  // adds a row per pass until the bound, so a region holding one cycle sent
  // sixty-five of its boxes to rows 294-301 while the rest sat at 0-2, and the
  // order they were then packed in had nothing to do with what leads to what.
  // The order reading learned this first ({@link withoutBackEdges} there); the
  // cycle is still drawn, it just cannot stretch the picture.
  const regionOf = new Map(members.map((s) => [s.id, s.region?.id ?? anchor.id]));
  const intra = links.filter(
    (l) =>
      l.source !== anchor.id &&
      l.target !== anchor.id &&
      l.source !== l.target &&
      regionOf.get(l.source) === regionOf.get(l.target)
  );
  /** The steps the screen itself leads to — where its one line into a region can land. */
  const fromAnchor = new Set(links.filter((l) => l.source === anchor.id).map((l) => l.target));
  const parentsOf = new Map<string, string[]>();
  for (const l of forwardLinks(intra)) {
    const list = parentsOf.get(l.target) ?? [];
    list.push(l.source);
    parentsOf.set(l.target, list);
  }

  // Who a step is drawn under: the FIRST step in the region that leads to it,
  // in the walk's order — the same first-reach-wins the walk itself uses. A
  // step belongs to one cluster, so a box that fires twenty things has those
  // twenty under it rather than scattered down the region.
  const childrenOf = new Map<string, string[]>();
  {
    const order = new Map(members.map((s) => [s.id, s.order ?? Number.MAX_SAFE_INTEGER]));
    const out = new Map<string, string[]>();
    for (const l of forwardLinks(intra)) out.set(l.source, [...(out.get(l.source) ?? []), l.target]);
    const owned = new Set<string>();
    const queue = members.filter((s) => (parentsOf.get(s.id) ?? []).length === 0).map((s) => s.id);
    for (const id of queue) owned.add(id);
    while (queue.length > 0) {
      const id = queue.shift()!;
      const kids = [...new Set(out.get(id) ?? [])].sort(
        (a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0) || a.localeCompare(b)
      );
      for (const kid of kids) {
        if (owned.has(kid)) continue;
        owned.add(kid);
        childrenOf.set(id, [...(childrenOf.get(id) ?? []), kid]);
        queue.push(kid);
      }
    }
  }

  interface Packed {
    /** Where each member sits: x from the region's left, and which line it is on. */
    pos: Map<string, { x: number; line: number }>;
    lines: number;
    width: number;
    entry: string;
  }
  const anchorY = PADDING;
  /**
   * The whole picture at one line width: every region packed with its lines
   * allowed to run that wide, then the regions dropped onto the canvas.
   *
   * The width cannot be estimated from the boxes alone — a cluster spends
   * lines on its own structure, so `total / width` badly under-counts what a
   * region takes — and it cannot be chosen per region either: widening one
   * region to square it off leaves fewer of them side by side, so the CANVAS
   * gets taller even as each region looks better (`/home` went 3,584px to
   * 5,624px that way). One width, scored on the finished canvas.
   */
  const layoutAt = (lineMax: number) => {
    const packed = new Map<string, Packed>();
    for (const region of regions.values()) {
      // A region is drawn as CLUSTERS, not as rows: a step, then the steps it
      // sets in motion on the line under it, indented. Rows-then-wrap put every
      // step of one distance on the same rows and wrapped them at a fixed width,
      // so a box and the thing it fires ended up seven
      // lines apart and their line crossed everything between — 70 of 113 lines
      // on one real screen joined boxes ONE step apart and rendered seven lines
      // apart. Under a cluster the same line is one line long.
      const ids = new Set(region.members.map((m) => m.id));
      const kidsOf = (id: string): string[] => (childrenOf.get(id) ?? []).filter((k) => ids.has(k));
      const starts = region.members.filter((m) => (parentsOf.get(m.id) ?? []).length === 0).map((m) => m.id);

      /** Lay the region out with its lines allowed to run this wide. */
      const layAt = (lineMax: number): { pos: Map<string, { x: number; line: number }>; lines: number; width: number } => {
        /**
         * One cluster, in its own coordinates: a step, then the steps it sets
         * in motion on the line under it, stepped in, and a cluster of its own
         * for anything that leads on further.
         */
        const cluster = (root: string): { pos: Map<string, { x: number; line: number }>; lines: number; width: number } => {
          const pos = new Map<string, { x: number; line: number }>();
          let line = 0;
          let width = 0;
          const spread = (list: string[], left: number): void => {
            if (list.length === 0) return;
            let lx = left;
            for (const id of list) {
              const bw = widthOf(id);
              if (lx > left && lx + bw - left > lineMax) {
                line += 1;
                lx = left;
              }
              pos.set(id, { x: lx, line });
              width = Math.max(width, lx + bw);
              lx += bw + NODE_GAP;
            }
            line += 1;
          };
          const place = (id: string, depth: number): void => {
            const x = Math.min(depth, CLUSTER_DEPTH_MAX) * CLUSTER_INDENT;
            pos.set(id, { x, line });
            width = Math.max(width, x + widthOf(id));
            line += 1;
            const kids = kidsOf(id);
            spread(kids.filter((k) => kidsOf(k).length === 0), x + CLUSTER_INDENT);
            for (const hub of kids.filter((k) => kidsOf(k).length > 0)) place(hub, depth + 1);
          };
          place(root, 0);
          return { pos, lines: line, width };
        };

        /** The steps that fire nothing, side by side — a screen's handlers are siblings, not a hierarchy. */
        const flat = (list: string[]): { pos: Map<string, { x: number; line: number }>; lines: number; width: number } => {
          const pos = new Map<string, { x: number; line: number }>();
          let line = 0;
          let width = 0;
          let lx = 0;
          for (const id of list) {
            const bw = widthOf(id);
            if (lx > 0 && lx + bw > lineMax) {
              line += 1;
              lx = 0;
            }
            pos.set(id, { x: lx, line });
            width = Math.max(width, lx + bw);
            lx += bw + NODE_GAP;
          }
          return { pos, lines: list.length === 0 ? 0 : line + 1, width };
        };

        // The region's blocks, in the walk's order: everything that fires
        // nothing first, as one spread, then a cluster per step that does.
        const blocks: { pos: Map<string, { x: number; line: number }>; lines: number; width: number }[] = [];
        const bare = starts.filter((id) => kidsOf(id).length === 0);
        if (bare.length > 0) blocks.push(flat(bare));
        const placed = new Set(bare);
        for (const id of starts) {
          if (placed.has(id)) continue;
          const b = cluster(id);
          for (const k of b.pos.keys()) placed.add(k);
          blocks.push(b);
        }
        // A cycle can leave a member with no reachable start; it stands alone.
        for (const m of region.members) {
          if (placed.has(m.id)) continue;
          const b = cluster(m.id);
          for (const k of b.pos.keys()) placed.add(k);
          blocks.push(b);
        }

        // The blocks stack, one under the next, in the walk's order.
        //
        // Dropping them side by side the way the REGIONS drop onto the canvas
        // was tried and measured across a real app's 51 screens, and it is a
        // bad trade: total height 42,084px -> 39,756px (-6%), but lines running
        // over other boxes 120 -> 134 and lines crossing each other 5 -> 8,
        // because two clusters side by side put each one's lines through the
        // other. Height is cheap to scroll; a crossed line is what made this
        // picture unreadable in the first place. Regions differ — they are far
        // enough apart that few lines run between them.
        const pos = new Map<string, { x: number; line: number }>();
        let width = 0;
        let lines = 0;
        for (const b of blocks) {
          for (const [id, at2] of b.pos) pos.set(id, { x: at2.x, line: lines + at2.line });
          width = Math.max(width, b.width);
          lines += b.lines;
        }
        return { pos, lines, width };
      };

      const { pos, lines: line, width } = layAt(lineMax);
      // Where the screen's own line into this region lands: the box nearest the
      // region's top-left that the screen actually leads to. The walk's first
      // member used to stand for the region, but clustering moves a step that
      // fires something below the ones that fire nothing, so that box could sit
      // lines down inside the region and the line from the start had to reach
      // past everything above it to get there.
      const topmost = (ids: string[]): string | null =>
        ids
          .filter((id) => pos.has(id))
          .sort((a, b) => pos.get(a)!.line - pos.get(b)!.line || pos.get(a)!.x - pos.get(b)!.x)[0] ?? null;
      const entry =
        topmost(region.members.filter((m) => fromAnchor.has(m.id)).map((m) => m.id)) ??
        topmost(region.members.map((m) => m.id)) ??
        region.members[0]!.id;
      packed.set(region.id, { pos, lines: line, width, entry });
    }

    // How wide the picture may run before a region has to go underneath.
    let area = 0;
    let widest = 0;
    for (const region of regions.values()) {
      const p = packed.get(region.id)!;
      area += p.width * p.lines * REGION_PITCH;
      widest = Math.max(widest, p.width);
    }
    const budget = bandBudget(area, widest);

    // Place everything. The anchor is alone on top; each region, in the order
    // the walk met them, goes as high as it can and then as far left as it can.
    //
    // Squaring the regions off into bands — a row at a time, the row as tall as
    // its tallest member — left a screen's canvas 55% region and 45% nothing
    // (`/home` 44%: 4,860px tall to hold 2,160px of picture), and that emptiness
    // is what a reader scrolls through. Going highest-then-leftmost keeps the
    // reading order (an earlier region is placed first, so it is never pushed
    // below a later one) while a short region tucks under another short one
    // instead of waiting for the tall one beside it.
    const at = new Map<string, { x: number; y: number; line: number }>();
    const zones: StepRegionZone[] = [];
    const topY = anchorY + NODE_HEIGHT + SCREEN_LAYER_GAP + BAND_GAP;
    /** What each stretch of the canvas is filled to, so far. */
    const sky: { x0: number; x1: number; y: number }[] = [];
    const floorAt = (x0: number, x1: number): number => {
      let f = topY;
      for (const s of sky) if (s.x1 > x0 + 1 && s.x0 < x1 - 1) f = Math.max(f, s.y);
      return f;
    };
    for (const region of regions.values()) {
      const p = packed.get(region.id)!;
      const rh = Math.max(0, p.lines - 1) * REGION_PITCH + NODE_HEIGHT;
      // Somewhere to start, plus the right-hand edge of everything already down.
      const spots = [PADDING, ...sky.map((s) => s.x1 + REGION_GUTTER)]
        .filter((x, i, all) => all.indexOf(x) === i && x + p.width <= PADDING + Math.max(budget, p.width))
        .sort((m, n) => m - n);
      let best = { x: PADDING, y: floorAt(PADDING, PADDING + p.width) };
      for (const x of spots) {
        const y = floorAt(x, x + p.width);
        if (y < best.y - 1) best = { x, y };
      }
      const { x, y } = best;
      // A cluster reads from its left edge, not from the region's centre: the
      // indent is what says which step fired which.
      for (const [id, at2] of p.pos) {
        at.set(id, { x: x + at2.x, y: y + at2.line * REGION_PITCH, line: 0 });
      }
      zones.push({ id: region.id, label: region.label, x, y, width: p.width, height: rh, entry: p.entry });
      // The gap under a region carries the next one's caption.
      sky.push({ x0: x, x1: x + p.width, y: y + rh + BAND_GAP });
    }
    const contentWidth = Math.max(widthOf(anchor.id), ...zones.map((z) => z.x + z.width - PADDING));
    // The layering comes from the finished geometry, not from a band counter:
    // once regions drop independently, what a reader sees as one row IS one row.
    for (const spot of at.values()) spot.line = Math.round((spot.y - topY) / REGION_PITCH);
    const globalLine = Math.max(0, ...[...at.values()].map((v) => v.line)) + 1;
    const height = Math.max(anchorY + NODE_HEIGHT, ...zones.map((z) => z.y + z.height)) + PADDING;
    return { at, zones, contentWidth, globalLine, height, width: contentWidth + PADDING * 2 };
  };

  // Try the widths and keep the picture that comes out closest to the shape a
  // window has. A tie keeps the narrowest, so a small picture never sprawls.
  const tries = REGION_WIDTHS.map((w) => layoutAt(w));
  const { at, zones, contentWidth, globalLine, height } = tries.reduce((a, b) =>
    canvasCost(a) <= canvasCost(b) ? a : b
  );


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
      weight: 0,
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
  // A hop too far to follow says itself in words on both its boxes instead
  // ({@link StepStub}); drawing it as well is the web those words replace.
  if (model.stubbed.has(edge.id)) return false;
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
