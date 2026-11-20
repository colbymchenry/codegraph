import { canonicalProjectRoot } from '../directory';
import { EXTRACTION_VERSION } from '../extraction/extraction-version';
import { CodeGraphPackageVersion } from './version';

export interface IndexBuildInfo {
  version: string | null;
  extractionVersion: number | null;
}

export const INDEX_VERSION_WARNING_PREFIX =
  "⚠️ This project's CodeGraph index predates the running extraction engine.";

/** Per-MCP-client bookkeeping for the one-time stale-index warning. */
export class IndexVersionWarningState {
  private readonly warnedProjects = new Set<string>();

  /**
   * Claim the warning for a project root, however it is spelled: the proxy and
   * the handler reach one project by different paths. True only on the first claim.
   */
  claim(projectRoot: string): boolean {
    const key = canonicalProjectRoot(projectRoot);
    if (this.warnedProjects.has(key)) return false;
    this.warnedProjects.add(key);
    return true;
  }
}

/** Human-readable engine identity recorded in an index's metadata. */
export function formatIndexBuildVersion(build: IndexBuildInfo): string {
  const extraction = build.extractionVersion ?? 'unknown';
  if (!build.version) return `an earlier CodeGraph version (extraction ${extraction})`;
  return `CodeGraph v${build.version.replace(/^v/, '')} (extraction ${extraction})`;
}

/** Human-readable identity of the process currently serving MCP. */
export function formatRunningVersion(): string {
  return `v${CodeGraphPackageVersion.replace(/^v/, '')} (extraction ${EXTRACTION_VERSION})`;
}

/** Actionable warning prepended to the first successful response for a stale project. */
export function formatIndexVersionWarning(build: IndexBuildInfo): string {
  return (
    `${INDEX_VERSION_WARNING_PREFIX} ` +
    `It was built with ${formatIndexBuildVersion(build)}; the running engine is ` +
    `CodeGraph ${formatRunningVersion()}. Answers can miss symbols and relationships this ` +
    "engine adds. Indexing is the user's decision: they can run `codegraph index` in the " +
    'project to rebuild it.'
  );
}
