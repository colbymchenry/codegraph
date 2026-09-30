/**
 * Runs a SCIP indexer and installs its output, guarded:
 *
 * 1. snapshot the content hash of every file of the language (the hash gate's
 *    reference point — taken BEFORE the indexer reads anything)
 * 2. run the indexer, niced, into a temp file — as one process, or one per
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
import { INDEXERS, IndexerRun, RUN_WARNING, resolveIndexer } from './indexers';
import { ScipDecodeError } from './reader';
import { ScipLanguage, ScipMeta, indexPath, metaPath, readMeta, snapshotHashes, writeFileAtomic } from './store';

/** Largest drop in resolved calls a new index may show before it is rejected. */
export const MAX_RESOLUTION_DROP = 0.2;

const INDEXER_TIMEOUT_MS = 30 * 60 * 1000;

export type ProduceResult =
  | { status: 'installed'; lang: ScipLanguage; documents: number; resolvedCalls: number; durationMs: number; warnings: string[] }
  | { status: 'skipped'; lang: ScipLanguage; reason: string }
  | { status: 'rejected'; lang: ScipLanguage; reason: string }
  | { status: 'failed'; lang: ScipLanguage; reason: string };

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
  fs.mkdirSync(path.dirname(final), { recursive: true }); // adapters may write helper files beside the output
  const indexer = resolveIndexer(projectRoot, lang, tmp);
  if ('skip' in indexer) return { status: 'skipped', lang, reason: indexer.skip };

  const started = Date.now();
  const hashes = snapshotHashes(db, projectRoot, INDEXERS[lang].codegraphLanguages);
  const warnings: string[] = indexer.warning ? [indexer.warning] : [];
  if (indexer.warning) opts.log?.(`${lang}: ${indexer.warning}`);
  const { runs } = indexer;
  const all = (rs: typeof runs): typeof runs => rs.flatMap(r => [r, ...all(r.fallback ?? [])]);
  try {
    // Heavy runs one at a time (parallel heavy runs would stack the very memory
    // the split exists to bound), then light runs in a small pool. A failed run
    // with a fallback is retried as its parts; any other failed part of a split
    // run is a warning — its files stay heuristic-only. Only a total failure fails.
    const outputs = new Map<IndexerRun, string[]>();
    const failures: string[] = [];
    let done = 0;
    const attempt = async (r: IndexerRun): Promise<string[]> => {
      if (opts.signal?.aborted) return [];
      opts.log?.(`${runs.length > 1 ? `[${++done}/${runs.length}] ${r.label}: ` : ''}running ${indexer.cmd} ${r.args.slice(0, 8).join(' ')}${r.args.length > 8 ? ` … (+${r.args.length - 8} more)` : ''}`);
      const useNice = opts.nice && process.platform !== 'win32';
      const [cmd, args] = useNice ? ['nice', ['-n', '10', indexer.cmd, ...r.args]] : [indexer.cmd, r.args];
      const { code, stderr } = await run(cmd, args, projectRoot, { ...indexer.env, ...r.env }, opts.signal);
      const why = code !== 0 ? `${indexer.cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`
        : !fs.existsSync(r.output) ? `${indexer.cmd} exited 0 but wrote no index at ${r.output}` : null;
      if (!why) {
        for (const w of stderr.split('\n')) if (w.startsWith(RUN_WARNING)) warnings.push(`${r.label}: ${w.slice(RUN_WARNING.length)} — its files stay heuristic-only`);
        return [r.output];
      }
      if (r.fallback?.length) {
        opts.log?.(`${r.label}: failed as a batch, retrying its ${r.fallback.length} projects one by one — ${why}`);
        const parts: string[] = [];
        for (const f of r.fallback) parts.push(...await attempt(f));
        return parts;
      }
      failures.push(`${r.label}: ${why}`);
      opts.log?.(`${r.label}: failed — ${why}`);
      return [];
    };
    for (const r of runs.filter(r => !r.light)) outputs.set(r, await attempt(r));
    const light = runs.filter(r => r.light);
    await Promise.all(Array.from({ length: Math.min(lightConcurrency(), light.length) }, async () => {
      for (let r = light.shift(); r; r = light.shift()) outputs.set(r, await attempt(r));
    }));
    if (opts.signal?.aborted) return { status: 'failed', lang, reason: 'aborted' };
    const parts = runs.flatMap(r => outputs.get(r) ?? []); // plan order, whatever finished first
    if (parts.length === 0) {
      return { status: 'failed', lang, reason: failures.length === 1 ? failures[0]! : `all ${failures.length} runs failed; first: ${failures[0]}` };
    }
    for (const f of failures) warnings.push(`${f} — its files stay heuristic-only`);

    // Compact while combining: one part in memory at a time (see compact.ts).
    const compact = new Compactor(projectRoot, lang);
    try {
      for (const p of parts) compact.add(fs.readFileSync(p));
    } catch (err) {
      if (!(err instanceof ScipDecodeError)) throw err;
      return { status: 'failed', lang, reason: `${indexer.cmd} wrote an unreadable index: ${err.message}` };
    }
    if (compact.paths.length === 0) return { status: 'failed', lang, reason: `${indexer.cmd} wrote an index with no documents` };
    compact.write(tmp);
    const resolvedCalls = compact.resolvedCalls();
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
    const meta: ScipMeta = { tool: compact.meta!.toolName, toolVersion: compact.meta!.toolVersion, producedAt: started, hashes, resolvedCalls };
    writeFileAtomic(metaPath(projectRoot, lang), JSON.stringify(meta));
    return { status: 'installed', lang, documents: compact.paths.length, resolvedCalls, durationMs: Date.now() - started, warnings };
  } finally {
    fs.rmSync(tmp, { force: true });
    for (const r of all(runs)) fs.rmSync(r.output, { force: true });
  }
}

/**
 * Light runs at once: up to 4, at most half the cores, and as many ~3 GB
 * processes as 60% of physical memory holds.
 */
function lightConcurrency(): number {
  const byMemory = Math.floor((os.totalmem() * 0.6) / (3 * 1024 ** 3));
  return Math.max(1, Math.min(4, Math.floor(os.cpus().length / 2), byMemory));
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
