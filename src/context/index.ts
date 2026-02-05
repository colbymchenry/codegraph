/**
 * Context Builder
 *
 * Builds rich context for tasks by combining semantic search with graph traversal.
 * Outputs structured context ready to inject into Claude.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  Node,
  Edge,
  Subgraph,
  CodeBlock,
  TaskContext,
  TaskInput,
  BuildContextOptions,
  FindRelevantContextOptions,
  SearchResult,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { GraphTraverser } from '../graph';
import { VectorManager } from '../vectors';
import { formatContextAsMarkdown, formatContextAsJson } from './formatter';
import { logDebug, logWarn } from '../errors';

/**
 * Default options for context building
 *
 * Tuned for minimal context usage while still providing useful results:
 * - Fewer nodes and code blocks by default
 * - Smaller code block size limit
 * - Shallower traversal
 */
const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
};

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: 3,        // Reduced from 5
  traversalDepth: 1,     // Reduced from 2
  maxNodes: 20,          // Reduced from 50
  minScore: 0.3,
  edgeKinds: [],
  nodeKinds: [],
};

/**
 * Context Builder
 *
 * Coordinates semantic search and graph traversal to build
 * comprehensive context for tasks.
 */
export class ContextBuilder {
  private projectRoot: string;
  private queries: QueryBuilder;
  private traverser: GraphTraverser;
  private vectorManager: VectorManager | null;

  constructor(
    projectRoot: string,
    queries: QueryBuilder,
    traverser: GraphTraverser,
    vectorManager: VectorManager | null
  ) {
    this.projectRoot = projectRoot;
    this.queries = queries;
    this.traverser = traverser;
    this.vectorManager = vectorManager;
  }

