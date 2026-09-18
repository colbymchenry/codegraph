/**
 * The Flow strip's geometry, without a browser.
 *
 * The strip reads left to right: one card per hop, opened at the line that
 * makes the next call, linked by an 86px connector carrying the edge. That is a
 * straight line for one path — but two paths that share endpoints are one
 * picture, not two, so the layout is a small DAG over the union of whatever
 * flows are on screen, and a single chain is just the DAG with one node per
 * column.
 *
 * Two rules make it deterministic, which is the whole point of not using a
 * physics layout (design spec §1):
 *
 * - **A card's column is its longest distance from a start.** Two routes that
 *   rejoin therefore rejoin in the same column, and a card never sits left of
 *   something that calls it.
 * - **A card's height is computed, not measured.** The number of source lines
 *   is known before anything renders, so the rows can be packed without waiting
 *   for a `ResizeObserver` — and the card's CSS pins the same height, so the
 *   arrows land where the arithmetic said they would. The File view's outline
 *   works the same way and for the same reason.
 *
 * Tested in `__tests__/ui-flow-model.test.ts`.
 */

import type {
  WireBoundaryCandidate,
  WireFlow,
  WireFlowBoundary,
  WireFlowContinuation,
  WireFlowEdge,
  WireFlowHop,
} from './api';

/* ------------------------------------------------------------ dimensions -- */

/** Card width (design spec §3.5). */
export const CARD_WIDTH = 380;
/** Connector width between two cards, when the label fits inside it. */
export const LINK_WIDTH = 86;
/** Distance between two columns' left edges, for a link with an ordinary label. */
export const COLUMN_PITCH = CARD_WIDTH + LINK_WIDTH;

/**
 * Advance of IBM Plex Mono at the 11px a connector label is set in, and the
 * clear space kept either side of the longest line.
 *
 * A gap only ever GROWS past {@link LINK_WIDTH}: 86px holds `calls` and
 * `line 2029` comfortably, but a synthesized hop's `registered at App.tsx:3764`
 * is twenty-six characters, and at a fixed pitch it ran underneath the cards on
 * both sides of it — on excalidraw's `mutateElement` flow, over the source of
 * the very card the label was explaining. The label is the evidence for a hop
 * nobody can see in the source, so the picture makes room for it.
 */
const LABEL_CHAR_WIDTH = 6.65;
const LABEL_PAD = 18;

/** Card header: `10px 12px 6px` padding around one 18px row, plus a rule. */
export const HEADER_HEIGHT = 35;
/** Source window: `12px/19px` mono with 6px of padding above and below. */
export const CODE_LINE_HEIGHT = 19;
export const CODE_PADDING = 12;
/** A card with no source still says why, in one line of the same height. */
export const NO_SOURCE_HEIGHT = CODE_LINE_HEIGHT + CODE_PADDING;
/** Clear space between two cards stacked in one column. */
export const ROW_GAP = 24;
/** Canvas padding around the whole strip. */
export const PADDING = 32;

/** Exact rendered height of a card, which its CSS then pins. */
export function cardHeight(hop: WireFlowHop): number {
  const lines = hop.source?.lines?.length ?? 0;
  const body = lines > 0 ? lines * CODE_LINE_HEIGHT + CODE_PADDING : NO_SOURCE_HEIGHT;
  return HEADER_HEIGHT + body;
}

/* --------------------------------------------------------------- end cap -- */

/** End-cap width (design spec §3.5). */
export const END_CAP_WIDTH = 240;
/** Padding inside the cap, all four sides. */
export const END_CAP_PADDING = 12;
/** 12px text at 1.45 — the cap's own line box. */
export const END_CAP_LINE = 17.4;
/** One mono row: a candidate target, an uncertain continuation. */
export const END_CAP_ROW = 18;
/** Space between two blocks inside the cap. */
export const END_CAP_GAP = 8;

/**
 * Characters of 12px Archivo that fit across the cap's 216px of content.
 *
 * The cap's height has to be known before it renders, for the same reason a
 * card's does — the layout packs columns with it. So the text is built here
 * (see {@link endCapText}), measured with this constant, and the component
 * renders exactly what was measured. Deliberately a little pessimistic: a cap
 * estimated too tall leaves white space, a cap estimated too short would put
 * its last row under the next one.
 */
const END_CAP_CHARS = 32;

function wrappedLines(text: string): number {
  return Math.max(1, Math.ceil(text.length / END_CAP_CHARS));
}

