/**
 * Context Formatter
 *
 * Formats TaskContext as markdown or JSON for consumption by Claude.
 */

import { Node, Edge, TaskContext, Subgraph } from '../types';
import { isGeneratedFile } from '../extraction/generated-detection';

/**
 * Format context as markdown
 *
 * Creates a compact markdown document optimized for Claude with minimal context usage:
 * - Brief summary
 * - Entry points with locations
 * - Code blocks only for key symbols
 */
export function formatContextAsMarkdown(context: TaskContext): string {
  const lines: string[] = [];

  // Header with query
  lines.push('## Code Context\n');
  lines.push(`**Query:** ${context.query}\n`);

  // Entry points - compact format. Re-sort so generated files (.pb.go,
  // .pulsar.go, mocks, …) rank LAST — a flow query should lead with the
  // hand-written implementation, not protobuf scaffolding.
  const orderedEntries = [...context.entryPoints].sort((a, b) => {
    const aGen = isGeneratedFile(a.filePath) ? 1 : 0;
    const bGen = isGeneratedFile(b.filePath) ? 1 : 0;
    return aGen - bGen;
  });
  if (orderedEntries.length > 0) {
    lines.push('### Entry Points\n');
    for (const node of orderedEntries) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`- **${node.name}** (${node.kind}) - ${node.filePath}${location}`);
      if (node.signature) {
        lines.push(`  \`${node.signature}\``);
      }
    }
    lines.push('');
  }

  // Related symbols - compact list (skip verbose structure tree). Drop nodes
  // in generated source files (`.pb.go` / `.pulsar.go` / mocks / …) — agents
  // chasing a flow never want to land on protobuf scaffolding (cosmos-Q3 used
  // to list `gov.pulsar.go::GetExpeditedThreshold` and `1.pulsar.go::Get` in
  // Related Symbols, pure noise that displaced real-flow entries).
  const otherSymbols = Array.from(context.subgraph.nodes.values())
    .filter(n => !context.entryPoints.some(e => e.id === n.id))
    .filter(n => !isGeneratedFile(n.filePath))
    .slice(0, 10); // Limit to 10 related symbols

  if (otherSymbols.length > 0) {
    lines.push('### Related Symbols\n');
    const byFile = new Map<string, Node[]>();
    for (const node of otherSymbols) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(`- ${file}: ${nodeList}`);
    }
    lines.push('');
  }

  // Code blocks - only for key entry points. Re-sort so non-generated blocks
  // show first (consistent with Entry Points reordering above).
  if (context.codeBlocks.length > 0) {
    const orderedBlocks = [...context.codeBlocks].sort((a, b) => {
      const aGen = isGeneratedFile(a.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.filePath) ? 1 : 0;
      return aGen - bGen;
    });
    lines.push('### Code\n');
    for (const block of orderedBlocks) {
      const nodeName = block.node?.name ?? 'Unknown';
      lines.push(`#### ${nodeName} (${block.filePath}:${block.startLine})\n`);
      lines.push('```' + block.language);
      lines.push(block.content);
      lines.push('```\n');
    }
  }

  return lines.join('\n');
}

/**
 * Format context as JSON
 *
 * Returns a structured JSON representation suitable for programmatic use.
 */
export function formatContextAsJson(context: TaskContext): string {
  // Convert Map to array for JSON serialization
  const serializable = {
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints.map(serializeNode),
    nodes: Array.from(context.subgraph.nodes.values()).map(serializeNode),
    edges: context.subgraph.edges.map(serializeEdge),
    codeBlocks: context.codeBlocks.map((block) => ({
      filePath: block.filePath,
      startLine: block.startLine,
      endLine: block.endLine,
      language: block.language,
      content: block.content,
      nodeName: block.node?.name,
      nodeKind: block.node?.kind,
    })),
    relatedFiles: context.relatedFiles,
    stats: context.stats,
  };

  return JSON.stringify(serializable, null, 2);
}

/**
 * Format a subgraph as an ASCII tree structure
 */
