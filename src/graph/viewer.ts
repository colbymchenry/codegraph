/**
 * Graph Viewer
 *
 * Renders the CodeGraph index as an interactive, zoomable, searchable graph in
 * a single self-contained HTML file. CodeGraph is otherwise terminal/MCP-only;
 * this reads the same SQLite index the CLI reads and lays it out with
 * vis-network so a human can open it in a browser and see the codebase's shape.
 *
 * The vis-network library is bundled locally (assets/vis-network.min.js) and
 * inlined into the output, so the generated page works fully offline — no CDN,
 * matching CodeGraph's 100%-local design.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SqliteDatabase } from '../db/sqlite-adapter';

/** Distinct colors per node kind so the graph reads visually at a glance. */
const KIND_COLORS: Record<string, string> = {
  file: '#6b7280',
  module: '#6b7280',
  class: '#f59e0b',
  struct: '#f59e0b',
  interface: '#eab308',
  trait: '#eab308',
  protocol: '#eab308',
  function: '#3b82f6',
  method: '#2563eb',
  property: '#06b6d4',
  field: '#06b6d4',
  variable: '#10b981',
  constant: '#10b981',
  enum: '#a855f7',
  enum_member: '#a855f7',
  type_alias: '#8b5cf6',
  namespace: '#94a3b8',
  parameter: '#94a3b8',
  import: '#cbd5e1',
  export: '#cbd5e1',
  route: '#ef4444',
  component: '#ec4899',
};
const DEFAULT_COLOR = '#94a3b8';

/**
 * Edge kinds hidden by default because they're usually noise for a "look at my
 * architecture" view. Toggle back on with `includeImports`.
 */
const NOISY_EDGE_KINDS = ['imports', 'exports', 'references'];

export interface GraphViewOptions {
  /** Only show this symbol (by name or qualified name) and its 1-hop neighborhood. */
  symbol?: string;
  /** Only show symbols from files matching this substring, plus their 1-hop neighbors. */
  file?: string;
  /** Include import/export/reference edges (noisy on real repos, off by default). */
  includeImports?: boolean;
  /** Cap on nodes for whole-graph / file view (highest-degree kept). */
  maxNodes?: number;
}

export interface ViewNode {
  id: string;
  label: string;
  title: string;
  group: string;
  color: string;
  value: number;
  file: string;
}

export interface ViewEdge {
  from: string;
  to: string;
  label: string;
  arrows: string;
  title: string;
}

export interface GraphViewStats {
  totalNodes: number;
  totalEdges: number;
  kinds: string[];
}

export interface GraphViewData {
  nodes: ViewNode[];
  edges: ViewEdge[];
  stats: GraphViewStats;
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
}

/**
 * Thrown when a `--symbol` / `--file` filter matches nothing, so the command
 * can print a friendly hint instead of a stack trace.
 */
export class EmptyGraphViewError extends Error {}

/**
 * Assemble the node/edge/stat payload for the viewer straight from the SQLite
 * index. Mirrors the CLI's own querying style (raw prepared statements over the
 * `nodes`/`edges` tables) rather than the higher-level QueryBuilder, because the
 * whole-graph view needs a degree-ranked top-N that has no first-class query.
 */
