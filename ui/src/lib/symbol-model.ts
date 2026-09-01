/**
 * Everything the Symbol view derives from one `/api/node` payload, as plain
 * functions over plain data.
 *
 * None of this touches the DOM or Svelte's reactivity. The screen's hard parts
 * — which lines get a port, which callee row sits at which height, which call
 * site is a link — are all decisions about the payload, and keeping them here
 * means they can be reasoned about (and tested) without a browser.
 *
 * Design spec §3.2.
 */

import type {
  WireEdge,
  WireMember,
  WireOutsideIndex,
  WireRelation,
  WireSymbolPayload,
} from './api';

/* ------------------------------------------------------------- constants -- */

/** Bodies at or under this are shown whole (design spec §3.2). */
export const FULL_BODY_LINES = 260;
/** Above that, the head is shown in full before the windows begin. */
export const HEAD_LINES = 80;
/** Lines of context kept either side of a call site in a windowed body. */
export const WINDOW_CONTEXT = 4;
/** Two windows closer than this merge — a 1-line gap row costs more than it saves. */
const WINDOW_MERGE_GAP = 2;
/** Windows in one body. Past this the body is a listing, not a reading. */
const MAX_WINDOWS = 30;
/** A container bigger than this shows its outline instead of its body. */
export const CONTAINER_BODY_LINES = 80;

/** Kinds that hold other symbols — they get an outline, not a 700-line body. */
export const CONTAINER_KINDS = new Set([
  'file',
  'module',
  'namespace',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'enum',
  'union',
]);

/** Kinds whose outline rows are dimmed: data, not behaviour. */
const QUIET_MEMBER_KINDS = new Set(['property', 'field', 'enum_member', 'constant', 'variable']);

/* ----------------------------------------------------------------- words -- */

/**
 * What an edge is called in a rail's meta line.
 *
 * `calls` returns '' deliberately: it is the default reading of the whole
 * screen, and labelling every row "calls" is noise that hides the rows where
 * the relationship is something else.
 */
export function edgeWord(edge: WireEdge): string {
  switch (edge.kind) {
    case 'calls':
      return '';
    case 'instantiates':
      return 'creates';
    case 'navigates':
      return 'navigates to';
    case 'references':
      return edge.valueRef ? 'passes as value' : 'uses type';
    default:
      return edge.kind;
  }
}

/** The distinct edge words for a relation, in first-seen order, blanks dropped. */
export function relationWords(relation: WireRelation): string[] {
  const words: string[] = [];
  for (const edge of relation.edges) {
    const word = edgeWord(edge);
    if (word && !words.includes(word)) words.push(word);
  }
  return words;
}

/** The distinct branch conditions across a relation's edges, at most three. */
export function relationWhens(relation: WireRelation): string[] {
  const out: string[] = [];
  for (const edge of relation.edges) {
    if (edge.when && !out.includes(edge.when)) out.push(edge.when);
    if (out.length === 3) break;
  }
  return out;
}

/** The synthesizer that produced this relation's edge, when one did. */
export function synthesizedBy(relation: WireRelation): string | null {
  if (!relation.synthesized) return null;
  const edge = relation.edges.find((e) => e.provenance === 'heuristic');
  return edge?.synthesizedBy ?? edge?.via ?? 'synthesized';
}

export function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** The trailing segment of a dotted/qualified name — what appears in the source. */
export function lastSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}

/* --------------------------------------------------------------- windows -- */

export interface SourceWindow {
  /** 1-based file line of `lines[0]`. */
  start: number;
  lines: string[];
}

export interface CodeBlock {
  windows: SourceWindow[];
  /** Lines skipped between window i and i+1 — the "⋯ N lines without calls" rows. */
  gapsAfter: number[];
  /** Lines dropped after the last window, if the body did not run to its end. */
  tailGap: number;
  /** The body was shown whole. */
  whole: boolean;
}

/**
 * Cut a long body down to its head plus the neighbourhood of every call site.
 *
 * The rule is the one the prototype established and the screenshots pin: a
 * body of {@link FULL_BODY_LINES} or fewer is shown whole, and a longer one
 * keeps its first {@link HEAD_LINES} lines — where the signature, the guards
 * and the shape of the function live — plus ±{@link WINDOW_CONTEXT} lines
 * around each call, because a call site with no context is a name, not code.
 *
 * @param startLine 1-based first line of the symbol
 * @param lines     the body's source, `lines[0]` being `startLine`
 * @param callLines every line in the body that makes an outgoing edge
 */
