/**
 * Runs a SCIP indexer and installs its output, guarded:
 *
 * 1. snapshot the content hash of every file of the language (the hash gate's
 *    reference point — taken BEFORE the indexer reads anything)
 * 2. run the indexer into a temp file — as one process, or one per
 *    sub-project with the outputs concatenated (see IndexerRun)
 * 3. refuse the new index when its resolved-call count dropped more than
 *    20% below the installed one (a half-broken build usually shows up as a
 *    collapse in resolution, not as a failed exit) — the old index stays
 * 4. otherwise swap it in atomically, then write the snapshot
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { Compactor } from './compact';
import { referenceSites } from './sites';
import { INDEXERS, IndexerRun, ResolvedIndexer, resolveIndexer } from './indexers';
import { ScipDecodeError } from './reader';
import { ScipLanguage, indexPath, installIndex, readMeta, snapshotHashes } from './store';

/** Largest drop in resolved calls a new index may show before it is rejected. */
const MAX_RESOLUTION_DROP = 0.2;

const INDEXER_TIMEOUT_MS = 30 * 60 * 1000;

export type ProduceResult =
  | { status: 'installed'; lang: ScipLanguage; documents: number; resolvedCalls: number; durationMs: number; warnings: string[] }
  | { status: 'skipped'; lang: ScipLanguage; reason: string }
  | { status: 'rejected'; lang: ScipLanguage; reason: string }
  | { status: 'failed'; lang: ScipLanguage; reason: string };

export interface ProduceOptions {
  /** install even when the regression guard would reject */
  force?: boolean;
  log?: (msg: string) => void;
}

export async function produceIndex(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, opts: ProduceOptions = {}
): Promise<ProduceResult> {
  const final = indexPath(projectRoot, lang);
  const raw = `${final}.${process.pid}.raw`; // the indexer's own output, compacted into the installed index
  fs.mkdirSync(path.dirname(final), { recursive: true }); // where the indexer writes `raw`
  const indexer = resolveIndexer(projectRoot, lang, raw);
  if ('skip' in indexer) return { status: 'skipped', lang, reason: indexer.skip };

  const started = Date.now();
  const hashes = snapshotHashes(db, projectRoot, INDEXERS[lang].codegraphLanguages);
  const warnings: string[] = indexer.warning ? [indexer.warning] : [];
  if (indexer.warning) opts.log?.(`${lang}: ${indexer.warning}`);
  try {
    const pool = await runAll(projectRoot, indexer, opts);
    const parts = indexer.runs.flatMap(r => pool.outputs.get(r) ?? []); // plan order, whatever finished first
    if (parts.length === 0) {
      return {
        status: 'failed', lang,
        reason: pool.failures.length === 1 ? pool.failures[0]! : `all ${pool.failures.length} runs failed; first: ${pool.failures[0]}`,
      };
    }
    for (const f of pool.failures) warnings.push(`${f} — its files stay heuristic-only`);

    // Compact while combining: one part in memory at a time (see compact.ts). codegraph's
    // references are what compaction keeps the SCIP references for.
    const compact = new Compactor(projectRoot, referenceSites(db));
    try {
      for (const p of parts) compact.add(fs.readFileSync(p));
    } catch (err) {
      if (!(err instanceof ScipDecodeError)) throw err;
      return { status: 'failed', lang, reason: `${indexer.cmd} wrote an unreadable index: ${err.message}` };
    }
    if (compact.paths.length === 0) return { status: 'failed', lang, reason: `${indexer.cmd} wrote an index with no documents` };
    const resolvedCalls = compact.resolvedCalls();
    const previous = fs.existsSync(final) ? readMeta(projectRoot, lang)?.resolvedCalls ?? null : null;
    if (!opts.force && previous !== null && resolvedCalls < previous * (1 - MAX_RESOLUTION_DROP)) {
      return {
        status: 'rejected', lang,
        reason: `resolved calls fell from ${previous} to ${resolvedCalls} (>${MAX_RESOLUTION_DROP * 100}% drop) — kept the previous index; fix the build or pass --force`,
      };
    }
    installIndex(projectRoot, lang, f => compact.write(f), {
      tool: compact.meta!.toolName, toolVersion: compact.meta!.toolVersion, producedAt: started, hashes, resolvedCalls,
    });
    return { status: 'installed', lang, documents: compact.paths.length, resolvedCalls, durationMs: Date.now() - started, warnings };
  } finally {
    sweep(raw);
  }
}