export function buildGraphViewData(db: SqliteDatabase, options: GraphViewOptions): GraphViewData {
  const { symbol, file, includeImports = false, maxNodes = 250 } = options;

  // Edge-kind filters, parameterized. Built once and reused for the seed/neighbor
  // expansion and the final edge fetch.
  const edgeKindFilter = includeImports
    ? ''
    : `AND kind NOT IN (${NOISY_EDGE_KINDS.map(() => '?').join(',')})`;
  const edgeKindFilterQualified = includeImports
    ? ''
    : `AND e.kind NOT IN (${NOISY_EDGE_KINDS.map(() => '?').join(',')})`;
  const edgeKindParams = includeImports ? [] : [...NOISY_EDGE_KINDS];

  const nodeRows: NodeRow[] = [];
  const nodeIds = new Set<string>();

  if (symbol) {
    // Seed on a specific symbol, expand one hop out via edges.
    const seed = db
      .prepare('SELECT id FROM nodes WHERE name = ? OR qualified_name = ? LIMIT 1')
      .get(symbol, symbol) as { id: string } | undefined;
    if (!seed) {
      throw new EmptyGraphViewError(
        `No symbol found matching '${symbol}'. Try \`codegraph query "${symbol}"\` to check spelling.`
      );
    }
    const seedId = seed.id;
    nodeIds.add(seedId);
    const rows = db
      .prepare(
        `SELECT source, target FROM edges WHERE (source = ? OR target = ?) ${edgeKindFilter}`
      )
      .all(seedId, seedId, ...edgeKindParams) as EdgeRow[];
    for (const r of rows) {
      nodeIds.add(r.source);
      nodeIds.add(r.target);
    }
    const placeholders = [...nodeIds].map(() => '?').join(',');
    const rows2 = db
      .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
      .all(...nodeIds) as NodeRow[];
    nodeRows.push(...rows2);
  } else if (file) {
    const seededRows = db
      .prepare('SELECT * FROM nodes WHERE file_path LIKE ? LIMIT ?')
      .all(`%${file}%`, maxNodes) as NodeRow[];
    nodeRows.push(...seededRows);
    for (const r of seededRows) nodeIds.add(r.id);
    if (nodeIds.size > 0) {
      const placeholders = [...nodeIds].map(() => '?').join(',');
      const neighborRows = db
        .prepare(
          `SELECT DISTINCT n.* FROM nodes n
             JOIN edges e ON (e.source = n.id OR e.target = n.id)
             WHERE (e.source IN (${placeholders}) OR e.target IN (${placeholders})) ${edgeKindFilterQualified}
             LIMIT ?`
        )
        .all(...nodeIds, ...nodeIds, ...edgeKindParams, maxNodes) as NodeRow[];
      for (const r of neighborRows) {
        if (!nodeIds.has(r.id)) {
          nodeRows.push(r);
          nodeIds.add(r.id);
        }
      }
    }
  } else {
    // Whole-graph view: drop raw parameter/import noise, cap at maxNodes, bias
    // toward the most-connected symbols (degree) so a cap still shows the
    // architecturally interesting parts rather than an arbitrary slice.
    const rows = db
      .prepare(
        `SELECT n.*, (
             SELECT COUNT(*) FROM edges e WHERE e.source = n.id OR e.target = n.id
           ) AS degree
           FROM nodes n
           WHERE n.kind NOT IN ('parameter','import')
           ORDER BY degree DESC
           LIMIT ?`
      )
      .all(maxNodes) as NodeRow[];
    nodeRows.push(...rows);
    for (const r of rows) nodeIds.add(r.id);
  }

  if (nodeIds.size === 0) {
    throw new EmptyGraphViewError(
      'No matching nodes found. Check --file / --symbol against `codegraph files` or `codegraph query`.'
    );
  }

  const placeholders = [...nodeIds].map(() => '?').join(',');
  const edgeRows = db
    .prepare(
      `SELECT source, target, kind FROM edges
         WHERE source IN (${placeholders}) AND target IN (${placeholders}) ${edgeKindFilter}`
    )
    .all(...nodeIds, ...nodeIds, ...edgeKindParams) as EdgeRow[];

  // Node degree, for sizing.
  const degree = new Map<string, number>();
  for (const id of nodeIds) degree.set(id, 0);
  for (const e of edgeRows) {
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const nodes: ViewNode[] = nodeRows.map((r) => {
    const d = degree.get(r.id) ?? 0;
    return {
      id: r.id,
      label: r.name,
      title:
        `${r.qualified_name}\n${r.file_path}:${r.start_line}` +
        `\nkind: ${r.kind}\nconnections: ${d}`,
      group: r.kind,
      color: KIND_COLORS[r.kind] ?? DEFAULT_COLOR,
      value: Math.max(5, Math.min(40, 5 + d * 3)),
      file: r.file_path,
    };
  });

  const edges: ViewEdge[] = edgeRows.map((e) => ({
    from: e.source,
    to: e.target,
    label: e.kind,
    arrows: 'to',
    title: e.kind,
  }));

  const stats: GraphViewStats = {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    kinds: [...new Set(nodes.map((n) => n.group))].sort(),
  };

  return { nodes, edges, stats };
}

/**
 * Locate the bundled vis-network library. In a built install it sits in
 * `dist/assets/`; running from source it's `assets/` at the repo root. This file
 * compiles to `dist/graph/viewer.js`, so `../assets` resolves the built copy and
 * the source-tree fallback covers `tsx`/test runs before a build.
 */
function readVisNetworkJs(): string {
  const candidates = [
    path.join(__dirname, '..', 'assets', 'vis-network.min.js'),
    path.join(__dirname, '..', '..', 'assets', 'vis-network.min.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return fs.readFileSync(c, 'utf-8');
  }
  throw new Error(
    `Bundled vis-network.min.js not found (looked in ${candidates.join(', ')}). ` +
      'Reinstall CodeGraph, or run `npm run build` if running from source.'
  );
}

/**
 * JSON that is safe to inline inside a <script> tag: escape `<` so a `</script>`
 * or `<!--` sequence in string data can't terminate the script element early.
 */
function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * Render the full standalone HTML page for a graph. `titleSuffix` decorates the
 * document title with the active filter (e.g. " — run_campaign").
 */
export function renderViewerHtml(data: GraphViewData, titleSuffix: string): string {
  const { nodes, edges, stats } = data;

  const legendHtml = stats.kinds
    .map((kind) => {
      const color = KIND_COLORS[kind] ?? DEFAULT_COLOR;
      return `<span class="legend-item"><span class="swatch" style="background:${color}"></span>${kind}</span>`;
    })
    .join('');

  const visNetworkJs = readVisNetworkJs();

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>CodeGraph Viewer${titleSuffix}</title>
<script>${visNetworkJs}</script>
<style>
  body { margin: 0; font-family: -apple-system, Segoe UI, Roboto, sans-serif; background: #0f1117; color: #e5e7eb; }
  #header { padding: 12px 18px; background: #171a21; border-bottom: 1px solid #2a2e37; display: flex;
            align-items: center; gap: 16px; flex-wrap: wrap; }
  #header h1 { font-size: 15px; margin: 0; font-weight: 600; color: #f3f4f6; }
  #header .stat { font-size: 13px; color: #9ca3af; }
  #search { background: #0f1117; border: 1px solid #2a2e37; color: #e5e7eb; padding: 6px 10px;
            border-radius: 6px; font-size: 13px; width: 220px; }
  #legend { padding: 10px 18px; display: flex; gap: 14px; flex-wrap: wrap; background: #12141a;
            border-bottom: 1px solid #2a2e37; font-size: 12px; }
  .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 50%; margin-right: 5px; }
  .legend-item { display: flex; align-items: center; color: #9ca3af; }
  #network { width: 100vw; height: calc(100vh - 96px); }
</style>
</head>
<body>
  <div id="header">
    <h1>CodeGraph Viewer</h1>
    <span class="stat">${stats.totalNodes} symbols · ${stats.totalEdges} relationships</span>
    <input id="search" type="text" placeholder="Search symbol name...">
  </div>
  <div id="legend">${legendHtml}</div>
  <div id="network"></div>
<script>
  const nodesData = new vis.DataSet(${safeJson(nodes)});
  const edgesData = new vis.DataSet(${safeJson(edges)});
  const container = document.getElementById('network');
  const data = { nodes: nodesData, edges: edgesData };
  const options = {
    nodes: {
      shape: 'dot',
      font: { color: '#e5e7eb', size: 12 },
      borderWidth: 1,
      scaling: { min: 6, max: 42 }
    },
    edges: {
      color: { color: '#374151', highlight: '#60a5fa' },
      font: { color: '#6b7280', size: 9, strokeWidth: 0 },
      smooth: { type: 'continuous' }
    },
    // forceAtlas2Based + avoidOverlap keeps nodes from stacking, like Obsidian.
    // Physics stays ON so nodes repel and dragging one nudges its neighbors.
    physics: {
      enabled: true,
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: -60,
        centralGravity: 0.008,
        springLength: 110,
        springConstant: 0.06,
        damping: 0.5,
        avoidOverlap: 1
      },
      stabilization: { iterations: 250, fit: true },
      minVelocity: 0.6,
      timestep: 0.4
    },
    interaction: {
      hover: true,
      tooltipDelay: 100,
      dragNodes: true,
      dragView: true,
      zoomView: true,
      zoomSpeed: 0.6,
      multiselect: true,
      navigationButtons: false,
      keyboard: false
    }
  };
  const network = new vis.Network(container, data, options);

  // Keep physics live but calm: after first settle, damp velocities so the
  // graph stops jittering yet stays fully draggable (Obsidian behavior).
  network.once('stabilizationIterationsDone', () => {
    network.fit();
    network.setOptions({ physics: { minVelocity: 0.9 } });
  });

  // Clamp zoom so wheel/pinch can't blow past usable bounds.
  const MIN_ZOOM = 0.15, MAX_ZOOM = 4.0;
  network.on('zoom', () => {
    const s = network.getScale();
    if (s < MIN_ZOOM) network.moveTo({ scale: MIN_ZOOM });
    else if (s > MAX_ZOOM) network.moveTo({ scale: MAX_ZOOM });
  });

  // While dragging a node, wake physics so neighbors respond.
  network.on('dragStart', () => network.setOptions({ physics: { enabled: true } }));

  document.getElementById('search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    if (!q) { nodesData.forEach(n => nodesData.update({ id: n.id, hidden: false })); return; }
    nodesData.forEach(n => {
      const match = n.label.toLowerCase().includes(q);
      nodesData.update({ id: n.id, hidden: !match });
    });
  });
</script>
</body>
</html>
`;
}