export function buildCodeBlock(
  startLine: number,
  lines: readonly string[],
  callLines: readonly number[]
): CodeBlock {
  const endLine = startLine + lines.length - 1;
  const slice = (from: number, to: number): SourceWindow => ({
    start: from,
    lines: lines.slice(from - startLine, to - startLine + 1),
  });

  if (lines.length <= FULL_BODY_LINES) {
    return {
      windows: lines.length > 0 ? [slice(startLine, endLine)] : [],
      gapsAfter: [],
      tailGap: 0,
      whole: true,
    };
  }

  const headEnd = Math.min(endLine, startLine + HEAD_LINES - 1);
  const ranges: Array<[number, number]> = [[startLine, headEnd]];
  const sites = [...new Set(callLines)]
    .filter((line) => line > headEnd && line <= endLine)
    .sort((a, b) => a - b);
  for (const line of sites) {
    ranges.push([
      Math.max(startLine, line - WINDOW_CONTEXT),
      Math.min(endLine, line + WINDOW_CONTEXT),
    ]);
  }

  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range[0] <= last[1] + WINDOW_MERGE_GAP) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range] as [number, number]);
  }

  const kept = merged.slice(0, MAX_WINDOWS);
  const windows = kept.map(([from, to]) => slice(from, to));
  const gapsAfter = kept.slice(0, -1).map((range, i) => (kept[i + 1] as [number, number])[0] - range[1] - 1);
  const lastEnd = kept[kept.length - 1]?.[1] ?? endLine;

  return { windows, gapsAfter, tailGap: Math.max(0, endLine - lastEnd), whole: false };
}

/* ------------------------------------------------------------------ refs -- */

/** One identifier in the body that the graph has something to say about. */
export interface LineRef {
  /** The identifier as it appears in the source — what the token must match. */
  ident: string;
  /** 0-based column the edge was recorded at, or null when it carries none. */
  col: number | null;
  /** Target node id, or null for a reference that leaves the index. */
  targetId: string | null;
  uncertain: boolean;
  /** No node behind it — rendered as text with a soft underline, not a link. */
  outside: boolean;
  title: string;
}

/**
 * Which identifiers on which lines are edges, keyed by 1-based line.
 *
 * Includes the type references (`uses types …` in the header) so a line that
 * only names a type still gets its port: the port's claim is "something leaves
 * the graph from this line", and a type reference does.
 */
export function refsByLine(payload: WireSymbolPayload): Map<number, LineRef[]> {
  const byLine = new Map<number, LineRef[]>();
  const add = (line: number, ref: LineRef): void => {
    const bucket = byLine.get(line);
    if (bucket) bucket.push(ref);
    else byLine.set(line, [ref]);
  };

  for (const relation of [...payload.outgoing.items, ...payload.typesUsed]) {
    for (const edge of relation.edges) {
      if (!edge.line) continue;
      const word = edgeWord(edge);
      add(edge.line, {
        ident: lastSegment(relation.node.name),
        col: typeof edge.col === 'number' ? edge.col : null,
        targetId: relation.node.id,
        uncertain: relation.uncertain,
        outside: false,
        title:
          `${word || 'calls'} ${relation.node.qualifiedName} — ${relation.node.file}:${relation.node.line}` +
          (edge.confidence != null ? ` · confidence ${edge.confidence}` : '') +
          (edge.resolvedBy ? ` · resolved by ${edge.resolvedBy}` : ''),
      });
    }
  }

  for (const ref of outsideRefs(payload.outsideIndex)) add(ref.line, ref.ref);
  return byLine;
}

/**
 * The lines a long body is windowed around.
 *
 * Only edges that reach something IN the graph count. An unresolved reference
 * still gets its port and its soft underline where it happens to be on screen,
 * but it must not open a window of its own: a function with 170 calls into
 * `console`, `Promise` and `fs` would window around nearly every line and the
 * head-plus-windows rule would buy nothing.
 */
export function graphCallLines(payload: WireSymbolPayload): number[] {
  const lines = new Set<number>();
  for (const relation of [...payload.outgoing.items, ...payload.typesUsed]) {
    for (const line of relation.lines) lines.add(line);
  }
  return [...lines].sort((a, b) => a - b);
}

/**
 * References with no node behind them, as line refs.
 *
 * The samples are raw resolver bookkeeping, so anything that is not a plain
 * identifier — a whole arrow function captured as a "name", a receiver
 * expression — is dropped rather than searched for in the line: a ref that
 * cannot match a token would silently claim the wrong one.
 */
