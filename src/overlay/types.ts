/**
 * Overlay System Types
 *
 * Type definitions for the remote graph overlay system that enables
 * team-friendly code intelligence by combining a shared base graph
 * with local feature branch changes.
 *
 * Architecture:
 *   Remote base graph (main branch, built by CI)
 *         +
 *   Local overlay (feature branch diffs only)
 *         =
 *   Seamless merged view for LLM queries
 */

/**
 * Configuration for connecting to a remote base graph.
 *
 * The base graph represents the main/development branch's complete
 * code graph, built and hosted centrally (e.g., by CI/CD).
 */
export interface RemoteGraphConfig {
  /**
   * URL or file path to the remote database.
   *
   * Supported schemes:
   * - Local file paths: `/path/to/base-graph.db`
   * - file:// URIs: `file:///path/to/base-graph.db`
   * - HTTP(S): `https://ci-server.example.com/codegraph/base-graph.db`
   */
  url: string;

  /**
   * Base branch name to compare against for diff detection.
   * Typically 'main' or 'development'.
   */
  baseBranch: string;

  /**
   * Local cache directory for the downloaded database.
   * Defaults to `.codegraph/` within the project root.
   */
  cacheDir?: string;

  /**
   * Cache time-to-live in milliseconds.
   * The cached base graph is considered fresh within this period.
   * Default: 3_600_000 (1 hour).
   */
  cacheTTL?: number;
}

/**
 * Result of branch diff detection, categorizing files by their
 * change status relative to the base branch.
 */
export interface BranchDiffResult {
  /** Files added on the feature branch (not present on base) */
  added: string[];

  /** Files modified on the feature branch (content differs from base) */
  modified: string[];

  /** Files deleted on the feature branch (present on base but removed) */
  deleted: string[];

  /** Name of the current feature branch */
  currentBranch: string;

  /** Name of the base branch being compared against */
  baseBranch: string;
}
