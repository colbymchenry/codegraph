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
 *
 * With `incremental`, a tsgo-built index is instead patched: only files edited,
 * added or removed since its snapshot — and the files importing them — are
 * re-indexed, and their documents are spliced into the installed index (see
 * incrementalPlan). Anything else falls through to the full run.
 */

import { spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import type { MergeScope } from './index';
import { Compactor } from './compact';
import { ReferenceSites, referenceSites } from './sites';
import { INDEXERS, IndexerRun, RUN_WARNING, ResolvedIndexer, resolveIndexer } from './indexers';
import {
  ROLE_DEFINITION, ScipDecodeError, ScipDocument, decodeScipIndex, loadScipIndex,
} from './reader';
import {
  ScipLanguage, indexPath, installIndex, isMerged, metaAfterFull, metaAfterPatch, patchDriftExceeded,
  readHashed, readMeta, snapshotHashes,
} from './store';

/** Largest drop in resolved calls a new index may show before it is rejected. */
const MAX_RESOLUTION_DROP = 0.2;

const INDEXER_TIMEOUT_MS = 30 * 60 * 1000;

export type ProduceResult =
  | {
    status: 'installed'; lang: ScipLanguage; documents: number; resolvedCalls: number; durationMs: number; warnings: string[];
    /** files re-indexed, when the index was patched rather than rebuilt */
    incremental?: number;
    /** what the patch changed, for a merge of just that (see runScipPass) */
    scope?: MergeScope;
  }
  | { status: 'skipped'; lang: ScipLanguage; reason: string }
  /** incremental: nothing changed since the installed index was built */
  | { status: 'current'; lang: ScipLanguage }
  | { status: 'rejected'; lang: ScipLanguage; reason: string }
  | { status: 'failed'; lang: ScipLanguage; reason: string };

export interface ProduceOptions {
  /** install even when the regression guard would reject */
  force?: boolean;
  /** run under `nice` (background reindex) */
  nice?: boolean;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** patch the installed index when only a few files changed (see incrementalPlan) */
  incremental?: boolean;
}

/** Import edges below this confidence are codegraph's name guesses, not resolved imports. */
const MIN_IMPORT_CONFIDENCE = 0.5;

/** Most files a patch re-indexes, however cheap it looks; beyond this a full run is easier to trust. */
const MAX_INCREMENTAL_FILES = 500;

export interface IncrementalPlan {
  /** files to re-index: changed since the snapshot, plus the files importing them */
  files: string[];
  /** files the installed index covers that codegraph no longer has */
  deleted: string[];
  /** the adapter's units covering `files` (IndexerSpec.patch.units) */
  units: string[];
  /** the adapter's own estimate for re-indexing `units` (IndexerSpec.patch.seconds), ms */
  declaredMs: number;
  /** `declaredMs` scaled by what earlier patches measured (ScipMeta.patchRatio) */
  estimateMs: number;
}

/**
 * What changed since the installed index was built: files whose codegraph hash
 * differs from the snapshot (edited or new) and, because their calls into an
 * edited file may now resolve differently, the files importing one; plus files
 * that are gone. Null when only a full run will do — no snapshot, an index
 * built by a tool the language can't patch (IndexerSpec.patch), more than
 * MAX_INCREMENTAL_FILES files, an estimate of at least half the last full run
 * (a patch that slow buys little), or MAX_PATCHES / MAX_PATCH_AGE_MS reached.
 * Deeper effects (a type changing two imports away) wait for that full run.
 */
export function incrementalPlan(db: SqliteDatabase, projectRoot: string, lang: ScipLanguage): IncrementalPlan | null {
  const meta = readMeta(projectRoot, lang);
  const patch = meta && INDEXERS[lang].patch?.[meta.tool];
  if (!meta || !patch) return null;
  if (patchDriftExceeded(meta)) return null;
  const langs = INDEXERS[lang].codegraphLanguages;
  const rows = db.prepare(`SELECT path, content_hash FROM files WHERE language IN (${langs.map(() => '?').join(',')})`)
    .all(...langs) as { path: string; content_hash: string }[];
  const current = new Set(rows.map(r => r.path));
  const changed = rows.filter(r => meta.hashes[r.path] !== r.content_hash).map(r => r.path);
  const files = new Set(changed);
  // Name guesses don't count: codegraph matches an unresolved `import { URL } from 'url'` to any
  // `URL` class (confidence 0.4), which on vscode pulled the 5k-file src/ project into a 1-file patch.
  const importers = db.prepare(`SELECT DISTINCT s.file_path AS p FROM nodes t
    JOIN edges e ON e.target = t.id AND e.kind = 'imports' JOIN nodes s ON s.id = e.source
    WHERE t.file_path = ? AND COALESCE(json_extract(e.metadata, '$.confidence'), 1) >= ${MIN_IMPORT_CONFIDENCE}`);
  for (const c of changed) for (const { p } of importers.all(c) as { p: string }[]) if (current.has(p)) files.add(p);
  const deleted = Object.keys(meta.hashes).filter(p => !current.has(p));
  if (files.size > MAX_INCREMENTAL_FILES) return null;
  const sorted = [...files].sort();
  const units = sorted.length ? patch.units(projectRoot, sorted) : [];
  const declaredMs = units.length ? patch.seconds(projectRoot, units, lightConcurrency()) * 1000 : 0;
  const estimateMs = declaredMs * (meta.patchRatio ?? 1);
  if (meta.fullRunMs !== undefined && estimateMs >= meta.fullRunMs / 2) return null;
  return { files: sorted, deleted, units, declaredMs, estimateMs };
}

export async function produceIndex(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, opts: ProduceOptions = {}
): Promise<ProduceResult> {
  const prepared = prepare(projectRoot, lang);
  if ('status' in prepared) return prepared;
  if (opts.incremental) {
    const patched = await patchIndex(db, projectRoot, lang, prepared.indexer, prepared.raw, opts);
    if (patched) return patched;
  }
  // codegraph's references: compaction keeps the SCIP references there, and an indexer
  // that resolves only what the merge reads (tsgo-index) is told where they are.
  const refs = referenceSites(db);
  return fullRun(db, projectRoot, lang, prepared, refs, opts).finish(refs);
}

/** A full run whose indexer runs are under way; `finish` compacts and installs their output. */
export interface StartedIndex {
  lang: ScipLanguage;
  /** settles when the runs are done (whatever their outcome): the next language's runs may start */
  ran: Promise<void>;
  /** compacts against `refs`, the graph's reference sites as they are now (resolved), installs, and cleans up — call it exactly once */
  finish(refs: ReferenceSites): Promise<ProduceResult>;
}

/**
 * A full run started before codegraph has resolved its references — the first
 * index's overlap (`init --scip`): `refs` are the reference sites extracted so
 * far (sites.ts pendingReferenceSites), a superset of the lines the resolved
 * edges will sit on, which is all tsgo-index needs. `after`: start the runs
 * only once it settles (one language's runs at a time, as produceIndex does).
 * A language with nothing to run finishes as its skip, once `after` settles.
 */
export function startIndex(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, refs: ReferenceSites, opts: StartOptions = {}
): StartedIndex {
  const prepared = prepare(projectRoot, lang);
  if (!('status' in prepared)) return fullRun(db, projectRoot, lang, prepared, refs, opts);
  return { lang, ran: (opts.after ?? Promise.resolve()).then(() => undefined, () => undefined), finish: async () => prepared };
}

type StartOptions = ProduceOptions & { after?: Promise<unknown> };

interface Prepared { final: string; raw: string; indexer: ResolvedIndexer }

function prepare(projectRoot: string, lang: ScipLanguage): Prepared | ProduceResult {
  const final = indexPath(projectRoot, lang);
  const raw = `${final}.${process.pid}.raw`; // the indexer's own output, compacted into the installed index
  fs.mkdirSync(path.dirname(final), { recursive: true }); // adapters may write helper files beside the output
  const indexer = resolveIndexer(projectRoot, lang, raw);
  if ('skip' in indexer) return { status: 'skipped', lang, reason: indexer.skip };
  return { final, raw, indexer };
}

/** Starts the full run's indexer now (once `after` settles); see StartedIndex. `refs`: what the runs read (Invocation.referenceSites). */
function fullRun(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, { final, raw, indexer }: Prepared, refs: ReferenceSites, opts: StartOptions
): StartedIndex {
  const started = Date.now();
  const hashes = snapshotHashes(db, projectRoot, INDEXERS[lang].codegraphLanguages);
  if (indexer.referenceSites) writeReferenceSites(indexer.referenceSites, refs);
  const warnings: string[] = indexer.warning ? [indexer.warning] : [];
  if (indexer.warning) opts.log?.(`${lang}: ${indexer.warning}`);
  const { runs } = indexer;
  const pool = runFull(projectRoot, indexer, opts);

  const finish = async (compactRefs: ReferenceSites): Promise<ProduceResult> => {
    try {
      await pool.ran;
      const compactStart = Date.now();
      if (opts.signal?.aborted) return { status: 'failed', lang, reason: 'aborted' };
      const parts = runs.flatMap(r => pool.outputs.get(r) ?? []); // plan order, whatever finished first
      if (parts.length === 0) {
        return {
          status: 'failed', lang,
          reason: pool.failures.length === 1 ? pool.failures[0]! : `all ${pool.failures.length} runs failed; first: ${pool.failures[0]}`,
        };
      }
      for (const f of pool.failures) warnings.push(`${f} — its files stay heuristic-only`);
      warnings.push(...pool.warnings);

      // Compact while combining: one part in memory at a time (see compact.ts).
      const compact = new Compactor(projectRoot, lang, compactRefs);
      try {
        for (const p of parts) compact.add(fs.readFileSync(p));
      } catch (err) {
        if (!(err instanceof ScipDecodeError)) throw err;
        return { status: 'failed', lang, reason: `${indexer.cmd} wrote an unreadable index: ${err.message}` };
      }
      if (compact.paths.length === 0) return { status: 'failed', lang, reason: `${indexer.cmd} wrote an index with no documents` };
      const resolvedCalls = compact.resolvedCalls();
      const before = fs.existsSync(final) ? readMeta(projectRoot, lang) : null;
      const previous = before?.resolvedCalls ?? null;
      if (!opts.force && previous !== null && resolvedCalls < previous * (1 - MAX_RESOLUTION_DROP)) {
        return {
          status: 'rejected', lang,
          reason: `resolved calls fell from ${previous} to ${resolvedCalls} (>${MAX_RESOLUTION_DROP * 100}% drop) — kept the previous index; fix the build or pass --force`,
        };
      }
      const durationMs = pool.runMs + (Date.now() - compactStart);
      installIndex(projectRoot, lang, f => compact.write(f), metaAfterFull(before, {
        tool: compact.meta!.toolName, toolVersion: compact.meta!.toolVersion, producedAt: started, hashes, resolvedCalls,
        fullRunMs: durationMs,
      }));
      return { status: 'installed', lang, documents: compact.paths.length, resolvedCalls, durationMs, warnings };
    } finally {
      sweep(raw);
    }
  };
  // `finish` rethrows a failure of the runs; the handler here keeps it from being "unhandled" until then.
  return { lang, ran: pool.ran.catch(() => undefined), finish };
}

/**
 * The incremental path of produceIndex: re-index the plan's units with the
 * adapter's patch runs (IndexerSpec.patch), splice the plan's documents into the
 * installed index, and install the result under the same guard. Null → do a
 * full run instead.
 */
async function patchIndex(
  db: SqliteDatabase, projectRoot: string, lang: ScipLanguage, indexer: ResolvedIndexer, raw: string, opts: ProduceOptions
): Promise<ProduceResult | null> {
  const final = indexPath(projectRoot, lang);
  const previous = readMeta(projectRoot, lang);
  const patch = previous && previous.tool === indexer.tool ? INDEXERS[lang].patch?.[previous.tool] : undefined; // another tool now: rebuild
  if (!previous || !patch || !fs.existsSync(final)) return null;
  const plan = incrementalPlan(db, projectRoot, lang);
  if (!plan) return null;
  if (plan.files.length === 0 && plan.deleted.length === 0) return { status: 'current', lang };
  // An index with call marks keeps its other documents as they are (Compactor.addCompacted):
  // only the plan's files are compacted, so only their reference sites are read (vscode: the
  // whole graph's took 4.4 s). Without marks (an index from before them) every document is
  // compacted again, which marks them for the next patch.
  const passThrough = previous.callMarks === true;
  const refs = passThrough ? referenceSites(db, plan.files) : referenceSites(db);

  const started = Date.now();
  const hashes: Record<string, string> = {};
  for (const f of plan.files) {
    const h = readHashed(projectRoot, f)?.hash;
    if (h) hashes[f] = h;
  }
  const present = Object.keys(hashes); // a file that can't be read now is dropped with the deleted ones
  const units = present.length === plan.files.length ? plan.units : present.length ? patch.units(projectRoot, present) : [];
  const runs = units.length ? patch.runs(indexer.runs, units, raw) : [];
  if (!runs) return null;
  const warnings: string[] = [];
  try {
    let partial: ScipDocument[] = [];
    let tool = { toolName: previous.tool, toolVersion: previous.toolVersion, projectRoot: '' };
    if (runs.length) {
      if (indexer.referenceSites) writeReferenceSites(indexer.referenceSites, refs); // a helper file: swept below
      opts.log?.(`${lang}: re-indexing ${present.length} changed or dependent file(s) — ${units.length} unit(s), ~${Math.round(plan.estimateMs / 1000)}s`);
      const pool = await runPatch(projectRoot, indexer, runs, opts);
      if (opts.signal?.aborted) return { status: 'failed', lang, reason: 'aborted' };
      if (pool.failed) {
        opts.log?.(`${lang}: partial reindex failed (${pool.failed}) — running a full one`);
        return null;
      }
      warnings.push(...pool.warnings);
      // Several runs may each carry a file (an import both share): the first copy stands.
      const seen = new Set<string>();
      for (const out of pool.outputs) {
        const index = decodeScipIndex(fs.readFileSync(out), projectRoot);
        tool = { toolName: index.toolName, toolVersion: index.toolVersion, projectRoot: '' }; // paths are rebased already
        for (const d of index.documents) {
          if (seen.has(d.relativePath)) continue;
          seen.add(d.relativePath);
          partial.push(d);
        }
      }
    }

    // Splice: the plan's files get their new documents (or none); every other file keeps its
    // installed one. Each document defines everything its file declares, so nothing else moves.
    // What the replaced documents defined, before and after, is what other files' calls may have changed into.
    const replaced = new Set([...plan.files, ...plan.deleted]);
    const symbols = new Set<string>();
    const defines = (d: ScipDocument) => { for (const o of d.occurrences) if (o.roles & ROLE_DEFINITION) symbols.add(o.symbol); };
    const docs = new Map<string, ScipDocument>();
    for (const d of loadScipIndex(final).documents) {
      if (replaced.has(d.relativePath)) defines(d);
      else docs.set(d.relativePath, d);
    }
    const fresh = new Set<string>(); // the documents the patch wrote: compacted; the others are kept as they are
    for (const d of partial) {
      if (!replaced.has(d.relativePath)) continue;
      docs.set(d.relativePath, d);
      fresh.add(d.relativePath);
      defines(d);
    }
    const compact = new Compactor(projectRoot, lang, refs);
    if (passThrough) {
      compact.addCompacted(tool, [...docs.values()].filter(d => !fresh.has(d.relativePath)));
      compact.addDocuments(tool, [...docs.values()].filter(d => fresh.has(d.relativePath)));
    } else {
      compact.addDocuments(tool, docs.values()); // decoded already: no encode and re-scan of the whole index
    }
    const resolvedCalls = compact.resolvedCalls();
    if (!opts.force && previous.resolvedCalls !== undefined && resolvedCalls < previous.resolvedCalls * (1 - MAX_RESOLUTION_DROP)) {
      return { status: 'rejected', lang, reason: `resolved calls fell from ${previous.resolvedCalls} to ${resolvedCalls} after a partial reindex — kept the previous index` };
    }
    const snapshot = { ...previous.hashes };
    for (const f of replaced) delete snapshot[f];
    Object.assign(snapshot, hashes);
    const durationMs = Date.now() - started;
    installIndex(projectRoot, lang, f => compact.write(f), metaAfterPatch(previous, {
      tool: tool.toolName, toolVersion: tool.toolVersion, producedAt: started, hashes: snapshot, resolvedCalls,
      durationMs, declaredMs: plan.declaredMs, unitsMatchPlan: units === plan.units,
    }));
    return {
      status: 'installed', lang, documents: compact.paths.length, resolvedCalls, durationMs,
      warnings, incremental: present.length,
      // A patch of an index never merged (installed, then the round failed) carries its unmerged
      // documents along: only a full merge brings them in — a scope would mark them merged unjudged.
      scope: isMerged(db, lang, previous) ? { files: [...replaced], symbols: [...symbols] } : undefined,
    };
  } finally {
    sweep(raw);
  }
}

/**
 * Removes what a run of `raw` may leave: the output, its parts (`.partN`) and
 * helper files (`.refs`) — adapters name them all after the raw output.
 */
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

interface FullRuns {
  /** settles when every run is done, whatever its outcome */
  ran: Promise<void>;
  /** each run's outputs: its own, or its fallback parts' */
  outputs: Map<IndexerRun, string[]>;
  failures: string[];
  warnings: string[];
  /** the runs' own time, not the wait for `after` (what the patch planner compares against) */
  runMs: number;
}

/**
 * A full run's indexer runs, started now (once `after` settles). Heavy runs one
 * at a time (parallel heavy runs would stack the very memory the split exists to
 * bound), then light runs in a small pool. A failed run with a fallback is retried
 * as its parts; any other failed part of a split run is a warning — its files stay
 * heuristic-only. Only a total failure fails (see fullRun).
 */
function runFull(projectRoot: string, indexer: ResolvedIndexer, opts: StartOptions): FullRuns {
  const { runs } = indexer;
  const done: FullRuns = { ran: Promise.resolve(), outputs: new Map(), failures: [], warnings: [], runMs: 0 };
  let started = 0;
  const attempt = async (r: IndexerRun): Promise<string[]> => {
    if (opts.signal?.aborted) return [];
    opts.log?.(`${runs.length > 1 ? `[${++started}/${runs.length}] ${r.label}: ` : ''}running ${indexer.cmd} ${r.args.slice(0, 8).join(' ')}${r.args.length > 8 ? ` … (+${r.args.length - 8} more)` : ''}`);
    const { why, runWarnings } = await runOnce(projectRoot, indexer, r, opts);
    if (!why) {
      for (const w of runWarnings) done.warnings.push(`${r.label}: ${w} — its files stay heuristic-only`);
      return [r.output];
    }
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
  done.ran = (async () => {
    await opts.after?.catch(() => undefined);
    const runStart = Date.now();
    try {
      for (const r of runs.filter(r => !r.light)) done.outputs.set(r, await attempt(r));
      await inPool(runs.filter(r => r.light), lightConcurrency(), async r => { done.outputs.set(r, await attempt(r)); });
    } finally {
      done.runMs = Date.now() - runStart;
    }
  })();
  return done;
}

/**
 * A patch's indexer runs: side by side when every one is light, else one at a
 * time. Unlike a full run there is no fallback and no partial result: the first
 * failure stops it, and the caller rebuilds in full instead.
 */
async function runPatch(
  projectRoot: string, indexer: ResolvedIndexer, runs: readonly IndexerRun[], opts: ProduceOptions
): Promise<{ outputs: string[]; failed: string | null; warnings: string[] }> {
  const outputs: string[] = [];
  const warnings: string[] = [];
  let failed: string | null = null;
  await inPool(runs, runs.every(r => r.light) ? lightConcurrency() : 1, async r => {
    if (failed || opts.signal?.aborted) return;
    const { why, runWarnings } = await runOnce(projectRoot, indexer, r, opts);
    if (why) failed ??= `${r.label}: ${why}`;
    else {
      outputs.push(r.output);
      warnings.push(...runWarnings);
    }
  });
  return { outputs, failed, warnings };
}

/**
 * One indexer run, niced when asked: why it failed (a non-zero exit, or no
 * output), or null; and the warnings it reported (RUN_WARNING lines).
 */
async function runOnce(
  projectRoot: string, indexer: ResolvedIndexer, r: IndexerRun, opts: ProduceOptions
): Promise<{ why: string | null; runWarnings: string[] }> {
  const useNice = opts.nice && process.platform !== 'win32';
  const [cmd, args] = useNice ? ['nice', ['-n', '10', indexer.cmd, ...r.args]] : [indexer.cmd, r.args];
  const { code, stderr } = await runIndexer(cmd, args, path.join(projectRoot, r.cwd ?? '.'), { ...indexer.env, ...r.env }, opts.signal);
  const why = code !== 0 ? `${indexer.cmd} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`
    : !fs.existsSync(r.output) ? `${indexer.cmd} exited 0 but wrote no index at ${r.output}` : null;
  const runWarnings = stderr.split('\n').filter(w => w.startsWith(RUN_WARNING)).map(w => w.slice(RUN_WARNING.length));
  return { why, runWarnings };
}

/** The reference sites as tsgo-index's `--refs` list: `path<TAB>line` per line (1-based lines). */
function writeReferenceSites(file: string, refs: ReferenceSites): void {
  const out: string[] = [];
  for (const [p, lines] of refs) for (const line of lines.keys()) out.push(`${p}\t${line}`);
  fs.writeFileSync(file, out.join('\n'));
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
