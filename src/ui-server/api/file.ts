/**
 * `GET /api/file/<path>` — the File view in one round-trip.
 *
 * Three panes: what imports this file, the file's own outline in source order,
 * and what this file imports. All of it comes from four batched queries — the
 * file's nodes, their `contains` edges, their `imports` edges in each
 * direction — never a query per symbol.
 *
 * Two things worth knowing about `imports` edges before reading the mapping
 * below. First, they point at the *symbol* that was imported, not at the file
 * holding it, so file granularity means mapping each edge's endpoint through
 * `nodes.file_path`. Second, plenty of them stay inside one file (an import
 * declaration is a node in the importing file), so the same-file ones have to
 * be dropped or every file appears to import itself.
 *
 * The rails would still read as broken without the third piece: imports that
 * never resolved. A file importing `react`, `fs` and one local module would
 * otherwise show a single row, silently implying the other two do not exist.
 * They are listed separately, as what they are — outside the index.
 */

import type { CodeGraph } from '../../index';
import type { Edge, Node } from '../../types';
import { isTestFile } from '../../search/query-utils';
import { hasDriftedOnDisk, resolveRequestedFile } from './source';
import {
  MAX_IMPORT_FILES,
  MAX_OUTLINE_NODES,
  toNodeRef,
  toPosixPath,
  wireList,
  type WireNodeRef,
} from './wire';

/** Symbols named per import row before it just counts them. */
const MAX_SYMBOLS_PER_IMPORT = 12;

/** Unresolved imports listed by name. */
const MAX_UNRESOLVED_IMPORTS = 60;

/** A row in the file outline. */
export interface WireOutlineEntry extends WireNodeRef {
  /** Containing symbol within this file, or null for a top-level one. */
  parentId: string | null;
  /** Nesting depth from the top level of the file, starting at 0. */
  depth: number;
  /** Incoming / outgoing edge counts — the `← in  → out` column. */
  fanIn: number;
  fanOut: number;
}

/** One end of the File view's import rails. */
export interface WireImportRow {
  file: string;
  test: boolean;
  /** Which symbols the edges name, capped. */
  symbols: Array<{ id: string; name: string; kind: string; line: number }>;
  symbolCount: number;
}

export function buildFile(cg: CodeGraph, projectRoot: string, requested: string): unknown {
  // Refusal first, index lookup second — a traversal out of the project is a
  // refusal, not "no such file". See `resolveRequestedFile`.
  const { record, storedPath } = resolveRequestedFile(cg, projectRoot, requested);

  const nodes = cg.getNodesInFile(storedPath);
  const nodeIds = nodes.map((n) => n.id);
  const inThisFile = new Set(nodeIds);
  const fileNode = nodes.find((n) => n.kind === 'file') ?? null;

  // ---------------------------------------------------------------------------
  // Outline
  // ---------------------------------------------------------------------------
  const { entries: outline, total: outlineTotal } = buildOutlineEntries(cg, nodes);

  // ---------------------------------------------------------------------------
  // Import rails
  // ---------------------------------------------------------------------------
  const importsOut = cg.getOutgoingEdgesFrom(nodeIds, ['imports']);
  const importsIn = cg.getIncomingEdgesTo(nodeIds, ['imports']);

  const endpointIds = new Set<string>();
  for (const edge of importsOut) if (!inThisFile.has(edge.target)) endpointIds.add(edge.target);
  for (const edge of importsIn) if (!inThisFile.has(edge.source)) endpointIds.add(edge.source);
  const endpoints = cg.getNodesByIds([...endpointIds]);

  const imports = groupByFile(
    importsOut.filter((e) => !inThisFile.has(e.target)),
    (e) => e.target,
    endpoints
  );
  const importedBy = groupByFile(
    importsIn.filter((e) => !inThisFile.has(e.source)),
    (e) => e.source,
    endpoints
  );

  // Import statements that never resolved — the third-party packages and
  // runtime builtins. Attributed to the file node, which is where extraction
  // records a file-level import.
  const unresolvedImports = fileNode ? unresolvedImportsOf(cg, fileNode.id) : [];

  // Whether the file RUNS anything at its top level. Extraction records a
  // statement outside any definition as an edge out of the FILE node, so a
  // module that only defines things has none and a CLI entry point has many —
  // the same signal `/api/entrypoints` ranks on. It is worth a line on this
  // screen because the outline cannot show it: top-level code belongs to no
  // symbol, so the only way to read it is to open the file node itself.
  const topLevelEdges = fileNode
    ? cg.getOutgoingEdgesFrom([fileNode.id], ['calls', 'instantiates'])
    : [];

  return {
    file: {
      path: toPosixPath(storedPath),
      language: record.language,
      size: record.size,
      modifiedAt: record.modifiedAt,
      indexedAt: record.indexedAt,
      contentHash: record.contentHash,
      nodeCount: record.nodeCount,
      generated: record.generated === true,
      test: isTestFile(toPosixPath(storedPath)),
      errors: record.errors ?? [],
      /** The file node itself, so the viewer can navigate to it as a symbol. */
      id: fileNode?.id ?? null,
    },
    /**
     * Calls made at the top level of the file, outside every definition.
     * Counted as distinct call SITES — `(target, line, column)` — so a call
     * two resolvers both recorded is one thing to read, not two.
     */
    topLevel: {
      calls: new Set(topLevelEdges.map((e) => `${e.target}:${e.line ?? 0}:${e.column ?? 0}`)).size,
    },
    /** The file changed on disk since it was indexed — the outline's lines may be shifted. */
    drift: hasDriftedOnDisk(projectRoot, storedPath, record),
    outline: wireList(outline, outlineTotal),
    imports: wireList(imports.slice(0, MAX_IMPORT_FILES), imports.length),
    importedBy: wireList(importedBy.slice(0, MAX_IMPORT_FILES), importedBy.length),
    unresolvedImports,
    /**
     * The broader relationship: every file this one has a cross-file edge into,
     * and every file that has one into it — calls and type references, not just
     * import statements. `imports` alone understates both, badly in languages
     * where symbols resolve without an explicit import.
     */
    dependencies: cg.getFileDependencies(storedPath).map(toPosixPath).sort(),
    dependents: cg.getFileDependents(storedPath).map(toPosixPath).sort(),
  };
}