export function formatSubgraphTree(subgraph: Subgraph, entryPoints: Node[]): string {
  const lines: string[] = [];
  const printed = new Set<string>();

  // Build adjacency list for outgoing edges
  const outgoing = new Map<string, Edge[]>();
  for (const edge of subgraph.edges) {
    const existing = outgoing.get(edge.source) ?? [];
    existing.push(edge);
    outgoing.set(edge.source, existing);
  }

  // Print each entry point as a tree root
  for (const entry of entryPoints) {
    formatNodeTree(entry, subgraph, outgoing, printed, lines, 0, '');
    lines.push(''); // Blank line between trees
  }

  // Print any remaining nodes not reached from entry points
  const remaining: Node[] = [];
  for (const node of subgraph.nodes.values()) {
    if (!printed.has(node.id)) {
      remaining.push(node);
    }
  }

  if (remaining.length > 0 && remaining.length <= 10) {
    lines.push('Other relevant symbols:');
    for (const node of remaining) {
      const location = node.startLine ? `:${node.startLine}` : '';
      lines.push(`  ${node.kind}: ${node.name} (${node.filePath}${location})`);
    }
  } else if (remaining.length > 10) {
    lines.push(`... and ${remaining.length} more related symbols`);
  }

  return lines.join('\n').trim();
}

/**
 * Format a single node and its relationships
 */
function formatNodeTree(
  node: Node,
  subgraph: Subgraph,
  outgoing: Map<string, Edge[]>,
  printed: Set<string>,
  lines: string[],
  depth: number,
  prefix: string
): void {
  if (printed.has(node.id)) {
    return;
  }
  printed.add(node.id);

  // Node header
  const location = node.startLine ? `:${node.startLine}` : '';
  const signature = node.signature ? ` - ${truncate(node.signature, 50)}` : '';
  lines.push(`${prefix}${node.kind}: ${node.name} (${node.filePath}${location})${signature}`);

  // Outgoing edges
  const edges = outgoing.get(node.id) ?? [];
  const significantEdges = edges.filter((e) =>
    ['calls', 'extends', 'implements', 'imports', 'references'].includes(e.kind)
  );

  // Group by kind
  const edgesByKind = new Map<string, Edge[]>();
  for (const edge of significantEdges) {
    const existing = edgesByKind.get(edge.kind) ?? [];
    existing.push(edge);
    edgesByKind.set(edge.kind, existing);
  }

  // Print edges grouped by kind
  const newPrefix = prefix + '  ';
  for (const [kind, kindEdges] of edgesByKind) {
    if (kindEdges.length > 3) {
      // Summarize if too many
      const names = kindEdges
        .slice(0, 3)
        .map((e) => {
          const target = subgraph.nodes.get(e.target);
          return target?.name ?? 'unknown';
        })
        .join(', ');
      lines.push(`${newPrefix}├── ${kind}: ${names} and ${kindEdges.length - 3} more`);
    } else {
      for (let i = 0; i < kindEdges.length; i++) {
        const edge = kindEdges[i]!;
        const target = subgraph.nodes.get(edge.target);
        const targetName = target?.name ?? 'unknown';
        const connector = i === kindEdges.length - 1 ? '└──' : '├──';
        lines.push(`${newPrefix}${connector} ${kind} → ${targetName}`);
      }
    }
  }

  // Recurse for directly connected nodes (limited depth)
  if (depth < 1) {
    for (const edge of significantEdges.slice(0, 3)) {
      const target = subgraph.nodes.get(edge.target);
      if (target && !printed.has(target.id)) {
        formatNodeTree(target, subgraph, outgoing, printed, lines, depth + 1, newPrefix);
      }
    }
  }
}

/**
 * Serialize a node for JSON output
 */
function serializeNode(node: Node): Record<string, unknown> {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature,
    docstring: node.docstring,
    visibility: node.visibility,
    isExported: node.isExported,
    isAsync: node.isAsync,
    isStatic: node.isStatic,
  };
}

/**
 * Serialize an edge for JSON output
 */
function serializeEdge(edge: Edge): Record<string, unknown> {
  return {
    source: edge.source,
    target: edge.target,
    kind: edge.kind,
    line: edge.line,
    column: edge.column,
  };
}

/**
 * Truncate a string with ellipsis
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) {
    return str;
  }
  return str.slice(0, maxLength - 3) + '...';
}

/**
 * Format bytes as human-readable string
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
}
