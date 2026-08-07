/**
 * Per-file allocation diagnostic for `codegraph_explore` (CG-4).
 *
 * The explore response is a fixed byte envelope (`budget.maxOutputChars`, hard-
 * capped at 25K so the host never externalizes the result). WHICH files fill it,
 * and in what proportion, is decided by a long chain of gates, tiers and caps
 * spread across `handleExplore`. That chain is currently unobservable: you can
 * read the output and guess, but you cannot say "this file took 16% of the
 * envelope and that one took 21%" without hand-counting.
 *
 * This module is the instrument. Enabled by `CODEGRAPH_EXPLORE_DEBUG`, it
 * records, for one explore call:
 *   - per candidate file: relevance score, graph (RWR) mass, distinct query-term
 *     hits, ranking flags, render mode, bytes of source actually emitted, that
 *     file's share of the final envelope, whether it was clipped, whether it
 *     carries a flow-spine symbol — and for the ones that didn't render, why;
 *   - totals: envelope vs `maxOutputChars` vs the hard ceiling, source bytes vs
 *     meta-text overhead, files considered at each filter stage, and the score
 *     floor / relevance-gate thresholds that were applied.
 *
 * HARD CONSTRAINT — this ships in the product binary: when the env var is unset
 * the diagnostic must not exist. `start()` returns `null`, every call site is a
 * `diag?.` no-op, and the agent-facing response is byte-identical. The
 * diagnostic never mutates render state, and every method is wrapped so a bug in
 * here can never fail an explore call.
 *
 * Sinks (value of `CODEGRAPH_EXPLORE_DEBUG`):
 *   `1` / `true` / `on` / `yes` / `stderr` → human-readable table on stderr
 *   `json`                                 → one JSON object on stderr
 *   anything else                          → treated as a path; one JSON object
 *                                            per line appended (JSONL sidecar)
 */

import { appendFileSync } from 'fs';
import type { ExploreProjectState } from './explore-session-state';

/** How a file's source was rendered into the response. */
export type ExploreRenderMode =
  | 'whole'         // whole-file window
  | 'clusters'      // ranked contiguous clusters
  | 'focused'       // per-symbol view, named/spine bodies full
  | 'skeleton'      // per-symbol view, signatures only
  | 'stale-omitted' // drifted on disk; source deliberately withheld
  | 'backref'       // fully served by an earlier call this session (CG-18)
  | 'dropped';      // rendered into `lines` but cut by the final hard ceiling

/** Why a ranked candidate never reached the output. */
export type ExploreSkipReason =
  | 'max-files'          // maxFiles reached before this file
  | 'cliff'              // below the relevance cliff — pointer, not bytes (CG-12)
  | 'budget-whole-file'  // whole-file render wouldn't fit under the hard ceiling
  | 'budget-clusters'    // cluster render wouldn't fit under the hard ceiling
  | 'unreadable'         // outside root, missing, or read error
  | 'no-ranges';         // no renderable line ranges in this file

/** Ranking inputs for one candidate file, captured before the render loop. */
export interface ExploreCandidateMeta {
  rank: number;
  score: number;
  graphScore: number;
  termHits: number;
  nodes: number;
  named: boolean;
  central: boolean;
  entry: boolean;
  spine: boolean;
  lowValue: boolean;
  generated: boolean;
  /**
   * Nothing but type declarations in this file, and nothing in the index
   * depends on it (CG-28) — it cannot answer a flow question, so it ranks on
   * discounted signals unless the query named one of the types it declares.
   */
  ambientDeclaration: boolean;
  /**
   * Multiplier `rankPenalty` applied to BOTH `score` and `graphScore` (1 = no
   * penalty). Generated and test/i18n files rank on discounted signals, so the
   * raw values are `score / penalty` — worth reporting, since "why did this
   * generated file lose?" is otherwise invisible in the numbers (CG-10).
   */
  penalty: number;
  /**
   * Which NodeKinds the file's matched symbols were, most-numerous first
   * (`function:4 constant:1`). The scoring is kind-weighted, so this is the
   * breakdown that explains a score — a file carried by one isolated `constant`
   * is the #1500 failure, and it is legible here at a glance.
   */
  kinds: string;
}

