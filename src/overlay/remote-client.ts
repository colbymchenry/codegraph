/**
 * Remote Graph Client
 *
 * Handles fetching and caching of remote base graph databases.
 * The remote base graph represents the main/development branch's
 * complete code graph, hosted on a file server or shared filesystem.
 *
 * Fetch lifecycle:
 *   1. Check local cache validity (TTL-based)
 *   2. If stale/missing, download from URL (file:// or http(s)://)
 *   3. Open the cached database read-only
 *   4. Return a QueryBuilder backed by the base graph
 */

import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import { DatabaseConnection } from '../db';
import { QueryBuilder } from '../db/queries';
import { RemoteGraphConfig } from './types';

/** Default cache TTL: 1 hour */
const DEFAULT_CACHE_TTL = 3_600_000;

/** Filename for the cached base graph database */
const BASE_GRAPH_FILENAME = 'base-graph.db';

/**
 * Client for fetching, caching, and opening remote base graph databases.
 *
 * Usage:
 * ```ts
 * const client = new RemoteGraphClient({
 *   url: 'https://ci.example.com/codegraph.db',
 *   baseBranch: 'main',
 * });
 * await client.fetch();
 * const baseQueries = client.open();
 * // ... use baseQueries for lookups ...
 * client.close();
 * ```
 */
export class RemoteGraphClient {
  private config: RemoteGraphConfig;
  private db: DatabaseConnection | null = null;
  private queries: QueryBuilder | null = null;
  private cachePath: string;

  constructor(config: RemoteGraphConfig) {
    this.config = config;
    const cacheDir = config.cacheDir || path.join(process.cwd(), '.codegraph');
    this.cachePath = path.join(cacheDir, BASE_GRAPH_FILENAME);
  }

  /**
   * Fetch the remote base graph database into the local cache.
   *
   * Skips the download if the cached copy is still within TTL.
   * Supports local file paths (with or without `file://` prefix)
   * and HTTP(S) URLs.
   *
   * @throws Error if the source is unreachable or the download fails
   */
  async fetch(): Promise<void> {
    // Ensure cache directory exists
    const cacheDir = path.dirname(this.cachePath);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    // Skip download if cache is fresh
    if (this.isCacheValid()) {
      return;
    }

    const url = this.config.url;

    if (url.startsWith('http://') || url.startsWith('https://')) {
      await this.downloadHttp(url, this.cachePath);
    } else {
      // Local file path (strip file:// prefix if present)
      const filePath = url.replace(/^file:\/\//, '');
      if (!fs.existsSync(filePath)) {
        throw new Error(`Remote base graph not found: ${filePath}`);
      }
      fs.copyFileSync(filePath, this.cachePath);
    }
  }

  /**
   * Open the cached base graph database and return a QueryBuilder.
   *
   * The database is opened in the default mode (WAL). Must call
   * {@link fetch} before calling this method.
   *
   * @returns QueryBuilder backed by the base graph database
   * @throws Error if the cache file does not exist
   */
  open(): QueryBuilder {
    if (this.queries) return this.queries;

    if (!fs.existsSync(this.cachePath)) {
      throw new Error(
        'Remote base graph not cached. Call fetch() first.'
      );
    }

    this.db = DatabaseConnection.open(this.cachePath);
    this.queries = new QueryBuilder(this.db.getDb());
    return this.queries;
  }

  /**
   * Close the database connection and release resources.
   * Safe to call multiple times.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.queries = null;
    }
  }

  /** Get the overlay configuration. */
  getConfig(): RemoteGraphConfig {
    return this.config;
  }

  /** Get the local cache path for the base graph database. */
  getCachePath(): string {
    return this.cachePath;
  }

  /**
   * Check whether the local cache is still within TTL.
   *
   * @returns true if the cached file exists and is younger than cacheTTL
   */
  isCacheValid(): boolean {
    if (!fs.existsSync(this.cachePath)) return false;
    const ttl = this.config.cacheTTL ?? DEFAULT_CACHE_TTL;
    const stat = fs.statSync(this.cachePath);
    return Date.now() - stat.mtimeMs < ttl;
  }

  /**
   * Download a file over HTTP(S), following one level of redirects.
   *
   * @param url    - Source URL
   * @param dest   - Local destination path
   */
  private downloadHttp(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proto = url.startsWith('https') ? https : http;
      const file = fs.createWriteStream(dest);

      proto
        .get(url, (response) => {
          // Follow one redirect
          if (
            (response.statusCode === 301 || response.statusCode === 302) &&
            response.headers.location
          ) {
            file.close();
            fs.unlinkSync(dest);
            this.downloadHttp(response.headers.location, dest)
              .then(resolve)
              .catch(reject);
            return;
          }

          if (response.statusCode !== 200) {
            file.close();
            fs.unlinkSync(dest);
            reject(
              new Error(
                `Failed to download remote base graph: HTTP ${response.statusCode}`
              )
            );
            return;
          }

          response.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
        })
        .on('error', (err) => {
          file.close();
          if (fs.existsSync(dest)) fs.unlinkSync(dest);
          reject(err);
        });
    });
  }
}