function outsideRefs(outside: WireOutsideIndex): Array<{ line: number; ref: LineRef }> {
  const out: Array<{ line: number; ref: LineRef }> = [];
  for (const sample of outside.samples) {
    if (!sample.line) continue;
    const ident = lastSegment(sample.name ?? '');
    if (!/^[A-Za-z_$][\w$]*$/.test(ident)) continue;
    out.push({
      line: sample.line,
      ref: {
        ident,
        col: typeof sample.col === 'number' ? sample.col : null,
        targetId: null,
        uncertain: false,
        outside: true,
        title: `${sample.name} is not in the index — nothing here resolves it`,
      },
    });
  }
  return out;
}

/**
 * Decide which token on a line each ref refers to.
 *
 * A line can name the same identifier twice (`b.render(a.render())`) and the
 * recorded column points at the start of the *expression*, not at the callee's
 * own name, so an exact column hit is the exception rather than the rule. The
 * ladder — containing token, then first token at or after the column, then any
 * unclaimed one, then the last — is what makes `this.mutex.withLock(…)` mark
 * `withLock` instead of `this`.
 *
 * A candidate is any token whose TEXT is the identifier and that is not inside
 * a comment or a string. Deliberately not "any token the highlighter called an
 * identifier": grammars disagree about that constantly — Go scopes `string` as
 * `storage.type`, Java scopes a declared type name the same way — and a link
 * that vanished because a grammar had an opinion about a scope name would be a
 * highlighting change silently breaking navigation.
 *
 * @returns token index → the ref that claimed it
 */
export function assignRefs(
  tokens: ReadonlyArray<{ cls: string; text: string; col: number }>,
  refs: readonly LineRef[]
): Map<number, LineRef> {
  const claimed = new Map<number, LineRef>();
  for (const ref of refs) {
    const candidates: number[] = [];
    tokens.forEach((token, index) => {
      if (token.cls === 'comment' || token.cls === 'string') return;
      if (token.text === ref.ident) candidates.push(index);
    });
    if (candidates.length === 0) continue;

    let pick: number | undefined;
    if (ref.col !== null) {
      const col = ref.col;
      pick = candidates.find((i) => {
        const t = tokens[i] as { text: string; col: number };
        return t.col <= col && col < t.col + t.text.length;
      });
      if (pick === undefined) pick = candidates.find((i) => (tokens[i] as { col: number }).col >= col);
    }
    if (pick === undefined) pick = candidates.find((i) => !claimed.has(i));
    if (pick === undefined) pick = candidates[candidates.length - 1];
    if (pick === undefined || claimed.has(pick)) continue;
    claimed.set(pick, ref);
  }
  return claimed;
}

/* ------------------------------------------------------------ right rail -- */

export interface CalleeRow {
  relation: WireRelation;
  /** First call-site line — the height the row wants to sit at. */
  anchor: number | null;
  /** Distinct call-site lines; `×N` appears when there is more than one. */
  lines: number[];
  words: string[];
  via: string | null;
  /** `when` conditions, distinct, for the meta line. */
  when: string[];
}

export interface CalleeRailModel {
  rows: CalleeRow[];
  uncertain: CalleeRow[];
  /** Callee groups the API had to cap away. */
  hiddenGroups: number;
  outsideCalls: number;
  outsideTypeRefs: number;
}

export function buildCalleeRail(payload: WireSymbolPayload): CalleeRailModel {
  const rows: CalleeRow[] = [];
  const uncertain: CalleeRow[] = [];

  for (const relation of payload.outgoing.items) {
    const row: CalleeRow = {
      relation,
      anchor: relation.lines[0] ?? null,
      lines: relation.lines,
      words: relationWords(relation),
      via: synthesizedBy(relation),
      when: relationWhens(relation),
    };
    if (relation.uncertain) uncertain.push(row);
    else rows.push(row);
  }

  const typeRefs = payload.outsideIndex.byKind['references'] ?? 0;
  return {
    rows,
    uncertain,
    hiddenGroups: payload.outgoing.total - payload.outgoing.shown,
    outsideCalls: Math.max(0, payload.outsideIndex.total - typeRefs),
    outsideTypeRefs: typeRefs,
  };
}

/* ------------------------------------------------------------- left rail -- */

export interface CallerRow {
  relation: WireRelation;
  words: string[];
  /** Call-site lines in the CALLER's file — the `:4657` chips. */
  lines: number[];
  via: string | null;
  /** `when` conditions, distinct, for the meta line. */
  when: string[];
}

