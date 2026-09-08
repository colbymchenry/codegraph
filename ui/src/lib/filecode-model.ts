/**
 * The whole-file view's geometry (design spec §3.4, task CG-52).
 *
 * The Symbol view *measures* the laid-out DOM to place a callee row beside its
 * line, because a body of 60 lines can be re-flowed by a fold, a font or a
 * width. A whole file cannot afford that: `src/mcp/tools.ts` is 6 820 lines, and
 * asking the browser where each of them ended up — after rendering all of them —
 * is neither 60 fps nor possible.
 *
 * So this screen inverts the contract. **Every line is exactly
 * {@link CODE_LINE_HEIGHT} tall and its position is arithmetic**, which buys
 * three things at once: the document's height is known before a byte of source
 * arrives, only the visible lines are ever in the DOM, and the arcs, the ports
 * and the rail rows are all functions of a line number rather than of a
 * measurement. Nothing here touches the DOM.
 *
 * The one thing the view still measures is the x of two column edges, for the
 * connector hairlines — a single ResizeObserver, not a query per line.
 *
 * If you ever let a code line grow (a wrapped line, a taller row, an inline
 * banner), this whole screen silently drifts: lines land at the wrong offset,
 * arcs point between the wrong ones, rail rows detach from their calls. Change
 * {@link CODE_LINE_HEIGHT} and the CSS together, or make the list measure.
 * Same contract as the File view's outline and the Flow strip's cards.
 */

import type {
  WireFileCall,
  WireFileCodePayload,
  WireFileOutsideRef,
  WireOutlineEntry,
} from './api';
import { lastSegment, relationWords, synthesizedBy, type LineRef } from './symbol-model';

/* ------------------------------------------------------------- constants -- */

/** Height of one source line. Pinned in `FileCodeBlock.svelte`'s CSS. */
export const CODE_LINE_HEIGHT = 20;

/** Blank space above line 1, so the first line is not flush against the rule. */
export const CODE_TOP_PAD = 10;

/** Blank space after the last line, so the end of a file can be scrolled to. */
export const CODE_BOTTOM_PAD = 120;

/** The arc diagram's column, left of the line numbers (design spec §3.4). */
export const ARC_COLUMN = 56;

/** Callee rail width and row geometry — the Symbol view's numbers, unchanged. */
export const RAIL_WIDTH = 320;
export const ROW_HEIGHT = 34;
export const ROW_GAP = 6;

/** Row height of the sticky navigation rail. Pinned in `FileCodeOutline`'s CSS. */
export const NAV_ROW_HEIGHT = 24;

/** Lines drawn either side of the viewport, so a flick does not show holes. */
export const OVERSCAN_LINES = 24;

/**
 * Source lines fetched in one page.
 *
 * Measured on this repo's own TypeScript with the shipped classifier: a loaded
 * grammar classifies ~50 000 lines/second (CG-57 replaced the TextMate path,
 * which managed ~4 000), so a page plus its lead-in is ~20 ms of
 * single-threaded server. Bigger pages mean fewer, longer stalls; smaller ones
 * mean the lead-in dominates. The scroll itself never waits on this — ports,
 * arcs and rail rows are already drawn from the graph, and the text arrives
 * behind them.
 */
export const PAGE_LINES = 800;

/**
 * Lines fetched BEFORE a page and thrown away.
 *
 * A page that starts in the middle of a block comment, a template literal or a
 * JSX block does not know it: a parse starts from the top of what it is given.
 * Tokenising a run-up and discarding it is what keeps page 6 from rendering a
 * doc comment as code. The same trick the Flow strip's source windows use, at a
 * different scale — 150 lines covers every real comment block; a 3 000-line
 * literal would still be wrong, and would be wrong at any bounded lead-in.
 */
export const PAGE_LEAD_IN = 150;

/**
 * Arcs above which the diagram shows only the focused symbol's.
 *
 * Design spec §3.4. Two hundred arcs over six thousand lines is not a picture
 * of anything — every one of them is a full-height sweep and they overlap into
 * a grey wash. Past this point the header states the count and the arcs follow
 * the pointer instead.
 */
export const ARC_CROWD_LIMIT = 40;

/** Innermost and outermost bulge of an arc, within {@link ARC_COLUMN}. */
const ARC_MIN_DEPTH = 7;
const ARC_MAX_DEPTH = ARC_COLUMN - 8;

/* --------------------------------------------------------------- pixels -- */

/** Top edge of a 1-based file line, in the scrolling document's coordinates. */
export function lineTop(line: number): number {
  return CODE_TOP_PAD + (line - 1) * CODE_LINE_HEIGHT;
}

