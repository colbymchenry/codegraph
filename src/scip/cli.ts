/**
 * `codegraph scip …` subcommands (fork).
 *
 *   scip index  [path] [--lang <l>] [--force]   run the indexer(s) on PATH, then merge
 *   scip import <file> [path] [--lang <l>]      install an index built elsewhere, then merge
 *   scip status [path] [--json]
 */

import type { Command } from 'commander';
import { MergeScope, SCIP_LANGUAGES, ScipLanguage, ScipPassReport, importScipFile, joinScopes, runScipPass, scipStatus } from './index';
import { produceIndex } from './produce';
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

function describe(r: ScipPassReport): string {
  const o = r.outcome;
  return [
    `${r.freshDocuments}/${r.documents} documents merged (${r.staleDocuments.length} stale${r.judgedDocuments < r.freshDocuments ? `, ${r.judgedDocuments} re-judged` : ''}) in ${r.durationMs}ms (${Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    `sites: ${o.agree} agree, ${o.conflict} conflict, ${o.scipOnly} added, ${o.alreadyVerified} already verified, ${o.scipOnlyExternal} external-only, ${o.silent} unverified heuristic edges`,
    `edges: ${o.edgesUpdated} verified, ${o.edgesDeleted} wrong removed, ${o.edgesInserted} missing added` +
      (o.scipEdgesDropped || o.scipEdgesStale ? `, ${o.scipEdgesDropped} outdated dropped, ${o.scipEdgesStale} stale` : ''),
  ].join('\n');
}

export function registerScipCommands(program: Command, h: CliHelpers): void {
  const scip = program.command('scip').description('Compiler-grade call edges from SCIP indexers (fork)');

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

  const mergeAndReport = async (cg: import('../index').CodeGraph, scope?: MergeScope) => {
    const report = await cg.scipWrite((db) => runScipPass(db, cg.getProjectRoot(), scope));
    if (report) h.success(describe(report));
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
        let installed = 0;
        let current = 0;
        let scopes: MergeScope[] | null = []; // null once any index was rebuilt in full
        for (const lang of only ? [only] : SCIP_LANGUAGES) {
          const r = await produceIndex(cg.scipReadDb(), cg.getProjectRoot(), lang, { force: opts.force, incremental: opts.changed, log: h.info });
          if (r.status === 'installed') {
            installed++;
            scopes = r.scope && scopes ? [...scopes, r.scope] : null;
            const how = r.incremental !== undefined ? ` (patched: ${r.incremental} file(s) re-indexed)` : '';
            h.success(`${lang}: ${r.documents} documents, ${r.resolvedCalls} resolved calls in ${(r.durationMs / 1000).toFixed(1)}s${how}`);
            for (const w of r.warnings) h.warn(`${lang}: ${w}`);
          } else if (r.status === 'current') {
            h.info(`${lang}: up to date`);
            if (only) current++;
          } else if (r.status === 'skipped') {
            if (only) h.warn(`${lang}: skipped — ${r.reason}`);
            else h.info(`${lang}: skipped — ${r.reason}`);
          } else {
            h.warn(`${lang}: ${r.status} — ${r.reason}`);
          }
        }
        if (installed > 0) await mergeAndReport(cg, scopes ? joinScopes(scopes) : undefined);
        else if (only && current === 0) process.exitCode = 1;
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
      }));
}