interface FileRecord extends ExploreCandidateMeta {
  path: string;
  /**
   * Chars this file was RESERVED by the proportional allocator (CG-12), before
   * it rendered anything. `0` = cliffed; `null` = never reached the allocator.
   * The gap between this and `emittedChars` is the whole story of a budget bug:
   * reserved-but-unspent means the file had nothing to say, spent-over-reserved
   * means an oversize first cluster or the whole-file grace overshot — but read
   * `spendable` before calling it an overshoot, since inherited slack legitimately
   * lifts a file above its reservation.
   */
  allowance: number | null;
  /**
   * What the file could actually SPEND: its reservation plus the slack the
   * files above it left on the table (bounded by MAX_SHARE). Every render bound
   * reads this, not `allowance`, so it — not the reservation — is what an
   * overshoot is measured against. `null` until the render loop reaches the
   * file. Reporting only `allowance` makes an ordinary carry-forward look like
   * a file spending over its reservation.
   */
  spendable: number | null;
  /**
   * The DISPLACEMENT-GUARDED ceiling (CG-31): the most this file may render
   * without spending a reservation still owed to a file the loop has not
   * reached AND can still pay. `spendable` is what the file was promised, this
   * is what is actually still there to pay it with — every render path is
   * bounded by it, so `emittedChars` above it is a bug. Sits ABOVE `spendable`
   * when the room is there (the bounded overshoot a big cluster member may
   * take) and BELOW it when the files underneath need the bytes. `null` until
   * the render loop reaches the file.
   */
  funded: number | null;
  render?: ExploreRenderMode;
  /**
   * Source chars this call did NOT re-send because an earlier call in the
   * session already did (CG-18). Reclaimed, not lost: it leaves through
   * `sourceSpent` (the carry-forward pool hands it to lower-ranked files) and,
   * for a fully back-referenced file, through the freed `maxFiles` slot. The
   * reallocation is legible as the difference between this file's
   * `allowance` and `emittedChars` against the files below it in the table.
   */
  dedupSavedChars: number;
  /** Line spans replaced by a back-reference. */
  dedupCovered: Array<[number, number]>;
  /** Source chars the render loop handed to `lines` (pre-final-truncation). */
  emittedChars: number;
  /** Source chars present in the FINAL text — authoritative, truncation-aware. */
  finalChars: number;
  /** Share of the DELIVERED envelope, as a fraction (0–1). */
  share: number;
  /** Share of what the render loop ALLOCATED, before the hard-ceiling cut. */
  allocatedShare: number;
  clipped: boolean;
  skipped?: ExploreSkipReason;
}

/** Candidate counts down the selection pipeline, in the order it runs. */
interface StageCounts {
  /** Files with at least one gathered node. */
  grouped: number;
  /** Survived the test/spec/icon/i18n hard-exclude. */
  pastLowValueFilter: number;
  /** Survived the `group.score >= scoreFloor` filter. */
  pastScoreFloor: number;
  /** Survived the graph-relevance gate. */
  pastRelevanceGate: number;
}

/** Budget fields the diagnostic reports. Structural, to avoid a cyclic import. */
interface BudgetShape {
  maxOutputChars: number;
  maxCharsPerFile: number;
  defaultMaxFiles: number;
}

/** One file's line in the report. Also the JSONL sidecar's per-file shape. */
export interface ExploreDiagnosticFile extends ExploreCandidateMeta {
  path: string;
  allowance: number | null;
  /** Reservation + inherited slack — the bound the render paths actually use. */
  spendable: number | null;
  /** Render ceiling after holding back what is still owed to unreached files. */
  funded: number | null;
  render: ExploreRenderMode | null;
  skipped: ExploreSkipReason | null;
  clipped: boolean;
  dedupSavedChars: number;
  dedupCovered: Array<[number, number]>;
  emittedChars: number;
  finalChars: number;
  share: number;
  allocatedShare: number;
}

