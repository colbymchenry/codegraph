/**
 * Static HTML graph visualization support for the CLI.
 */

import {
  EDGE_KINDS,
  Edge,
  EdgeKind,
  GraphStats,
  NODE_KINDS,
  Node,
  NodeKind,
  SearchOptions,
  SearchResult,
  Subgraph,
  TraversalOptions,
} from './types';

export const DEFAULT_VISUALIZATION_LIMIT = 300;
export const DEFAULT_VISUALIZATION_DEPTH = 2;

export const DEFAULT_VISUALIZATION_NODE_KINDS: NodeKind[] = [
  'file',
  'module',
  'namespace',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'enum',
  'type_alias',
  'function',
  'method',
  'route',
  'component',
];

export const DEFAULT_VISUALIZATION_EDGE_KINDS: EdgeKind[] = [...EDGE_KINDS];

export interface VisualizationDataSource {
  getStats(): GraphStats;
  getNodesByKind(kind: NodeKind): Node[];
  getOutgoingEdges(nodeId: string): Edge[];
  getIncomingEdges(nodeId: string): Edge[];
  searchNodes(query: string, options?: SearchOptions): SearchResult[];
  traverse(startId: string, options?: TraversalOptions): Subgraph;
}

export interface BuildVisualizationOptions {
  projectRoot: string;
  symbol?: string;
  limit?: number;
  depth?: number;
  direction?: 'incoming' | 'outgoing' | 'both';
  nodeKinds?: NodeKind[];
  edgeKinds?: EdgeKind[];
}

export interface VisualizationNode {
  id: string;
  label: string;
  kind: NodeKind;
  qualifiedName: string;
  filePath: string;
  language: string;
  line: number;
  signature?: string;
  exported: boolean;
  root: boolean;
  incoming: number;
  outgoing: number;
  size: number;
}

export interface VisualizationEdge {
  source: string;
  target: string;
  kind: EdgeKind;
  line?: number;
  provenance?: Edge['provenance'];
}

export interface VisualizationGraph {
  title: string;
  projectRoot: string;
  mode: 'overview' | 'symbol';
  query?: string;
  generatedAt: number;
  nodes: VisualizationNode[];
  edges: VisualizationEdge[];
  rootIds: string[];
  stats: {
    totalNodes: number;
    totalEdges: number;
    includedNodes: number;
    includedEdges: number;
    truncated: boolean;
  };
}

const KIND_WEIGHT: Record<NodeKind, number> = {
  file: 110,
  route: 105,
  module: 100,
  namespace: 98,
  class: 96,
  struct: 94,
  interface: 92,
  trait: 91,
  protocol: 91,
  component: 90,
  function: 86,
  method: 84,
  enum: 78,
  type_alias: 76,
  property: 50,
  field: 48,
  constant: 46,
  variable: 40,
  enum_member: 34,
  import: 24,
  export: 24,
  parameter: 10,
};

const OVERVIEW_POOL_MULTIPLIER = 8;
const OVERVIEW_POOL_MIN = 500;
const OVERVIEW_POOL_MAX = 4000;