/**
 * A file's symbols in source order, nested under their container.
 *
 * Extracted so the whole-file source view (`/api/filecode`) draws the same rows
 * as the outline view rather than a second, subtly different reading of the
 * same `contains` edges — an outline rail whose line numbers disagreed with the
 * source beside it would be worse than no rail.
 *
 * Four batched queries whatever the file holds: its nodes are already in hand,
 * their `contains` edges, and fan-in / fan-out for the whole set at once.
 *
 * @returns the capped rows and the TRUE symbol count, which is what a header
 *          has to print — see `wireList`.
 */
export function buildOutlineEntries(
  cg: CodeGraph,
  nodes: readonly Node[]
): { entries: WireOutlineEntry[]; total: number } {
  const nodeIds = nodes.map((n) => n.id);
  const inThisFile = new Set(nodeIds);
  const fileNodeId = nodes.find((n) => n.kind === 'file')?.id;

  const parentOf = new Map<string, string>();
  for (const edge of cg.getOutgoingEdgesFrom(nodeIds, ['contains'])) {
    // Only nesting *within* this file: a `contains` edge reaching out of it is
    // not something a file outline can draw.
    if (inThisFile.has(edge.target) && !parentOf.has(edge.target)) {
      parentOf.set(edge.target, edge.source);
    }
  }

  const fanIn = cg.getFanIn(nodeIds);
  const fanOut = cg.getFanOut(nodeIds);

  const outlineNodes = nodes
    // The file node is the subject of the screen, not a row in its own outline;
    // import declarations get their own rail and would otherwise be most of it.
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));

  const entries: WireOutlineEntry[] = outlineNodes.slice(0, MAX_OUTLINE_NODES).map((node) => ({
    ...toNodeRef(node),
    parentId: resolveOutlineParent(node.id, parentOf, fileNodeId),
    depth: depthOf(node.id, parentOf, fileNodeId),
    fanIn: fanIn.get(node.id) ?? 0,
    fanOut: fanOut.get(node.id) ?? 0,
  }));

  return { entries, total: outlineNodes.length };
}

/**
 * The outline parent of a symbol: its container within the file, or null when
 * that container is the file node itself (a top-level symbol has no parent row).
 */
function resolveOutlineParent(
  id: string,
  parentOf: Map<string, string>,
  fileNodeId: string | undefined
): string | null {
  const parent = parentOf.get(id);
  if (!parent || parent === fileNodeId) return null;
  return parent;
}

function depthOf(
  id: string,
  parentOf: Map<string, string>,
  fileNodeId: string | undefined
): number {
  let depth = 0;
  let current = id;
  // Bounded by the number of links so a cyclic `contains` chain — which should
  // be impossible, but is one bad index away — cannot spin here.
  for (let guard = 0; guard < 32; guard++) {
    const parent = parentOf.get(current);
    if (!parent || parent === fileNodeId) return depth;
    depth++;
    current = parent;
  }
  return depth;
}

/** Fold edges into one row per file at the far end, ordered by symbol count. */
function groupByFile(
  edges: readonly Edge[],
  endpoint: (edge: Edge) => string,
  nodes: Map<string, Node>
): WireImportRow[] {
  const byFile = new Map<string, Map<string, Node>>();
  for (const edge of edges) {
    const node = nodes.get(endpoint(edge));
    if (!node) continue;
    const file = toPosixPath(node.filePath);
    let bucket = byFile.get(file);
    if (!bucket) {
      bucket = new Map<string, Node>();
      byFile.set(file, bucket);
    }
    bucket.set(node.id, node);
  }

  return [...byFile.entries()]
    .map(([file, symbols]) => {
      const ordered = [...symbols.values()].sort(
        (a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name)
      );
      return {
        file,
        test: isTestFile(file),
        symbols: ordered.slice(0, MAX_SYMBOLS_PER_IMPORT).map((n) => ({
          id: n.id,
          name: n.name,
          kind: n.kind,
          line: n.startLine,
        })),
        symbolCount: ordered.length,
      };
    })
    .sort((a, b) => b.symbolCount - a.symbolCount || a.file.localeCompare(b.file));
}

function unresolvedImportsOf(
  cg: CodeGraph,
  fileNodeId: string
): Array<{ name: string; line: number }> {
  try {
    return cg
      .getUnresolvedReferencesFrom(fileNodeId)
      .filter((ref) => ref.referenceKind === 'imports')
      .sort((a, b) => a.line - b.line || a.referenceName.localeCompare(b.referenceName))
      .slice(0, MAX_UNRESOLVED_IMPORTS)
      .map((ref) => ({ name: ref.referenceName, line: ref.line }));
  } catch {
    return [];
  }
}
