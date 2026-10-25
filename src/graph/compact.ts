/**
 * Compact, token-efficient CLI outputs — `codegraph deps` and
 * `codegraph info` (GitHub issue #500).
 *
 * These commands exist for LLM context injection: an agent wants a dense,
 * markdown summary of a FILE's dependency map or a SYMBOL's relationships,
 * not the human-oriented (ANSI, padded) output of the other verbs. The query
 * and formatting logic lives here so it is unit-testable and shared if a
 * future surface (the MCP server) wants the same shape.
 *
 * Everything reads through the public `CodeGraph` surface — batched where a
 * per-symbol query would be (getNodesByIds / getOutgoingEdgesFrom /
 * getIncomingEdgesTo), never one query per edge.
 */

import type { CodeGraph } from '../index';
import type { Edge, Node } from '../types';
import { readFileSync } from 'fs';
import * as path from 'path';

/** A symbol definition summarized in `codegraph deps` ("class AuthUtil"). */
export interface DepDef {
  kind: string;
  name: string;
}

/** A repo-internal module import, with the symbols it pulls in. */
export interface LocalImport {
  module: string;
  symbols: Array<{ kind: string; name: string }>;
}

/** The full data `codegraph deps` renders (and `--json` emits). */
export interface FileDepsData {
  path: string;
  defines: DepDef[];
  /** External/package imports that never resolved to an indexed symbol. */
  npmImports: string[];
  /** Imports that resolved to other files in the index, by written specifier. */
  localImports: LocalImport[];
  /** Files that reach into this one, with a representative line each. */
  dependents: Array<{ file: string; line: number }>;
}

/** One row of a symbol's "depends on" / "used by" list. */
export interface RelationEntry {
  kind: string;
  name: string;
  /** The distinct relationship kinds (calls, references, extends, …). */
  relations: string[];
}

/** The data `codegraph info` renders (and `--json` emits). */
export interface SymbolInfoData {
  symbol: string;
  kind: string;
  filePath: string;
  startLine: number;
  exported: boolean | undefined;
  visibility: string | undefined;
  /** Ambiguous name: the query named more than one distinct definition. */
  ambiguous: boolean;
  dependsOn: RelationEntry[];
  usedBy: RelationEntry[];
  truncated: { dependsOn?: boolean; usedBy?: boolean };
  /** The symbol's source body, when `--with-code` was requested. */
  code?: string;
}

/** Maximum relationship rows printed per section (keeps output bounded). */
const MAX_RELATIONS = 50;
/** Maximum source lines printed for `--with-code`. */
const MAX_CODE_LINES = 200;