function unique<T>(values: T[]): T[] {
  return Array.from(new Set(values));
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function edgeKey(edge: Edge): string {
  return `${edge.source}\u0000${edge.target}\u0000${edge.kind}\u0000${edge.line ?? ''}`;
}

function isExactSymbolMatch(node: Node, symbol: string): boolean {
  return (
    node.name === symbol ||
    node.qualifiedName === symbol ||
    node.name.endsWith(`.${symbol}`) ||
    node.name.endsWith(`::${symbol}`) ||
    node.qualifiedName.endsWith(`.${symbol}`) ||
    node.qualifiedName.endsWith(`::${symbol}`)
  );
}

function nodeBaseScore(node: Node): number {
  return (
    KIND_WEIGHT[node.kind] +
    (node.isExported ? 20 : 0) +
    (node.visibility === 'public' ? 8 : 0) +
    (node.kind === 'file' ? 6 : 0)
  );
}

function collectOverviewCandidates(
  source: VisualizationDataSource,
  nodeKinds: NodeKind[],
  limit: number
): Node[] {
  const seen = new Set<string>();
  const nodes: Node[] = [];

  for (const kind of nodeKinds) {
    for (const node of source.getNodesByKind(kind)) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      nodes.push(node);
    }
  }

  const poolSize = Math.min(
    nodes.length,
    Math.max(OVERVIEW_POOL_MIN, Math.min(OVERVIEW_POOL_MAX, limit * OVERVIEW_POOL_MULTIPLIER))
  );

  return nodes
    .sort((a, b) => {
      const score = nodeBaseScore(b) - nodeBaseScore(a);
      if (score !== 0) return score;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, poolSize);
}

function buildOverviewSubgraph(
  source: VisualizationDataSource,
  options: Required<Pick<BuildVisualizationOptions, 'limit' | 'nodeKinds' | 'edgeKinds'>>
): Subgraph {
  const candidates = collectOverviewCandidates(source, options.nodeKinds, options.limit);
  const candidateById = new Map(candidates.map((node) => [node.id, node]));
  const candidateIds = new Set(candidateById.keys());
  const edgeKinds = new Set(options.edgeKinds);
  const edgesByKey = new Map<string, Edge>();
  const degree = new Map<string, number>();

  for (const node of candidates) {
    for (const edge of source.getOutgoingEdges(node.id)) {
      if (!edgeKinds.has(edge.kind)) continue;
      if (!candidateIds.has(edge.target)) continue;
      edgesByKey.set(edgeKey(edge), edge);
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }
  }

  const selected = candidates
    .sort((a, b) => {
      const aScore = (degree.get(a.id) ?? 0) * 100 + nodeBaseScore(a);
      const bScore = (degree.get(b.id) ?? 0) * 100 + nodeBaseScore(b);
      if (bScore !== aScore) return bScore - aScore;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, options.limit);

  const nodes = new Map(selected.map((node) => [node.id, node]));
  const edges = Array.from(edgesByKey.values()).filter(
    (edge) => nodes.has(edge.source) && nodes.has(edge.target)
  );

  return { nodes, edges, roots: [] };
}

function mergeSubgraphs(subgraphs: Subgraph[]): Subgraph {
  const nodes = new Map<string, Node>();
  const edgesByKey = new Map<string, Edge>();
  const roots: string[] = [];

  for (const subgraph of subgraphs) {
    for (const [id, node] of subgraph.nodes) {
      nodes.set(id, node);
    }
    for (const edge of subgraph.edges) {
      edgesByKey.set(edgeKey(edge), edge);
    }
    roots.push(...subgraph.roots);
  }

  return {
    nodes,
    edges: Array.from(edgesByKey.values()),
    roots: unique(roots),
  };
}

function findSymbolRoots(
  source: VisualizationDataSource,
  symbol: string,
  nodeKinds: NodeKind[]
): Node[] {
  const matches = source.searchNodes(symbol, {
    limit: 50,
    kinds: nodeKinds.length > 0 ? nodeKinds : undefined,
  });
  const exact = matches.filter((match) => isExactSymbolMatch(match.node, symbol));
  const roots = exact.length > 0 ? exact : matches.slice(0, 1);
  return unique(roots.map((match) => match.node.id))
    .map((id) => roots.find((match) => match.node.id === id)!.node)
    .slice(0, 5);
}

function buildSymbolSubgraph(
  source: VisualizationDataSource,
  symbol: string,
  options: Required<
    Pick<BuildVisualizationOptions, 'limit' | 'depth' | 'direction' | 'nodeKinds' | 'edgeKinds'>
  >
): Subgraph {
  const roots = findSymbolRoots(source, symbol, options.nodeKinds);
  if (roots.length === 0) return { nodes: new Map(), edges: [], roots: [] };

  const perRootLimit = Math.max(options.limit, Math.ceil(options.limit / roots.length));
  const subgraphs = roots.map((root) =>
    source.traverse(root.id, {
      maxDepth: options.depth,
      direction: options.direction,
      edgeKinds: options.edgeKinds,
      nodeKinds: options.nodeKinds,
      limit: perRootLimit,
      includeStart: true,
    })
  );

  return mergeSubgraphs(subgraphs);
}

export function buildVisualizationGraphFromSubgraph(args: {
  subgraph: Subgraph;
  projectRoot: string;
  title: string;
  mode: VisualizationGraph['mode'];
  query?: string;
  limit?: number;
  totalNodes?: number;
  totalEdges?: number;
}): VisualizationGraph {
  const limit = clampInt(args.limit, DEFAULT_VISUALIZATION_LIMIT, 1, 2000);
  const originalNodes = Array.from(args.subgraph.nodes.values());
  const originalEdges = args.subgraph.edges;
  const rootIds = unique(args.subgraph.roots);
  const rootIdSet = new Set(rootIds);
  const degree = new Map<string, { incoming: number; outgoing: number }>();

  for (const edge of originalEdges) {
    const sourceDegree = degree.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing++;
    degree.set(edge.source, sourceDegree);

    const targetDegree = degree.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    targetDegree.incoming++;
    degree.set(edge.target, targetDegree);
  }

  const selected = originalNodes
    .sort((a, b) => {
      const aDegree = degree.get(a.id);
      const bDegree = degree.get(b.id);
      const aScore =
        (rootIdSet.has(a.id) ? 100000 : 0) +
        ((aDegree?.incoming ?? 0) + (aDegree?.outgoing ?? 0)) * 100 +
        nodeBaseScore(a);
      const bScore =
        (rootIdSet.has(b.id) ? 100000 : 0) +
        ((bDegree?.incoming ?? 0) + (bDegree?.outgoing ?? 0)) * 100 +
        nodeBaseScore(b);
      if (bScore !== aScore) return bScore - aScore;
      const file = a.filePath.localeCompare(b.filePath);
      return file !== 0 ? file : a.name.localeCompare(b.name);
    })
    .slice(0, Math.max(limit, rootIds.length));

  const selectedIds = new Set(selected.map((node) => node.id));
  const edges = originalEdges.filter(
    (edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target)
  );
  const includedDegree = new Map<string, { incoming: number; outgoing: number }>();

  for (const edge of edges) {
    const sourceDegree = includedDegree.get(edge.source) ?? { incoming: 0, outgoing: 0 };
    sourceDegree.outgoing++;
    includedDegree.set(edge.source, sourceDegree);

    const targetDegree = includedDegree.get(edge.target) ?? { incoming: 0, outgoing: 0 };
    targetDegree.incoming++;
    includedDegree.set(edge.target, targetDegree);
  }

  const nodes: VisualizationNode[] = selected.map((node) => {
    const nodeDegree = includedDegree.get(node.id) ?? { incoming: 0, outgoing: 0 };
    const totalDegree = nodeDegree.incoming + nodeDegree.outgoing;
    return {
      id: node.id,
      label: node.name || node.qualifiedName || node.filePath,
      kind: node.kind,
      qualifiedName: node.qualifiedName,
      filePath: node.filePath,
      language: node.language,
      line: node.startLine,
      signature: node.signature,
      exported: node.isExported === true,
      root: rootIdSet.has(node.id),
      incoming: nodeDegree.incoming,
      outgoing: nodeDegree.outgoing,
      size: Math.min(22, 6 + Math.sqrt(totalDegree + 1) * 2 + (rootIdSet.has(node.id) ? 4 : 0)),
    };
  });

  return {
    title: args.title,
    projectRoot: args.projectRoot,
    mode: args.mode,
    query: args.query,
    generatedAt: Date.now(),
    nodes,
    edges: edges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      kind: edge.kind,
      line: edge.line,
      provenance: edge.provenance,
    })),
    rootIds,
    stats: {
      totalNodes: args.totalNodes ?? originalNodes.length,
      totalEdges: args.totalEdges ?? originalEdges.length,
      includedNodes: nodes.length,
      includedEdges: edges.length,
      truncated: originalNodes.length > nodes.length || originalEdges.length > edges.length,
    },
  };
}

