/**
 * `GET /api/filecode/<path>` — the whole-file source view in one round-trip.
 *
 * The Symbol view asks "what does this body reach"; this screen asks the same
 * question of every line of a file at once, and answers it beside the file's
 * own source. What that needs is one payload holding everything the graph says
 * about lines in this file, and nothing that depends on scroll position:
 *
 * * the file's symbols in source order — the sticky outline rail, and the
 *   definition line every intra-file arc lands on,
 * * one row per (calling symbol, called symbol) pair, carrying the call-site
 *   lines the gutter ports and the callee rail anchor to,
 * * the references that never resolved, so a line that reaches `console.log`
 *   still shows a hollow port instead of an empty gutter that reads as
 *   "nothing happens here",
 * * the file's total line count, which IS the layout: every line is a fixed
 *   height, so the viewer can size a 6 800-line document and start drawing
 *   before a single page of source has arrived.
 *
 * The source itself does NOT ride along. A 6 800-line TypeScript file is ~1.5 s
 * of parsing and megabytes of JSON; the viewer pages it through
 * `/api/source` as the reader scrolls, which is also what lets the graph
 * facts — ports, arcs, rail rows — be complete from the first frame while the
 * text fills in behind them.
 *
 * **The arcs are not a separate list.** An arc is a call whose target is
 * defined in this same file, so the viewer derives them from `calls` and the
 * `intraFileCalls` count here is computed from the SHOWN groups for the same
 * reason: a header that counted raw edges would disagree with the picture under
 * it the moment a cap bit.
 */

import type { CodeGraph } from '../../index';
import type { Edge, Node } from '../../types';
import { isTestFile } from '../../search/query-utils';
import { buildOutlineEntries, type WireOutlineEntry } from './file';
import { readFileShape, resolveRequestedFile } from './source';
import { badRequest } from './respond';
import {
  firstLine,
  groupRelations,
  toPosixPath,
  wireList,
  type WireList,
  type WireRelation,
} from './wire';

/**
 * Call groups returned for one file.
 *
 * A generous cap, not a display budget: the viewer only ever draws the rows in
 * the window it is scrolled to, so the number that matters is what a payload
 * costs to ship. This repo's largest file (`src/mcp/tools.ts`, 6 820 lines)
 * produces 498.
 */
export const MAX_FILE_CALL_GROUPS = 2000;

/**
 * Unresolved references returned for one file.
 *
 * These are markers, not rows — each one is a hollow port and a soft underline
 * with nothing behind it. `src/mcp/tools.ts` has 1 113; a generated bundle can
 * have tens of thousands, and past this point the count says everything the
 * list would.
 */
export const MAX_FILE_OUTSIDE_REFS = 3000;

/**
 * Unresolved-reference rows read before the count itself becomes a floor.
 *
 * `total` has to be the real number — the rest of this API guarantees that a
 * count equals a list — and the filter below (plain identifiers only) is not
 * expressible in SQL, so the rows have to be scanned to be counted. This is the
 * backstop against a generated bundle with a million of them, and it is far
 * above anything hand-written: the largest file in this repo's own index has
 * 1 113.
 */
export const MAX_FILE_OUTSIDE_SCAN = 50_000;

/** A reference the resolver never landed: a port with no destination. */
export interface WireFileOutsideRef {
  line: number;
  col: number;
  /** The identifier as written — how the viewer finds the token to underline. */
  name: string;
  kind: string;
}

/** Every edge from ONE symbol in this file to ONE symbol anywhere. */
export interface WireFileCall {
  /**
   * The symbol in this file that makes the calls.
   *
   * Never null: extraction records a statement outside every definition as an
   * edge out of the FILE node, so top-level code has an owner too — the file
   * itself.
   */
  ownerId: string;
  /** First line of the owner's definition, so a rail row can be attributed. */
  ownerLine: number;
  relation: WireRelation;
}

export interface WireFileCodePayload {
  file: {
    path: string;
    language: string;
    size: number;
    indexedAt: number;
    contentHash: string;
    generated: boolean;
    test: boolean;
    errors: string[];
    /** The file node's own id — the owner of every top-level call. */
    id: string | null;
    /**
     * Lines on disk right now. Null when the file could not be read, which is
     * the one case the viewer cannot lay out and says so.
     */
    totalLines: number | null;
  };
  /** The file changed on disk since it was indexed — every line number is suspect. */
  drift: boolean;
  /** Why, when there is something to say beyond the flag. */
  reason?: string;
  /** The file's symbols in source order — the same rows `/api/file` draws. */
  outline: WireList<WireOutlineEntry>;
  /** One row per (calling symbol, called symbol) pair, in call-site order. */
  calls: WireList<WireFileCall>;
  /** References with nothing behind them — hollow ports. */
  outside: WireList<WireFileOutsideRef>;
  /**
   * Calls landing on a definition in THIS file — the arc diagram's total.
   *
   * Counted over the groups actually returned, so it always equals the number
   * of arcs the viewer can draw from this payload.
   */
  intraFileCalls: number;
  timing: { elapsedMs: number };
}

