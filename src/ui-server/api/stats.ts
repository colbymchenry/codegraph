/**
 * `GET /api/stats` — what this index is, and how much to trust it.
 *
 * The viewer's top bar shows a couple of numbers from here, but the reason the
 * endpoint carries more than that is honesty: an index can be truncated
 * (`state: "indexing"` after a killed run), built by an older extractor, or
 * simply old. A reader that draws confident graphs over a half-built index is
 * the failure mode worth designing against, so the state travels with the
 * counts rather than being something the UI has to ask for separately.
 */

import * as path from 'path';
import type { CodeGraph } from '../../index';
import { BLAST_DEPTH, HUB_THRESHOLD, UNCERTAIN_BELOW } from './wire';

/**
 * How many of the index's most-depended-on symbols the blast scale measures.
 *
 * The Symbol view's blast bar is a comparison — "wide for this repo, or
 * narrow?" — so it needs a denominator, and the honest one is the widest
 * radius in the index. Measuring all of them means a depth-3 traversal per
 * symbol, which on a large repo is minutes. Measuring the most-depended-on
 * ones costs 24 traversals and finds the widest radius in practice: a radius
 * is grown by dependents, so the symbol with the widest one is very nearly
 * always near the top of that list.
 *
 * "Very nearly always" is not "always" — a symbol with three dependents that
 * each have three hundred can beat them — so the scale is a floor, not a
 * claim: {@link blastScaleFor} reports it as `sampled`, and the viewer raises
 * it whenever the symbol on screen exceeds it rather than drawing past 100%.
 */
const BLAST_SCALE_SAMPLE = 24;

export interface WireBlastScale {
  /** Most distinct dependents any symbol in the index has. Exact — one query. */
  maxDirect: number;
  /** Widest depth-{@link BLAST_DEPTH} radius found across the sampled symbols. */
  maxWithinHops: number;
  hops: number;
  /** How many symbols were measured for `maxWithinHops`. */
  sampled: number;
  /** True whenever `maxWithinHops` came from a sample rather than every symbol. */
  estimated: boolean;
}

/**
 * The denominator for the Symbol view's blast bar.
 *
 * Computed once per process and cached against the index's build stamp: it is
 * a property of the whole graph, every Symbol view needs it, and re-deriving it
 * per request would put 24 traversals in front of every screen.
 */
let cachedScale: { key: string; value: WireBlastScale } | null = null;

export function blastScaleFor(
  cg: CodeGraph,
  projectRoot: string,
  edgeCount: number
): WireBlastScale {
  // Keyed on the project AND the index's stamp AND its edge count, so a
  // re-index (or a sync that only moved edges) invalidates it and two indexes
  // opened by one process cannot share a denominator. A stale one would
  // silently rescale every bar in the app.
  const key = `${projectRoot}\u0000${cg.getLastIndexedAt() ?? 0}:${edgeCount}`;
  if (cachedScale?.key === key) return cachedScale.value;

  const top = cg.getTopDependedOn(BLAST_SCALE_SAMPLE);
  let maxWithinHops = 0;
  for (const candidate of top) {
    try {
      const subgraph = cg.getImpactRadius(candidate.nodeId, BLAST_DEPTH);
      maxWithinHops = Math.max(maxWithinHops, subgraph.nodes.size - 1);
    } catch {
      // A candidate that cannot be traversed (a node the edge table names but
      // the node table lost) narrows the sample; it must not fail the screen.
    }
  }

  const value: WireBlastScale = {
    maxDirect: top[0]?.dependents ?? 0,
    maxWithinHops,
    hops: BLAST_DEPTH,
    sampled: top.length,
    estimated: true,
  };
  cachedScale = { key, value };
  return value;
}

/** Drop the memoised scale — for tests, which build a fresh index per case. */
export function resetBlastScaleCache(): void {
  cachedScale = null;
}

export function buildStats(cg: CodeGraph, projectRoot: string): unknown {
  const stats = cg.getStats();
  const build = cg.getIndexBuildInfo();

  return {
    project: {
      root: projectRoot,
      name: path.basename(projectRoot) || projectRoot,
    },
    index: {
      /**
       * `complete` is the only good value. `indexing` means a run was killed
       * part-way and the graph on disk is a truncated one; `partial`/`failed`
       * mean the run finished but dropped files. `null` predates the marker.
       */
      state: cg.getIndexState(),
      lastIndexedAt: cg.getLastIndexedAt(),
      /** Built by an older extractor — a re-index would add data no migration can. */
      stale: cg.isIndexStale(),
      version: build.version,
      extractionVersion: build.extractionVersion,
      backend: cg.getBackend(),
      journalMode: cg.getJournalMode(),
      /** References still waiting to resolve; > 0 means edges are still missing. */
      pendingReferences: cg.getPendingReferenceCount(),
      generatedFiles: cg.getGeneratedFileCount(),
      watching: cg.isWatching(),
      watcherDegraded: cg.isWatcherDegraded(),
    },
    graph: {
      nodes: stats.nodeCount,
      edges: stats.edgeCount,
      files: stats.fileCount,
      nodesByKind: stats.nodesByKind,
      edgesByKind: stats.edgesByKind,
      filesByLanguage: stats.filesByLanguage,
      dbSizeBytes: stats.dbSizeBytes,
      walSizeBytes: stats.walSizeBytes,
    },
    frameworks: cg.getDetectedFrameworks(),
    /**
     * The thresholds the API itself applied, so the viewer's copy ("hub · N",
     * "confidence < 0.6") stays in step with the data instead of hard-coding a
     * second copy of the same numbers.
     */
    thresholds: { hub: HUB_THRESHOLD, uncertainBelow: UNCERTAIN_BELOW },
    /**
     * The denominator the Symbol view's blast bar is drawn against, so one
     * symbol's radius reads as wide or narrow *for this repo* instead of as a
     * bare number. See {@link blastScaleFor} for what "sampled" costs and
     * concedes.
     */
    blastScale: blastScaleFor(cg, projectRoot, stats.edgeCount),
  };
}