export function buildVisualizationGraph(
  source: VisualizationDataSource,
  options: BuildVisualizationOptions
): VisualizationGraph {
  const limit = clampInt(options.limit, DEFAULT_VISUALIZATION_LIMIT, 1, 2000);
  const depth = clampInt(options.depth, DEFAULT_VISUALIZATION_DEPTH, 1, 10);
  const direction = options.direction ?? 'both';
  const nodeKinds = options.nodeKinds?.length
    ? options.nodeKinds
    : DEFAULT_VISUALIZATION_NODE_KINDS;
  const edgeKinds = options.edgeKinds?.length
    ? options.edgeKinds
    : DEFAULT_VISUALIZATION_EDGE_KINDS;
  const stats = source.getStats();

  if (options.symbol) {
    const subgraph = buildSymbolSubgraph(source, options.symbol, {
      limit,
      depth,
      direction,
      nodeKinds,
      edgeKinds,
    });

    return buildVisualizationGraphFromSubgraph({
      subgraph,
      projectRoot: options.projectRoot,
      title: `CodeGraph: ${options.symbol}`,
      mode: 'symbol',
      query: options.symbol,
      limit,
      totalNodes: stats.nodeCount,
      totalEdges: stats.edgeCount,
    });
  }

  const subgraph = buildOverviewSubgraph(source, {
    limit,
    nodeKinds,
    edgeKinds,
  });

  return buildVisualizationGraphFromSubgraph({
    subgraph,
    projectRoot: options.projectRoot,
    title: 'CodeGraph project map',
    mode: 'overview',
    limit,
    totalNodes: stats.nodeCount,
    totalEdges: stats.edgeCount,
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function serializeForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function isNodeKind(value: string): value is NodeKind {
  return (NODE_KINDS as readonly string[]).includes(value);
}

export function isEdgeKind(value: string): value is EdgeKind {
  return (EDGE_KINDS as readonly string[]).includes(value);
}

function renderStatValue(count: number): string {
  return count.toLocaleString();
}

export function renderVisualizationHtml(graph: VisualizationGraph): string {
  const title = escapeHtml(graph.title);
  const dataJson = serializeForInlineScript(graph);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --ink: #20242a;
      --muted: #69717d;
      --line: #d9dde4;
      --accent: #2266aa;
      --soft: #eef2f6;
      --surface: #fbfcfd;
    }

    * { box-sizing: border-box; }
    html, body { height: 100%; }
    body {
      margin: 0;
      color: var(--ink);
      background: var(--bg);
      font: 14px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow: hidden;
    }

    .app {
      display: grid;
      grid-template-columns: minmax(270px, 330px) minmax(0, 1fr) minmax(270px, 340px);
      height: 100vh;
      min-height: 560px;
    }

    .panel, .details {
      min-width: 0;
      overflow: auto;
      background: var(--panel);
      border-color: var(--line);
      padding: 18px;
    }

    .panel { border-right: 1px solid var(--line); }
    .details { border-left: 1px solid var(--line); }

    .stage {
      position: relative;
      min-width: 0;
      background:
        linear-gradient(rgba(32, 36, 42, 0.026) 1px, transparent 1px),
        linear-gradient(90deg, rgba(32, 36, 42, 0.026) 1px, transparent 1px),
        var(--surface);
      background-size: 34px 34px;
    }

    #graph {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: block;
      touch-action: none;
      cursor: grab;
    }

    #graph.dragging { cursor: grabbing; }

    .brand {
      display: flex;
      gap: 12px;
      align-items: center;
      margin-bottom: 16px;
    }

    .mark {
      width: 36px;
      height: 36px;
      border-radius: 8px;
      background: conic-gradient(from 30deg, #2266aa, #277a58, #c69232, #c75136, #2266aa);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,0.65);
      flex: none;
    }

    h1 {
      margin: 0;
      font-size: 18px;
      line-height: 1.2;
      overflow-wrap: anywhere;
    }

    h2 {
      margin: 18px 0 8px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    p { margin: 0; color: var(--muted); }
    .meta { font-size: 12px; overflow-wrap: anywhere; }

    .stats {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin: 16px 0;
    }

    .stat {
      min-width: 0;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }

    .stat strong {
      display: block;
      font-size: 18px;
      line-height: 1.1;
    }

    .stat span {
      color: var(--muted);
      font-size: 12px;
    }

    label.search span,
    .range span {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 6px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }

    input[type="search"] {
      width: 100%;
      height: 36px;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 0 10px;
      color: var(--ink);
      background: #fff;
      outline: none;
    }

    input[type="search"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(34, 102, 170, 0.14);
    }

    .range {
      display: block;
      margin-top: 12px;
    }

    .range strong {
      color: var(--ink);
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }

    input[type="range"] {
      width: 100%;
      accent-color: var(--accent);
    }

    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 8px;
      margin-top: 10px;
    }

    button {
      height: 34px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #fff;
      color: var(--ink);
      font: inherit;
      cursor: pointer;
    }

    button:hover { border-color: var(--accent); color: var(--accent); }

    .filters {
      display: grid;
      gap: 6px;
    }

    .check {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      min-width: 0;
      padding: 7px 8px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--surface);
    }

    .check > span {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .swatch {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      flex: none;
      background: var(--accent);
    }

    .check small { color: var(--muted); }
    .check input { width: 16px; height: 16px; flex: none; }

    .hint {
      margin-top: 10px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--soft);
      color: var(--muted);
      font-size: 12px;
    }

    .detail-empty {
      min-height: 120px;
      display: grid;
      place-items: center;
      color: var(--muted);
      border: 1px dashed var(--line);
      border-radius: 8px;
      text-align: center;
      padding: 16px;
    }

    .detail-title {
      display: flex;
      gap: 10px;
      align-items: center;
      min-width: 0;
    }

    .detail-title strong {
      font-size: 17px;
      overflow-wrap: anywhere;
    }

    .pill {
      display: inline-flex;
      align-items: center;
      max-width: 100%;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 3px 8px;
      color: var(--muted);
      background: var(--surface);
      font-size: 12px;
      overflow-wrap: anywhere;
    }

    .detail-grid {
      display: grid;
      gap: 8px;
      margin-top: 14px;
    }

    .detail-row {
      display: grid;
      grid-template-columns: 86px minmax(0, 1fr);
      gap: 10px;
      padding: 8px 0;
      border-bottom: 1px solid var(--line);
    }

    .detail-row span:first-child {
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
    }

    .detail-row span:last-child { overflow-wrap: anywhere; }

    .connection {
      display: grid;
      grid-template-columns: 70px minmax(0, 1fr);
      gap: 8px;
      padding: 7px 0;
      border-bottom: 1px solid var(--line);
    }

    .connection strong {
      color: var(--muted);
      font-size: 12px;
    }

    .connection span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    @media (max-width: 980px) {
      body { overflow: auto; }
      .app {
        grid-template-columns: 1fr;
        grid-template-rows: auto minmax(560px, 72vh) auto;
        height: auto;
        min-height: 100vh;
      }
      .panel, .details {
        border: 0;
        border-bottom: 1px solid var(--line);
      }
      .details { border-top: 1px solid var(--line); }
      .stats { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    }

    @media (max-width: 620px) {
      .stats { grid-template-columns: 1fr 1fr; }
      .actions { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="app">
    <aside class="panel">
      <div class="brand">
        <div class="mark" aria-hidden="true"></div>
        <div>
          <h1>${title}</h1>
          <p class="meta" id="projectRoot"></p>
        </div>
      </div>
      <div class="stats">
        <div class="stat"><strong id="visibleNodeCount">0</strong><span>visible nodes</span></div>
        <div class="stat"><strong id="visibleEdgeCount">0</strong><span>visible edges</span></div>
        <div class="stat"><strong id="totalNodeCount">${renderStatValue(graph.stats.totalNodes)}</strong><span>indexed nodes</span></div>
        <div class="stat"><strong id="totalEdgeCount">${renderStatValue(graph.stats.totalEdges)}</strong><span>indexed edges</span></div>
      </div>
      <label class="search">
        <span>Search</span>
        <input id="search" type="search" autocomplete="off" placeholder="name, file, kind">
      </label>
      <label class="range">
        <span>Gravity <strong id="gravityValue">18</strong></span>
        <input id="gravitySlider" type="range" min="0" max="140" value="18">
      </label>
      <label class="range">
        <span>Repulsion <strong id="repulsionValue">1500</strong></span>
        <input id="repulsionSlider" type="range" min="250" max="4200" value="1500">
      </label>
      <label class="range">
        <span>Link <strong id="linkValue">165</strong></span>
        <input id="linkSlider" type="range" min="70" max="900" value="165">
      </label>
      <div class="actions">
        <button id="fit" type="button">Fit</button>
        <button id="spread" type="button">Spread</button>
        <button id="animate" type="button">Pause</button>
        <button id="cluster" type="button">Cluster</button>
        <button id="expand" type="button">Expand</button>
        <button id="reset" type="button">Reset</button>
      </div>
      <p class="hint">Gravity pulls nodes toward the center. Lower it to let the graph breathe; raise it to make related regions aggregate.</p>
      <h2>Nodes</h2>
      <div id="nodeFilters" class="filters"></div>
      <h2>Edges</h2>
      <div id="edgeFilters" class="filters"></div>
    </aside>

    <main class="stage">
      <canvas id="graph" aria-label="CodeGraph visualization"></canvas>
    </main>

    <aside class="details">
      <div id="detailEmpty" class="detail-empty">Select a node or file cluster</div>
      <div id="detailContent" hidden>
        <div class="detail-title">
          <span id="detailSwatch" class="swatch"></span>
          <strong id="detailName"></strong>
        </div>
        <div style="margin-top: 10px;"><span id="detailKind" class="pill"></span></div>
        <div class="detail-grid" id="detailGrid"></div>
        <h2>Connections</h2>
        <div id="connections"></div>
      </div>
      <h2>Generated</h2>
      <p class="meta" id="generatedAt"></p>
      <p class="meta" id="truncatedNote" style="margin-top: 8px;"></p>
    </aside>
  </div>

  <script>
    const GRAPH_DATA = ${dataJson};
    (function () {
      const colors = {
        file: '#64748b',
        module: '#2266aa',
        namespace: '#2266aa',
        class: '#7b4ea3',
        struct: '#7b4ea3',
        interface: '#9a5a2f',
        trait: '#9a5a2f',
        protocol: '#9a5a2f',
        enum: '#c75136',
        type_alias: '#c69232',
        function: '#277a58',
        method: '#118ab2',
        route: '#d64f3f',
        component: '#d7872f',
        property: '#6d7785',
        field: '#6d7785',
        variable: '#6d7785',
        constant: '#6d7785',
        import: '#89919c',
        export: '#89919c',
        parameter: '#a2a8b1',
        enum_member: '#a2a8b1',
        fileCluster: '#334155'
      };
      const edgeColors = {
        calls: '#2266aa',
        imports: '#277a58',
        extends: '#7b4ea3',
        implements: '#7b4ea3',
        contains: '#9aa1aa',
        references: '#c69232',
        instantiates: '#c75136',
        exports: '#5f6b7a',
        type_of: '#9a5a2f',
        returns: '#9a5a2f',
        overrides: '#7b4ea3',
        decorates: '#d7872f'
      };

      const canvas = document.getElementById('graph');
      const ctx = canvas.getContext('2d');
      const searchInput = document.getElementById('search');
      const nodeFilters = document.getElementById('nodeFilters');
      const edgeFilters = document.getElementById('edgeFilters');
      const detailEmpty = document.getElementById('detailEmpty');
      const detailContent = document.getElementById('detailContent');
      const detailGrid = document.getElementById('detailGrid');
      const connections = document.getElementById('connections');
      const visibleNodeCount = document.getElementById('visibleNodeCount');
      const visibleEdgeCount = document.getElementById('visibleEdgeCount');
      const projectRoot = document.getElementById('projectRoot');
      const generatedAt = document.getElementById('generatedAt');
      const truncatedNote = document.getElementById('truncatedNote');
      const detailSwatch = document.getElementById('detailSwatch');
      const detailName = document.getElementById('detailName');
      const detailKind = document.getElementById('detailKind');
      const animateButton = document.getElementById('animate');
      const gravitySlider = document.getElementById('gravitySlider');
      const repulsionSlider = document.getElementById('repulsionSlider');
      const linkSlider = document.getElementById('linkSlider');
      const gravityValue = document.getElementById('gravityValue');
      const repulsionValue = document.getElementById('repulsionValue');
      const linkValue = document.getElementById('linkValue');
      const rawNodes = GRAPH_DATA.nodes;
      const rawEdges = GRAPH_DATA.edges.map(function (edge, index) {
        return Object.assign({ id: 'edge:' + index }, edge);
      });
      const rawNodeById = new Map(rawNodes.map(function (node) { return [node.id, node]; }));
      const activeNodeKinds = new Set(unique(rawNodes.map(function (node) { return node.kind; })));
      const activeEdgeKinds = new Set(unique(rawEdges.map(function (edge) { return edge.kind; })));
      const positions = new Map();
      let renderNodes = [];
      let renderEdges = [];
      let renderNodeById = new Map();
      let clusterByNode = new Map();
      let selectedId = null;
      let hoverId = null;
      let query = '';
      let clustered = rawNodes.length > 45;
      let expandedFiles = new Set();
      let animationEnabled = true;
      let width = 1000;
      let height = 700;
      let dpr = 1;
      let zoom = 1;
      let panX = 0;
      let panY = 0;
      let draggingNode = null;
      let panning = false;
      let pointerDown = null;
      let movedPointer = false;
      let lastTime = 0;
      let settleFrames = 160;

      const state = {
        gravity: Number(gravitySlider.value),
        repulsion: Number(repulsionSlider.value),
        linkLength: Number(linkSlider.value)
      };

      function unique(values) {
        return Array.from(new Set(values));
      }

      function text(value) {
        return value == null ? '' : String(value);
      }

      function basename(filePath) {
        const parts = String(filePath).split('/');
        return parts[parts.length - 1] || filePath;
      }

      function colorFor(kind) {
        return colors[kind] || '#5f6b7a';
      }

      function edgeColorFor(kind) {
        return edgeColors[kind] || '#8b949e';
      }

      function countsBy(values) {
        const counts = new Map();
        values.forEach(function (value) {
          counts.set(value, (counts.get(value) || 0) + 1);
        });
        return counts;
      }

      function hashString(value) {
        let hash = 0;
        for (let i = 0; i < value.length; i++) {
          hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
        }
        return hash;
      }

      function nodeMatches(node) {
        if (!activeNodeKinds.has(node.kind)) return false;
        if (!query) return true;
        const haystack = [
          node.label,
          node.kind,
          node.qualifiedName,
          node.filePath,
          node.language,
          node.signature
        ].map(text).join(' ').toLowerCase();
        return haystack.indexOf(query) !== -1;
      }

      function createFilter(containerEl, values, activeSet, counts, colorFn) {
        values.sort().forEach(function (value) {
          const label = document.createElement('label');
          label.className = 'check';
          const left = document.createElement('span');
          const swatch = document.createElement('i');
          swatch.className = 'swatch';
          swatch.style.background = colorFn(value);
          const name = document.createElement('span');
          name.textContent = value;
          left.appendChild(swatch);
          left.appendChild(name);
          const right = document.createElement('span');
          const count = document.createElement('small');
          count.textContent = text(counts.get(value) || 0);
          const input = document.createElement('input');
          input.type = 'checkbox';
          input.checked = true;
          input.addEventListener('change', function () {
            if (input.checked) activeSet.add(value);
            else activeSet.delete(value);
            rebuildGraph();
          });
          right.appendChild(count);
          right.appendChild(input);
          label.appendChild(left);
          label.appendChild(right);
          containerEl.appendChild(label);
        });
      }

      function rememberPositions() {
        renderNodes.forEach(function (node) {
          positions.set(node.id, { x: node.x, y: node.y });
        });
      }

      function seedPosition(id, index, radius) {
        const saved = positions.get(id);
        if (saved) return { x: saved.x, y: saved.y };
        const hash = Math.abs(hashString(id));
        const angle = (hash % 6283) / 1000;
        const ring = radius + (index % 9) * 18;
        return {
          x: Math.cos(angle) * ring,
          y: Math.sin(angle) * ring
        };
      }

      function makeRenderNode(base, index) {
        const degree = (base.incoming || 0) + (base.outgoing || 0);
        const radius = Math.max(6, Math.min(24, base.size || 9));
        const pos = seedPosition(base.id, index, 190 + Math.sqrt(rawNodes.length) * 22);
        return {
          id: base.id,
          label: base.label,
          kind: base.kind,
          filePath: base.filePath,
          language: base.language,
          line: base.line,
          qualifiedName: base.qualifiedName,
          signature: base.signature,
          exported: base.exported,
          root: base.root,
          incoming: base.incoming,
          outgoing: base.outgoing,
          cluster: false,
          memberIds: [],
          memberCount: 1,
          edgeCount: degree,
          radius,
          mass: 1 + degree / 14,
          x: pos.x,
          y: pos.y,
          vx: 0,
          vy: 0,
          fixed: false
        };
      }

      function makeClusterNode(filePath, members, index) {
        const id = 'cluster:' + filePath;
        const saved = positions.get(id);
        let x = 0;
        let y = 0;
        if (saved) {
          x = saved.x;
          y = saved.y;
        } else {
          let count = 0;
          members.forEach(function (member) {
            const pos = positions.get(member.id);
            if (pos) {
              x += pos.x;
              y += pos.y;
              count++;
            }
          });
          if (count > 0) {
            x /= count;
            y /= count;
          } else {
            const seeded = seedPosition(id, index, 230 + Math.sqrt(rawNodes.length) * 26);
            x = seeded.x;
            y = seeded.y;
          }
        }
        const edgeCount = rawEdges.filter(function (edge) {
          return members.some(function (member) {
            return edge.source === member.id || edge.target === member.id;
          });
        }).length;
        const radius = Math.min(34, 13 + Math.sqrt(members.length) * 4.8);
        return {
          id,
          label: basename(filePath),
          kind: 'fileCluster',
          filePath,
          language: '',
          line: 1,
          qualifiedName: filePath,
          signature: undefined,
          exported: false,
          root: members.some(function (member) { return member.root; }),
          incoming: 0,
          outgoing: 0,
          cluster: true,
          memberIds: members.map(function (member) { return member.id; }),
          memberCount: members.length,
          edgeCount,
          radius,
          mass: 1.7 + members.length / 7,
          x,
          y,
          vx: 0,
          vy: 0,
          fixed: false
        };
      }

      function rebuildGraph() {
        rememberPositions();
        query = searchInput.value.trim().toLowerCase();
        const visibleBase = rawNodes.filter(nodeMatches);
        const visibleIds = new Set(visibleBase.map(function (node) { return node.id; }));
        const groups = new Map();
        visibleBase.forEach(function (node) {
          if (node.kind === 'file') return;
          const list = groups.get(node.filePath) || [];
          list.push(node);
          groups.set(node.filePath, list);
        });

        const clusterFiles = new Set();
        if (clustered && !query) {
          groups.forEach(function (members, filePath) {
            if (members.length >= 3 && !expandedFiles.has(filePath)) clusterFiles.add(filePath);
          });
        }

        clusterByNode = new Map();
        renderNodes = [];
        visibleBase.forEach(function (node) {
          if (clusterFiles.has(node.filePath)) {
            clusterByNode.set(node.id, 'cluster:' + node.filePath);
            return;
          }
          renderNodes.push(makeRenderNode(node, renderNodes.length));
        });
        clusterFiles.forEach(function (filePath) {
          const members = groups.get(filePath) || [];
          members.forEach(function (member) {
            clusterByNode.set(member.id, 'cluster:' + filePath);
          });
          renderNodes.push(makeClusterNode(filePath, members, renderNodes.length));
        });

        renderNodeById = new Map(renderNodes.map(function (node) { return [node.id, node]; }));
        const edgeMap = new Map();
        rawEdges.forEach(function (edge) {
          if (!activeEdgeKinds.has(edge.kind)) return;
          if (!visibleIds.has(edge.source) || !visibleIds.has(edge.target)) return;
          const source = clusterByNode.get(edge.source) || edge.source;
          const target = clusterByNode.get(edge.target) || edge.target;
          if (source === target) return;
          if (!renderNodeById.has(source) || !renderNodeById.has(target)) return;
          const key = source + '>' + target + ':' + edge.kind;
          const existing = edgeMap.get(key);
          if (existing) {
            existing.count++;
          } else {
            edgeMap.set(key, { source, target, kind: edge.kind, count: 1 });
          }
        });
        renderEdges = Array.from(edgeMap.values());
        visibleNodeCount.textContent = String(renderNodes.length);
        visibleEdgeCount.textContent = String(renderEdges.length);
        if (selectedId && !renderNodeById.has(selectedId)) clearSelection();
        settleFrames = 160;
      }

      function resizeCanvas() {
        const rect = canvas.getBoundingClientRect();
        width = Math.max(320, rect.width || width);
        height = Math.max(360, rect.height || height);
        dpr = Math.max(1, window.devicePixelRatio || 1);
        canvas.width = Math.floor(width * dpr);
        canvas.height = Math.floor(height * dpr);
        canvas.style.width = width + 'px';
        canvas.style.height = height + 'px';
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }

      function worldToScreen(x, y) {
        return { x: x * zoom + panX, y: y * zoom + panY };
      }

      function screenToWorld(x, y) {
        return { x: (x - panX) / zoom, y: (y - panY) / zoom };
      }

      function pointerPoint(event) {
        const rect = canvas.getBoundingClientRect();
        return { x: event.clientX - rect.left, y: event.clientY - rect.top };
      }

      function hitTest(screenX, screenY) {
        const point = screenToWorld(screenX, screenY);
        for (let i = renderNodes.length - 1; i >= 0; i--) {
          const node = renderNodes[i];
          const dx = point.x - node.x;
          const dy = point.y - node.y;
          const hitRadius = node.radius + 8 / zoom;
          if (dx * dx + dy * dy <= hitRadius * hitRadius) return node;
        }
        return null;
      }

      function fitGraph() {
        if (renderNodes.length === 0) return;
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        renderNodes.forEach(function (node) {
          minX = Math.min(minX, node.x - node.radius);
          minY = Math.min(minY, node.y - node.radius);
          maxX = Math.max(maxX, node.x + node.radius);
          maxY = Math.max(maxY, node.y + node.radius);
        });
        const graphW = Math.max(1, maxX - minX);
        const graphH = Math.max(1, maxY - minY);
        zoom = Math.min(2.4, Math.max(0.16, Math.min(width / graphW, height / graphH) * 0.78));
        panX = width / 2 - ((minX + maxX) / 2) * zoom;
        panY = height / 2 - ((minY + maxY) / 2) * zoom;
      }

      function spreadGraph() {
        if (renderNodes.length === 0) return;
        const count = Math.max(1, renderNodes.length);
        const baseRadius = Math.max(260, Math.sqrt(count) * 72);
        renderNodes.forEach(function (node, index) {
          const hash = Math.abs(hashString(node.id));
          const angle = (hash % 6283) / 1000;
          const ring = baseRadius * (0.45 + ((index % 11) / 10) * 0.72);
          const jitter = 1 + ((hash % 31) - 15) / 120;
          node.x = Math.cos(angle) * ring * jitter;
          node.y = Math.sin(angle) * ring * jitter;
          node.vx = Math.cos(angle) * 2.4;
          node.vy = Math.sin(angle) * 2.4;
          positions.set(node.id, { x: node.x, y: node.y });
        });
        settleFrames = 180;
      }

      function stepPhysics(dt) {
        if (renderNodes.length === 0) return;
        const scale = Math.min(2, Math.max(0.2, dt / 16.67));
        const centerForce = state.gravity * 0.0000034 * scale;
        const springForce = 0.0033 * scale;
        const repelBase = state.repulsion * 0.038 * scale;

        renderEdges.forEach(function (edge) {
          const source = renderNodeById.get(edge.source);
          const target = renderNodeById.get(edge.target);
          if (!source || !target) return;
          let dx = target.x - source.x;
          let dy = target.y - source.y;
          let dist = Math.sqrt(dx * dx + dy * dy);
          if (dist < 0.01) {
            dx = 0.1;
            dy = 0.1;
            dist = 0.14;
          }
          const ideal = state.linkLength * (edge.kind === 'contains' ? 0.72 : edge.kind === 'imports' ? 1.25 : 1);
          const force = (dist - ideal) * springForce * Math.min(3, edge.count);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!source.fixed) {
            source.vx += fx / source.mass;
            source.vy += fy / source.mass;
          }
          if (!target.fixed) {
            target.vx -= fx / target.mass;
            target.vy -= fy / target.mass;
          }
        });

        for (let i = 0; i < renderNodes.length; i++) {
          const a = renderNodes[i];
          for (let j = i + 1; j < renderNodes.length; j++) {
            const b = renderNodes[j];
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            let distSq = dx * dx + dy * dy;
            if (distSq < 0.01) {
              dx = 0.1;
              dy = 0.1;
              distSq = 0.02;
            }
            const dist = Math.sqrt(distSq);
            const minDist = a.radius + b.radius + 12;
            const overlap = dist < minDist ? (minDist - dist) * 0.028 : 0;
            const repel = Math.min(8.5, repelBase * Math.sqrt(a.mass * b.mass) / Math.max(55, distSq)) + overlap;
            const fx = (dx / dist) * repel;
            const fy = (dy / dist) * repel;
            if (!a.fixed) {
              a.vx -= fx / a.mass;
              a.vy -= fy / a.mass;
            }
            if (!b.fixed) {
              b.vx += fx / b.mass;
              b.vy += fy / b.mass;
            }
          }
        }

        renderNodes.forEach(function (node) {
          if (!node.fixed) {
            node.vx += -node.x * centerForce;
            node.vy += -node.y * centerForce;
            const speed = Math.sqrt(node.vx * node.vx + node.vy * node.vy);
            const maxSpeed = 18;
            if (speed > maxSpeed) {
              node.vx = (node.vx / speed) * maxSpeed;
              node.vy = (node.vy / speed) * maxSpeed;
            }
            node.x += node.vx * scale;
            node.y += node.vy * scale;
            const damping = Math.pow(0.86, scale);
            node.vx *= damping;
            node.vy *= damping;
          }
          positions.set(node.id, { x: node.x, y: node.y });
        });
      }

      function drawGrid() {
        const grid = 34 * zoom;
        if (grid < 12) return;
        ctx.save();
        ctx.strokeStyle = 'rgba(32,36,42,0.045)';
        ctx.lineWidth = 1;
        const offsetX = panX % grid;
        const offsetY = panY % grid;
        for (let x = offsetX; x < width; x += grid) {
          ctx.beginPath();
          ctx.moveTo(x, 0);
          ctx.lineTo(x, height);
          ctx.stroke();
        }
        for (let y = offsetY; y < height; y += grid) {
          ctx.beginPath();
          ctx.moveTo(0, y);
          ctx.lineTo(width, y);
          ctx.stroke();
        }
        ctx.restore();
      }

      function drawArrow(from, to, color) {
        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        const ux = dx / dist;
        const uy = dy / dist;
        const tipX = to.x - ux * (to.radius + 2);
        const tipY = to.y - uy * (to.radius + 2);
        const size = 6 / zoom;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(tipX - ux * size - uy * size * 0.62, tipY - uy * size + ux * size * 0.62);
        ctx.lineTo(tipX - ux * size + uy * size * 0.62, tipY - uy * size - ux * size * 0.62);
        ctx.closePath();
        ctx.fill();
      }

      function drawLabel(node) {
        const shouldDraw =
          zoom > 0.72 ||
          node.cluster ||
          node.root ||
          node.id === selectedId ||
          node.id === hoverId;
        if (!shouldDraw) return;
        const label = node.cluster ? node.label + '\\n' + node.memberCount + ' symbols' : node.label;
        const lines = label.split('\\n').slice(0, 2);
        const fontSize = Math.max(10, Math.min(15, 12 + zoom * 1.5));
        ctx.font = '600 ' + fontSize + 'px Segoe UI, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        lines.forEach(function (line, index) {
          const y = node.y + node.radius + 5 / zoom + (index * (fontSize + 1)) / zoom;
          ctx.lineWidth = 4 / zoom;
          ctx.strokeStyle = 'rgba(255,255,255,0.92)';
          ctx.fillStyle = '#20242a';
          ctx.strokeText(line, node.x, y);
          ctx.fillText(line, node.x, y);
        });
      }

      function draw() {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, width, height);
        drawGrid();
        ctx.save();
        ctx.translate(panX, panY);
        ctx.scale(zoom, zoom);

        renderEdges.forEach(function (edge) {
          const source = renderNodeById.get(edge.source);
          const target = renderNodeById.get(edge.target);
          if (!source || !target) return;
          const color = edgeColorFor(edge.kind);
          ctx.globalAlpha = edge.kind === 'contains' ? 0.32 : 0.48;
          ctx.strokeStyle = color;
          ctx.lineWidth = (edge.kind === 'calls' ? 1.8 : 1.1) / zoom + Math.min(1.6, edge.count * 0.14);
          ctx.setLineDash(edge.kind === 'contains' ? [4 / zoom, 5 / zoom] : []);
          ctx.beginPath();
          ctx.moveTo(source.x, source.y);
          ctx.lineTo(target.x, target.y);
          ctx.stroke();
          ctx.setLineDash([]);
          if (edge.kind !== 'contains' && zoom > 0.45) drawArrow(source, target, color);
          ctx.globalAlpha = 1;
        });

        renderNodes.forEach(function (node) {
          const selected = node.id === selectedId;
          const hovered = node.id === hoverId;
          const color = node.cluster ? colorFor('fileCluster') : colorFor(node.kind);
          ctx.save();
          ctx.shadowColor = 'rgba(32,36,42,0.16)';
          ctx.shadowBlur = selected || hovered ? 14 / zoom : 8 / zoom;
          ctx.shadowOffsetY = 2 / zoom;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();

          ctx.lineWidth = (selected || hovered || node.root ? 3 : 2) / zoom;
          ctx.strokeStyle = selected || hovered ? '#20242a' : '#ffffff';
          ctx.beginPath();
          ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
          ctx.stroke();

          if (node.cluster) {
            ctx.globalAlpha = 0.45;
            ctx.lineWidth = 1.5 / zoom;
            ctx.strokeStyle = '#ffffff';
            ctx.beginPath();
            ctx.arc(node.x, node.y, Math.max(3, node.radius - 6 / zoom), 0, Math.PI * 2);
            ctx.stroke();
            ctx.globalAlpha = 1;
          }
        });

        renderNodes.forEach(drawLabel);
        ctx.restore();
      }

      function frame(time) {
        const dt = lastTime ? time - lastTime : 16.67;
        lastTime = time;
        if (animationEnabled || settleFrames > 0 || draggingNode) {
          stepPhysics(dt);
          if (!animationEnabled && settleFrames > 0) settleFrames--;
        }
        draw();
        requestAnimationFrame(frame);
      }

      function setAnimation(enabled) {
        animationEnabled = enabled;
        animateButton.textContent = enabled ? 'Pause' : 'Animate';
        settleFrames = enabled ? 160 : 0;
      }

      function addDetail(label, value) {
        const row = document.createElement('div');
        row.className = 'detail-row';
        const key = document.createElement('span');
        const val = document.createElement('span');
        key.textContent = label;
        val.textContent = value;
        row.appendChild(key);
        row.appendChild(val);
        detailGrid.appendChild(row);
      }

      function showConnections(node) {
        connections.replaceChildren();
        if (node.cluster) {
          const note = document.createElement('p');
          note.className = 'meta';
          note.textContent = 'Double-click this cluster to expand the symbols in this file.';
          connections.appendChild(note);
          return;
        }
        const related = rawEdges.filter(function (edge) {
          return edge.source === node.id || edge.target === node.id;
        }).slice(0, 24);
        if (related.length === 0) {
          const empty = document.createElement('p');
          empty.className = 'meta';
          empty.textContent = 'No visible connections.';
          connections.appendChild(empty);
          return;
        }
        related.forEach(function (edge) {
          const row = document.createElement('div');
          row.className = 'connection';
          const kind = document.createElement('strong');
          const target = document.createElement('span');
          const otherId = edge.source === node.id ? edge.target : edge.source;
          const other = rawNodeById.get(otherId);
          kind.textContent = edge.source === node.id ? edge.kind + ' ->' : '<- ' + edge.kind;
          target.textContent = other ? other.label + ' (' + other.filePath + ':' + other.line + ')' : otherId;
          row.appendChild(kind);
          row.appendChild(target);
          connections.appendChild(row);
        });
      }

      function selectNode(node) {
        if (!node) {
          clearSelection();
          return;
        }
        selectedId = node.id;
        detailEmpty.hidden = true;
        detailContent.hidden = false;
        detailGrid.replaceChildren();
        connections.replaceChildren();
        detailSwatch.style.background = node.cluster ? colorFor('fileCluster') : colorFor(node.kind);
        detailName.textContent = node.label;
        detailKind.textContent = node.cluster ? 'file cluster' : node.kind + ' - ' + node.language;
        addDetail('File', node.cluster ? node.filePath : node.filePath + ':' + node.line);
        if (node.cluster) {
          addDetail('Symbols', String(node.memberCount));
          addDetail('Edges', String(node.edgeCount));
        } else {
          addDetail('Name', node.qualifiedName);
          if (node.signature) addDetail('Signature', node.signature);
          addDetail('Degree', node.incoming + ' in / ' + node.outgoing + ' out');
          addDetail('Exported', node.exported ? 'yes' : 'no');
        }
        showConnections(node);
      }

      function clearSelection() {
        selectedId = null;
        detailEmpty.hidden = false;
        detailContent.hidden = true;
      }

      function updateSliderLabels() {
        gravityValue.textContent = String(state.gravity);
        repulsionValue.textContent = String(state.repulsion);
        linkValue.textContent = String(state.linkLength);
      }

      projectRoot.textContent = GRAPH_DATA.projectRoot;
      generatedAt.textContent = new Date(GRAPH_DATA.generatedAt).toLocaleString();
      truncatedNote.textContent = GRAPH_DATA.stats.truncated
        ? 'Showing ' + GRAPH_DATA.stats.includedNodes + ' of ' + GRAPH_DATA.stats.totalNodes + ' nodes.'
        : 'Full selected graph included.';

      createFilter(
        nodeFilters,
        unique(rawNodes.map(function (node) { return node.kind; })),
        activeNodeKinds,
        countsBy(rawNodes.map(function (node) { return node.kind; })),
        colorFor
      );
      createFilter(
        edgeFilters,
        unique(rawEdges.map(function (edge) { return edge.kind; })),
        activeEdgeKinds,
        countsBy(rawEdges.map(function (edge) { return edge.kind; })),
        edgeColorFor
      );

      searchInput.addEventListener('input', rebuildGraph);
      gravitySlider.addEventListener('input', function () {
        state.gravity = Number(gravitySlider.value);
        updateSliderLabels();
        settleFrames = 120;
      });
      repulsionSlider.addEventListener('input', function () {
        state.repulsion = Number(repulsionSlider.value);
        updateSliderLabels();
        settleFrames = 120;
      });
      linkSlider.addEventListener('input', function () {
        state.linkLength = Number(linkSlider.value);
        updateSliderLabels();
        settleFrames = 120;
      });

      document.getElementById('fit').addEventListener('click', fitGraph);
      document.getElementById('spread').addEventListener('click', function () {
        spreadGraph();
        fitGraph();
      });
      animateButton.addEventListener('click', function () {
        setAnimation(!animationEnabled);
      });
      document.getElementById('cluster').addEventListener('click', function () {
        clustered = true;
        expandedFiles = new Set();
        rebuildGraph();
        fitGraph();
      });
      document.getElementById('expand').addEventListener('click', function () {
        clustered = false;
        expandedFiles = new Set();
        rebuildGraph();
        fitGraph();
      });
      document.getElementById('reset').addEventListener('click', function () {
        searchInput.value = '';
        gravitySlider.value = '18';
        repulsionSlider.value = '1500';
        linkSlider.value = '165';
        state.gravity = 18;
        state.repulsion = 1500;
        state.linkLength = 165;
        clustered = rawNodes.length > 45;
        expandedFiles = new Set();
        setAnimation(true);
        updateSliderLabels();
        clearSelection();
        rebuildGraph();
        spreadGraph();
        fitGraph();
      });

      canvas.addEventListener('pointerdown', function (event) {
        const point = pointerPoint(event);
        const hit = hitTest(point.x, point.y);
        pointerDown = point;
        movedPointer = false;
        if (hit) {
          draggingNode = hit;
          hit.fixed = true;
          selectNode(hit);
        } else {
          panning = true;
        }
        canvas.classList.add('dragging');
        canvas.setPointerCapture(event.pointerId);
      });

      canvas.addEventListener('pointermove', function (event) {
        const point = pointerPoint(event);
        const hit = hitTest(point.x, point.y);
        hoverId = hit ? hit.id : null;
        if (pointerDown) {
          const dx = point.x - pointerDown.x;
          const dy = point.y - pointerDown.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) movedPointer = true;
        }
        if (draggingNode) {
          const world = screenToWorld(point.x, point.y);
          draggingNode.x = world.x;
          draggingNode.y = world.y;
          draggingNode.vx = 0;
          draggingNode.vy = 0;
          positions.set(draggingNode.id, { x: draggingNode.x, y: draggingNode.y });
          settleFrames = 80;
        } else if (panning && pointerDown) {
          panX += point.x - pointerDown.x;
          panY += point.y - pointerDown.y;
          pointerDown = point;
        }
      });

      canvas.addEventListener('pointerup', function (event) {
        const point = pointerPoint(event);
        const hit = hitTest(point.x, point.y);
        if (!movedPointer && hit) selectNode(hit);
        if (!movedPointer && !hit) clearSelection();
        if (draggingNode) draggingNode.fixed = false;
        draggingNode = null;
        panning = false;
        pointerDown = null;
        canvas.classList.remove('dragging');
      });

      canvas.addEventListener('pointercancel', function () {
        if (draggingNode) draggingNode.fixed = false;
        draggingNode = null;
        panning = false;
        pointerDown = null;
        canvas.classList.remove('dragging');
      });

      canvas.addEventListener('dblclick', function (event) {
        const point = pointerPoint(event);
        const hit = hitTest(point.x, point.y);
        if (!hit) return;
        if (hit.cluster) {
          expandedFiles.add(hit.filePath);
          clustered = true;
          rebuildGraph();
        } else {
          zoom = Math.min(2.5, Math.max(zoom, 1.35));
          const screen = worldToScreen(hit.x, hit.y);
          panX += width / 2 - screen.x;
          panY += height / 2 - screen.y;
        }
      });

      canvas.addEventListener('wheel', function (event) {
        event.preventDefault();
        const point = pointerPoint(event);
        const before = screenToWorld(point.x, point.y);
        const scale = event.deltaY < 0 ? 1.12 : 0.89;
        zoom = Math.min(4, Math.max(0.12, zoom * scale));
        panX = point.x - before.x * zoom;
        panY = point.y - before.y * zoom;
      }, { passive: false });

      window.addEventListener('resize', function () {
        resizeCanvas();
        fitGraph();
      });

      updateSliderLabels();
      resizeCanvas();
      rebuildGraph();
      spreadGraph();
      fitGraph();
      requestAnimationFrame(frame);
    })();
  </script>
</body>
</html>
`;
}
