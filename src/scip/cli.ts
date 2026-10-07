/**
 * `codegraph scip …` subcommands (fork).
 *
 *   scip index  [path] [--lang <l>] [--force]   run the indexer(s) on PATH, then merge
 *   scip import <file> [path] [--lang <l>]      install an index built elsewhere, then merge
 *   scip status [path] [--json]
 */

import type { Command } from 'commander';
import { SCIP_LANGUAGES, ScipLanguage, importScipFile, mergePass, scipStatus } from './index';
import { describeInstalled, describePass, reindexRound } from './round';
import { referenceSites } from './sites';
import { scipDir, tryReindexLock } from './store';

export interface CliHelpers {
  resolveProjectPath(pathArg?: string): string;
  isInitialized(projectPath: string): boolean;
  loadCodeGraph(): Promise<typeof import('../index')>;
  success(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

function parseLang(raw: string | undefined): ScipLanguage | undefined {
  if (raw === undefined) return undefined;
  if (!(SCIP_LANGUAGES as readonly string[]).includes(raw)) {
    throw new Error(`--lang must be one of ${SCIP_LANGUAGES.join(', ')} (got "${raw}")`);
  }
  return raw as ScipLanguage;
}

export function registerScipCommands(program: Command, h: CliHelpers): void {
  const scip = program.command('scip').description('Compiler-grade call edges from SCIP indexers');

  const withGraph = async (pathArg: string | undefined, fn: (cg: import('../index').CodeGraph) => Promise<void>) => {
    const projectPath = h.resolveProjectPath(pathArg);
    try {
      if (!h.isInitialized(projectPath)) {
        h.error(`CodeGraph not initialized in ${projectPath} — run \`codegraph init\` first`);
        process.exit(1);
      }
      const { default: CodeGraph } = await h.loadCodeGraph();
      const cg = await CodeGraph.open(projectPath);
      try {
        await fn(cg);
      } finally {
        cg.close();
      }
    } catch (err) {
      h.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  };

  /** index and import replace the installed index and merge: never alongside another re-index. */
  const exclusively = async (cg: import('../index').CodeGraph, fn: () => Promise<void>) => {
    const lock = tryReindexLock(cg.getProjectRoot());
    if (!lock) {
      throw new Error(`another process (a watcher or a CLI run) is re-indexing this project — retry when it finishes, or delete ${scipDir(cg.getProjectRoot())}/reindex.lock if none is running`);
    }
    try {
      await fn();
    } finally {
      lock.release();
    }
  };

  const mergeAndReport = async (cg: import('../index').CodeGraph) => {
    const report = await cg.scipWrite((db) => mergePass(db, cg.scipDbPath(), cg.getProjectRoot()));
    if (report) h.success(describePass(report));
    else h.info('No SCIP index installed — nothing to merge');
  };

  scip
    .command('index [path]')
    .description('Run the SCIP indexer for each detected language (must be on PATH), then merge')
    .option('--lang <lang>', `Only this language (${SCIP_LANGUAGES.join('|')})`)
    .option('-f, --force', 'Install the new index even if resolution dropped sharply')
    .option('--changed', 'Re-index only files changed since the installed index, and their importers (tsgo); else a full run')
    .action((pathArg: string | undefined, opts: { lang?: string; force?: boolean; changed?: boolean }) =>
      withGraph(pathArg, (cg) => exclusively(cg, async () => {
        const only = parseLang(opts.lang);
        const { results, report } = await reindexRound(cg, {
          langs: only ? [only] : SCIP_LANGUAGES,
          force: opts.force,
          incremental: opts.changed,
          log: h.info,
        });
        let current = 0;
        for (const r of results) {
          if (r.status === 'installed') {
            h.success(describeInstalled(r));
            for (const w of r.warnings) h.warn(`${r.lang}: ${w}`);
          } else if (r.status === 'current') {
            h.info(`${r.lang}: up to date`);
            if (only) current++;
          } else if (r.status === 'skipped') {
            if (only) h.warn(`${r.lang}: skipped — ${r.reason}`);
            else h.info(`${r.lang}: skipped — ${r.reason}`);
          } else {
            h.warn(`${r.lang}: ${r.status} — ${r.reason}`);
          }
        }
        if (report) h.success(describePass(report));
        else if (only && current === 0 && !results.some(r => r.status === 'installed')) process.exitCode = 1;
      })));

  scip
    .command('import <file> [path]')
    .description('Install a SCIP index built elsewhere (from the current sources), then merge')
    .option('--lang <lang>', 'Language the index covers (default: inferred from the indexer name)')
    .action((file: string, pathArg: string | undefined, opts: { lang?: string }) =>
      withGraph(pathArg, (cg) => exclusively(cg, async () => {
        const { lang, documents, newerThanIndex } = importScipFile(cg.getProjectRoot(), file, parseLang(opts.lang), referenceSites(cg.scipReadDb()));
        h.info(`${lang}: installed ${documents} documents`);
        if (newerThanIndex.length > 0) {
          h.warn(`${newerThanIndex.length} file(s) changed after ${file} was written — left to the heuristic until a reindex (e.g. ${newerThanIndex.slice(0, 3).join(', ')})`);
        }
        await mergeAndReport(cg);
      })));

  scip
    .command('status [path]')
    .description('Installed SCIP indexes and how much of the graph they verify')
    .option('-j, --json', 'Output as JSON')
    .action((pathArg: string | undefined, opts: { json?: boolean }) =>
      withGraph(pathArg, async (cg) => {
        const s = scipStatus(cg.scipReadDb(), cg.getProjectRoot());
        if (opts.json) {
          console.log(JSON.stringify(s, null, 2));
          return;
        }
        if (s.indexes.length === 0) {
          h.info('No SCIP index installed. Run `codegraph scip index` (needs e.g. scip-typescript on PATH).');
          return;
        }
        for (const i of s.indexes) {
          h.info(`${i.lang}: ${i.tool} ${i.toolVersion}, built ${new Date(i.producedAt).toISOString()}, ${i.mergedDocuments}/${i.files} files merged`);
        }
        h.info(`edges: ${s.edges.scip} compiler-verified (${s.edges.stale} stale), ${s.edges.silent} unverified heuristic`);
        if (s.indexes.some(i => i.lang === 'python') && s.edges.silent > 0) {
          h.info('python: a call on a receiver without type hints stays unverified — the type checker has nothing to resolve it with');
        }
      }));
}