/** Vertical centre of a line — what an arc, a port and a connector all anchor to. */
export function lineCentre(line: number): number {
  return lineTop(line) + CODE_LINE_HEIGHT / 2;
}

/** Total height of the scrolling document for a file of `totalLines`. */
export function documentHeight(totalLines: number): number {
  return CODE_TOP_PAD + Math.max(0, totalLines) * CODE_LINE_HEIGHT + CODE_BOTTOM_PAD;
}

/**
 * The 1-based line at a vertical offset in the document.
 *
 * Clamped into the file: the top pad is above line 1 and the bottom pad is
 * below the last, and both should read as the line they are adjacent to.
 */
export function lineAtOffset(y: number, totalLines: number): number {
  if (totalLines <= 0) return 1;
  const line = Math.floor((y - CODE_TOP_PAD) / CODE_LINE_HEIGHT) + 1;
  return Math.max(1, Math.min(totalLines, line));
}

/** The 1-based lines to render for a scroll position, with overscan. */
export function visibleLines(
  scrollTop: number,
  viewport: number,
  totalLines: number,
  overscan = OVERSCAN_LINES
): { first: number; last: number } {
  if (totalLines <= 0) return { first: 1, last: 0 };
  const firstRaw = Math.floor((scrollTop - CODE_TOP_PAD) / CODE_LINE_HEIGHT) + 1 - overscan;
  const count = Math.ceil((viewport || 800) / CODE_LINE_HEIGHT) + overscan * 2;
  const first = Math.max(1, Math.min(totalLines, firstRaw));
  return { first, last: Math.max(first - 1, Math.min(totalLines, first + count)) };
}

/* ---------------------------------------------------------------- pages -- */

export interface SourcePage {
  /** 0-based page index. */
  index: number;
  /** First and last line the page OWNS. */
  from: number;
  to: number;
  /** First line to ASK for — `from` minus the lead-in that gets discarded. */
  requestFrom: number;
}

export function pageOf(line: number): number {
  return Math.floor((line - 1) / PAGE_LINES);
}

export function pageFor(index: number, totalLines: number): SourcePage {
  const from = index * PAGE_LINES + 1;
  return {
    index,
    from,
    to: Math.min(totalLines, from + PAGE_LINES - 1),
    requestFrom: Math.max(1, from - PAGE_LEAD_IN),
  };
}

/** Every page index a rendered line range touches, in reading order. */
export function pagesForRange(first: number, last: number, totalLines: number): number[] {
  if (totalLines <= 0 || last < first) return [];
  const pages: number[] = [];
  for (let p = pageOf(Math.max(1, first)); p <= pageOf(Math.min(totalLines, last)); p++) {
    pages.push(p);
  }
  return pages;
}

/* ------------------------------------------------------------- ownership -- */

/**
 * Which symbol owns a line — the DEEPEST outline entry whose range holds it.
 *
 * Entries arrive in source order, so a symbol's descendants follow it and the
 * last containing entry is the specific answer. Taking the first would land on
 * the enclosing class, which owns every line of the file equally and would make
 * hovering anywhere light every arc in it. Same rule the File view's `?hl=`
 * landing uses.
 */
export function ownerAt(outline: readonly WireOutlineEntry[], line: number): string | null {
  let owner: string | null = null;
  for (const entry of outline) {
    if (entry.line > line) break;
    if (line <= entry.endLine) owner = entry.id;
  }
  return owner;
}

/* ---------------------------------------------------------------- ports -- */

/**
 * Which identifiers on which lines the graph has something to say about.
 *
 * Same shape the Symbol view's code block consumes, so `assignRefs` — the
 * ladder that makes `this.mutex.withLock(…)` underline `withLock` and not
 * `this` — is shared rather than re-derived. See `symbol-model.ts`.
 *
 * Two file-scale details the single-symbol version does not have:
 *
 * * A relation caps the EDGES it ships but never its `lines`, so a group with
 *   more call sites than edges would lose ports on the overflow. Every line
 *   without a ref for its target gets one anyway, with no column — the port is
 *   right, the underline just falls back to the first matching token.
 * * Unresolved references arrive as one file-wide list rather than as a sample
 *   per symbol, and are what keeps a line calling `console.log` from showing an
 *   empty gutter that reads as "nothing happens here".
 */