/**
 * This session's explore history for this project, as of BEFORE the call being
 * reported (CG-17). Present only when the caller tracks session state — the CLI
 * and bare-handler callers don't, so it is absent there rather than zeroed.
 */
export interface ExploreDiagnosticSession {
  /** 1-based index of THIS call within the session, for this project. */
  callIndex: number;
  /** Calls already served this session for this project. */
  priorCalls: number;
  /** Response chars already served this session for this project. */
  priorResponseChars: number;
  /** Files already served source this session, most-recent call first. */
  priorFiles: Array<{ path: string; ranges: Array<[number, number]>; bytes: number }>;
}

/** The full report — one per explore call, JSON-serialized to the sink. */
export interface ExploreDiagnosticReport {
  tool: 'codegraph_explore';
  query: string;
  projectRoot: string;
  indexedFileCount: number;
  note?: string;
  /** Session-scoped call state (CG-17); absent when the caller tracks none. */
  session?: ExploreDiagnosticSession;
  budget: {
    maxOutputChars: number;
    maxCharsPerFile: number;
    maxFiles: number;
    hardCeiling: number;
  };
  envelope: {
    /** Chars actually returned to the agent (post-truncation). */
    chars: number;
    /** Chars the render loop produced, BEFORE the hard-ceiling cut. */
    allocatedChars: number;
    overBudget: boolean;
    truncated: boolean;
    sourceChars: number;
    sourceShare: number;
    metaChars: number;
    metaShare: number;
  };
  selection: {
    scoreFloor: number;
    maxGraph: number;
    graphGateThreshold: number;
    graphGateApplied: boolean;
    filesGrouped: number;
    filesPastLowValueFilter: number;
    filesPastScoreFloor: number;
    filesRanked: number;
    filesRenderedByLoop: number;
    filesInFinalOutput: number;
  };
  /**
   * Cross-call source dedup (CG-18): what this call did NOT re-send because an
   * earlier call in this session already sent it, and where those bytes went.
   * `savedChars` 0 with a non-empty session block means nothing overlapped.
   */
  dedup: {
    savedChars: number;
    backReferenced: string[];
    /** Files fully replaced by a pointer — each one also freed a `maxFiles` slot. */
    fullyBackReferenced: string[];
  };
  /** The proportional split (CG-12): what each file was promised, and why. */
  allocation: {
    /** Chars divided among admitted files (envelope minus per-file overhead). */
    pool: number;
    /** Weight threshold the cliff fired at; 0 when nothing was cliffed. */
    cliffAt: number;
    /** Files given zero source — pointers in the not-shown list instead. */
    cliffed: string[];
    /** Sum of reservations. Must not exceed `pool`. */
    reserved: number;
  };
  files: ExploreDiagnosticFile[];
}

type Sink =
  | { kind: 'stderr'; json: boolean }
  | { kind: 'file'; path: string };

const OFF = new Set(['', '0', 'false', 'off', 'no']);
const STDERR_TABLE = new Set(['1', 'true', 'on', 'yes', 'stderr']);

/**
 * Resolve the sink from the environment. `null` means the diagnostic is off —
 * read per call (not memoized) so a test can toggle it between invocations.
 */
function resolveSink(): Sink | null {
  const raw = process.env.CODEGRAPH_EXPLORE_DEBUG;
  if (raw === undefined) return null;
  const value = raw.trim();
  const lower = value.toLowerCase();
  if (OFF.has(lower)) return null;
  if (STDERR_TABLE.has(lower)) return { kind: 'stderr', json: false };
  if (lower === 'json') return { kind: 'stderr', json: true };
  return { kind: 'file', path: value };
}

const num = (n: number) => Math.round(n).toLocaleString('en-US');
const pct = (f: number) => `${(f * 100).toFixed(1)}%`;

export class ExploreDiagnostics {
  private readonly files = new Map<string, FileRecord>();
  private readonly stages: StageCounts = {
    grouped: 0, pastScoreFloor: 0, pastLowValueFilter: 0, pastRelevanceGate: 0,
  };
  private scoreFloor = 0;
  private maxGraph = 0;
  private graphGateThreshold = 0;
  private graphGateApplied = false;
  private note = '';
  private session: ExploreDiagnosticSession | undefined;
  private allocPool = 0;
  private allocCliffAt = 0;
  private allocCliffed: string[] = [];

