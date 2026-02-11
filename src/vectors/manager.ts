/**
 * Vector Manager
 *
 * High-level manager that coordinates embedding generation and vector search.
 */

import Database from 'better-sqlite3';
import { Node, SearchResult, SearchOptions } from '../types';
import { TextEmbedder, createEmbedder, EmbedderOptions, EMBEDDING_DIMENSION } from './embedder';
import { VectorSearchManager, createVectorSearch } from './search';
import { QueryBuilder } from '../db/queries';

/**
 * Progress callback for embedding generation
 */
export interface EmbeddingProgress {
  /** Current node index */
  current: number;

  /** Total nodes to embed */
  total: number;

  /** Current node being embedded */
  nodeName?: string;
}

/**
 * Options for the vector manager
 */
export interface VectorManagerOptions {
  /** Embedder options */
  embedder?: EmbedderOptions;

  /** Node kinds to embed (default: functions, methods, classes, interfaces) */
  nodeKinds?: Node['kind'][];

  /** Batch size for embedding generation */
  batchSize?: number;
}

/**
 * Default node kinds to embed
 */
const DEFAULT_NODE_KINDS: Node['kind'][] = [
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'module',
  'component',
];

/**
 * Vector Manager
 *
 * Provides high-level interface for semantic search:
 * - Generates embeddings for code nodes
 * - Stores embeddings in the database
 * - Performs semantic similarity search
 */
export class VectorManager {
  private embedder: TextEmbedder;
  private searchManager: VectorSearchManager;
  private queries: QueryBuilder;
  private nodeKinds: Node['kind'][];
  private batchSize: number;
  private initialized = false;
  private queryEmbeddingCache = new Map<string, Float32Array>();
  private static readonly QUERY_CACHE_MAX_SIZE = 50;

  constructor(
    db: Database.Database,
    queries: QueryBuilder,
    options: VectorManagerOptions = {}
  ) {
    this.embedder = createEmbedder(options.embedder);
    this.searchManager = createVectorSearch(db, EMBEDDING_DIMENSION);
    this.queries = queries;
    this.nodeKinds = options.nodeKinds || DEFAULT_NODE_KINDS;
    this.batchSize = options.batchSize || 32;
  }

  /**
   * Initialize the vector manager
   *
   * Loads the embedding model and initializes vector search.
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    // Initialize embedder (downloads model if needed)
    await this.embedder.initialize();

    // Initialize vector search (loads sqlite-vss if available)
    await this.searchManager.initialize();

    this.initialized = true;
  }

  /**
   * Check if the vector manager is initialized
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Generate embeddings for all eligible nodes
   *
   * @param onProgress - Optional progress callback
   * @returns Number of nodes embedded
   */
  async embedAllNodes(onProgress?: (progress: EmbeddingProgress) => void): Promise<number> {
    if (!this.initialized) {
      throw new Error('VectorManager not initialized. Call initialize() first.');
    }

    // Get all nodes that should be embedded
    const nodesToEmbed: Node[] = [];
    for (const kind of this.nodeKinds) {
      const nodes = this.queries.getNodesByKind(kind);
      nodesToEmbed.push(...nodes);
    }

    // Filter out nodes that already have embeddings
    const existingIds = new Set(this.searchManager.getIndexedNodeIds());
    const newNodes = nodesToEmbed.filter((n) => !existingIds.has(n.id));

    if (newNodes.length === 0) {
      return 0;
    }

    // Process in batches
    let processed = 0;
    const model = this.embedder.getModelId();

    for (let i = 0; i < newNodes.length; i += this.batchSize) {
      const batch = newNodes.slice(i, i + this.batchSize);

      // Create text representations
      const texts = batch.map((node) => TextEmbedder.createNodeText(node));

      // Generate embeddings
      const result = await this.embedder.embedBatch(texts, 'document');

      // Store embeddings
      const entries: Array<{ nodeId: string; embedding: Float32Array }> = [];
      for (let idx = 0; idx < batch.length; idx++) {
        const node = batch[idx];
        const embedding = result.embeddings[idx];
        if (node && embedding) {
          entries.push({ nodeId: node.id, embedding });
        }
      }
      this.searchManager.storeVectorBatch(entries, model);

      processed += batch.length;

      // Report progress
      if (onProgress) {
        onProgress({
          current: processed,
          total: newNodes.length,
          nodeName: batch[batch.length - 1]?.name,
        });
      }
    }

    return processed;
  }

  /**
   * Generate embedding for a single node
   *
   * @param node - Node to embed
   */
  async embedNode(node: Node): Promise<void> {
    if (!this.initialized) {
      throw new Error('VectorManager not initialized. Call initialize() first.');
    }

    const text = TextEmbedder.createNodeText(node);
    const result = await this.embedder.embed(text);
    this.searchManager.storeVector(node.id, result.embedding, result.model);
  }