export function buildFileRefs(payload: WireFileCodePayload): Map<number, LineRef[]> {
  const byLine = new Map<number, LineRef[]>();
  const add = (line: number, ref: LineRef): void => {
    const bucket = byLine.get(line);
    if (bucket) bucket.push(ref);
    else byLine.set(line, [ref]);
  };

  for (const call of payload.calls.items) {
    const relation = call.relation;
    const ident = lastSegment(relation.node.name);
    const words = relationWords(relation);
    const covered = new Set<number>();
    for (const edge of relation.edges) {
      if (!edge.line) continue;
      covered.add(edge.line);
      add(edge.line, {
        ident,
        col: typeof edge.col === 'number' ? edge.col : null,
        targetId: relation.node.id,
        uncertain: relation.uncertain,
        outside: false,
        title:
          `${words[0] || 'calls'} ${relation.node.qualifiedName} — ${relation.node.file}:${relation.node.line}` +
          (edge.confidence != null ? ` · confidence ${edge.confidence}` : '') +
          (edge.resolvedBy ? ` · resolved by ${edge.resolvedBy}` : ''),
      });
    }
    for (const line of relation.lines) {
      if (covered.has(line)) continue;
      add(line, {
        ident,
        col: null,
        targetId: relation.node.id,
        uncertain: relation.uncertain,
        outside: false,
        title: `${words[0] || 'calls'} ${relation.node.qualifiedName} — ${relation.node.file}:${relation.node.line}`,
      });
    }
  }

  for (const ref of payload.outside.items) add(ref.line, outsideRef(ref));
  return byLine;
}

function outsideRef(ref: WireFileOutsideRef): LineRef {
  return {
    ident: ref.name,
    col: ref.col,
    targetId: null,
    uncertain: false,
    outside: true,
    title: `${ref.name} is not in the index — nothing here resolves it`,
  };
}

/* ----------------------------------------------------------------- rail -- */

export interface FileCallRow {
  /** Stable across re-renders: the pair IS the row. */
  key: string;
  /** The symbol in this file that makes the calls. */
  ownerId: string;
  call: WireFileCall;
  /** First call-site line — the height the row wants. */
  anchor: number | null;
  lines: number[];
  words: string[];
  via: string | null;
  /** Top edge, in the document's coordinates, after collision resolution. */
  top: number;
}

/**
 * The callee rail: one row per (calling symbol, called symbol) pair, placed.
 *
 * The pair is the unit here, not the target. Inside one body a helper called
 * from three lines is one row with `×3`, and it can sit beside them because
 * they are a few lines apart. Across a 6 800-line file the same helper called
 * from two functions a thousand lines apart cannot be one row: a row is
 * anchored to a line, and there is no line that is both. The server groups it
 * that way; this places it.
 *
 * Placement is the Symbol view's rule, run over the whole file: a row wants the
 * centre of its first call site, and takes `previous + height + gap` when that
 * would overlap. Order beats exactness — a rail whose rows jump around relative
 * to the source stops being a reading of it — and the connector still runs to
 * the real line, so any displacement is visible rather than silent.
 */
export function buildFileCallRows(payload: WireFileCodePayload): FileCallRow[] {
  const rows: FileCallRow[] = payload.calls.items.map((call) => ({
    key: `${call.ownerId}>${call.relation.node.id}`,
    ownerId: call.ownerId,
    call,
    anchor: call.relation.lines[0] ?? null,
    lines: call.relation.lines,
    words: relationWords(call.relation),
    via: synthesizedBy(call.relation),
    top: 0,
  }));

  // The server already sorts by first call line; sorting again keeps this
  // function correct on its own, which is what the tests exercise.
  rows.sort(
    (a, b) =>
      (a.anchor ?? Number.MAX_SAFE_INTEGER) - (b.anchor ?? Number.MAX_SAFE_INTEGER) ||
      a.call.ownerLine - b.call.ownerLine ||
      a.call.relation.node.name.localeCompare(b.call.relation.node.name)
  );

  let y = CODE_TOP_PAD;
  for (const row of rows) {
    const wanted = row.anchor === null ? y : lineCentre(row.anchor) - ROW_HEIGHT / 2;
    y = Math.max(wanted, y);
    row.top = y;
    y += ROW_HEIGHT + ROW_GAP;
  }
  return rows;
}

/** The rows whose boxes intersect a pixel range. Rows are sorted by `top`. */
export function rowsInRange(
  rows: readonly FileCallRow[],
  from: number,
  to: number
): FileCallRow[] {
  const out: FileCallRow[] = [];
  for (const row of rows) {
    if (row.top > to) break;
    if (row.top + ROW_HEIGHT >= from) out.push(row);
  }
  return out;
}

/** Height the rail needs, so the document never ends above its last row. */
export function railHeight(rows: readonly FileCallRow[]): number {
  const last = rows[rows.length - 1];
  return last ? last.top + ROW_HEIGHT + CODE_BOTTOM_PAD : 0;
}

/* ----------------------------------------------------------------- arcs -- */

