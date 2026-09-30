/**
 * Runs a SCIP indexer and installs its output, guarded:
 *
 * 1. snapshot the content hash of every file of the language (the hash gate's
 *    reference point — taken BEFORE the indexer reads anything)
 * 2. run the indexer, niced, into a temp file
 * 3. refuse the new index when its resolved-call count dropped more than
 *    20% below the installed one (a half-broken build usually shows up as a
 *    collapse in resolution, not as a failed exit) — the old index stays
 * 4. otherwise swap it in atomically, then write the snapshot
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { ROLE_DEFINITION, ScipIndex, isLocalSymbol, loadScipIndex, parseSymbol } from './reader';
import { resolveIndexer } from './indexers';
import { callShape } from './sites';
import { ScipLanguage, ScipMeta, indexPath, metaPath, readMeta, snapshotHashes, writeFileAtomic } from './store';

/** Largest drop in resolved calls a new index may show before it is rejected. */
export const MAX_RESOLUTION_DROP = 0.2;

const INDEXER_TIMEOUT_MS = 30 * 60 * 1000;

export type ProduceResult =
  | { status: 'installed'; lang: ScipLanguage; documents: number; resolvedCalls: number; durationMs: number }
  | { status: 'skipped'; lang: ScipLanguage; reason: string }
  | { status: 'rejected'; lang: ScipLanguage; reason: string }
  | { status: 'failed'; lang: ScipLanguage; reason: string };

/**
 * Calls and instantiations the compiler resolved to a symbol the project itself
 * defines — the guard's measure of "how much the index resolved". Imports and
 * type references are left out on purpose: a broken build can keep those while
 * call resolution collapses. Reads the current sources for the call shape.
 */
export function resolvedCallCount(ix: ScipIndex, projectRoot: string): number {
  const defined = new Set<string>();
  for (const d of ix.documents) {
    for (const o of d.occurrences) if (o.roles & ROLE_DEFINITION && !isLocalSymbol(o.symbol)) defined.add(o.symbol);
  }
  let n = 0;
  for (const d of ix.documents) {
    let lines: string[];
    try {
      lines = fs.readFileSync(path.join(projectRoot, d.relativePath), 'utf8').split(/\r?\n/);
    } catch {
      continue; // unreadable source: its calls can't be told from other references
    }
    for (const o of d.occurrences) {
      if (o.roles & ROLE_DEFINITION || !defined.has(o.symbol)) continue;
      const kind = parseSymbol(o.symbol)?.last.kind;
      const shape = callShape(o, lines, d.positionEncoding);
      if ((kind === 'method' || kind === 'term') && shape === 'call') n++;
      else if (kind === 'type' && shape) n++;
    }
  }
  return n;
}

export interface ProduceOptions {
  /** install even when the regression guard would reject */
  force?: boolean;
  /** run under `nice` (background reindex) */
  nice?: boolean;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export async function produceIndex(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, opts: ProduceOptions = {}
): Promise<ProduceResult> {
  const final = indexPath(projectRoot, lang);
  const tmp = `${final}.${process.pid}.tmp`;
  const indexer = resolveIndexer(projectRoot, lang, tmp);
  if ('skip' in indexer) return { status: 'skipped', lang, reason: indexer.skip };

  const started = Date.now();
  const hashes = snapshotHashes(db, projectRoot, lang);
  fs.mkdirSync(path.dirname(final), { recursive: true });
  try {
    const useNice = opts.nice && process.platform !== 'win32';
    const [cmd, args] = useNice ? ['nice', ['-n', '10', indexer.cmd, ...indexer.args]] : [indexer.cmd, indexer.args];
    opts.log?.(`running ${indexer.cmd} ${indexer.args.join(' ')}`);
    const { code, stderr } = await run(cmd, args, projectRoot, indexer.env, opts.signal);
    if (code !== 0) return { status: 'failed', lang, reason: `${indexer.cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}` };
    if (!fs.existsSync(tmp)) return { status: 'failed', lang, reason: `${indexer.cmd} exited 0 but wrote no index at ${tmp}` };

    let ix: ScipIndex;
    try {
      ix = loadScipIndex(tmp);
    } catch (err) {
      return { status: 'failed', lang, reason: err instanceof Error ? err.message : String(err) };
    }
    const resolvedCalls = resolvedCallCount(ix, projectRoot);
    const previous = fs.existsSync(final) ? readMeta(projectRoot, lang)?.resolvedCalls ?? null : null;
    if (!opts.force && previous !== null && resolvedCalls < previous * (1 - MAX_RESOLUTION_DROP)) {
      return {
        status: 'rejected', lang,
        reason: `resolved calls fell from ${previous} to ${resolvedCalls} (>${MAX_RESOLUTION_DROP * 100}% drop) — kept the previous index; fix the build or pass --force`,
      };
    }
    // Swap order: index first, then the snapshot that vouches for it. A crash
    // between the two leaves a new index under an old snapshot, which only makes
    // more documents read as stale — never a wrong edge.
    fs.renameSync(tmp, final);
    const meta: ScipMeta = { tool: ix.toolName, toolVersion: ix.toolVersion, producedAt: started, hashes, resolvedCalls };
    writeFileAtomic(metaPath(projectRoot, lang), JSON.stringify(meta));
    return { status: 'installed', lang, documents: ix.documents.length, resolvedCalls, durationMs: Date.now() - started };
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function run(
  cmd: string, args: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], signal, timeout: INDEXER_TIMEOUT_MS });
    } catch (err) {
      resolve({ code: -1, stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-8192);
    });
    child.on('error', (err) => resolve({ code: -1, stderr: err.message }));
    child.on('close', (code) => resolve({ code, stderr }));
  });
}
