/**
 * One re-index round (`scip index`): produce each language (errors become
 * failed results), then merge whatever this round installed and any index
 * still awaiting a merge — so a throw in a later language can never leave an
 * earlier install unmerged. The formatters below are what the CLI prints.
 */

import { ScipHost, ScipLanguage, ScipPassReport, mergeInstalled } from './index';
import { ProduceResult, produceIndex } from './produce';

export interface ReindexRoundOptions {
  langs: readonly ScipLanguage[];
  force?: boolean;
  log?: (msg: string) => void;
}

export interface ReindexRoundOutcome {
  results: ProduceResult[];
  report: ScipPassReport | null;
}

/** One language's part of a round: produce (or finish producing) its index. */
interface RoundStep {
  lang: ScipLanguage;
  run(): Promise<ProduceResult>;
}

/**
 * Run `steps` in order, catching throws as `{ status: 'failed' }`, then
 * {@link mergeInstalled}. Callers own the reindex lock and how results are shown.
 */
async function runRound(host: ScipHost, steps: readonly RoundStep[]): Promise<ReindexRoundOutcome> {
  const results: ProduceResult[] = [];
  for (const { lang, run } of steps) {
    try {
      results.push(await run());
    } catch (err) {
      results.push({ status: 'failed', lang, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, report: await mergeInstalled(host, results) };
}

/** A round that runs each of `langs`' indexers. */
export function reindexRound(host: ScipHost, opts: ReindexRoundOptions): Promise<ReindexRoundOutcome> {
  const { force, log } = opts;
  return runRound(host, opts.langs.map(lang => ({
    lang,
    run: () => produceIndex(host.scipReadDb(), host.getProjectRoot(), lang, { force, log }),
  })));
}

/** `<lang>: N documents, M resolved calls in Xs` for an installed index. */
export function describeInstalled(r: Extract<ProduceResult, { status: 'installed' }>): string {
  return `${r.lang}: ${r.documents} documents, ${r.resolvedCalls} resolved calls in ${(r.durationMs / 1000).toFixed(1)}s`;
}

/** What a merge did, in three lines. */
export function describePass(r: ScipPassReport): string {
  const o = r.outcome;
  return [
    `${r.freshDocuments}/${r.documents} documents merged (${r.staleDocuments.length} stale) in ${r.durationMs}ms (${Object.entries(r.phases).map(([k, v]) => `${k} ${v}`).join(', ')})`,
    `sites: ${o.agree} agree, ${o.conflict} conflict, ${o.scipOnly} added, ${o.alreadyVerified} already verified, ${o.scipOnlyExternal} external-only, ${o.silent} unverified heuristic edges`,
    `edges: ${o.edgesUpdated} verified, ${o.edgesDeleted} wrong removed, ${o.edgesInserted} missing added` +
      (o.scipEdgesDropped || o.scipEdgesStale ? `, ${o.scipEdgesDropped} outdated dropped, ${o.scipEdgesStale} stale` : ''),
  ].join('\n');
}
