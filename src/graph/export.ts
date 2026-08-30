/**
 * Graph Export Module
 *
 * Provides formatters to export subgraphs and call graphs to Mermaid.js diagrams,
 * Graphviz DOT, and JSON graph formats for documentation and visual rendering.
 */

import type { Subgraph } from '../types';


export type ExportFormat = 'mermaid' | 'dot' | 'json';

export interface ExportOptions {
  /** Output format: 'mermaid' | 'dot' | 'json' */
  format?: ExportFormat;
  /** Layout direction for Mermaid: 'TD' (top-down) | 'LR' (left-right) */
  direction?: 'TD' | 'LR' | 'TB' | 'BT' | 'RL';
  /** Title or name for the graph */
  title?: string;
  /** Filter to specific edge kinds */
  edgeKinds?: string[];
  /** Include file path in node labels */
  includeLocations?: boolean;
}

/**
 * Sanitize an identifier for use in Mermaid or DOT node IDs
 */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Escape text for Mermaid node labels
 */
function escapeMermaidLabel(text: string): string {
  return text.replace(/"/g, '#quot;').replace(/[\r\n]+/g, ' ');
}

/**
 * Escape text for Graphviz DOT labels
 */
function escapeDotLabel(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Export a Subgraph to Mermaid flowchart markdown syntax
 */
export function exportToMermaid(subgraph: Subgraph, options: ExportOptions = {}): string {
  const dir = options.direction || 'TD';
  const lines: string[] = [];

  if (options.title) {
    lines.push(`---`);
    lines.push(`title: ${options.title}`);
    lines.push(`---`);
  }
  lines.push(`graph ${dir}`);

  const edgeKindsFilter = options.edgeKinds ? new Set(options.edgeKinds) : null;
  const nodes = Array.from(subgraph.nodes.values());

  // Render nodes
  for (const node of nodes) {
    const safeId = sanitizeId(node.id);
    let label = `${escapeMermaidLabel(node.name)} (${node.kind})`;
    if (options.includeLocations && node.filePath) {
      label += `<br/>${escapeMermaidLabel(node.filePath)}${node.startLine ? `:${node.startLine}` : ''}`;
    }

    // Use different shape brackets for different kinds
    if (node.kind === 'class' || node.kind === 'struct') {
      lines.push(`  ${safeId}["${label}"]`);
    } else if (node.kind === 'interface' || node.kind === 'trait') {
      lines.push(`  ${safeId}["&lt;&lt;interface&gt;&gt;<br/>${label}"]`);
    } else if (node.kind === 'function' || node.kind === 'method') {
      lines.push(`  ${safeId}(["${label}"])`);
    } else if (node.kind === 'file') {
      lines.push(`  ${safeId}[/"${label}"/]`);
    } else {
      lines.push(`  ${safeId}["${label}"]`);
    }
  }

  // Render edges
  const seenEdges = new Set<string>();
  for (const edge of subgraph.edges) {
    if (edgeKindsFilter && !edgeKindsFilter.has(edge.kind)) continue;
    const sourceNode = subgraph.nodes.get(edge.source);
    const targetNode = subgraph.nodes.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sourceId = sanitizeId(edge.source);
    const targetId = sanitizeId(edge.target);
    const key = `${sourceId}->${targetId}:${edge.kind}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    const edgeLabel = edge.kind ? `|${edge.kind}|` : '';
    lines.push(`  ${sourceId} -->${edgeLabel} ${targetId}`);
  }

  return lines.join('\n');
}

/**
 * Export a Subgraph to Graphviz DOT syntax
 */
export function exportToDot(subgraph: Subgraph, options: ExportOptions = {}): string {
  const graphName = options.title ? sanitizeId(options.title) : 'CodeGraph';
  const lines: string[] = [
    `digraph ${graphName} {`,
    `  node [shape=box, style="rounded,filled", fillcolor="#f8fafc", fontname="sans-serif", fontsize=10];`,
    `  edge [fontname="sans-serif", fontsize=8, color="#64748b"];`,
    `  rankdir=${options.direction === 'LR' ? 'LR' : 'TB'};`,
  ];

  const edgeKindsFilter = options.edgeKinds ? new Set(options.edgeKinds) : null;
  const nodes = Array.from(subgraph.nodes.values());

  for (const node of nodes) {
    const safeId = sanitizeId(node.id);
    let label = `${node.name}\\n(${node.kind})`;
    if (options.includeLocations && node.filePath) {
      label += `\\n${node.filePath}${node.startLine ? `:${node.startLine}` : ''}`;
    }
    const escaped = escapeDotLabel(label);

    let color = '#f8fafc';
    if (node.kind === 'class' || node.kind === 'struct') color = '#e0f2fe';
    else if (node.kind === 'function' || node.kind === 'method') color = '#f0fdf4';
    else if (node.kind === 'interface') color = '#fef3c7';

    lines.push(`  "${safeId}" [label="${escaped}", fillcolor="${color}"];`);
  }

  const seenEdges = new Set<string>();
  for (const edge of subgraph.edges) {
    if (edgeKindsFilter && !edgeKindsFilter.has(edge.kind)) continue;
    const sourceNode = subgraph.nodes.get(edge.source);
    const targetNode = subgraph.nodes.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const sourceId = sanitizeId(edge.source);
    const targetId = sanitizeId(edge.target);
    const key = `${sourceId}->${targetId}:${edge.kind}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);

    lines.push(`  "${sourceId}" -> "${targetId}" [label="${escapeDotLabel(edge.kind)}"];`);
  }

  lines.push(`}`);
  return lines.join('\n');
}

/**
 * Export a Subgraph to JSON Graph format
 */
export function exportToJson(subgraph: Subgraph): string {
  const nodes = Array.from(subgraph.nodes.values()).map((n) => ({
    id: n.id,
    name: n.name,
    kind: n.kind,
    filePath: n.filePath,
    startLine: n.startLine,
    endLine: n.endLine,
    isExported: n.isExported,
  }));

  const edges = subgraph.edges.map((e) => ({
    source: e.source,
    target: e.target,
    kind: e.kind,
    line: e.line,
    column: e.column,
    provenance: e.provenance,
  }));

  return JSON.stringify(
    {
      roots: subgraph.roots,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
    },
    null,
    2
  );
}

/**
 * Export graph dispatcher
 */
export function exportGraph(subgraph: Subgraph, options: ExportOptions = {}): string {
  const format = options.format || 'mermaid';
  switch (format) {
    case 'dot':
      return exportToDot(subgraph, options);
    case 'json':
      return exportToJson(subgraph);
    case 'mermaid':
    default:
      return exportToMermaid(subgraph, options);
  }
}