/** Is `specifier` a relative (`.` / `..`) import path? */
function isRelativeSpecifier(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Build the dependency summary for one file.
 *
 * `filePath` is the project-relative stored path (callers normalize the
 * user's argument against `getProjectRoot`).
 */
export function buildFileDeps(cg: CodeGraph, filePath: string): FileDepsData {
  const nodes = cg.getNodesInFile(filePath);
  const nodeIds = nodes.map((n) => n.id);
  const inThisFile = new Set(nodeIds);

  // defines — every symbol in the file except the file node and import
  // declarations, in source order.
  const defines = nodes
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name))
    .map((n) => ({ kind: n.kind, name: n.name }));

  // Imports — the import declaration nodes (kind 'import') name the written
  // specifier, and the resolved cross-file `imports` edges (emitted from the
  // file node) record what each resolved to. Every edge of one import
  // statement shares its line: the edge whose target is the target FILE node
  // carries the specifier as its refName, and the edges whose targets are the
  // imported SYMBOLS describe what the statement pulls in. Grouping edges by
  // line associates the specifier with its symbols. The `imports` edge from a
  // file to its own import declarations is same-file and is dropped below.
  const importsOut = cg
    .getOutgoingEdgesFrom(nodeIds, ['imports'])
    .filter((e) => !inThisFile.has(e.target));
  const targets = cg.getNodesByIds([...new Set(importsOut.map((e) => e.target))]);

  // Per import line: the specifier (from the file-node edge) + the imported
  // symbols (from the symbol edges).
  const lineInfo = new Map<number, { spec?: string; symbols: Map<string, Node> }>();
  for (const edge of importsOut) {
    const tgt = targets.get(edge.target);
    if (!tgt) continue;
    let info = lineInfo.get(edge.line ?? 0);
    if (!info) {
      info = { symbols: new Map() };
      lineInfo.set(edge.line ?? 0, info);
    }
    if (tgt.kind === 'file') {
      const ref = edge.metadata?.refName;
      if (typeof ref === 'string' && info.spec === undefined) info.spec = ref;
    } else {
      info.symbols.set(tgt.id, tgt);
    }
  }

  // Import declaration nodes, in source order — the authoritative list of
  // specifiers (resolved or not), used to classify each statement.
  const importDecls = nodes
    .filter((n) => n.kind === 'import')
    .sort((a, b) => a.startLine - b.startLine);

  const localImports: LocalImport[] = [];
  const npmImports: string[] = [];
  const seenLocalSpecs = new Set<string>();

  for (const decl of importDecls) {
    const info = lineInfo.get(decl.startLine);
    const resolved = info !== undefined && (info.spec !== undefined || info.symbols.size > 0);

    if (!resolved) {
      // Unresolved. Relative → broken local import (listed, no symbols);
      // otherwise → external package (npm).
      if (isRelativeSpecifier(decl.name)) {
        if (!seenLocalSpecs.has(decl.name)) {
          seenLocalSpecs.add(decl.name);
          localImports.push({ module: decl.name, symbols: [] });
        }
      } else {
        npmImports.push(decl.name);
      }
      continue;
    }

    // Resolved into the index: a local module regardless of how the specifier
    // is spelled (it may be a path alias like `@lib/...`).
    const spec = info.spec ?? decl.name;
    if (seenLocalSpecs.has(spec)) continue;
    seenLocalSpecs.add(spec);
    const symbols = [...info.symbols.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((n) => ({ kind: n.kind, name: n.name }));
    localImports.push({ module: spec, symbols });
  }

  // Drop the resolved-local specifiers from the npm list (a non-relative
  // specifier that resolved is an alias, not a package).
  const filteredNpm = npmImports.filter((name) => !seenLocalSpecs.has(name));
  const dedupNpm = [...new Set(filteredNpm)].sort();
  npmImports.length = 0;
  npmImports.push(...dedupNpm);

  localImports.sort((a, b) => a.module.localeCompare(b.module));

  // Called by (reverse deps) — cross-file edges INTO this file's nodes, one
  // representative line per source file.
  const importsIn = cg.getIncomingEdgesTo(nodeIds).filter((e) => !inThisFile.has(e.source));
  const srcNodes = cg.getNodesByIds([...new Set(importsIn.map((e) => e.source))]);
  const byFile = new Map<string, number>();
  for (const edge of importsIn) {
    const src = srcNodes.get(edge.source);
    if (!src) continue;
    const line = edge.line ?? src.startLine;
    const prev = byFile.get(src.filePath);
    if (prev === undefined || line < prev) byFile.set(src.filePath, line);
  }
  const dependents = [...byFile.entries()]
    .map(([file, line]) => ({ file, line }))
    .sort((a, b) => a.file.localeCompare(b.file));

  return { path: filePath, defines, npmImports, localImports, dependents };
}

/** Order relationship kinds so calls/references lead and less common edges trail. */
const RELATION_PRIORITY = [
  'calls',
  'references',
  'instantiates',
  'extends',
  'implements',
  'overrides',
  'type_of',
  'returns',
  'decorates',
  'imports',
  'exports',
  'navigates',
];

function relationSortKey(entry: RelationEntry): number {
  const best = Math.min(
    ...entry.relations.map((r) => {
      const idx = RELATION_PRIORITY.indexOf(r);
      return idx === -1 ? RELATION_PRIORITY.length : idx;
    })
  );
  return best;
}

/** Collect edges into distinct endpoint rows, sorted by relationship then name. */
function collectRelations(
  edges: Edge[],
  endpoint: 'source' | 'target',
  cg: CodeGraph
): { entries: RelationEntry[]; truncated: boolean } {
  const ids = [...new Set(edges.map((e) => (endpoint === 'target' ? e.target : e.source)))];
  const nodes = cg.getNodesByIds(ids);
  const byId = new Map<string, { node: Node; relations: Set<string> }>();
  for (const edge of edges) {
    const id = endpoint === 'target' ? edge.target : edge.source;
    let entry = byId.get(id);
    if (!entry) {
      const node = nodes.get(id);
      // `file` and `import` nodes are scaffolding, not symbols — skip them so a
      // symbol profile lists only meaningful references (a file that imports
      // the symbol is already covered by the symbol-level edges).
      if (!node || node.kind === 'file' || node.kind === 'import') continue;
      entry = { node, relations: new Set() };
      byId.set(id, entry);
    }
    entry.relations.add(edge.kind);
  }
  const all = [...byId.values()]
    .map(({ node, relations }) => ({
      kind: node.kind,
      name: node.name,
      relations: [...relations],
    }))
    .sort((a, b) => relationSortKey(a) - relationSortKey(b) || a.name.localeCompare(b.name));
  const truncated = all.length > MAX_RELATIONS;
  return { entries: all.slice(0, MAX_RELATIONS), truncated };
}

/** Read a node's source body as line-numbered text, or undefined when it can't. */
function readNodeSource(cg: CodeGraph, node: Node): string | undefined {
  try {
    const abs = path.join(cg.getProjectRoot(), node.filePath);
    const lines = readFileSync(abs, 'utf8').split('\n');
    const start = Math.max(1, node.startLine);
    const end = Math.min(lines.length, Math.max(start, node.endLine));
    const slice = lines.slice(start - 1, end);
    const shown = slice.slice(0, MAX_CODE_LINES);
    const text = shown.map((line, i) => `${String(start + i).padStart(4)}  ${line}`).join('\n');
    const overflow = slice.length - shown.length;
    return overflow > 0 ? `${text}\n      … (+${overflow} more lines)` : text;
  } catch {
    return undefined;
  }
}

/**
 * A symbol's "own" ids plus those of everything it contains (its members,
 * transitively). A class is the sum of its methods: its type references and
 * calls live on those members, so summarizing the class requires gathering
 * their edges too.
 */
function expandWithMembers(cg: CodeGraph, ids: string[]): string[] {
  const seen = new Set(ids);
  let frontier = [...ids];
  while (frontier.length > 0) {
    const children = cg
      .getOutgoingEdgesFrom(frontier, ['contains'])
      .map((e) => e.target)
      .filter((id) => !seen.has(id));
    for (const id of children) seen.add(id);
    frontier = children;
  }
  return [...seen];
}

/**
 * Build the compact summary for a symbol.
 *
 * `group` is one definition's worth of nodes (same file + qualified name —
 * overloads stay together, exactly as the callers/callees/impact verbs group
 * them). `ambiguous` reflects whether the query named more than one distinct
 * definition.
 */
export function buildSymbolInfo(
  cg: CodeGraph,
  group: Node[],
  symbol: string,
  opts: { withCode?: boolean },
): SymbolInfoData {
  const head = group[0]!;
  const ids = expandWithMembers(cg, group.map((n) => n.id));
  const idSet = new Set(ids);

  // Edges that cross the symbol's boundary: outgoing to anything outside its
  // own/member set (depends on), incoming from anything outside (used by).
  // Containment edges never appear; self/internal edges are dropped.
  const outgoing = cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && !idSet.has(e.target));
  const incoming = cg
    .getIncomingEdgesTo(ids)
    .filter((e) => e.kind !== 'contains' && !idSet.has(e.source));

  const depends = collectRelations(outgoing, 'target', cg);
  const usedBy = collectRelations(incoming, 'source', cg);

  const info: SymbolInfoData = {
    symbol,
    kind: head.kind,
    filePath: head.filePath,
    startLine: head.startLine,
    exported: head.isExported,
    visibility: head.visibility,
    ambiguous: false,
    dependsOn: depends.entries,
    usedBy: usedBy.entries,
    truncated: {
      dependsOn: depends.truncated || undefined,
      usedBy: usedBy.truncated || undefined,
    },
  };

  if (opts.withCode) {
    info.code = readNodeSource(cg, head);
  }

  return info;
}

