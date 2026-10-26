/**
 * One project's index summary — the fields the `codegraph_projects` MCP tool
 * and `codegraph projects` share.
 *
 * Both surfaces open a project's index and read the same numbers, so the
 * derivation lives here rather than in either caller: two copies would
 * eventually disagree about what "up to date" means. The MCP server passes an
 * out-of-process `measureChanges` (a large checkout must not stall its shared
 * transport); the CLI reads the opened instance directly, exactly as
 * `codegraph status` does.
 */
import * as path from 'path';
import CodeGraph from './index';
import { getCodeGraphDir, isInitialized } from './directory';

export interface PendingChanges {
  added: number;
  modified: number;
  removed: number;
}

/**
 * `up-to-date` / `out-of-date` compare the index with the working tree;
 * `unknown` means the change check timed out (never assume zero);
 * `not-indexed` means the registry entry outlived its `.codegraph/`.
 */
export type ProjectStatus = 'up-to-date' | 'out-of-date' | 'unknown' | 'not-indexed' | 'error';

export interface ProjectSummary {
  projectPath: string;
  indexPath: string;
  registeredAt: string | null;
  /** ISO timestamp of the newest indexed file, or null when nothing is indexed. */
  lastIndexedAt: string | null;
  stats: { fileCount: number; nodeCount: number; edgeCount: number } | null;
  /** Null when the change check did not complete. */
  pendingChanges: PendingChanges | null;
  status: ProjectStatus;
  /** Failure detail for `status: 'error'`. */
  error?: string;
}

export interface SummarizeProjectOptions {
  registeredAt?: string | null;
  /**
   * Measure working-tree changes out of process. When omitted, the opened
   * instance's own `getChangedFiles()` is used.
   */
  measureChanges?: (projectRoot: string) => Promise<PendingChanges | null>;
  /** An already-open instance for this project (the MCP server's default). */
  reuse?: CodeGraph;
}

/** Summarize one project. Never throws: failures become a reportable status. */
export async function summarizeProject(
  projectRoot: string,
  options: SummarizeProjectOptions = {}
): Promise<ProjectSummary> {
  const projectPath = path.resolve(projectRoot);
  const base = {
    projectPath,
    indexPath: getCodeGraphDir(projectPath),
    registeredAt: options.registeredAt ?? null,
  };

  if (!isInitialized(projectPath)) {
    return {
      ...base,
      lastIndexedAt: null,
      stats: null,
      pendingChanges: null,
      status: 'not-indexed',
    };
  }

  let cg = options.reuse ?? null;
  const owns = cg === null;
  try {
    cg ??= CodeGraph.openSync(projectPath);
    const raw = cg.getStats();
    const lastIndexedMs = cg.getLastIndexedAt();

    let pendingChanges: PendingChanges | null;
    if (options.measureChanges) {
      pendingChanges = await options.measureChanges(projectPath);
    } else {
      const changed = cg.getChangedFiles();
      pendingChanges = {
        added: changed.added.length,
        modified: changed.modified.length,
        removed: changed.removed.length,
      };
    }

    const status: ProjectStatus = pendingChanges === null
      ? 'unknown'
      : pendingChanges.added + pendingChanges.modified + pendingChanges.removed === 0
        ? 'up-to-date'
        : 'out-of-date';

    return {
      ...base,
      lastIndexedAt: lastIndexedMs == null ? null : new Date(lastIndexedMs).toISOString(),
      stats: {
        fileCount: raw.fileCount,
        nodeCount: raw.nodeCount,
        edgeCount: raw.edgeCount,
      },
      pendingChanges,
      status,
    };
  } catch (err) {
    return {
      ...base,
      lastIndexedAt: null,
      stats: null,
      pendingChanges: null,
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (owns) {
      try {
        cg?.close();
      } catch {
        /* already closed */
      }
    }
  }
}
