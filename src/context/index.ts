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
const DEFAULT_BUILD_OPTIONS = {
  maxNodes: 20,           // Reduced from 50 - most tasks don't need 50 symbols
  maxCodeBlocks: 5,       // Reduced from 10 - only show most relevant code
  maxCodeBlockSize: 1500, // Reduced from 2000
  includeCode: true,
  format: 'markdown',
  searchLimit: 3,         // Reduced from 5 - fewer entry points
  traversalDepth: 1,      // Reduced from 2 - shallower graph expansion
  minScore: 0.3,
  nodeKinds: [],
  edgeKinds: [],
};

/**
 * Default options for finding relevant context
 */
const DEFAULT_FIND_OPTIONS = {
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
    const opts = {
      maxNodes: options.maxNodes ?? DEFAULT_BUILD_OPTIONS.maxNodes,
      maxCodeBlocks: options.maxCodeBlocks ?? DEFAULT_BUILD_OPTIONS.maxCodeBlocks,
      maxCodeBlockSize: options.maxCodeBlockSize ?? DEFAULT_BUILD_OPTIONS.maxCodeBlockSize,
      includeCode: options.includeCode ?? DEFAULT_BUILD_OPTIONS.includeCode,
      format: options.format ?? DEFAULT_BUILD_OPTIONS.format,
      searchLimit: options.searchLimit ?? DEFAULT_BUILD_OPTIONS.searchLimit,
      traversalDepth: options.traversalDepth ?? DEFAULT_BUILD_OPTIONS.traversalDepth,
      minScore: options.minScore ?? DEFAULT_BUILD_OPTIONS.minScore,
      nodeKinds: options.nodeKinds ?? DEFAULT_BUILD_OPTIONS.nodeKinds,
      edgeKinds: options.edgeKinds ?? DEFAULT_BUILD_OPTIONS.edgeKinds,
      pathHint: options.pathHint,
      language: options.language,
      includeFiles: options.includeFiles,
    };

    // Parse input
    const query = typeof input === 'string' ? input : `${input.title}${input.description ? `: ${input.description}` : ''}`;

    // Find relevant context (semantic search + graph expansion)
    const subgraph = await this.findRelevantContext(query, {
      searchLimit: opts.searchLimit,
      traversalDepth: opts.traversalDepth,
      maxNodes: opts.maxNodes,
      minScore: opts.minScore,
      nodeKinds: opts.nodeKinds,
      edgeKinds: opts.edgeKinds,
      pathHint: opts.pathHint,
      language: opts.language,
      includeFiles: opts.includeFiles,
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
    const opts = {
      searchLimit: options.searchLimit ?? DEFAULT_FIND_OPTIONS.searchLimit,
      traversalDepth: options.traversalDepth ?? DEFAULT_FIND_OPTIONS.traversalDepth,
      maxNodes: options.maxNodes ?? DEFAULT_FIND_OPTIONS.maxNodes,
      minScore: options.minScore ?? DEFAULT_FIND_OPTIONS.minScore,
      edgeKinds: options.edgeKinds ?? DEFAULT_FIND_OPTIONS.edgeKinds,
      nodeKinds: options.nodeKinds ?? DEFAULT_FIND_OPTIONS.nodeKinds,
      pathHint: options.pathHint,
      language: options.language,
      includeFiles: options.includeFiles,
    };
    const includeFiles = this.resolveIncludeFiles(query, opts.includeFiles);
    const pathHint = opts.pathHint?.trim().toLowerCase();
    const language = opts.language;
    const nodeKinds = opts.nodeKinds && opts.nodeKinds.length > 0 ? opts.nodeKinds : undefined;
    const candidateLimit = Math.max(opts.searchLimit * 4, 20);

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
        const semanticResults = await this.vectorManager.search(query, {
          limit: candidateLimit,
          kinds: nodeKinds,
        });
        searchResults = this.rankAndFilterSearchResults(semanticResults, query, {
          minScore: opts.minScore,
          limit: opts.searchLimit,
          includeFiles,
          pathHint,
          language,
        });
      } catch (error) {
        logDebug('Semantic search failed, falling back to text search', { query, error: String(error) });
      }
    }

    // Fall back to text search if no semantic results
    if (searchResults.length === 0) {
      try {
        const textResults = this.queries.searchNodes(query, {
          limit: candidateLimit,
          kinds: nodeKinds,
          languages: language ? [language] : undefined,
          includeFiles,
          includePatterns: pathHint ? [`*${pathHint}*`] : undefined,
        });
        searchResults = this.rankAndFilterSearchResults(textResults, query, {
          minScore: opts.minScore,
          limit: opts.searchLimit,
          includeFiles,
          pathHint,
          language,
        });
      } catch (error) {
        logWarn('Text search failed', { query, error: String(error) });
        // Return empty results
      }
    }

    // Add entry points to subgraph
    for (const result of searchResults) {
      nodes.set(result.node.id, result.node);
      roots.push(result.node.id);
    }

    // Traverse from each entry point
    for (const result of searchResults) {
      const traversalResult = this.traverser.traverseBFS(result.node.id, {
        maxDepth: opts.traversalDepth,
        edgeKinds: opts.edgeKinds && opts.edgeKinds.length > 0 ? opts.edgeKinds : undefined,
        nodeKinds,
        direction: 'both',
        limit: Math.ceil(opts.maxNodes / Math.max(1, searchResults.length)),
      });

      // Merge nodes
      for (const [id, node] of traversalResult.nodes) {
        if (!includeFiles && node.kind === 'file') continue;
        if (language && node.language !== language) continue;
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

    // Remove edges that point to filtered-out nodes
    const filteredEdges = edges.filter((edge) => nodes.has(edge.source) && nodes.has(edge.target));
    const filteredRoots = roots.filter((id) => nodes.has(id));

    // Trim to max nodes if needed
    if (nodes.size > opts.maxNodes) {
      // Prioritize entry points and their direct neighbors
      const priorityIds = new Set(filteredRoots);
      for (const edge of filteredEdges) {
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
      const trimmedEdges = filteredEdges.filter(
        (e) => trimmedNodes.has(e.source) && trimmedNodes.has(e.target)
      );

      const trimmedRoots = filteredRoots.filter((id) => trimmedNodes.has(id));
      return { nodes: trimmedNodes, edges: trimmedEdges, roots: trimmedRoots };
    }

    return { nodes, edges: filteredEdges, roots: filteredRoots };
  }

  private rankAndFilterSearchResults(
    results: SearchResult[],
    query: string,
    options: {
      minScore: number;
      limit: number;
      includeFiles: boolean;
      pathHint?: string;
      language?: string;
    }
  ): SearchResult[] {
    const terms = this.extractSearchTerms(query);
    const deduped = new Map<string, SearchResult>();
    const graphSignalCache = new Map<string, number>();

    for (const result of results) {
      if (result.score < options.minScore) continue;

      const node = result.node;
      if (!options.includeFiles && node.kind === 'file') continue;
      if (options.language && node.language !== options.language) continue;
      if (options.pathHint && !node.filePath.toLowerCase().includes(options.pathHint)) continue;

      const existing = deduped.get(node.id);
      if (!existing || result.score > existing.score) {
        deduped.set(node.id, result);
      }
    }

    return Array.from(deduped.values())
      .map((result) => {
        const lexical = this.computeLexicalSignal(result.node, terms);
        const kindBoost = this.getKindBoost(result.node.kind);
        const pathIntent = this.computePathIntentSignal(result.node, terms);
        let graphSignal = graphSignalCache.get(result.node.id);
        if (graphSignal === undefined) {
          graphSignal = this.computeGraphEvidenceSignal(result.node);
          graphSignalCache.set(result.node.id, graphSignal);
        }
        const score =
          result.score * 0.45 +
          lexical * 0.25 +
          kindBoost * 0.1 +
          pathIntent * 0.12 +
          graphSignal * 0.08;
        return { ...result, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, options.limit);
  }

  private computeLexicalSignal(node: Node, terms: string[]): number {
    if (terms.length === 0) return 0.3;

    const name = node.name.toLowerCase();
    const qualifiedName = node.qualifiedName.toLowerCase();
    const filePath = node.filePath.toLowerCase();
    const fileName = filePath.split('/').pop() ?? '';

    let score = 0;
    for (const term of terms) {
      if (name === term || qualifiedName === term) {
        score += 1.0;
      } else if (name.startsWith(term) || fileName.startsWith(term)) {
        score += 0.9;
      } else if (name.includes(term) || fileName.includes(term)) {
        score += 0.82;
      } else if (qualifiedName.includes(term) || filePath.includes(term)) {
        score += 0.72;
      } else {
        score += 0.1;
      }
    }

    return score / terms.length;
  }

  /**
   * Score how well query terms align with directory/path intent.
   * This helps traces like "tui -> server -> prompt" prioritize matching subsystems.
   */
  private computePathIntentSignal(node: Node, terms: string[]): number {
    if (terms.length === 0) return 0.3;

    const filePath = node.filePath.toLowerCase();
    const segments = filePath.split('/').filter(Boolean);
    if (segments.length === 0) return 0.2;

    let score = 0;
    for (const term of terms) {
      const exactSegment = segments.some((segment) => segment === term);
      const partialSegment = segments.some((segment) => segment.includes(term));
      const directoryPrefix = segments.some((segment) => segment.startsWith(term));

      if (exactSegment) {
        score += 1.0;
      } else if (directoryPrefix) {
        score += 0.8;
      } else if (partialSegment) {
        score += 0.65;
      } else if (filePath.includes(term)) {
        score += 0.5;
      } else {
        score += 0.1;
      }
    }

    return score / terms.length;
  }

  /**
   * Score node evidence from graph connectivity with a SCIP emphasis.
   * Nodes with high-confidence SCIP-backed references/calls are often better anchors.
   */
  private computeGraphEvidenceSignal(node: Node): number {
    const outgoing = this.queries.getOutgoingEdges(node.id);
    const incoming = this.queries.getIncomingEdges(node.id);
    const edges = [...outgoing, ...incoming];

    if (edges.length === 0) return 0.2;

    let scipBacked = 0;
    let highConfidence = 0;
    let structural = 0;

    for (const edge of edges) {
      const metadata = edge.metadata ?? {};
      const resolvedBy = String(metadata.resolvedBy ?? '').toLowerCase();
      const source = String(metadata.source ?? '').toLowerCase();
      const confidence = Number(metadata.confidence ?? 0);

      if (resolvedBy === 'scip' || source === 'scip') {
        scipBacked++;
      }
      if (confidence >= 0.9) {
        highConfidence++;
      }
      if (edge.kind === 'calls' || edge.kind === 'references' || edge.kind === 'imports') {
        structural++;
      }
    }

    const total = edges.length;
    const scipRatio = scipBacked / total;
    const confidenceRatio = highConfidence / total;
    const structuralRatio = structural / total;

    return Math.min(1, scipRatio * 0.45 + confidenceRatio * 0.3 + structuralRatio * 0.25);
  }

  private extractSearchTerms(query: string): string[] {
    const stopWords = new Set([
      'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how',
      'in', 'into', 'is', 'it', 'its', 'of', 'on', 'or', 'that', 'the',
      'their', 'this', 'to', 'understand', 'with', 'during', 'show', 'me',
    ]);

    const cleaned = query
      .toLowerCase()
      .replace(/[^a-z0-9_./\\-]+/g, ' ')
      .trim();
    if (!cleaned) return [];

    const terms = cleaned
      .split(/\s+/)
      .map((term) => term.replace(/^[./\\-]+|[./\\-]+$/g, ''))
      .filter((term) => term.length >= 2)
      .filter((term) => !stopWords.has(term));

    return Array.from(new Set(terms));
  }

  private getKindBoost(kind: Node['kind']): number {
    switch (kind) {
      case 'function':
      case 'method':
      case 'route':
      case 'component':
        return 1.0;
      case 'class':
      case 'struct':
      case 'interface':
      case 'trait':
      case 'protocol':
        return 0.92;
      case 'module':
      case 'namespace':
        return 0.84;
      case 'file':
        return 0.35;
      default:
        return 0.72;
    }
  }

  private resolveIncludeFiles(query: string, includeFiles?: boolean): boolean {
    if (typeof includeFiles === 'boolean') return includeFiles;

    const trimmed = query.trim();
    if (!trimmed) return false;
    return /[\\/]/.test(trimmed) || /\.[a-z0-9]{1,8}$/i.test(trimmed);
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
    const filePath = path.join(this.projectRoot, node.filePath);

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