/** Removes what a run of `raw` may leave: the output and its parts (`.partN`), which adapters name after it. */
function sweep(raw: string): void {
  const dir = path.dirname(raw);
  const base = path.basename(raw);
  for (const f of fs.readdirSync(dir)) if (f === base || f.startsWith(`${base}.`)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}

/** Runs `fn` over `items`, at most `width` at a time (a small pool, not one promise per item). */
async function inPool<T>(items: readonly T[], width: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(width, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
  }));
}

interface Runs {
  /** each run's outputs: its own, or its fallback parts' */
  outputs: Map<IndexerRun, string[]>;
  failures: string[];
}

/**
 * Every run of `indexer`. Heavy runs one at a time (parallel heavy runs would
 * stack the very memory the split exists to bound), then light runs in a small
 * pool. A failed run with a fallback is retried as its parts; any other failed
 * part of a split run is a warning — its files stay heuristic-only. Only a
 * total failure fails (see produceIndex).
 */
async function runAll(projectRoot: string, indexer: ResolvedIndexer, opts: ProduceOptions): Promise<Runs> {
  const { runs } = indexer;
  const done: Runs = { outputs: new Map(), failures: [] };
  let started = 0;
  const attempt = async (r: IndexerRun): Promise<string[]> => {
    opts.log?.(`${runs.length > 1 ? `[${++started}/${runs.length}] ${r.label}: ` : ''}running ${indexer.cmd} ${r.args.slice(0, 8).join(' ')}${r.args.length > 8 ? ` … (+${r.args.length - 8} more)` : ''}`);
    const why = await runOnce(projectRoot, indexer, r);
    if (!why) return [r.output];
    if (r.fallback?.length) {
      opts.log?.(`${r.label}: failed as a batch, retrying its ${r.fallback.length} projects one by one — ${why}`);
      const parts: string[] = [];
      for (const f of r.fallback) parts.push(...await attempt(f));
      return parts;
    }
    done.failures.push(`${r.label}: ${why}`);
    opts.log?.(`${r.label}: failed — ${why}`);
    return [];
  };
  for (const r of runs.filter(r => !r.light)) done.outputs.set(r, await attempt(r));
  await inPool(runs.filter(r => r.light), lightConcurrency(), async r => { done.outputs.set(r, await attempt(r)); });
  return done;
}

/** One indexer run: why it failed (a non-zero exit, or no output), or null. */
async function runOnce(projectRoot: string, indexer: ResolvedIndexer, r: IndexerRun): Promise<string | null> {
  const { code, stderr } = await runIndexer(indexer.cmd, r.args, projectRoot, r.env ?? {});
  if (code !== 0) return `${indexer.cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`;
  return fs.existsSync(r.output) ? null : `${indexer.cmd} exited 0 but wrote no index at ${r.output}`;
}

/**
 * Light runs at once: up to 4, at most half the cores, and as many ~3 GB
 * processes as 60% of physical memory holds.
 */
function lightConcurrency(): number {
  const byMemory = Math.floor((os.totalmem() * 0.6) / (3 * 1024 ** 3));
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2), byMemory));
}

function runIndexer(
  cmd: string, args: string[], cwd: string, env: Record<string, string>
): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'], timeout: INDEXER_TIMEOUT_MS, windowsHide: true });
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