/** One dispatch site as the cap words it. */
export interface EndCapSite {
  /** "computed member call at line 61". */
  headline: string;
  /** The statically visible key, set in mono. Null when it is a runtime value. */
  key: string | null;
  /** "key is a runtime value", or the "+N more such sites" tail. */
  notes: string[];
  candidates: WireBoundaryCandidate[];
  /** "N candidate targets", the heading over the rows. Null when there are none. */
  candidateHeading: string | null;
  /** Why there is no shortlist, when a key was visible but too generic. */
  candidateNote: string | null;
}

/**
 * Everything the end cap says, as strings.
 *
 * Built here rather than in the component so the layout can measure the cap
 * before it exists — and so the wording is testable without a browser.
 */
export interface EndCapText {
  /** The sentence after the bold "Where the graph stops." lead. */
  intro: string;
  sites: EndCapSite[];
  /** "No dynamic-dispatch site …", when the detector found nothing. */
  quiet: string | null;
  uncertainHeading: string | null;
  uncertain: WireFlowContinuation[];
  further: string | null;
  missed: string | null;
}

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export function endCapText(boundary: WireFlowBoundary): EndCapText {
  const sites: EndCapSite[] = boundary.sites.map((site) => {
    const notes: string[] = [];
    if (site.key === null) notes.push('the key is a runtime value');
    if (site.moreSites > 0) {
      notes.push(`+${site.moreSites} more such ${plural(site.moreSites, 'site', 'sites')} here`);
    }
    return {
      headline: `${site.label} at line ${site.line}`,
      key: site.key,
      notes,
      candidates: site.candidates,
      candidateHeading:
        site.candidates.length > 0
          ? `${site.candidates.length} candidate ${plural(site.candidates.length, 'target', 'targets')} \u203a`
          : null,
      candidateNote: site.candidateNote,
    };
  });

  const missedNames = boundary.missed.map((m) => m.name);
  return {
    intro:
      boundary.sites.length > 0
        ? `${boundary.node.name} chooses its next call at runtime.`
        : `${boundary.node.name} is the last symbol on this path.`,
    sites,
    quiet:
      boundary.sites.length > 0
        ? null
        : 'No dynamic-dispatch site was detected in its body, so nothing here explains the break.',
    uncertainHeading:
      boundary.uncertain.total > 0
        ? `${boundary.uncertain.total} name-only ${plural(boundary.uncertain.total, 'match', 'matches')} not followed (confidence < 0.6)`
        : null,
    uncertain: boundary.uncertain.items,
    further:
      boundary.further.total > 0
        ? `It makes ${boundary.further.total} further resolved ${plural(boundary.further.total, 'call', 'calls')} this path does not need.`
        : null,
    missed:
      missedNames.length > 0
        ? `Never reaches ${missedNames.join(', ')}${boundary.missed.length < missedNames.length ? '…' : '.'}`
        : null,
  };
}

/** Exact rendered height of an end cap, which its CSS then pins as a minimum. */
export function endCapHeight(boundary: WireFlowBoundary): number {
  const text = endCapText(boundary);
  let h = END_CAP_PADDING * 2;
  h += wrappedLines(`Where the graph stops. ${text.intro}`) * END_CAP_LINE;
  for (const site of text.sites) {
    h += END_CAP_GAP;
    h += wrappedLines(site.headline) * END_CAP_LINE;
    if (site.key !== null) h += END_CAP_ROW;
    for (const note of site.notes) h += wrappedLines(note) * END_CAP_LINE;
    if (site.candidateHeading !== null) {
      h += END_CAP_LINE + site.candidates.length * END_CAP_ROW;
    } else if (site.candidateNote !== null) {
      h += wrappedLines(site.candidateNote) * END_CAP_LINE;
    }
  }
  if (text.quiet !== null) h += END_CAP_GAP + wrappedLines(text.quiet) * END_CAP_LINE;
  if (text.uncertainHeading !== null) {
    h += END_CAP_GAP + wrappedLines(text.uncertainHeading) * END_CAP_LINE;
    h += text.uncertain.length * END_CAP_ROW;
  }
  if (text.further !== null) h += END_CAP_GAP + wrappedLines(text.further) * END_CAP_LINE;
  if (text.missed !== null) h += END_CAP_GAP + wrappedLines(text.missed) * END_CAP_LINE;
  return Math.round(h);
}

/* ----------------------------------------------------------------- model -- */

export interface FlowCardLayout {
  /** Node id — unique in the DAG even when two flows both contain it. */
  id: string;
  hop: WireFlowHop;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  /** Flows this card belongs to, by flow id — what dims when one is picked. */
  flows: string[];
  /** Position in the ACTIVE flow, or -1 when it is not on it. */
  step: number;
  /**
   * The dispatch line an end cap hangs off, when one does.
   *
   * The card is tinted there for the same reason a hop is tinted at its call
   * site: it is the line the next thing on screen is about. A boundary card has
   * no resolved call to link, so the tint is all the connection there is.
   */
  stopLine: number | null;
}