  private constructor(
    private readonly sink: Sink,
    private readonly query: string,
    private readonly projectRoot: string,
    private readonly budget: BudgetShape,
    private readonly maxFiles: number,
    private readonly indexedFileCount: number,
  ) {}

  /**
   * Returns `null` when `CODEGRAPH_EXPLORE_DEBUG` is unset/off — the whole
   * instrument then costs one env read per explore call and nothing else.
   */
  static start(
    query: string,
    projectRoot: string,
    budget: BudgetShape,
    maxFiles: number,
    indexedFileCount: number,
  ): ExploreDiagnostics | null {
    try {
      const sink = resolveSink();
      if (!sink) return null;
      return new ExploreDiagnostics(sink, query, projectRoot, budget, maxFiles, indexedFileCount);
    } catch {
      return null;
    }
  }

  /**
   * Candidate count after the test/spec/icon/i18n hard-exclude — the FIRST
   * selection stage, ahead of the score floor.
   */
  setLowValueFiltered(grouped: number, kept: number): void {
    this.stages.grouped = grouped;
    this.stages.pastLowValueFilter = kept;
    this.stages.pastScoreFloor = kept;
    this.stages.pastRelevanceGate = kept;
  }

  /**
   * Record what this session had already been served for this project (CG-17),
   * so the report says which call in the session it is and what the earlier ones
   * cost. Read-only for now: nothing in the render loop consults it, which is
   * what keeps the response byte-identical at this stage.
   *
   * Files are listed most-recent call first and de-duplicated by path — the same
   * file re-served across calls is the pattern this instrument exists to make
   * visible, and its ranges are unioned so a glance shows what of it the agent
   * already holds.
   */
  noteSession(prior: ExploreProjectState | null): void {
    if (!prior) return;
    const byPath = new Map<string, { path: string; ranges: Array<[number, number]>; bytes: number }>();
    for (const call of [...prior.calls].reverse()) {
      for (const file of call.files) {
        const existing = byPath.get(file.path);
        const spans = file.ranges.map((r) => [r.start, r.end] as [number, number]);
        if (existing) {
          existing.ranges.push(...spans);
          existing.bytes += file.bytes;
        } else {
          byPath.set(file.path, { path: file.path, ranges: spans, bytes: file.bytes });
        }
      }
    }
    this.session = {
      callIndex: prior.callCount + 1,
      priorCalls: prior.callCount,
      priorResponseChars: prior.responseBytes,
      priorFiles: [...byPath.values()],
    };
  }

  /** Candidate count after the `group.score >= floor` filter. */
  setScoreFloor(floor: number, kept: number): void {
    this.scoreFloor = floor;
    this.stages.pastScoreFloor = kept;
    this.stages.pastRelevanceGate = kept;
  }

  /** Graph-relevance gate: threshold, whether it actually pruned, what survived. */
  setRelevanceGate(maxGraph: number, threshold: number, applied: boolean, kept: number): void {
    this.maxGraph = maxGraph;
    this.graphGateThreshold = threshold;
    this.graphGateApplied = applied;
    this.stages.pastRelevanceGate = kept;
  }

  /** Record one ranked candidate's scoring inputs, in final sort order. */
  noteCandidate(path: string, meta: ExploreCandidateMeta): void {
    this.files.set(path, {
      path, ...meta, allowance: null, spendable: null, funded: null,
      dedupSavedChars: 0, dedupCovered: [],
      emittedChars: 0, finalChars: 0, share: 0, allocatedShare: 0, clipped: false,
    });
  }

  /**
   * Record the proportional split (CG-12), taken right after ranking and before
   * a single byte renders. Called once per explore.
   */
  setAllocation(
    allowances: ReadonlyMap<string, number>,
    cliffed: readonly string[],
    cliffAt: number,
    pool: number,
  ): void {
    this.allocPool = pool;
    this.allocCliffAt = cliffAt;
    this.allocCliffed = [...cliffed];
    for (const [path, chars] of allowances) {
      const rec = this.files.get(path);
      if (rec) rec.allowance = chars;
    }
    for (const path of cliffed) {
      const rec = this.files.get(path);
      if (rec) rec.allowance = 0;
    }
  }

