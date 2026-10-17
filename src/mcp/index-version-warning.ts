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

  /** Claim the warning for a resolved project root. True only on the first claim. */
  claim(projectRoot: string): boolean {
    if (this.warnedProjects.has(projectRoot)) return false;
    this.warnedProjects.add(projectRoot);
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
    `CodeGraph ${formatRunningVersion()}. Run \`codegraph index\` in the project to ` +
    'rebuild it before relying on newly supported symbols and relationships.'
  );
}