export interface FlowLinkLayout {
  id: string;
  source: string;
  target: string;
  /** Null on the dotted link into an end cap — no edge records a non-call. */
  edge: WireFlowEdge | null;
  /** Flows this link belongs to. */
  flows: string[];
  /** The full label, for the connector's tooltip. */
  label: string;
  /**
   * The label broken into short centred lines, longest path segments shortened
   * to a basename. Eighty-six pixels is about eleven monospace characters, so a
   * synthesized hop's `via interface impl / registered at payroll.go:37` has to
   * stack rather than run over both cards it sits between.
   */
  labelLines: string[];
  /** `line 2029` — drawn under the connector, when the edge recorded one. */
  lineLabel: string | null;
  /** SVG dasharray, or null for a solid line. */
  dash: string | null;
  /** This is the dotted link into an end cap, not a recorded edge. */
  cap: boolean;
}

/** An end cap, placed one column past the symbol whose path stopped. */
export interface FlowEndCapLayout {
  /** `cap:<anchor node id>`. */
  id: string;
  /** The card the dotted link comes out of. */
  anchorId: string;
  boundary: WireFlowBoundary;
  x: number;
  y: number;
  width: number;
  height: number;
  column: number;
  /** Flows that stop here — what dims when one is picked. */
  flows: string[];
}

export interface FlowLayout {
  cards: FlowCardLayout[];
  endCaps: FlowEndCapLayout[];
  links: FlowLinkLayout[];
  width: number;
  height: number;
  /** Longest chain on screen, in cards. */
  columns: number;
  /** Connector width after each column — {@link LINK_WIDTH} unless a label needed more. */
  gaps: number[];
}

/** Dash pattern for a link (design spec §3.5). Heuristic wins over uncertain. */
export function dashFor(edge: WireFlowEdge): string | null {
  if (edge.synthesized) return '5 3';
  if (edge.uncertain) return '2 3';
  return null;
}

/** The dotted link into an end cap (design spec §3.5). */
export const END_CAP_DASH = '2 4';

/** The layout id of the cap hanging off `anchorId`, and the way back. */
export const capId = (anchorId: string): string => `cap:${anchorId}`;
export const isCapId = (id: string): boolean => id.startsWith('cap:');
export const anchorOf = (id: string): string => (isCapId(id) ? id.slice(4) : id);

/** Longest a connector label line may be before it is cut. */
export const LABEL_MAX_CHARS = 26;

/** `src/a/b/thing.go:37` reads as `thing.go:37` under an 86px connector. */
function shortenSites(text: string): string {
  return text.replace(/[\w.@$/\\-]+[/\\]([\w.$-]+:\d+)/g, '$1');
}

/**
 * The label, stacked. `\u00b7`-separated clauses become their own lines, and
 * anything still too long is cut with an ellipsis — the connector's tooltip
 * carries the untruncated text.
 */
export function labelLinesFor(edge: WireFlowEdge): string[] {
  return shortenSites(edge.label)
    .split(' \u00b7 ')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) =>
      part.length > LABEL_MAX_CHARS ? `${part.slice(0, LABEL_MAX_CHARS - 1)}\u2026` : part
    );
}

/** `line 2029`, or null when the edge carries no line. */
export function lineLabelFor(edge: WireFlowEdge): string | null {
  return typeof edge.line === 'number' && edge.line > 0 ? `line ${edge.line}` : null;
}

/**
 * Lay out the union of `flows`, highlighting `activeId`.
 *
 * Passing one flow gives a single row of cards; passing several gives the DAG
 * where they share hops. The active flow decides the vertical order — it is
 * drawn along the top of its columns — so picking a flow never re-sorts the
 * picture underneath the reader.
 */
