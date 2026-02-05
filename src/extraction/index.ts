/**
 * Extraction Orchestrator
 *
 * Coordinates file scanning, parsing, and database storage.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  Language,
  FileRecord,
  ExtractionResult,
  ExtractionError,
  CodeGraphConfig,
} from '../types';
import { QueryBuilder } from '../db/queries';
import { extractFromSource } from './tree-sitter';
import { detectLanguage, isLanguageSupported } from './grammars';
import { logDebug } from '../errors';
import picomatch from 'picomatch';

/**
 * Progress callback for indexing operations
 */
export interface IndexProgress {
  phase: 'scanning' | 'parsing' | 'storing' | 'resolving';
  current: number;
  total: number;
  currentFile?: string;
}

/**
 * Result of an indexing operation
 */
export interface IndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: ExtractionError[];
  durationMs: number;
}

/**
 * Result of a sync operation
 */
export interface SyncResult {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
}

/**
 * Calculate SHA256 hash of file contents
 */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if a path matches a glob pattern using picomatch.
 * Using a well-tested library prevents ReDoS from crafted patterns.
 */
function matchesGlob(filePath: string, pattern: string): boolean {
  return picomatch.isMatch(filePath, pattern, { dot: true });
}

/**
 * Check if a file should be included based on config
 */
export function shouldIncludeFile(
  filePath: string,
  config: CodeGraphConfig
): boolean {
  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesGlob(filePath, pattern)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesGlob(filePath, pattern)) {
      return true;
    }
  }

  return false;
}

/**
 * Recursively scan directory for source files
 */
export function scanDirectory(
  rootDir: string,
  config: CodeGraphConfig,
  onProgress?: (current: number, file: string) => void
): string[] {
  const files: string[] = [];
  let count = 0;
  // Track visited real paths to detect symlink cycles
  const visitedDirs = new Set<string>();

  function walk(dir: string): void {
    // Resolve real path to detect symlink cycles
    let realDir: string;
    try {
      realDir = fs.realpathSync(dir);
    } catch {
      logDebug('Skipping unresolvable directory', { dir });
      return;
    }

    if (visitedDirs.has(realDir)) {
      logDebug('Skipping already-visited directory (symlink cycle)', { dir, realDir });
      return;
    }
    visitedDirs.add(realDir);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      logDebug('Skipping unreadable directory', { dir, error: String(error) });
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(rootDir, fullPath);

      if (entry.isDirectory() || entry.isSymbolicLink()) {
        // For symlinks, check if they point to a directory
        if (entry.isSymbolicLink()) {
          try {
            const stat = fs.statSync(fullPath);
            if (!stat.isDirectory()) {
              // Symlink to a file — treat as file below
              if (stat.isFile() && shouldIncludeFile(relativePath, config)) {
                files.push(relativePath);
                count++;
                if (onProgress) {
                  onProgress(count, relativePath);
                }
              }
              continue;
            }
          } catch {
            logDebug('Skipping broken symlink', { path: fullPath });
            continue;
          }
        }

        // Check if directory should be excluded
        const dirPattern = relativePath + '/';
        let excluded = false;
        for (const pattern of config.exclude) {
          if (matchesGlob(dirPattern, pattern) || matchesGlob(relativePath, pattern)) {
            excluded = true;
            break;
          }
        }
        if (!excluded) {
          walk(fullPath);
        }
      } else if (entry.isFile()) {
        if (shouldIncludeFile(relativePath, config)) {
          files.push(relativePath);
          count++;
          if (onProgress) {
            onProgress(count, relativePath);
          }
        }
      }
    }
  }

  walk(rootDir);
  return files;
}

/**
 * Extraction orchestrator
 */
export class ExtractionOrchestrator {
  private rootDir: string;
  private config: CodeGraphConfig;
  private queries: QueryBuilder;

  constructor(rootDir: string, config: CodeGraphConfig, queries: QueryBuilder) {
    this.rootDir = rootDir;
    this.config = config;
    this.queries = queries;
  }

  /**
   * Index all files in the project
   */
  async indexAll(
    onProgress?: (progress: IndexProgress) => void,
    signal?: AbortSignal
  ): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    // Phase 1: Scan for files
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const files = scanDirectory(this.rootDir, this.config, (current, file) => {
      onProgress?.({
        phase: 'scanning',
        current,
        total: 0,
        currentFile: file,
      });
    });

    if (signal?.aborted) {
      return {
        success: false,
        filesIndexed: 0,
        filesSkipped: 0,
        nodesCreated: 0,
        edgesCreated: 0,
        errors: [{ message: 'Aborted', severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    // Phase 2: Parse files
    const total = files.length;

    for (let i = 0; i < files.length; i++) {
      if (signal?.aborted) {
        return {
          success: false,
          filesIndexed,
          filesSkipped,
          nodesCreated: totalNodes,
          edgesCreated: totalEdges,
          errors: [{ message: 'Aborted', severity: 'error' }, ...errors],
          durationMs: Date.now() - startTime,
        };
      }

      const filePath = files[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else if (result.errors.length === 0) {
        filesSkipped++;
      }
    }

    // Phase 3: Resolve references
    onProgress?.({
      phase: 'resolving',
      current: 0,
      total: 1,
    });

    // TODO: Implement reference resolution in Phase 3

    return {
      success: errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index specific files
   */
  async indexFiles(filePaths: string[]): Promise<IndexResult> {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    let filesIndexed = 0;
    let filesSkipped = 0;
    let totalNodes = 0;
    let totalEdges = 0;

    for (const filePath of filePaths) {
      const result = await this.indexFile(filePath);

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }

      if (result.nodes.length > 0) {
        filesIndexed++;
        totalNodes += result.nodes.length;
        totalEdges += result.edges.length;
      } else {
        filesSkipped++;
      }
    }

    return {
      success: errors.filter((e) => e.severity === 'error').length === 0,
      filesIndexed,
      filesSkipped,
      nodesCreated: totalNodes,
      edgesCreated: totalEdges,
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Index a single file
   */
  async indexFile(relativePath: string): Promise<ExtractionResult> {
    const fullPath = path.join(this.rootDir, relativePath);

    // Check file exists and is readable
    let content: string;
    let stats: fs.Stats;
    try {
      stats = fs.statSync(fullPath);
      content = fs.readFileSync(fullPath, 'utf-8');
    } catch (error) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
            severity: 'error',
          },
        ],
        durationMs: 0,
      };
    }

    // Check file size
    if (stats.size > this.config.maxFileSize) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `File exceeds max size (${stats.size} > ${this.config.maxFileSize})`,
            severity: 'warning',
          },
        ],
        durationMs: 0,
      };
    }