  /**
   * What the render loop will let this file spend — reservation plus inherited
   * slack. Called once per file, before any of its render paths run.
   */
  recordSpendable(path: string, chars: number): void {
    const rec = this.files.get(path);
    if (rec) rec.spendable = chars;
  }

  /**
   * What the render loop will let this file spend once the reservations still
   * owed BELOW it are held back (CG-31). Called alongside `recordSpendable`.
   */
  recordFunded(path: string, chars: number): void {
    const rec = this.files.get(path);
    if (rec) rec.funded = chars;
  }

  /** A candidate rendered source into the response. */
  recordRender(path: string, render: ExploreRenderMode, sourceChars: number, clipped: boolean): void {
    const rec = this.files.get(path);
    if (!rec) return;
    rec.render = render;
    rec.emittedChars = sourceChars;
    rec.clipped = clipped;
    rec.skipped = undefined;
  }

  /**
   * Source this call withheld because the session already holds it (CG-18).
   * Called with `(path, 0, [])` to clear a record — the anti-abandonment restore
   * puts a suppressed file's source back, and a diagnostic still claiming the
   * saving would misreport where the envelope went.
   */
  recordDedup(path: string, savedChars: number, covered: ReadonlyArray<{ start: number; end: number }>): void {
    const rec = this.files.get(path);
    if (!rec) return;
    rec.dedupSavedChars = savedChars;
    rec.dedupCovered = covered.map((r) => [r.start, r.end] as [number, number]);
  }

  /**
   * A candidate was passed over before rendering. First reason wins — the
   * blanket `max-files` sweep must not overwrite a file's specific reason.
   */
  recordSkip(path: string, reason: ExploreSkipReason): void {
    const rec = this.files.get(path);
    if (!rec || rec.render || rec.skipped) return;
    rec.skipped = reason;
  }

  /** Explore returned early (no subgraph). Emits a minimal record. */
  finishEmpty(reason: string): void {
    this.note = reason;
    this.emit(this.buildReport('', 0, 0, 0));
  }

  /**
   * Final pass: attribute the FINAL text's bytes back to files (so the hard
   * ceiling's truncation is reflected in what each file actually delivered),
   * then emit.
   *
   * `allocatedChars` is the pre-truncation length — the size the render loop
   * *chose*. Reporting both is the point: the allocator's decision and the
   * agent's delivered payload diverge exactly when the ceiling cuts, and
   * conflating them is how a dropped trailing file goes unnoticed.
   */
  finish(finalText: string, allocatedChars: number, hardCeiling: number, filesIncluded: number): void {
    try {
      const perFile = attributeSourceBytes(finalText);
      const envelope = finalText.length;
      for (const rec of this.files.values()) {
        rec.finalChars = perFile.get(rec.path) ?? 0;
        rec.share = envelope > 0 ? rec.finalChars / envelope : 0;
        rec.allocatedShare = allocatedChars > 0 ? rec.emittedChars / allocatedChars : 0;
        // Rendered into `lines` but absent from the final text → the hard
        // ceiling dropped its whole section. A back-referenced file has no
        // fenced source BY DESIGN (CG-18), so it is never "dropped".
        if (rec.render && rec.render !== 'stale-omitted' && rec.render !== 'backref'
            && rec.finalChars === 0) {
          rec.render = 'dropped';
          rec.clipped = true;
        }
      }
      this.emit(this.buildReport(finalText, allocatedChars, hardCeiling, filesIncluded));
    } catch {
      // A diagnostic must never fail an explore call.
    }
  }