export interface CallerFileGroup {
  file: string;
  /** True for the focal symbol's own file, which is labelled "same file". */
  same: boolean;
  rows: CallerRow[];
}

export interface CallerRailModel {
  groups: CallerFileGroup[];
  uncertain: CallerRow[];
  tests: { rows: CallerRow[]; calls: number; files: string[] };
  /** Distinct callers, including the ones folded into tests and uncertain. */
  total: number;
  hiddenGroups: number;
}

/**
 * The left rail: callers grouped by file, with tests and name-only guesses
 * folded away.
 *
 * The folds are not "hide the boring ones" — they are the two cases where a
 * long list would drown the answer. Tests are usually the largest group and
 * the least surprising ("of course the test file calls it"), and an uncertain
 * caller is a guess the reader should be able to see marked as one rather than
 * mixed into the same list as a resolved call. Both carry their counts.
 */
export function buildCallerRail(payload: WireSymbolPayload): CallerRailModel {
  const focalFile = payload.node.file;
  const byFile = new Map<string, CallerRow[]>();
  const uncertain: CallerRow[] = [];
  const testRows: CallerRow[] = [];

  for (const relation of payload.incoming.items) {
    const row: CallerRow = {
      relation,
      words: relationWords(relation),
      lines: relation.lines,
      via: synthesizedBy(relation),
      when: relationWhens(relation),
    };
    // Uncertainty wins over test-ness: a name-only guess is a claim about the
    // edge, and burying it in the tests fold would present it as established.
    if (relation.uncertain) {
      uncertain.push(row);
      continue;
    }
    if (relation.node.test) {
      testRows.push(row);
      continue;
    }
    const bucket = byFile.get(relation.node.file);
    if (bucket) bucket.push(row);
    else byFile.set(relation.node.file, [row]);
  }

  const groups: CallerFileGroup[] = [...byFile.entries()]
    .map(([file, rows]) => ({ file, same: file === focalFile, rows }))
    .sort((a, b) => (a.same ? -1 : b.same ? 1 : a.file.localeCompare(b.file)));

  return {
    groups,
    uncertain,
    tests: {
      rows: testRows,
      calls: testRows.reduce((sum, row) => sum + row.relation.edgeCount, 0),
      files: [...new Set(testRows.map((row) => row.relation.node.file))].sort(),
    },
    total: payload.incoming.total,
    hiddenGroups: payload.incoming.total - payload.incoming.shown,
  };
}

/* ----------------------------------------------------------- connectors -- */

/** One hairline from a gutter port to a callee row. Geometry comes from the view. */
export interface Connector {
  /** SVG path data — a single cubic from the port to the row. */
  d: string;
  targetId: string;
  uncertain: boolean;
  /** Synthesized rather than parsed — dynamic dispatch, drawn dashed. */
  heuristic: boolean;
  /** The edge the reader arrived by. */
  origin: boolean;
}

/* -------------------------------------------------------------- outline -- */

export interface OutlineRow {
  member: WireMember;
  nested: boolean;
  dimmed: boolean;
}

export function buildOutline(payload: WireSymbolPayload): OutlineRow[] {
  return payload.members.items.map((member) => ({
    member,
    nested: member.depth > 1,
    dimmed: QUIET_MEMBER_KINDS.has(member.kind),
  }));
}

/* ------------------------------------------------------------- decisions -- */

/**
 * Whether this symbol's body is worth drawing at all.
 *
 * A 700-line class body is a list of members with braces between them: the
 * outline says the same thing in 20 rows and lets the reader pick one. Below
 * {@link CONTAINER_BODY_LINES} the body IS the useful view of a container, so
 * both are shown.
 */
export function showsBody(kind: string, lines: number): boolean {
  return !(CONTAINER_KINDS.has(kind) && lines > CONTAINER_BODY_LINES);
}

/** The kind word and the modifiers that belong beside a symbol's name. */
export function kindPhrase(node: {
  kind: string;
  async?: boolean;
  static?: boolean;
  abstract?: boolean;
  visibility?: string;
}): string {
  const parts = [node.kind === 'type_alias' ? 'type' : node.kind.replace(/_/g, ' ')];
  if (node.async) parts.push('async');
  if (node.static) parts.push('static');
  if (node.abstract) parts.push('abstract');
  if (node.visibility && node.visibility !== 'public') parts.push(node.visibility);
  return parts.join(' · ');
}

/** "1 caller" / "12 callers" — the counts sit next to too many nouns to inline. */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
