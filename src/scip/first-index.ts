/**
 * The first index with SCIP (`codegraph init --scip`): each language's indexer
 * runs while codegraph resolves references, instead of after the whole init.
 *
 * The indexer needs two things from the graph, both there once extraction is
 * stored: the files' content hashes (the hash gate's snapshot) and, for
 * tsgo-index, the lines its references sit on — the extracted-but-unresolved
 * references give those (sites.ts pendingReferenceSites). Compaction, which
 * needs the resolved edges, runs at the end, then one merge.
 */

import type { CodeGraph } from '../index';
import type { FileLock } from '../utils';
import { StartedIndex, startIndex } from './produce';
import { describeInstalled, describePass, runRound } from './round';
import { pendingReferenceSites, referenceSites } from './sites';
import { SCIP_LANGUAGES, tryReindexLock } from './store';

export interface FirstIndexMessage { level: 'info' | 'success' | 'warn'; message: string }

export interface FirstIndexScip {
  /** pass as `indexAll({ onExtracted })` */
  onExtracted(): void;
  /** after indexAll: compact and install what the indexers wrote, then merge. Call it whatever indexAll returned. */
  finish(): Promise<FirstIndexMessage[]>;
}

export function firstIndexScip(cg: CodeGraph): FirstIndexScip {
  const root = cg.getProjectRoot();
  let lock: FileLock | null = null;
  let started: StartedIndex[] = [];
  const messages: FirstIndexMessage[] = [];
  return {
    onExtracted() {
      if (lock || messages.length) return; // once: init may run its index again (gitignored child repos)
      lock = tryReindexLock(root);
      if (!lock) {
        messages.push({ level: 'warn', message: 'SCIP: another process is re-indexing this project — run `codegraph scip index` when it finishes' });
        return;
      }
      const db = cg.scipReadDb();
      const refs = pendingReferenceSites(db);
      // One language's runs at a time, as `scip index` does: each starts when the previous one's runs end.
      let after: Promise<void> | undefined;
      started = SCIP_LANGUAGES.map(lang => {
        const s = startIndex(db, root, lang, refs, { after });
        after = s.ran;
        return s;
      });
    },
    async finish() {
      try {
        const refs = started.length ? referenceSites(cg.scipReadDb()) : new Map(); // resolved now: what compaction keeps
        const { results, report } = await runRound(cg, started.map(s => ({ lang: s.lang, run: () => s.finish(refs) })));
        for (const r of results) {
          if (r.status === 'installed') {
            messages.push({ level: 'success', message: describeInstalled(r) });
            for (const w of r.warnings) messages.push({ level: 'warn', message: `${r.lang}: ${w}` });
          } else if (r.status !== 'skipped' && r.status !== 'current') {
            messages.push({ level: 'warn', message: `${r.lang}: ${r.status} — ${r.reason}` });
          }
        }
        if (report) messages.push({ level: 'success', message: describePass(report) });
        return messages;
      } finally {
        lock?.release();
      }
    },
  };
}