    // Detect language
    const language = detectLanguage(relativePath);
    if (!isLanguageSupported(language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [],
        durationMs: 0,
      };
    }

    // Extract from source
    const result = extractFromSource(relativePath, content, language);

    // Store in database
    if (result.nodes.length > 0 || result.errors.length === 0) {
      this.storeExtractionResult(relativePath, content, language, stats, result);
    }

    return result;
  }

  /**
   * Store extraction result in database
   */
  private storeExtractionResult(
    filePath: string,
    content: string,
    language: Language,
    stats: fs.Stats,
    result: ExtractionResult
  ): void {
    const contentHash = hashContent(content);

    // Check if file already exists and hasn't changed
    const existingFile = this.queries.getFileByPath(filePath);
    if (existingFile && existingFile.contentHash === contentHash) {
      return; // No changes
    }

    // Delete existing data for this file
    if (existingFile) {
      this.queries.deleteFile(filePath);
    }

    // Insert nodes
    if (result.nodes.length > 0) {
      this.queries.insertNodes(result.nodes);
    }

    // Insert edges
    if (result.edges.length > 0) {
      this.queries.insertEdges(result.edges);
    }

    // Insert unresolved references
    for (const ref of result.unresolvedReferences) {
      this.queries.insertUnresolvedRef(ref);
    }

    // Insert file record
    const fileRecord: FileRecord = {
      path: filePath,
      contentHash,
      language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      indexedAt: Date.now(),
      nodeCount: result.nodes.length,
      errors: result.errors.length > 0 ? result.errors : undefined,
    };
    this.queries.upsertFile(fileRecord);
  }

  /**
   * Sync with current file state
   */
  async sync(onProgress?: (progress: IndexProgress) => void): Promise<SyncResult> {
    const startTime = Date.now();
    let filesChecked = 0;
    let filesAdded = 0;
    let filesModified = 0;
    let filesRemoved = 0;
    let nodesUpdated = 0;

    // Get current files on disk
    onProgress?.({
      phase: 'scanning',
      current: 0,
      total: 0,
    });

    const currentFiles = new Set(scanDirectory(this.rootDir, this.config));
    filesChecked = currentFiles.size;

    // Get tracked files from database
    const trackedFiles = this.queries.getAllFiles();

    // Find files to remove (in DB but not on disk)
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        this.queries.deleteFile(tracked.path);
        filesRemoved++;
      }
    }

    // Find files to add or update
    const filesToIndex: string[] = [];

    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file during sync', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedFiles.find((f) => f.path === filePath);

      if (!tracked) {
        // New file
        filesToIndex.push(filePath);
        filesAdded++;
      } else if (tracked.contentHash !== contentHash) {
        // Modified file
        filesToIndex.push(filePath);
        filesModified++;
      }
    }

    // Index changed files
    const total = filesToIndex.length;
    for (let i = 0; i < filesToIndex.length; i++) {
      const filePath = filesToIndex[i]!;
      onProgress?.({
        phase: 'parsing',
        current: i + 1,
        total,
        currentFile: filePath,
      });

      const result = await this.indexFile(filePath);
      nodesUpdated += result.nodes.length;
    }

    return {
      filesChecked,
      filesAdded,
      filesModified,
      filesRemoved,
      nodesUpdated,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Get files that have changed since last index
   */
  getChangedFiles(): { added: string[]; modified: string[]; removed: string[] } {
    const currentFiles = new Set(scanDirectory(this.rootDir, this.config));
    const trackedFiles = this.queries.getAllFiles();

    const added: string[] = [];
    const modified: string[] = [];
    const removed: string[] = [];

    // Find removed files
    for (const tracked of trackedFiles) {
      if (!currentFiles.has(tracked.path)) {
        removed.push(tracked.path);
      }
    }

    // Find added and modified files
    for (const filePath of currentFiles) {
      const fullPath = path.join(this.rootDir, filePath);
      let content: string;
      try {
        content = fs.readFileSync(fullPath, 'utf-8');
      } catch (error) {
        logDebug('Skipping unreadable file while detecting changes', { filePath, error: String(error) });
        continue;
      }

      const contentHash = hashContent(content);
      const tracked = trackedFiles.find((f) => f.path === filePath);

      if (!tracked) {
        added.push(filePath);
      } else if (tracked.contentHash !== contentHash) {
        modified.push(filePath);
      }
    }

    return { added, modified, removed };
  }
}

// Re-export useful types and functions
export { extractFromSource } from './tree-sitter';
export { detectLanguage, isLanguageSupported, getSupportedLanguages } from './grammars';