// ---------------------------------------------------------------------------
// Markdown formatters
// ---------------------------------------------------------------------------

function defineLabel(def: DepDef): string {
  if (def.kind === 'function' || def.kind === 'method') {
    return `${def.kind} ${def.name}()`;
  }
  return `${def.kind} ${def.name}`;
}

/** Format `codegraph deps` output as compressed markdown. */
export function formatFileDepsMarkdown(data: FileDepsData): string {
  const lines: string[] = [];
  lines.push(`## deps of: ${data.path}`);
  lines.push('');
  lines.push('### calls out (imports)');

  const callsOut: string[] = [];
  if (data.npmImports.length > 0) {
    callsOut.push(`- \`${data.npmImports.join('`, `')}\` (npm)`);
  }
  for (const loc of data.localImports) {
    const syms = loc.symbols.map((s) => s.name).join(', ');
    callsOut.push(`- \`${loc.module}\` (local) - \`${syms}\``);
  }
  if (callsOut.length === 0) callsOut.push('- (none)');
  lines.push(...callsOut);

  lines.push('');
  lines.push('### called by (reverse deps)');
  if (data.dependents.length === 0) {
    lines.push('- (none)');
  } else {
    for (const d of data.dependents) lines.push(`- \`${d.file}:${d.line}\``);
  }

  lines.push('');
  lines.push('### defines');
  if (data.defines.length === 0) {
    lines.push('- (no symbols)');
  } else {
    for (const def of data.defines) lines.push(`- \`${defineLabel(def)}\``);
  }

  return lines.join('\n');
}