  private buildReport(
    finalText: string,
    allocatedChars: number,
    hardCeiling: number,
    filesIncluded: number,
  ): ExploreDiagnosticReport {
    const envelope = finalText.length;
    const records = [...this.files.values()];
    const rendered = records.filter((r) => r.finalChars > 0);
    const sourceChars = rendered.reduce((s, r) => s + r.finalChars, 0);
    return {
      tool: 'codegraph_explore',
      query: this.query,
      projectRoot: this.projectRoot,
      indexedFileCount: this.indexedFileCount,
      note: this.note || undefined,
      session: this.session,
      budget: {
        maxOutputChars: this.budget.maxOutputChars,
        maxCharsPerFile: this.budget.maxCharsPerFile,
        maxFiles: this.maxFiles,
        hardCeiling,
      },
      envelope: {
        chars: envelope,
        allocatedChars,
        overBudget: allocatedChars > this.budget.maxOutputChars,
        truncated: allocatedChars > hardCeiling,
        sourceChars,
        sourceShare: envelope > 0 ? sourceChars / envelope : 0,
        metaChars: envelope - sourceChars,
        metaShare: envelope > 0 ? (envelope - sourceChars) / envelope : 0,
      },
      selection: {
        scoreFloor: this.scoreFloor,
        maxGraph: this.maxGraph,
        graphGateThreshold: this.graphGateThreshold,
        graphGateApplied: this.graphGateApplied,
        filesGrouped: this.stages.grouped,
        filesPastLowValueFilter: this.stages.pastLowValueFilter,
        filesPastScoreFloor: this.stages.pastScoreFloor,
        filesRanked: this.stages.pastRelevanceGate,
        filesRenderedByLoop: filesIncluded,
        filesInFinalOutput: rendered.length,
      },
      dedup: {
        savedChars: records.reduce((s, r) => s + r.dedupSavedChars, 0),
        backReferenced: records.filter((r) => r.dedupSavedChars > 0).map((r) => r.path),
        fullyBackReferenced: records.filter((r) => r.render === 'backref').map((r) => r.path),
      },
      allocation: {
        pool: this.allocPool,
        cliffAt: round6(this.allocCliffAt),
        cliffed: [...this.allocCliffed],
        reserved: records.reduce((s, r) => s + (r.allowance ?? 0), 0),
      },
      files: records
        .slice()
        .sort((a, b) => b.emittedChars - a.emittedChars || b.finalChars - a.finalChars || a.rank - b.rank)
        .map((r) => ({
          path: r.path,
          rank: r.rank,
          score: r.score,
          graphScore: round6(r.graphScore),
          termHits: r.termHits,
          nodes: r.nodes,
          named: r.named,
          central: r.central,
          entry: r.entry,
          spine: r.spine,
          lowValue: r.lowValue,
          generated: r.generated,
          ambientDeclaration: r.ambientDeclaration,
          penalty: round6(r.penalty),
          kinds: r.kinds,
          allowance: r.allowance,
          spendable: r.spendable,
          funded: r.funded,
          render: r.render ?? null,
          skipped: r.skipped ?? null,
          clipped: r.clipped,
          dedupSavedChars: r.dedupSavedChars,
          dedupCovered: r.dedupCovered.map((s) => [...s] as [number, number]),
          emittedChars: r.emittedChars,
          finalChars: r.finalChars,
          share: round6(r.share),
          allocatedShare: round6(r.allocatedShare),
        })),
    };
  }

  private emit(report: ExploreDiagnosticReport): void {
    try {
      if (this.sink.kind === 'file') {
        appendFileSync(this.sink.path, JSON.stringify(report) + '\n', 'utf-8');
        return;
      }
      if (this.sink.json) {
        process.stderr.write(JSON.stringify(report, null, 2) + '\n');
        return;
      }
      process.stderr.write(renderTable(report) + '\n');
    } catch {
      // Unwritable sidecar / closed stderr must not fail the explore call.
    }
  }
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/**
 * Attribute the final response's source bytes back to files by walking the
 * rendered markdown: a ``**`path`**`` section header followed by a fenced code
 * block. Reading the FINAL text (rather than trusting the render loop's running
 * total) is what makes the numbers truthful — it accounts for the hard-ceiling
 * truncation that can drop whole trailing sections after they were "emitted".
 *
 * Line numbering is on by default, so a source line that is itself a ``` fence
 * arrives as `42\t```` and cannot close the block early.
 */
export function attributeSourceBytes(finalText: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!finalText) return out;
  const lines = finalText.split('\n');
  let current: string | null = null;
  let inFence = false;
  let acc: string[] = [];
  const flush = () => {
    if (current && acc.length > 0) {
      out.set(current, (out.get(current) ?? 0) + acc.join('\n').length);
    }
    acc = [];
  };
  for (const line of lines) {
    if (!inFence) {
      const header = /^\*\*`([^`]+)`\*\*/.exec(line);
      if (header) {
        current = header[1]!;
        continue;
      }
      if (current && line.startsWith('```')) {
        inFence = true;
        continue;
      }
      continue;
    }
    if (line === '```') {
      inFence = false;
      flush();
      continue;
    }
    acc.push(line);
  }
  // Unterminated fence (final-ceiling truncation cut mid-block): count it.
  if (inFence) flush();
  return out;
}

