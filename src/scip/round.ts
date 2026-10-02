/**
 * One re-index round: produce each language (errors become failed results), then
 * merge whatever this round installed and any index still awaiting a merge.
 *
 * Shared by `scip index` and the watcher's background reindex so a throw in a
 * later language can never leave an earlier install unmerged. `init --scip`
 * keeps its overlapped start/finish produce path and only uses {@link mergeInstalled}.
 */

import { ScipHost, ScipLanguage, ScipPassReport, mergeInstalled } from './index';
import { ProduceResult, produceIndex } from './produce';

export interface ReindexRoundOptions {
  langs: readonly ScipLanguage[];
  incremental?: boolean;
  force?: boolean;
  nice?: boolean;
  signal?: AbortSignal;
  log?: (msg: string) => void;
}

export interface ReindexRoundOutcome {
  results: ProduceResult[];
  report: ScipPassReport | null;
}

/**
 * Produce each of `langs` in order, catching throws as `{ status: 'failed' }`,
 * then {@link mergeInstalled}. Callers own the reindex lock and how results are shown.
 */
export async function reindexRound(host: ScipHost, opts: ReindexRoundOptions): Promise<ReindexRoundOutcome> {
  const root = host.getProjectRoot();
  const results: ProduceResult[] = [];
  for (const lang of opts.langs) {
    if (opts.signal?.aborted) break;
    try {
      results.push(await produceIndex(host.scipReadDb(), root, lang, {
        incremental: opts.incremental,
        force: opts.force,
        nice: opts.nice,
        signal: opts.signal,
        log: opts.log,
      }));
    } catch (err) {
      results.push({
        status: 'failed',
        lang,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (opts.signal?.aborted) return { results, report: null };
  return { results, report: await mergeInstalled(host, results) };
}