export function buildFlowLayout(flows: readonly WireFlow[], activeId: string | null): FlowLayout {
  const active = flows.find((f) => f.id === activeId) ?? flows[0] ?? null;
  const activeSteps = new Map<string, number>();
  active?.hops.forEach((hop, index) => activeSteps.set(hop.node.id, index));

  // ---- collect nodes and edges over every flow on screen -------------------
  const cards = new Map<string, { hop: WireFlowHop; flows: string[]; order: number }>();
  const links = new Map<
    string,
    { source: string; target: string; edge: WireFlowEdge; flows: string[] }
  >();
  const successors = new Map<string, Set<string>>();
  const indegree = new Map<string, number>();

  let order = 0;
  for (const flow of flows) {
    for (let i = 0; i < flow.hops.length; i++) {
      const hop = flow.hops[i] as WireFlowHop;
      const id = hop.node.id;
      const existing = cards.get(id);
      if (existing) {
        if (!existing.flows.includes(flow.id)) existing.flows.push(flow.id);
      } else {
        cards.set(id, { hop, flows: [flow.id], order: order++ });
        indegree.set(id, 0);
        successors.set(id, new Set());
      }

      const previous = flow.hops[i - 1];
      if (!previous || hop.edge === null) continue;
      // An upward hop is the same edge read backwards; the ARROW still points
      // the way the reader travelled, which is what the strip is describing.
      const from = previous.node.id;
      const key = `${from} ${id}`;
      const link = links.get(key);
      if (link) {
        if (!link.flows.includes(flow.id)) link.flows.push(flow.id);
        continue;
      }
      links.set(key, { source: from, target: id, edge: hop.edge, flows: [flow.id] });
      const outs = successors.get(from);
      if (outs && !outs.has(id)) {
        outs.add(id);
        indegree.set(id, (indegree.get(id) ?? 0) + 1);
      }
    }
  }

  if (cards.size === 0) {
    return { cards: [], endCaps: [], links: [], width: 0, height: 0, columns: 0, gaps: [] };
  }

  // ---- column = longest distance from a start -----------------------------
  const column = new Map<string, number>();
  for (const id of cards.keys()) column.set(id, 0);
  // Kahn order, so a node is placed only after everything that reaches it.
  const pending = new Map(indegree);
  const queue = [...cards.keys()].filter((id) => (pending.get(id) ?? 0) === 0);
  const settled = new Set<string>();
  while (queue.length > 0) {
    const id = queue.shift() as string;
    settled.add(id);
    for (const next of successors.get(id) ?? []) {
      column.set(next, Math.max(column.get(next) ?? 0, (column.get(id) ?? 0) + 1));
      const left = (pending.get(next) ?? 0) - 1;
      pending.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  // A cycle (a flow that calls back into itself) leaves nodes unsettled. They
  // are still real hops, so they go one column past whatever reached them
  // rather than disappearing.
  for (const id of cards.keys()) {
    if (settled.has(id)) continue;
    let best = 0;
    for (const [from, outs] of successors) {
      if (outs.has(id)) best = Math.max(best, (column.get(from) ?? 0) + 1);
    }
    column.set(id, best);
  }

  // ---- the end caps ------------------------------------------------------
  // One cap per stopping symbol, not per flow: two paths that run out at the
  // same place ran out for the same reason, and two caps side by side saying so
  // would read as two different findings.
  const caps = new Map<string, { boundary: WireFlowBoundary; flows: string[] }>();
  for (const flow of flows) {
    const boundary = flow.boundary;
    if (!boundary || !cards.has(boundary.node.id)) continue;
    const hit = caps.get(boundary.node.id);
    if (hit) {
      if (!hit.flows.includes(flow.id)) hit.flows.push(flow.id);
    } else {
      caps.set(boundary.node.id, { boundary, flows: [flow.id] });
    }
  }

  // ---- pack each column, active flow first --------------------------------
  interface Member {
    id: string;
    width: number;
    height: number;
    /** Cards before caps, then first-seen order. */
    rank: number;
    onActive: boolean;
  }
  const members = new Map<string, Member>();
  for (const [id, card] of cards) {
    members.set(id, {
      id,
      width: CARD_WIDTH,
      height: cardHeight(card.hop),
      rank: card.order,
      onActive: activeSteps.has(id),
    });
  }
  const capColumn = new Map<string, number>();
  let capRank = cards.size;
  for (const [anchorId, cap] of caps) {
    const id = capId(anchorId);
    capColumn.set(id, (column.get(anchorId) ?? 0) + 1);
    members.set(id, {
      id,
      width: END_CAP_WIDTH,
      height: endCapHeight(cap.boundary),
      rank: capRank++,
      onActive: activeSteps.has(anchorId),
    });
  }
  const columnOf = (id: string): number => capColumn.get(id) ?? column.get(id) ?? 0;

  const byColumn = new Map<number, string[]>();
  for (const id of members.keys()) {
    const c = columnOf(id);
    const list = byColumn.get(c);
    if (list) list.push(id);
    else byColumn.set(c, [id]);
  }
  for (const list of byColumn.values()) {
    list.sort((a, b) => {
      const onA = (members.get(a) as Member).onActive ? 0 : 1;
      const onB = (members.get(b) as Member).onActive ? 0 : 1;
      if (onA !== onB) return onA - onB;
      return (members.get(a) as Member).rank - (members.get(b) as Member).rank;
    });
  }

  const columns = Math.max(...byColumn.keys()) + 1;

  // Each gap is wide enough for the widest label that crosses it. Labels are
  // built here rather than in the render pass because the geometry depends on
  // them — see LABEL_CHAR_WIDTH. A cap's dotted link keeps the spec's 86px: its
  // label is fixed and stacks into two short lines.
  const labelled = [...links.entries()].map(([key, link]) => ({
    key,
    link,
    lines: labelLinesFor(link.edge),
    lineLabel: lineLabelFor(link.edge),
  }));
  const gaps = Array.from({ length: Math.max(0, columns - 1) }, () => LINK_WIDTH);
  for (const { link, lines, lineLabel } of labelled) {
    const from = column.get(link.source) ?? 0;
    if (from < 0 || from >= gaps.length) continue;
    const widest = Math.max(0, ...lines.map((l) => l.length), lineLabel?.length ?? 0);
    gaps[from] = Math.max(gaps[from] as number, Math.ceil(widest * LABEL_CHAR_WIDTH) + LABEL_PAD);
  }

  // A column is as wide as its widest member, so a cap sharing a column with a
  // card does not push the card's neighbours out of line.
  const columnWidth = Array.from({ length: columns }, () => 0);
  for (const [c, list] of byColumn) {
    columnWidth[c] = Math.max(...list.map((id) => (members.get(id) as Member).width));
  }
  const columnX: number[] = [PADDING];
  for (let c = 1; c < columns; c++) {
    columnX[c] = (columnX[c - 1] as number) + (columnWidth[c - 1] as number) + (gaps[c - 1] as number);
  }

  // Rows are centred on the tallest column, so a one-card column sits opposite
  // the middle of a two-card one instead of hugging the top of the canvas.
  const columnHeights = new Map<number, number>();
  for (const [c, list] of byColumn) {
    columnHeights.set(
      c,
      list.reduce((sum, id) => sum + (members.get(id) as Member).height, 0) +
        ROW_GAP * (list.length - 1)
    );
  }
  const tallest = Math.max(...columnHeights.values());

  const laidOut = new Map<string, FlowCardLayout>();
  const endCaps: FlowEndCapLayout[] = [];
  for (const [c, list] of byColumn) {
    let y = PADDING + (tallest - (columnHeights.get(c) ?? 0)) / 2;
    for (const id of list) {
      const member = members.get(id) as Member;
      const cap = caps.get(anchorOf(id));
      if (cap && isCapId(id)) {
        endCaps.push({
          id,
          anchorId: anchorOf(id),
          boundary: cap.boundary,
          x: columnX[c] as number,
          y,
          width: member.width,
          height: member.height,
          column: c,
          flows: cap.flows,
        });
      } else {
        const card = cards.get(id) as { hop: WireFlowHop; flows: string[]; order: number };
        laidOut.set(id, {
          id,
          hop: card.hop,
          x: columnX[c] as number,
          y,
          width: member.width,
          height: member.height,
          column: c,
          flows: card.flows,
          step: activeSteps.get(id) ?? -1,
          stopLine: caps.get(id)?.boundary.sites[0]?.line ?? null,
        });
      }
      y += member.height + ROW_GAP;
    }
  }

  const linkLayouts: FlowLinkLayout[] = labelled.map(({ link, lines, lineLabel }) => ({
    id: `${link.source}->${link.target}`,
    source: link.source,
    target: link.target,
    edge: link.edge,
    flows: link.flows,
    label: link.edge.label,
    labelLines: lines,
    lineLabel,
    dash: dashFor(link.edge),
    cap: false,
  }));
  for (const cap of endCaps) {
    linkLayouts.push({
      id: `${cap.anchorId}->${cap.id}`,
      source: cap.anchorId,
      target: cap.id,
      edge: null,
      flows: cap.flows,
      label: 'end of static path',
      labelLines: ['end of', 'static path'],
      lineLabel: null,
      dash: END_CAP_DASH,
      cap: true,
    });
  }

  return {
    cards: [...laidOut.values()].sort((a, b) => a.column - b.column || a.y - b.y),
    endCaps: endCaps.sort((a, b) => a.column - b.column || a.y - b.y),
    links: linkLayouts,
    width: (columnX[columns - 1] as number) + (columnWidth[columns - 1] as number) + PADDING,
    height: PADDING * 2 + tallest,
    columns,
    gaps,
  };
}
