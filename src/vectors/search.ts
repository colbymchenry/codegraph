/**
 * Vector Search
 *
 * Provides vector similarity search using sqlite-vss extension.
 * Falls back to brute-force cosine similarity if sqlite-vss is not available.
 */

import Database from 'better-sqlite3';
import { Node } from '../types';
import { TextEmbedder, EMBEDDING_DIMENSION } from './embedder';
import { logDebug, logWarn } from '../errors';

/**
 * Options for vector search
 */
export interface VectorSearchOptions {
  /** Maximum number of results to return */
  limit?: number;

  /** Minimum similarity score (0-1) */
  minScore?: number;

  /** Node kinds to filter results */
  nodeKinds?: Node['kind'][];
}

/**
 * Vector Search Manager
 *
 * Handles vector storage and similarity search for semantic code search.
 */
export class VectorSearchManager {
  private db: Database.Database;
  private vssEnabled = false;
  private embeddingDimension: number;

  constructor(db: Database.Database, dimension: number = EMBEDDING_DIMENSION) {
    this.db = db;
    this.embeddingDimension = dimension;
  }

  /**
   * Initialize vector search
   *
   * Attempts to load sqlite-vss extension. Falls back to brute-force
   * search if the extension is not available.
   */
  async initialize(): Promise<void> {
    try {
      // Try to load sqlite-vss extension
      await this.loadVssExtension();
      this.vssEnabled = true;
      logDebug('sqlite-vss extension loaded successfully');

      // Create the VSS virtual table
      this.createVssTable();
    } catch (error) {
      // Fall back to brute-force search
      logWarn('sqlite-vss extension not available, falling back to brute-force search', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.vssEnabled = false;
    }

    // Ensure the vectors table exists (for both VSS and fallback modes)
    this.ensureVectorsTable();
  }

  /**
   * Load the sqlite-vss extension
   */
  private async loadVssExtension(): Promise<void> {
    try {
      // The sqlite-vss npm package provides functions to load extensions
      const vss = await import('sqlite-vss');

      // Use the load function which loads both vector0 and vss0
      if (typeof vss.load === 'function') {
        vss.load(this.db);
      } else if (typeof vss.default?.load === 'function') {
        vss.default.load(this.db);
      } else {
        throw new Error('sqlite-vss load function not found');
      }
    } catch (error) {
      throw new Error(`Failed to load sqlite-vss: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Create the VSS virtual table for vector search
   */
  private createVssTable(): void {
    // Check if the table already exists
    const tableExists = this.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vss_vectors'")
      .get();

    if (!tableExists) {
      // Create VSS virtual table
      // vss0 is the vector search extension
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vss_vectors USING vss0(
          embedding(${this.embeddingDimension})
        );
      `);

      // Create mapping table to link VSS rowids to node IDs
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vss_map (
          rowid INTEGER PRIMARY KEY,
          node_id TEXT NOT NULL UNIQUE
        );
      `);

      // Create index on node_id
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_vss_map_node ON vss_map(node_id);
      `);
    }
  }