  /**
   * Build context for a task
   *
   * Pipeline:
   * 1. Parse task input (string or {title, description})
   * 2. Run semantic search to find entry points
   * 3. Expand graph around entry points
   * 4. Extract code blocks for key nodes
   * 5. Format output for Claude
   *
   * @param input - Task description or object with title/description
   * @param options - Build options
   * @returns TaskContext (structured) or formatted string
   */
  async buildContext(
    input: TaskInput,
    options: BuildContextOptions = {}
  ): Promise<TaskContext | string> {
    const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
    });

    // Get entry points (nodes from semantic search)
    const entryPoints = this.getEntryPoints(subgraph);

    // Extract code blocks for key nodes
    const codeBlocks = opts.includeCode
      ? await this.extractCodeBlocks(subgraph, opts.maxCodeBlocks, opts.maxCodeBlockSize)
      : [];

    // Get related files
    const relatedFiles = this.getRelatedFiles(subgraph);

    // Generate summary
    const summary = this.generateSummary(query, subgraph, entryPoints);

    // Calculate stats
    const stats = {
      nodeCount: subgraph.nodes.size,
      edgeCount: subgraph.edges.length,
      fileCount: relatedFiles.length,
      codeBlockCount: codeBlocks.length,
      totalCodeSize: codeBlocks.reduce((sum, block) => sum + block.content.length, 0),
    };

    const context: TaskContext = {
      query,
      subgraph,
      entryPoints,
      codeBlocks,
      relatedFiles,
      summary,
      stats,
    };

    // Return formatted output or raw context
    if (opts.format === 'markdown') {
      return formatContextAsMarkdown(context);
    } else if (opts.format === 'json') {
      return formatContextAsJson(context);
    }

    return context;
  }

  /**
   * Find relevant subgraph for a query
   *
   * Combines semantic search with graph traversal:
   * 1. Use semantic search to find relevant entry points
   * 2. Traverse graph from entry points
   * 3. Merge results into a unified subgraph
   *
   * @param query - Natural language query
   * @param options - Search and traversal options
   * @returns Subgraph of relevant nodes and edges
   */
  async findRelevantContext(
    query: string,
    options: FindRelevantContextOptions = {}
  ): Promise<Subgraph> {
    const opts = { ...DEFAULT_FIND_OPTIONS, ...options };

    // Start with empty subgraph
    const nodes = new Map<string, Node>();
    const edges: Edge[] = [];
    const roots: string[] = [];

    // Handle empty query - return empty subgraph
    if (!query || query.trim().length === 0) {
      return { nodes, edges, roots };
    }

    // Try semantic search if vector manager is available
    let searchResults: SearchResult[] = [];
    if (this.vectorManager && this.vectorManager.isInitialized()) {
      try {
        searchResults = await this.vectorManager.search(query, {
          limit: opts.searchLimit,
          kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        });
      } catch (error) {
        logDebug('Semantic search failed, falling back to text search', { query, error: String(error) });
      }
    }

    // Fall back to text search if no semantic results
    if (searchResults.length === 0) {
      try {
        const textResults = this.queries.searchNodes(query, {
          limit: opts.searchLimit,
          kinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        });
        searchResults = textResults;
      } catch (error) {
        logWarn('Text search failed', { query, error: String(error) });
        // Return empty results
      }
    }

    // Filter by minimum score
    const filteredResults = searchResults.filter((r) => r.score >= opts.minScore);

    // Add entry points to subgraph
    for (const result of filteredResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Traverse from each entry point
    for (const result of filteredResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds: opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, filteredResults.length)),
      });

      // Merge nodes
      for (const [id, node] of traversalResult.nodes) {
        if (!nodes.has(id)) {
          nodes.set(id, node);
        }
      }

      // Merge edges (avoid duplicates)
      for (const edge of traversalResult.edges) {
        const exists = edges.some(
          (e) => e.source === edge.source && e.target === edge.target && e.kind === edge.kind
        );
        if (!exists) {
          edges.push(edge);
        }
      }
    }

    // Trim to max nodes if needed
    if (nodes.size > opts.maxNodes) {
      // Prioritize entry points and their direct neighbors
      const priorityIds = new Set(roots);
      for (const edge of edges) {
        if (priorityIds.has(edge.source)) {
          priorityIds.add(edge.target);
        }
        if (priorityIds.has(edge.target)) {
          priorityIds.add(edge.source);
        }
      }

      // Keep priority nodes, then fill remaining slots
      const trimmedNodes = new Map<string, Node>();
      for (const id of priorityIds) {
        const node = nodes.get(id);
        if (node && trimmedNodes.size < opts.maxNodes) {
          trimmedNodes.set(id, node);
        }
      }

      // Fill remaining from other nodes
      for (const [id, node] of nodes) {
        if (trimmedNodes.size >= opts.maxNodes) break;
        if (!trimmedNodes.has(id)) {
          trimmedNodes.set(id, node);
        }
      }

      // Filter edges to only include kept nodes
      const trimmedEdges = edges.filter(
        (e) => trimmedNodes.has(e.source) && trimmedNodes.has(e.target)
      );

      return { nodes: trimmedNodes, edges: trimmedEdges, roots };
    }

    return { nodes, edges, roots };
  }

  /**
   * Get the source code for a node
   *
   * Reads the file and extracts the code between startLine and endLine.
   *
   * @param nodeId - ID of the node
   * @returns Code string or null if not found
   */
  async getCode(nodeId: string): Promise<string | null> {
    const node = this.queries.getNodeById(nodeId);
    if (!node) {
      return null;
    }

    return this.extractNodeCode(node);
  }

  /**
   * Extract code from a node's source file
   */
  private async extractNodeCode(node: Node): Promise<string | null> {
    const filePath = path.resolve(this.projectRoot, node.filePath);

    // Prevent path traversal: ensure resolved path stays within project root
    if (!filePath.startsWith(path.resolve(this.projectRoot) + path.sep) &&
        filePath !== path.resolve(this.projectRoot)) {
      logWarn('Path traversal blocked', { nodeId: node.id, filePath: node.filePath });
      return null;
    }

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      // Extract lines (1-indexed to 0-indexed)
      const startIdx = Math.max(0, node.startLine - 1);
      const endIdx = Math.min(lines.length, node.endLine);

      return lines.slice(startIdx, endIdx).join('\n');
    } catch (error) {
      logDebug('Failed to extract code from node', { nodeId: node.id, filePath: node.filePath, error: String(error) });
      return null;
    }
  }

  /**
   * Get entry points from a subgraph (the root nodes)
   */
  private getEntryPoints(subgraph: Subgraph): Node[] {
    return subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => n !== undefined);
  }

  /**
   * Extract code blocks for key nodes in the subgraph
   */
  private async extractCodeBlocks(
    subgraph: Subgraph,
    maxBlocks: number,
    maxBlockSize: number
  ): Promise<CodeBlock[]> {
    const blocks: CodeBlock[] = [];

    // Prioritize entry points, then functions/methods
    const priorityNodes: Node[] = [];

    // First: entry points
    for (const id of subgraph.roots) {
      const node = subgraph.nodes.get(id);
      if (node) {
        priorityNodes.push(node);
      }
    }

    // Then: functions and methods
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'function' || node.kind === 'method') {
          priorityNodes.push(node);
        }
      }
    }

    // Then: classes
    for (const node of subgraph.nodes.values()) {
      if (!subgraph.roots.includes(node.id)) {
        if (node.kind === 'class') {
          priorityNodes.push(node);
        }
      }
    }

    // Extract code for priority nodes
    for (const node of priorityNodes) {
      if (blocks.length >= maxBlocks) break;

      const code = await this.extractNodeCode(node);
      if (code) {
        // Truncate if too long
        const truncated = code.length > maxBlockSize
          ? code.slice(0, maxBlockSize) + '\n// ... truncated ...'
          : code;

        blocks.push({
          content: truncated,
          filePath: node.filePath,
          startLine: node.startLine,
          endLine: node.endLine,
          language: node.language,
          node,
        });
      }
    }

    return blocks;
  }

  /**
   * Get unique files from a subgraph
   */
  private getRelatedFiles(subgraph: Subgraph): string[] {
    const files = new Set<string>();
    for (const node of subgraph.nodes.values()) {
      files.add(node.filePath);
    }
    return Array.from(files).sort();
  }

  /**
   * Generate a summary of the context
   */
  private generateSummary(_query: string, subgraph: Subgraph, entryPoints: Node[]): string {
    const nodeCount = subgraph.nodes.size;
    const edgeCount = subgraph.edges.length;
    const files = this.getRelatedFiles(subgraph);

    const entryPointNames = entryPoints
      .slice(0, 3)
      .map((n) => n.name)
      .join(', ');

    const remaining = entryPoints.length > 3 ? ` and ${entryPoints.length - 3} more` : '';

    return `Found ${nodeCount} relevant code symbols across ${files.length} files. ` +
      `Key entry points: ${entryPointNames}${remaining}. ` +
      `${edgeCount} relationships identified.`;
  }
}

/**
 * Create a context builder
 */
export function createContextBuilder(
  projectRoot: string,
  queries: QueryBuilder,
  traverser: GraphTraverser,
  vectorManager: VectorManager | null
): ContextBuilder {
  return new ContextBuilder(projectRoot, queries, traverser, vectorManager);
}

// Re-export formatter
export { formatContextAsMarkdown, formatContextAsJson } from './formatter';
