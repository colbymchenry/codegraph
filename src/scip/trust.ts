/**
 * Workspace trust for SCIP indexers.
 *
 * An indexer run executes what the project controls: `codegraph.json`'s
 * `scip.<lang>` block picks the command, its arguments and its environment,
 * and scip-typescript loads the project's own TypeScript. So indexers run only
 * in a project the user trusted from the CLI (`codegraph scip trust`, or
 * confirming `codegraph scip index`), and only while that block is what they
 * trusted: an edit to it (a pull, a branch switch) stops every run until the
 * user trusts the project again.
 *
 * Merges are gated the same way, though a merge runs nothing: an index shipped
 * inside the project (a committed `.codegraph/scip/`) would otherwise rewrite
 * its graph. A trusted project's repository can already run code through its
 * indexers, so an index it ships gives it nothing more.
 *
 * The record lives in `~/.codegraph/scip-trust.json`, outside every project,
 * so a repository can't ship its own trust.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalProjectRoot } from '../directory';
import { PROJECT_CONFIG_FILENAME } from '../project-config';
import { writeFileAtomic } from './store';

export type TrustState = 'trusted' | 'untrusted' | 'changed';

interface TrustRecord {
  /** configDigest of the `scip` block the user trusted, as readScipBlock read it */
  digest: string;
  trustedAt: string;
}

interface TrustFile {
  projects: Record<string, TrustRecord>;
}

export function trustFilePath(): string {
  return path.join(os.homedir(), '.codegraph', 'scip-trust.json');
}

/**
 * The `scip` block of the project's `codegraph.json` as it stands (`block` is
 * undefined when there is none), or why it can't be read. What trust is
 * granted for; its shape is the indexers' to validate (indexers/index.ts).
 */
export type ScipBlock = { block: unknown } | { error: string };

export function readScipBlock(projectRoot: string): ScipBlock {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(projectRoot, PROJECT_CONFIG_FILENAME), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { block: undefined };
    return { error: `can't read ${PROJECT_CONFIG_FILENAME}: ${err instanceof Error ? err.message : String(err)}` };
  }
  try {
    return { block: (JSON.parse(raw) as { scip?: unknown } | null)?.scip };
  } catch (err) {
    return { error: `${PROJECT_CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** A digest of `config`: key order doesn't change it. */
export function configDigest(config: unknown): string {
  return crypto.createHash('sha256').update(stableJson(config)).digest('hex');
}

function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map(k => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** The trust file's contents; empty when there is none. A file that can't be read or parsed is an error. */
function readTrustFile(): TrustFile {
  let raw: string;
  try {
    raw = fs.readFileSync(trustFilePath(), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} };
    throw new Error(`can't read ${trustFilePath()}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${trustFilePath()} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  const projects = (parsed as { projects?: unknown } | null)?.projects;
  if (typeof projects !== 'object' || projects === null || Array.isArray(projects)) {
    throw new Error(`${trustFilePath()} has no "projects" object`);
  }
  return { projects: projects as Record<string, TrustRecord> };
}

/**
 * Whether indexers may run in `projectRoot` with its `scip` block as `read`
 * (read now by default; a caller that goes on to use the block passes the read
 * it uses, so what was checked is what runs).
 */
export function trustState(projectRoot: string, read: ScipBlock = readScipBlock(projectRoot)): TrustState {
  const record = readTrustFile().projects[canonicalProjectRoot(projectRoot)];
  if (!record) return 'untrusted';
  return record.digest === configDigest(read) ? 'trusted' : 'changed';
}

/** Trust `projectRoot` to run indexers while its `scip` block stays as `read` (the one the user reviewed). */
export function trustProject(projectRoot: string, read: ScipBlock = readScipBlock(projectRoot)): void {
  const file = readTrustFile();
  file.projects[canonicalProjectRoot(projectRoot)] = { digest: configDigest(read), trustedAt: new Date().toISOString() };
  writeFileAtomic(trustFilePath(), `${JSON.stringify(file, null, 2)}\n`);
}

/** Why an indexer won't run, for a state other than 'trusted'. */
export function untrustedReason(state: Exclude<TrustState, 'trusted'>): string {
  return state === 'changed'
    ? "codegraph.json's scip block changed since you trusted this project — run `codegraph scip trust` to review it"
    : 'this project is not trusted to run SCIP indexers — run `codegraph scip trust` to review and allow them';
}