export function buildFileCode(
  cg: CodeGraph,
  projectRoot: string,
  requested: string
): WireFileCodePayload {
  const started = Date.now();
  if (requested === '') throw badRequest('No file path was given. Use /api/filecode/<path>.');

  // Refusal first, index lookup second — see `resolveRequestedFile`.
  const { record, storedPath } = resolveRequestedFile(cg, projectRoot, requested);
  const posixPath = toPosixPath(storedPath);

  const nodes = cg.getNodesInFile(storedPath);
  const fileNode = nodes.find((n) => n.kind === 'file') ?? null;
  const { entries: outline, total: outlineTotal } = buildOutlineEntries(cg, nodes);

  const { calls, total: callTotal, intraFileCalls } = buildCalls(cg, nodes, posixPath);
  const outside = buildOutsideRefs(cg, storedPath);

  // One read answers both the drift verdict and the document's height.
  const shape = readFileShape(projectRoot, storedPath, record);

  return {
    file: {
      path: posixPath,
      language: record.language,
      size: record.size,
      indexedAt: record.indexedAt,
      contentHash: record.contentHash,
      generated: record.generated === true,
      test: isTestFile(posixPath),
      // Messages, not the raw records: the screen prints a count and a line,
      // and an extractor's file/line bookkeeping is not something a reader acts
      // on.
      errors: (record.errors ?? []).map((e) => e.message),
      id: fileNode?.id ?? null,
      totalLines: shape.totalLines,
    },
    drift: shape.drift,
    ...(shape.reason ? { reason: shape.reason } : {}),
    outline: wireList(outline, outlineTotal),
    calls: wireList(calls, callTotal),
    outside: wireList(outside.items, outside.total),
    intraFileCalls,
    timing: { elapsedMs: Date.now() - started },
  };
}

/**
 * Every outgoing edge from every symbol in the file, grouped twice over: by the
 * symbol that makes the call, and within that by the symbol it reaches.
 *
 * Grouping by the OWNER as well as the target is what separates this from the
 * Symbol view's rail. Across one body, a helper called from three lines is one
 * row with `×3` and one place to sit. Across a 6 800-line file, the same helper
 * called from two different functions a thousand lines apart cannot be one row
 * — a row is anchored to a line, and there is no line that is both. So the pair
 * is the unit, and the rail reads in source order the way the file does.
 *
 * `contains` is excluded, as everywhere else: it is structure, not dependency,
 * and the outline already draws it.
 */
function buildCalls(
  cg: CodeGraph,
  nodes: readonly Node[],
  posixPath: string
): { calls: WireFileCall[]; total: number; intraFileCalls: number } {
  const nodeIds = nodes.map((n) => n.id);
  const lineOf = new Map(nodes.map((n) => [n.id, n.startLine] as const));

  const edges = cg.getOutgoingEdgesFrom(nodeIds).filter((e) => e.kind !== 'contains');
  if (edges.length === 0) return { calls: [], total: 0, intraFileCalls: 0 };

  const bySource = new Map<string, Edge[]>();
  for (const edge of edges) {
    const bucket = bySource.get(edge.source);
    if (bucket) bucket.push(edge);
    else bySource.set(edge.source, [edge]);
  }

  // One batched lookup for every counterpart, never one per edge: the engine's
  // busiest file reaches several hundred distinct symbols.
  const endpoints = cg.getNodesByIds([...new Set(edges.map((e) => e.target))]);

  const all: WireFileCall[] = [];
  for (const [ownerId, group] of bySource) {
    for (const relation of groupRelations(group, (e) => e.target, endpoints)) {
      all.push({ ownerId, ownerLine: lineOf.get(ownerId) ?? 0, relation });
    }
  }

  // Source order — the only ordering this screen has. A row with no recorded
  // call site (an edge the extractor gave no line) sorts to the end, where it
  // is also what a cap trims first.
  all.sort(
    (a, b) =>
      firstLine(a.relation) - firstLine(b.relation) ||
      a.ownerLine - b.ownerLine ||
      a.relation.node.name.localeCompare(b.relation.node.name)
  );

  const calls = all.slice(0, MAX_FILE_CALL_GROUPS);

  // Arcs, counted over what was KEPT — see the module comment.
  let intraFileCalls = 0;
  for (const call of calls) {
    if (call.relation.node.file !== posixPath) continue;
    const target = call.relation.node.line;
    for (const line of call.relation.lines) if (line !== target) intraFileCalls++;
  }

  return { calls, total: all.length, intraFileCalls };
}

/**
 * The file's unresolved references, as line markers.
 *
 * Only plain identifiers survive. The resolver's samples are bookkeeping, and a
 * "name" that is really a whole arrow function or a receiver expression cannot
 * be matched to a token on the line — a marker that could not find its
 * identifier would silently claim the wrong one, which is worse than no marker.
 * The same filter the Symbol view applies, applied once here rather than per
 * symbol.
 */
function buildOutsideRefs(
  cg: CodeGraph,
  storedPath: string
): { items: WireFileOutsideRef[]; total: number } {
  let raw;
  try {
    // Scanned, not capped at the display limit: `total` must be the real count
    // and the identifier filter below cannot run in SQL.
    raw = cg.getUnresolvedReferencesInFile(storedPath, MAX_FILE_OUTSIDE_SCAN);
  } catch {
    return { items: [], total: 0 };
  }

  const items: WireFileOutsideRef[] = [];
  let total = 0;
  for (const ref of raw) {
    const name = lastSegment(ref.referenceName ?? '');
    if (!/^[A-Za-z_$][\w$]*$/.test(name)) continue;
    if (!ref.line) continue;
    total++;
    if (items.length < MAX_FILE_OUTSIDE_REFS) {
      items.push({ line: ref.line, col: ref.column ?? 0, name, kind: ref.referenceKind });
    }
  }
  return { items, total };
}

/** The trailing segment of a dotted name — what actually appears in the source. */
function lastSegment(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot < 0 ? name : name.slice(dot + 1);
}