  /**
   * Ensure the basic vectors table exists (for fallback mode)
   */
  private ensureVectorsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vectors (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Check if VSS extension is enabled
   */
  isVssEnabled(): boolean {
    return this.vssEnabled;
  }

  /**
   * Store a vector embedding for a node
   *
   * @param nodeId - ID of the node
   * @param embedding - Vector embedding
   * @param model - Model used to generate embedding
   */
  storeVector(nodeId: string, embedding: Float32Array, model: string): void {
    const now = Date.now();

    // Store in the vectors table (always, for persistence)
    const blob = Buffer.from(embedding.buffer);
    this.db
      .prepare(
        `
        INSERT OR REPLACE INTO vectors (node_id, embedding, model, created_at)
        VALUES (?, ?, ?, ?)
      `
      )
      .run(nodeId, blob, model, now);

    // Also store in VSS table if enabled
    if (this.vssEnabled) {
      this.storeInVss(nodeId, embedding);
    }
  }

  /**
   * Store vector in VSS virtual table
   */
  private storeInVss(nodeId: string, embedding: Float32Array): void {
    try {
      // Check if already exists
      const existing = this.db
        .prepare('SELECT rowid FROM vss_map WHERE node_id = ?')
        .get(nodeId) as { rowid: number } | undefined;

      if (existing) {
        // Update existing vector
        const vectorJson = JSON.stringify(Array.from(embedding));
        this.db
          .prepare('UPDATE vss_vectors SET embedding = ? WHERE rowid = ?')
          .run(vectorJson, existing.rowid);
      } else {
        // Insert new vector - get max rowid and increment
        const maxRow = this.db
          .prepare('SELECT MAX(rowid) as max FROM vss_map')
          .get() as { max: number | null } | undefined;
        const newRowid = (maxRow?.max ?? 0) + 1;

        const vectorJson = JSON.stringify(Array.from(embedding));
        this.db
          .prepare('INSERT INTO vss_vectors (rowid, embedding) VALUES (?, ?)')
          .run(newRowid, vectorJson);

        // Map the rowid to node_id
        this.db
          .prepare('INSERT INTO vss_map (rowid, node_id) VALUES (?, ?)')
          .run(newRowid, nodeId);
      }
    } catch (error) {
      // VSS operations can fail for various reasons (dimension mismatch, etc.)
      // Fall back to brute-force search silently
      logWarn('VSS storage failed, using brute-force search', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Store multiple vectors in a batch
   *
   * @param entries - Array of node IDs and embeddings
   * @param model - Model used to generate embeddings
   */
  storeVectorBatch(
    entries: Array<{ nodeId: string; embedding: Float32Array }>,
    model: string
  ): void {
    const now = Date.now();

    // Use a transaction for better performance
    this.db.transaction(() => {
      for (const entry of entries) {
        const blob = Buffer.from(entry.embedding.buffer);
        this.db
          .prepare(
            `
            INSERT OR REPLACE INTO vectors (node_id, embedding, model, created_at)
            VALUES (?, ?, ?, ?)
          `
          )
          .run(entry.nodeId, blob, model, now);

        if (this.vssEnabled) {
          this.storeInVss(entry.nodeId, entry.embedding);
        }
      }
    })();
  }

  /**
   * Get vector for a node
   *
   * @param nodeId - ID of the node
   * @returns Embedding or null if not found
   */
  getVector(nodeId: string): Float32Array | null {
    const row = this.db
      .prepare('SELECT embedding FROM vectors WHERE node_id = ?')
      .get(nodeId) as { embedding: Buffer } | undefined;

    if (!row) {
      return null;
    }

    return new Float32Array(row.embedding.buffer.slice(
      row.embedding.byteOffset,
      row.embedding.byteOffset + row.embedding.byteLength
    ));
  }

  /**
   * Delete vector for a node
   *
   * @param nodeId - ID of the node
   */
  deleteVector(nodeId: string): void {
    this.db.prepare('DELETE FROM vectors WHERE node_id = ?').run(nodeId);

    if (this.vssEnabled) {
      // Get the rowid before deleting
      const mapping = this.db
        .prepare('SELECT rowid FROM vss_map WHERE node_id = ?')
        .get(nodeId) as { rowid: number } | undefined;

      if (mapping) {
        this.db.prepare('DELETE FROM vss_vectors WHERE rowid = ?').run(mapping.rowid);
        this.db.prepare('DELETE FROM vss_map WHERE node_id = ?').run(nodeId);
      }
    }
  }

  /**
   * Search for similar vectors
   *
   * @param queryEmbedding - Query vector to search for
   * @param options - Search options
   * @returns Array of node IDs with similarity scores
   */
  search(
    queryEmbedding: Float32Array,
    options: VectorSearchOptions = {}
  ): Array<{ nodeId: string; score: number }> {
    const { limit = 10, minScore = 0 } = options;

    if (this.vssEnabled) {
      return this.searchWithVss(queryEmbedding, limit, minScore);
    } else {
      return this.searchBruteForce(queryEmbedding, limit, minScore);
    }
  }

  /**
   * Search using sqlite-vss KNN search
   */
  private searchWithVss(
    queryEmbedding: Float32Array,
    limit: number,
    minScore: number
  ): Array<{ nodeId: string; score: number }> {
    try {
      const vectorJson = JSON.stringify(Array.from(queryEmbedding));
      // Sanitize limit to prevent SQL injection (ensure it's a positive integer)
      const safeLimit = Math.max(1, Math.floor(limit));

      // Use VSS KNN search
      // The distance is L2 (euclidean), we need to convert to similarity score
      // Note: sqlite-vss requires LIMIT to be a literal, not a parameter
      const rows = this.db
        .prepare(
          `
          SELECT
            vss_map.node_id,
            vss_vectors.distance
          FROM vss_vectors
          JOIN vss_map ON vss_map.rowid = vss_vectors.rowid
          WHERE vss_search(vss_vectors.embedding, ?)
          LIMIT ${safeLimit}
        `
        )
        .all(vectorJson) as Array<{ node_id: string; distance: number }>;

      // Convert L2 distance to similarity score (1 / (1 + distance))
      return rows
        .map((row) => ({
          nodeId: row.node_id,
          score: 1 / (1 + row.distance),
        }))
        .filter((r) => r.score >= minScore);
    } catch (error) {
      // VSS search failed, fall back to brute force
      logWarn('VSS search failed, using brute-force', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.searchBruteForce(queryEmbedding, limit, minScore);
    }
  }

  /**
   * Brute-force search using cosine similarity
   */
  private searchBruteForce(
    queryEmbedding: Float32Array,
    limit: number,
    minScore: number
  ): Array<{ nodeId: string; score: number }> {
    // Get all vectors
    const rows = this.db
      .prepare('SELECT node_id, embedding FROM vectors')
      .all() as Array<{ node_id: string; embedding: Buffer }>;

    // Calculate cosine similarity for each
    const results: Array<{ nodeId: string; score: number }> = [];

    for (const row of rows) {
      const embedding = new Float32Array(row.embedding.buffer.slice(
        row.embedding.byteOffset,
        row.embedding.byteOffset + row.embedding.byteLength
      ));

      const score = TextEmbedder.cosineSimilarity(queryEmbedding, embedding);

      if (score >= minScore) {
        results.push({ nodeId: row.node_id, score });
      }
    }

    // Sort by score descending and limit
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }

  /**
   * Get count of stored vectors
   */
  getVectorCount(): number {
    const result = this.db
      .prepare('SELECT COUNT(*) as count FROM vectors')
      .get() as { count: number };
    return result.count;
  }

  /**
   * Check if a node has a vector
   */
  hasVector(nodeId: string): boolean {
    const result = this.db
      .prepare('SELECT 1 FROM vectors WHERE node_id = ? LIMIT 1')
      .get(nodeId);
    return !!result;
  }

  /**
   * Get all node IDs that have vectors
   */
  getIndexedNodeIds(): string[] {
    const rows = this.db
      .prepare('SELECT node_id FROM vectors')
      .all() as Array<{ node_id: string }>;
    return rows.map((r) => r.node_id);
  }

  /**
   * Clear all vectors
   */
  clear(): void {
    this.db.prepare('DELETE FROM vectors').run();

    if (this.vssEnabled) {
      this.db.prepare('DELETE FROM vss_vectors').run();
      this.db.prepare('DELETE FROM vss_map').run();
    }
  }

  /**
   * Rebuild VSS index from vectors table
   *
   * Useful after bulk operations or if VSS index gets out of sync.
   */
  rebuildVssIndex(): void {
    if (!this.vssEnabled) {
      return;
    }

    // Clear VSS tables
    this.db.prepare('DELETE FROM vss_vectors').run();
    this.db.prepare('DELETE FROM vss_map').run();

    // Reload from vectors table
    const rows = this.db
      .prepare('SELECT node_id, embedding FROM vectors')
      .all() as Array<{ node_id: string; embedding: Buffer }>;

    this.db.transaction(() => {
      for (const row of rows) {
        const embedding = new Float32Array(row.embedding.buffer.slice(
          row.embedding.byteOffset,
          row.embedding.byteOffset + row.embedding.byteLength
        ));
        this.storeInVss(row.node_id, embedding);
      }
    })();
  }
}

/**
 * Create a vector search manager
 */
export function createVectorSearch(
  db: Database.Database,
  dimension?: number
): VectorSearchManager {
  return new VectorSearchManager(db, dimension);
}