/** Human-readable stderr rendering of the JSON report. */
export function renderTable(report: ExploreDiagnosticReport): string {
  const { budget, envelope: env, selection: sel, files } = report;

  const out: string[] = [];
  out.push('');
  out.push(`codegraph explore diagnostic — "${report.query}"`);
  out.push(`  project ${report.projectRoot} · ${num(report.indexedFileCount)} files indexed`);
  if (report.note) out.push(`  note: ${report.note}`);
  if (report.session) {
    const s = report.session;
    out.push(
      `  session call #${s.callIndex} for this project` +
      ` · ${num(s.priorCalls)} prior call${s.priorCalls === 1 ? '' : 's'}` +
      ` · ${num(s.priorResponseChars)} chars already served`,
    );
    for (const f of s.priorFiles.slice(0, 12)) {
      const spans = f.ranges.slice(0, 6).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',');
      const more = f.ranges.length > 6 ? `,+${f.ranges.length - 6}` : '';
      out.push(`    already served ${f.path} · ${num(f.bytes)} chars · L${spans}${more}`);
    }
    if (s.priorFiles.length > 12) out.push(`    … +${s.priorFiles.length - 12} more already-served file(s)`);
  }
  out.push(
    `  envelope ${num(env.chars)} chars delivered · ${num(env.allocatedChars)} allocated` +
    ` of ${num(budget.maxOutputChars)} budget (hard ceiling ${num(budget.hardCeiling)})` +
    `${env.overBudget ? ' [over budget]' : ''}${env.truncated ? ' [TRUNCATED]' : ''}`,
  );
  out.push(
    `  source ${num(env.sourceChars)} (${pct(env.sourceShare)})` +
    ` · meta ${num(env.metaChars)} (${pct(env.metaShare)})` +
    ` · per-file cap ${num(budget.maxCharsPerFile)}`,
  );
  out.push(
    `  files ${num(sel.filesGrouped)} grouped` +
    ` → ${num(sel.filesPastLowValueFilter)} past low-value filter` +
    ` → ${num(sel.filesPastScoreFloor)} past score floor (>=${sel.scoreFloor.toFixed(1)})` +
    ` → ${num(sel.filesRanked)} past relevance gate` +
    ` → ${num(sel.filesInFinalOutput)} in output (maxFiles ${num(budget.maxFiles)})`,
  );
  out.push(
    `  relevance gate ${sel.graphGateApplied ? 'applied' : 'not applied'}` +
    ` at graph >= ${sel.graphGateThreshold.toFixed(5)} (6% of max ${sel.maxGraph.toFixed(5)})`,
  );
  const dedup = report.dedup;
  if (dedup && dedup.savedChars > 0) {
    out.push(
      `  dedup ${num(dedup.savedChars)} chars not re-sent` +
      ` · ${dedup.fullyBackReferenced.length} file(s) fully back-referenced` +
      ` (each also freed a maxFiles slot)` +
      (dedup.backReferenced.length > 0 ? `: ${dedup.backReferenced.join(', ')}` : ''),
    );
  }
  const alloc = report.allocation;
  out.push(
    `  allocation ${num(alloc.reserved)} reserved of ${num(alloc.pool)} pool` +
    ` · cliff at weight ${alloc.cliffAt.toFixed(2)}` +
    (alloc.cliffed.length > 0
      ? ` · ${alloc.cliffed.length} cliffed to pointers: ${alloc.cliffed.join(', ')}`
      : ' · nothing cliffed'),
  );
  out.push('');

  // Allocated (not delivered) is the allocator's own decision — the number the
  // budget work is about. Delivered is what the agent got. They differ only
  // when the ceiling truncated; showing both makes that divergence obvious.
  const shown = files.filter((f) => f.emittedChars > 0 || f.finalChars > 0 || f.render === 'backref');
  if (shown.length > 0) {
    out.push('   #  alloc%  deliv%    bytes  reserved  score    graph  hits  pen   flags                render     file');
    for (const f of shown) {
      out.push(
        '  ' +
        String(f.rank).padStart(2) + '  ' +
        pct(f.allocatedShare).padStart(6) + '  ' +
        pct(f.share).padStart(6) + '  ' +
        num(f.emittedChars).padStart(7) + '  ' +
        (f.allowance === null ? '-' : num(f.allowance)).padStart(8) + '  ' +
        f.score.toFixed(1).padStart(5) + '  ' +
        f.graphScore.toFixed(5).padStart(7) + '  ' +
        String(f.termHits).padStart(4) + '  ' +
        f.penalty.toFixed(2).padStart(4) + '  ' +
        flagString(f).padEnd(19) + '  ' +
        ((f.render ?? '-') + (f.clipped ? '*' : '')).padEnd(9) + '  ' +
        f.path,
      );
      out.push('        kinds: ' + (f.kinds || '-'));
      // Only when it differs: a file that spent over `reserved` but inside
      // `spendable` took inherited slack, not a budget bug.
      if (f.spendable !== null && f.allowance !== null && f.spendable !== f.allowance) {
        out.push(`        spendable: ${num(f.spendable)} (reservation + inherited slack)`);
      }
      // Only when the displacement guard actually bit: the gap is the overshoot
      // this file was refused so the files below it could still be paid.
      if (f.funded !== null && f.spendable !== null && f.funded < Math.round(f.spendable * 1.5)) {
        out.push(`        funded: ${num(f.funded)} (held to this so the files below keep their reservations)`);
      }
      if (f.dedupSavedChars > 0) {
        const spans = f.dedupCovered.slice(0, 6).map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(',');
        const more = f.dedupCovered.length > 6 ? `,+${f.dedupCovered.length - 6}` : '';
        out.push(`        dedup: ${num(f.dedupSavedChars)} chars already sent this session · L${spans}${more}`);
      }
    }
    out.push('  (bytes = source allocated by the render loop; deliv% = 0 means the hard ceiling dropped the section)');
    out.push('  (* = clipped: some source in this file was elided, windowed, or its section dropped)');
  } else {
    out.push('  (no file source in the final output)');
  }

  const skipped = files.filter((f) => f.emittedChars === 0 && f.finalChars === 0);
  if (skipped.length > 0) {
    out.push('');
    out.push('  ranked but never rendered:');
    for (const f of skipped.slice(0, 15)) {
      out.push(
        `    #${String(f.rank).padStart(2)} ${f.path} — ${f.skipped ?? f.render ?? 'not reached'}` +
        ` (score ${f.score.toFixed(1)}, graph ${f.graphScore.toFixed(5)}, hits ${f.termHits},` +
        ` pen ${f.penalty.toFixed(2)}, ${flagString(f) || 'no flags'}, ${f.kinds || '-'})`,
      );
    }
    if (skipped.length > 15) out.push(`    … and ${skipped.length - 15} more`);
  }
  return out.join('\n');
}

function flagString(f: ExploreDiagnosticFile): string {
  const flags: string[] = [];
  if (f.named) flags.push('named');
  if (f.entry) flags.push('entry');
  if (f.central) flags.push('central');
  if (f.spine) flags.push('spine');
  if (f.lowValue) flags.push('low-value');
  if (f.generated) flags.push('generated');
  if (f.ambientDeclaration) flags.push('ambient-decl');
  return flags.join(' ') || '-';
}