function formatRelationEntry(entry: RelationEntry): string {
  return `- \`${entry.kind} ${entry.name}\` (${entry.relations.join(', ')})`;
}

/** Format `codegraph info` output as compressed markdown. */
export function formatSymbolInfoMarkdown(data: SymbolInfoData): string {
  const lines: string[] = [];
  lines.push(`## ${data.symbol}`);
  lines.push(
    `**kind**: ${data.kind} | **file**: \`${data.filePath}:${data.startLine}\``
  );
  const exported = data.exported ? 'yes' : 'no';
  const vis = data.visibility ?? '-';
  lines.push(`**exported**: ${exported} | **vis**: ${vis}`);

  lines.push('');
  lines.push('**depends on**:');
  if (data.dependsOn.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of data.dependsOn) lines.push(formatRelationEntry(entry));
    if (data.truncated.dependsOn) lines.push(`- … (+${MAX_RELATIONS} shown)`);
  }

  lines.push('');
  lines.push('**used by**:');
  if (data.usedBy.length === 0) {
    lines.push('- (none)');
  } else {
    for (const entry of data.usedBy) lines.push(formatRelationEntry(entry));
    if (data.truncated.usedBy) lines.push(`- … (+${MAX_RELATIONS} shown)`);
  }

  if (data.code !== undefined) {
    lines.push('');
    lines.push('```');
    lines.push(data.code);
    lines.push('```');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Compact one-line CLI output (issue #500, items 3–4)
// ---------------------------------------------------------------------------

/** One dense "kind name (path:line)" label for a symbol. */
export function compactSymbolLabel(node: Node, withKind = true): string {
  const loc = `${node.filePath}:${node.startLine}`;
  return withKind ? `${node.kind} ${node.name} (${loc})` : `${node.name} (${loc})`;
}

/**
 * The single most relevant relationship of a symbol, as a short suffix for a
 * compact line (e.g. `calls: authService.verify`). Derives from the symbol's
 * top "depends on" row so it reuses the same batched edge gathering as
 * `codegraph info`; returns undefined when the symbol has no cross-file
 * dependencies (files, imports, leaves).
 */
export function compactSymbolRelation(cg: CodeGraph, nodes: Node[]): string | undefined {
  if (nodes.length === 0) return undefined;
  const head = nodes[0]!;
  if (head.kind === 'file' || head.kind === 'import') return undefined;
  const info = buildSymbolInfo(cg, nodes, head.name, {});
  const top = info.dependsOn[0];
  if (!top) return undefined;
  return `${top.relations.join('/')}: ${top.name}`;
}

/** A node in the call-chain tree rendered by `codegraph graph`. */
export interface CallChainNode {
  node: Node;
  /** The edge kind that led to this node (undefined for the root). */
  edgeKind?: string;
  /** True when this node repeats an ancestor of itself (cycle guard). */
  cycle?: boolean;
  children: CallChainNode[];
}

/**
 * Build the callee call-chain tree rooted at `root`, to `maxDepth` (inclusive)
 * levels deep.
 *
 * The direct callees are the outgoing call-like edges of the node (calls,
 * references, instantiates, imports, navigates — the same set the traverser
 * uses), resolved in one batched fetch. We read the edges ourselves rather than
 * calling `getCallees` because that method de-duplicates across the whole
 * traversal and drops the root, so a self-recursion would never surface. We
 * recurse per child so a function reached through two different call paths
 * appears once per path, as a chain should. `onPath` (the ancestor set) guards
 * cycles: a child that is already an ancestor is marked `cycle` and never
 * recursed into, so the walk always terminates.
 */
export function buildCallChain(cg: CodeGraph, root: Node, maxDepth: number): CallChainNode {
  const build = (node: Node, depth: number, onPath: ReadonlySet<string>): CallChainNode => {
    const entry: CallChainNode = { node, children: [] };
    if (depth >= maxDepth) return entry;
    const edges = cg.getOutgoingEdgesFrom([node.id], ['calls', 'references', 'instantiates', 'imports', 'navigates']);
    const targets = cg.getNodesByIds(edges.map((e) => e.target));
    const seen = new Set<string>();
    for (const edge of edges) {
      const child = targets.get(edge.target);
      if (!child || child.kind === 'file' || child.kind === 'import') continue;
      if (seen.has(child.id)) continue; // two call sites to the same callee → one branch
      seen.add(child.id);
      const cycle = onPath.has(child.id);
      const childEntry: CallChainNode = {
        node: child,
        edgeKind: edge.kind,
        cycle,
        children: [],
      };
      if (!cycle) {
        const next = new Set(onPath);
        next.add(child.id);
        childEntry.children = build(child, depth + 1, next).children;
      }
      entry.children.push(childEntry);
    }
    return entry;
  };
  return build(root, 0, new Set([root.id]));
}

/** Render a call-chain tree as indented box-drawing text (`└─` / `├─`). */
export function formatCallChain(tree: CallChainNode, opts: { compact?: boolean } = {}): string {
  const lines: string[] = [];

  const labelFor = (n: CallChainNode, isRoot: boolean): string => {
    // Compact drops the kind for a denser line; the default form keeps it so a
    // reader can tell a function from a class at a glance.
    const base = opts.compact ? compactSymbolLabel(n.node, false) : compactSymbolLabel(n.node, true);
    if (isRoot) return base;
    const edge = n.edgeKind ?? 'calls';
    return `${edge} → ${base}${n.cycle ? ' (cycle)' : ''}`;
  };

  const walk = (n: CallChainNode, prefix: string, isLast: boolean, isRoot: boolean): void => {
    const marker = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    lines.push(`${prefix}${marker}${labelFor(n, isRoot)}`);
    const rec = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    n.children.forEach((c, i) => walk(c, rec, i === n.children.length - 1, false));
  };

  walk(tree, '', true, true);
  return lines.join('\n');
}