export interface FileArc {
  key: string;
  /** The line that makes the call. */
  fromLine: number;
  /** The line the callee is defined on. */
  toLine: number;
  ownerId: string;
  targetId: string;
  targetName: string;
  uncertain: boolean;
  synthesized: boolean;
  /** SVG path, an ellipse half bulging left of the gutter. */
  d: string;
  /** Bounding lines, for windowing. */
  minLine: number;
  maxLine: number;
}

/**
 * One arc per call whose callee is defined in this same file.
 *
 * This is the one place a "graph of the file" is legible, and the reason is
 * that it is not a graph drawing at all: the nodes are already placed, by the
 * author, in source order, and an arc only has to say which two lines are
 * connected. Crabviz's layout, with the file's own line numbering as the
 * vertical axis.
 *
 * **Depth is a function of the arc's own span, not of its rank.** Short arcs sit
 * innermost, as the spec asks, but computing that from a sort position would
 * make every arc jump sideways the moment the set is filtered to one symbol's.
 * A log scale against the file's longest span is monotonic in span, stable
 * under filtering, and keeps the local calls — the ones a reader is following —
 * legible next to the gutter.
 */
export function buildFileArcs(
  payload: WireFileCodePayload,
  rows: readonly FileCallRow[]
): FileArc[] {
  const path = payload.file.path;
  const arcs: FileArc[] = [];
  let maxSpan = 1;

  for (const row of rows) {
    const target = row.call.relation.node;
    if (target.file !== path) continue;
    for (const line of row.lines) {
      // A recursive call sits ON its own definition line often enough to be
      // worth skipping: a zero-height arc is a dot, not a drawing.
      if (line === target.line) continue;
      const span = Math.abs(target.line - line);
      if (span > maxSpan) maxSpan = span;
      arcs.push({
        key: `${row.key}:${line}`,
        fromLine: line,
        toLine: target.line,
        ownerId: row.ownerId,
        targetId: target.id,
        targetName: target.name,
        uncertain: row.call.relation.uncertain,
        synthesized: row.via !== null,
        d: '',
        minLine: Math.min(line, target.line),
        maxLine: Math.max(line, target.line),
      });
    }
  }

  const scale = Math.log1p(maxSpan);
  for (const arc of arcs) {
    const span = arc.maxLine - arc.minLine;
    const depth =
      ARC_MIN_DEPTH +
      (ARC_MAX_DEPTH - ARC_MIN_DEPTH) * (scale > 0 ? Math.log1p(span) / scale : 0);
    arc.d = arcPath(arc.fromLine, arc.toLine, depth);
  }

  // Long arcs first so short ones paint on top of them — the innermost arc is
  // the one a reader is most likely to be aiming at.
  arcs.sort((a, b) => b.maxLine - b.minLine - (a.maxLine - a.minLine));
  return arcs;
}

/**
 * Half an ellipse from one line to another, bulging into the arc column.
 *
 * Both ends sit on the column's right edge, so `rx` is the whole of the bulge
 * and `ry` is half the vertical span — the chord is a diameter, which makes the
 * arc exactly determined and its widest point exactly `depth` to the left.
 * The sweep flag flips with direction: on a screen whose y grows downward,
 * sweep 0 runs anticlockwise, which passes left going DOWN and right going up.
 */
export function arcPath(fromLine: number, toLine: number, depth: number): string {
  const y0 = lineCentre(fromLine);
  const y1 = lineCentre(toLine);
  const ry = Math.max(1, Math.abs(y1 - y0) / 2);
  const sweep = y1 > y0 ? 0 : 1;
  return `M${ARC_COLUMN},${y0} A${depth.toFixed(1)},${ry.toFixed(1)} 0 0 ${sweep} ${ARC_COLUMN},${y1}`;
}

/**
 * The arcs to draw: everything when there are few, otherwise the focused
 * symbol's alone (design spec §3.4).
 *
 * "The focused symbol's" is both directions — the calls it makes and the calls
 * that reach it — because a reader hovering a function is asking about its
 * neighbourhood, not about its out-edges.
 */
export function visibleArcs(
  arcs: readonly FileArc[],
  focusId: string | null,
  crowded: boolean
): FileArc[] {
  if (!crowded) return [...arcs];
  if (!focusId) return [];
  return arcs.filter((arc) => arc.ownerId === focusId || arc.targetId === focusId);
}

/** Arcs that reach into a rendered line range. */
export function arcsInRange(arcs: readonly FileArc[], first: number, last: number): FileArc[] {
  return arcs.filter((arc) => arc.minLine <= last && arc.maxLine >= first);
}

/* --------------------------------------------------------------- header -- */

/** `209 calls within this file` / `no calls stay inside this file`. */
export function arcSummary(count: number): string {
  if (count === 0) return 'No calls in this file reach another symbol in it.';
  return `${count} ${count === 1 ? 'call stays' : 'calls stay'} within this file`;
}