  /**
   * Semantic search for nodes matching a query
   *
   * @param query - Natural language query
   * @param options - Search options
   * @returns Array of search results with similarity scores
   */
  /**
   * Get cached query embedding (LRU via Map insertion order)
   */
  private async getCachedQueryEmbedding(query: string): Promise<Float32Array> {
    const cached = this.queryEmbeddingCache.get(query);
    if (cached) {
      // Move to end for LRU
      this.queryEmbeddingCache.delete(query);
      this.queryEmbeddingCache.set(query, cached);
      return cached;
    }

    const result = await this.embedder.embedQuery(query);

    // Evict oldest entry if at capacity
    if (this.queryEmbeddingCache.size >= VectorManager.QUERY_CACHE_MAX_SIZE) {
      const firstKey = this.queryEmbeddingCache.keys().next().value;
      if (firstKey !== undefined) {
        this.queryEmbeddingCache.delete(firstKey);
      }
    }

    this.queryEmbeddingCache.set(query, result.embedding);
    return result.embedding;
  }

  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new Error('VectorManager not initialized. Call initialize() first.');
    }

    const { limit = 10, kinds } = options;

    // Generate query embedding (cached)
    const queryEmbedding = await this.getCachedQueryEmbedding(query);

    // Search for similar vectors
    const vectorResults = this.searchManager.search(queryEmbedding, {
      limit: limit * 2, // Get more results to filter
      minScore: 0.3, // Minimum similarity threshold
    });

    // Get nodes and filter by kind if specified
    const results: SearchResult[] = [];
    for (const vr of vectorResults) {
      const node = this.queries.getNodeById(vr.nodeId);
      if (!node) {
        continue;
      }

      // Filter by node kind if specified
      if (kinds && kinds.length > 0 && !kinds.includes(node.kind)) {
        continue;
      }

      results.push({
        node,
        score: vr.score,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  /**
   * Find nodes similar to a given node
   *
   * @param nodeId - ID of the node to find similar nodes for
   * @param options - Search options
   * @returns Array of similar nodes with similarity scores
   */
  async findSimilar(nodeId: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    if (!this.initialized) {
      throw new Error('VectorManager not initialized. Call initialize() first.');
    }

    const { limit = 10, kinds } = options;

    // Get the node's embedding
    let embedding = this.searchManager.getVector(nodeId);

    // If no embedding exists, generate one
    if (!embedding) {
      const node = this.queries.getNodeById(nodeId);
      if (!node) {
        throw new Error(`Node not found: ${nodeId}`);
      }

      await this.embedNode(node);
      embedding = this.searchManager.getVector(nodeId);

      if (!embedding) {
        throw new Error(`Failed to generate embedding for node: ${nodeId}`);
      }
    }

    // Search for similar vectors (excluding the source node)
    const vectorResults = this.searchManager.search(embedding, {
      limit: limit + 1, // Get one extra to exclude the source
      minScore: 0.3,
    });

    // Get nodes and filter
    const results: SearchResult[] = [];
    for (const vr of vectorResults) {
      // Skip the source node
      if (vr.nodeId === nodeId) {
        continue;
      }

      const node = this.queries.getNodeById(vr.nodeId);
      if (!node) {
        continue;
      }

      // Filter by node kind if specified
      if (kinds && kinds.length > 0 && !kinds.includes(node.kind)) {
        continue;
      }

      results.push({
        node,
        score: vr.score,
      });

      if (results.length >= limit) {
        break;
      }
    }

    return results;
  }

  /**
   * Delete embedding for a node
   *
   * @param nodeId - ID of the node
   */
  deleteNodeEmbedding(nodeId: string): void {
    this.searchManager.deleteVector(nodeId);
  }

  /**
   * Get statistics about vector storage
   */
  getStats(): {
    totalVectors: number;
    vssEnabled: boolean;
    modelId: string;
    dimension: number;
  } {
    return {
      totalVectors: this.searchManager.getVectorCount(),
      vssEnabled: this.searchManager.isVssEnabled(),
      modelId: this.embedder.getModelId(),
      dimension: this.embedder.getDimension(),
    };
  }

  /**
   * Clear all vectors
   */
  clear(): void {
    this.searchManager.clear();
  }

  /**
   * Rebuild the VSS index
   */
  rebuildIndex(): void {
    this.searchManager.rebuildVssIndex();
  }

  /**
   * Release resources
   */
  dispose(): void {
    this.embedder.dispose();
  }
}

/**
 * Create a vector manager
 */
export function createVectorManager(
  db: Database.Database,
  queries: QueryBuilder,
  options?: VectorManagerOptions
): VectorManager {
  return new VectorManager(db, queries, options);
}
