/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import type CodeGraph from '../index';
import type { QueryPool } from './query-pool';
import { findNearestCodeGraphRoot } from '../directory';
// Lazy-load the heavy CodeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// CodeGraph is pulled in only when a tool actually opens a project. require() is
// sync + cached (CommonJS build).
const loadCodeGraph = (): typeof import('../index').default =>
  loadCodeGraphForTests ?? (require('../index') as typeof import('../index')).default;
// Test seam (same pattern as the watcher's `__setFsWatchForTests`): vitest's
// module transform can't service the lazy `require('../index')` above, so
// in-process tests that exercise a genuine cross-project open (an explicit
// `projectPath` to a different project — issue #1474's repro shape) inject the
// already-imported class here. Never set outside tests.
let loadCodeGraphForTests: typeof import('../index').default | null = null;
export function __setLoadCodeGraphForTests(cls: typeof import('../index').default | null): void {
  loadCodeGraphForTests = cls;
}
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, NodeKind } from '../types';
import { isTestFile, normalizeNameToken } from '../search/query-utils';
import { extractQueryPaths, queryMightContainPaths } from '../search/query-paths';
import {
  existsSync,
  readFileSync,
  statSync,
} from 'fs';
import { createHash } from 'crypto';
import { clamp, validatePathWithinRoot, validateProjectPath, isConfigLeafNode, CONFIG_LEAF_LANGUAGES } from '../utils';
import { scanDynamicDispatch } from './dynamic-boundaries';
import { getUpdateNotice } from '../upgrade/update-check';
import { ExploreDiagnostics } from './explore-diagnostics';
import {
  EXPLORE_EMISSION_KEY,
  EXPLORE_SESSION_VIEW_ARG,
  ExploreSessionState,
  readExploreSessionView,
  viewForProject,
  type ExploreEmission,
  type ExploreFileEmission,
  type ExploreLineRange,
} from './explore-session-state';
import {
  EXPLORE_DEDUP,
  dedupeRange,
  exploreDedupEnabled,
  fileFingerprint,
  formatBackReference,
  mergeRanges,
  servedRangesForFile,
  symbolsInSpans,
} from './explore-dedup';

/**
 * An expected, recoverable "codegraph can't serve this" condition — most
 * importantly a project with no index. The dispatch catch converts these to
 * SUCCESS-shaped responses (guidance text, NO isError): an `isError: true`
 * early in a session teaches the agent the toolset is broken and it stops
 * calling codegraph entirely (observed repeatedly), which is exactly wrong
 * for conditions the agent can simply work around (use built-in tools for
 * that codebase / pass projectPath). isError is reserved for "stop trying"
 * cases: security refusals ({@link PathRefusalError}) and genuine
 * malfunctions.
 */
export class NotIndexedError extends Error {}

/**
 * A security refusal (sensitive system path). Stays `isError: true` WITHOUT
 * retry guidance — abandoning this path is the desired agent reaction.
 */
export class PathRefusalError extends Error {}
import { resolve as resolvePath, relative as relativePath } from 'path';

/** Maximum output length to prevent context bloat (characters) */
const MAX_OUTPUT_LENGTH = 15000;

/**
 * Maximum length for free-form string inputs (query, task, symbol).
 * Bounds memory and CPU when a buggy or hostile MCP client sends a
 * huge payload — without this an attacker could ship a 100MB string
 * and force a full FTS5 scan / OOM the server. 10 000 characters is
 * far beyond any realistic legitimate query.
 */
const MAX_INPUT_LENGTH = 10_000;

/**
 * Maximum length for path-like string inputs (projectPath, path
 * filter, glob pattern). Paths beyond a few thousand chars are
 * never legitimate and signal abuse or a bug upstream.
 */
const MAX_PATH_LENGTH = 4_096;

/**
 * Rust path roots that have no file-system equivalent — `crate` is the
 * current crate, `super` is the parent module, `self` is the current
 * module. Used by `matchesSymbol` to strip these before file-path
 * matching so `crate::configurator::stage_apply::run` resolves the
 * same as `configurator::stage_apply::run`.
 */
const RUST_PATH_PREFIXES = new Set(['crate', 'super', 'self']);

/**
 * Node kinds that contain other symbols. For these, `codegraph_node` with
 * `includeCode=true` returns a structural outline (member names + signatures
 * + line numbers) instead of the full body, which for a large class is a
 * multi-thousand-character wall of source that bloats the agent's context.
 */
const CONTAINER_NODE_KINDS = new Set<NodeKind>([
  'class', 'struct', 'union', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/**
 * Last `::` / `.` / `/`-separated segment of a qualified symbol. An Erlang
 * arity tail (`mod::fn/3`, `fn/3`) is stripped first — the useful last segment
 * is the function name, never the digits (#1610).
 */
function lastQualifierPart(symbol: string): string {
  const noArity = symbol.replace(/\/\d{1,3}$/, '') || symbol;
  const parts = noArity.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
}

/**
 * Normalize Erlang-native symbol spellings in an explore query into the shapes
 * the rest of the pipeline already understands. Agents working Erlang code
 * name symbols the way the language spells them — `mod:fn/3`, `init/2` — and
 * those tokens previously died in both consumers: the flow-builder's token
 * filter rejects `:` and `/arity` outright, and the search-side field parser
 * eats `mod:fn` as an unknown `field:value`. Measured on cowboy: the agent
 * named `cowboy_stream_h:request_process/3` in two queries, got no body back
 * either time, and fell back to Read.
 *
 *   - `fn/3` → `fn` (arity tail after an identifier; a path segment like
 *     `src/2fa` doesn't match because the tail must be all digits)
 *   - `mod:fn` → `mod.fn` (exactly one colon between identifiers, so it rides
 *     the existing Class.method qualified handling; `::`, URLs, drive letters,
 *     and times don't match, and the query language's own field prefixes —
 *     kind:/lang:/language:/path:/name: — are left alone)
 *
 * Safe cross-language: Lua's `t:m` spelling maps to the same `t.m` its
 * qualified names use, and no other supported spelling contains a bare
 * single-colon identifier pair.
 */
export function normalizeQuerySpelling(query: string): string {
  return query
    .replace(/\b([A-Za-z_][\w@]*)\/(\d{1,3})(?=$|[\s,()[\]/])/g, '$1')
    .replace(
      /(^|[\s,()[\]])(?!(?:kind|lang|language|path|name):)([a-z_][\w@]*):([A-Za-z_][\w@]*)(?=$|[\s,()[\]])/g,
      '$1$2.$3'
    );
}

/**
 * Calculate the recommended number of codegraph_explore calls based on project size.
 * Larger codebases need more exploration calls to cover their surface area,
 * but smaller ones should use fewer to avoid unnecessary overhead.
 */
export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

/**
 * Adaptive output budget for `codegraph_explore`, scaled to project size.
 *
 * Smaller codebases get a tighter total cap, fewer default files, smaller
 * per-file cap, and tighter clustering — so a focused query on a 100-file
 * project doesn't dump a whole file's worth of source into the agent's
 * context. Larger codebases keep the generous defaults because the
 * agent's native discovery cost (grep + find + many Reads) genuinely
 * dwarfs a fat explore call at that scale.
 *
 * Meta-text (relationships map, "additional relevant files" list,
 * completeness signal, budget note) is gated off for tiny projects
 * where one rich call is the whole story and the extra prose is just
 * overhead.
 *
 * Tier breakpoints mirror `getExploreBudget` so a project sits in the
 * same tier across both knobs.
 */
export interface ExploreOutputBudget {
  /** Hard cap on total output characters. */
  maxOutputChars: number;
  /** Default `maxFiles` when the caller didn't specify one. */
  defaultMaxFiles: number;
  /** Cap on contiguous source returned per file (across all its clusters). */
  maxCharsPerFile: number;
  /** Cluster gap threshold in lines — tighter clustering on small projects. */
  gapThreshold: number;
  /** Max symbols listed in the per-file header (``**`path`** — sym(kind), ...``). */
  maxSymbolsInFileHeader: number;
  /** Max edges shown per relationship kind in the Relationships section. */
  maxEdgesPerRelationshipKind: number;
  /** Include the "Relationships" section. */
  includeRelationships: boolean;
  /** Include the "Additional relevant files (not shown)" trailing list. */
  includeAdditionalFiles: boolean;
  /** Include the "Complete source code is included above…" reminder. */
  includeCompletenessSignal: boolean;
  /** Include the explore-budget reminder at the end. */
  includeBudgetNote: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  // Tiered budget, scaled to project size. The budget is a CEILING (relevance
  // still gates WHAT is included), and it MUST stay under the agent's INLINE
  // tool-result cap (~25K chars). Above that, the host externalizes the result
  // to a file the agent then Reads back — re-introducing a read AND the
  // cache-write cost — which is exactly what a 35K vscode explore did in the
  // n=4 README A/B. So even large repos cap at ~24K: the answer is the handful
  // of ~100-line flow windows the agent would have grep-located and read (it
  // natively reads ~6–9 files, median 100-line ranges), NOT a sprawl of 12
  // files. Concentration onto the flow emerges from this cap + the named-file-
  // first sort dropping peripheral files. Invariant: a larger tier must never
  // get a smaller `maxCharsPerFile` than a smaller tier.
  if (fileCount < 150) {
    return {
      // ITER3: revert iter2's aggressive body shrink (forced Read fallback —
      // the per-file 2.5K cap pushed the agent to Read instead of node).
      // Back to the iter1 shape (13K/4/3.8K) but keep the test-file
      // hard-exclude. The cost lever for this tier lives in steering the
      // agent to stop after 1-2 calls, not in this budget.
      maxOutputChars: 13000,
      defaultMaxFiles: 4,
      maxCharsPerFile: 3800,
      gapThreshold: 7,
      maxSymbolsInFileHeader: 5,
      maxEdgesPerRelationshipKind: 4,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 500) {
    return {
      // ITER3: same revert/keep-filter pattern as <150.
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: false,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 5000) {
    return {
      // ~150-line per-file window (the native read unit) × ~6 files, capped at
      // the ~24K inline ceiling so the response is never externalized. Per-file
      // stays ≥ the <500 tier (3800) — monotonic.
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  // Large + very-large repos: SAME ~24K inline ceiling (a bigger response just
  // externalizes — see vscode). More files indexed → more CALLS via
  // getExploreBudget, not a bigger single response. Per-file 7000 (≥ smaller
  // tiers) gives the central file a ~180-line orientation window.
  if (fileCount < 15000) {
    return {
      maxOutputChars: 24000,
      defaultMaxFiles: 8,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  return {
    maxOutputChars: 24000,
    defaultMaxFiles: 8,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
  };
}

// ── Explore relevance scoring (CG-10 / #1500) ──────────────────────────────
//
// A file earns its slice of the explore envelope from the symbols in it that the
// query matched. Before this weighting every match counted the same per tier, so
// a file that merely declares a local `const explore` scored what a file that
// DEFINES the explore pipeline scored — which is how three
// `scripts/agent-eval/*.mjs` harnesses took 63% of this repo's own "how does
// explore allocate its output budget across files" response on nothing but a
// local `explore` and a `BUDGET` constant. Four levers — the first three are
// multiplicative, so they compose without ordering surprises; the fourth decides
// admission from the result:
//
//   1. KIND      — what a match on this NodeKind actually tells you (below).
//   2. ISOLATION — a weak-kind symbol nothing calls or references is a pure name
//                  collision; participation in the graph is the corroboration.
//   3. PENALTY   — generated / test / i18n files are weaker answers to an
//                  architecture question at EVERY signal, not just as the
//                  tiebreak-at-equal-score they used to be.
//   4. FLOOR     — admission scales with the best file's score, replacing an
//                  absolute bar that admitted noise wherever the top score was
//                  high.

/**
 * How strongly a match on a symbol of this kind corroborates that its FILE is
 * what the query is about.
 *
 *   1.0   a callable or a type — the unit an architecture question is about
 *   ~0.5  a member of a type, or the file node itself (a path match, not a
 *         symbol match)
 *   ~0.3  a variable / constant — as often a name collision as a definition
 *   0.15  a parameter — essentially never the subject of a question
 *
 * Unlisted kinds fall back to `DEFAULT_RELEVANCE_KIND_WEIGHT`, so a NodeKind
 * added later is neither free nor fatal.
 */
export const RELEVANCE_KIND_WEIGHT: Readonly<Record<string, number>> = {
  // Callables and types: the answer lives in one of these.
  function: 1, method: 1, class: 1, struct: 1, union: 1, interface: 1, trait: 1,
  protocol: 1, component: 1, route: 1, enum: 1, type_alias: 1, constructor: 1,
  // Containers: real structure, but a whole namespace/module matching a term is
  // a coarser signal than a callable matching it.
  namespace: 0.8, module: 0.8,
  // Members of a type: real, weaker on their own.
  property: 0.5, field: 0.5, enum_member: 0.35,
  // The file node itself — the path matched, no symbol did.
  file: 0.5,
  // Incidental until the graph corroborates them (see ISOLATED_ below).
  constant: 0.35, variable: 0.3, parameter: 0.15,
};
const DEFAULT_RELEVANCE_KIND_WEIGHT = 0.5;

/**
 * Kinds whose evidentiary value depends on whether anything USES them. An
 * exported `const DEFAULTS` that half the codebase references is a real
 * definition; a `const explore` living inside one function of an eval script is
 * a name collision. Only these kinds pay for the isolation probe.
 */
const WEAK_RELEVANCE_KINDS: ReadonlySet<string> = new Set([
  'constant', 'variable', 'parameter', 'field', 'property', 'enum_member',
]);

/** Weight for a weak-kind symbol with no incoming/outgoing usage edge at all. */
const ISOLATED_WEAK_KIND_WEIGHT = 0.08;

/**
 * Edges that mean "this symbol is used". `contains` is lexical nesting, not
 * usage — counting it would make every file-scope constant look corroborated,
 * which is exactly the case this guards against.
 */
const RELEVANCE_USAGE_EDGES: ReadonlySet<string> = new Set([
  'calls', 'references', 'extends', 'implements', 'overrides',
  'instantiates', 'returns', 'type_of', 'decorates',
]);

/**
 * Cap on what PERIPHERAL nodes (in the subgraph, but neither a query match nor
 * adjacent to one) can contribute to a file's score. Uncapped, each such node
 * added a flat +1, so a file grew more "relevant" simply by being bigger —
 * `parse-session.mjs` reached score 22 off ONE incidental constant plus twelve
 * unrelated symbols. Size is not evidence; cap its contribution.
 */
const PERIPHERAL_SCORE_CAP = 5;

/**
 * Rank penalties, applied to BOTH the relevance score and the graph mass.
 *
 * Generated source used to be a tiebreak at equal score only, so a generated
 * file that outscored the hand-written one still won — the #1500 report exactly:
 * the FKIT CRUD layer carries every query term AND more graph mass than the
 * use-case that implements the business rule. A multiplier demotes it on the
 * PRIMARY sort key instead, without ever hard-excluding it (ask about the
 * generated API by name and the named-seed tier still puts it first). It is
 * self-normalizing: in an all-generated repo everything scales together and
 * relative ranking is untouched.
 */
const GENERATED_RANK_PENALTY = 0.3;
/**
 * Test/spec/icon/i18n files. These are normally hard-excluded outright, but that
 * filter stands down when fewer than 2 non-low-value candidates remain (else
 * tests would be the only signal for the area). This is the softened form for
 * that case: down-weighted rather than removed.
 */
const LOW_VALUE_RANK_PENALTY = 0.5;
/**
 * Ambient declaration files — a hand-written `.d.ts` of global shims, vendored
 * typings, module augmentation (CG-28). Declares nothing but types, and nothing
 * in the index depends on it.
 *
 * Such a file cannot answer a FLOW question no matter how much its identifiers
 * overlap the query: no bodies, no call edges, no behaviour, and nothing typed
 * by it. Its ceiling of usefulness is a type signature, and one follow-up
 * explore fetches that. But the identifiers it declares are exactly the generic
 * ones a prose question uses (`Body`, `Message`, `ImageMetadata`,
 * `ReadableStream`), so on term overlap it out-scores the implementation and
 * takes the envelope — measured at rank #1 and 51% of delivered source, with
 * the flow's own entry file getting none.
 *
 * Softer than {@link GENERATED_RANK_PENALTY} on purpose: "generated" is a claim
 * about provenance the file itself makes, while this is an inference about what
 * a file can be USEFUL for. A demoted declaration file that is still the best
 * candidate should keep its place; the penalty only has to stop it beating real
 * implementation. It does NOT stack with the generated penalty (see rankPenalty)
 * — penalising twice for the same property is how a file gets cliffed out of
 * answers where it is genuinely relevant.
 */
const AMBIENT_DECLARATION_RANK_PENALTY = 0.5;
/**
 * The type-level NodeKinds. Must stay in step with the kind list in
 * `QueryBuilder.getAmbientDeclarationPathsAmong` — that query decides which
 * files are ambient declarations, this set decides which symbols in them the
 * agent can name to lift the penalty back off.
 */
const DECLARATION_KINDS = new Set(['interface', 'type_alias', 'enum', 'enum_member', 'namespace']);

/**
 * Score floor: `clamp(topScore * FRACTION, ABSOLUTE, MAX)`.
 *
 * An absolute floor alone (`>= 3`) admits noise on any repo where the top file
 * scores 50+, so the bar is now a FRACTION of the best file's score and scales
 * with how strong the best match is. On a diffuse survey question no file
 * dominates, every candidate sits near the top score, and the whole spread gets
 * through; on a precise question it cuts the long tail of incidental matches.
 *
 * ABSOLUTE is recalibrated for kind-weighted scores: the old `>= 3` assumed an
 * unweighted tier sum where any query match was worth 10. A file whose sole
 * match is an unused local constant now scores 0.8, so 3 had quietly become a
 * much harsher admission bar than it was written to be — and the relative floor
 * is what this change means to prune with anyway.
 */
const SCORE_FLOOR_ABSOLUTE = 1;
const SCORE_FLOOR_FRACTION_OF_TOP = 0.2;
/**
 * Ceiling on the relative floor, in units of one direct query match on a
 * callable (the `entryNodeIds` tier, weight 1.0). A single full-strength match
 * is never incidental, so no amount of concentration elsewhere may exclude it:
 * one named-seed-heavy file (`+50` per seed) otherwise pushed the floor to 21
 * and dropped `BridgeInterceptor`'s file, which the agent had named — a class,
 * so it entered at the +10 tier rather than +50. The #1500 noise this change
 * targets scores 0.8–6, well under this ceiling.
 */
const SCORE_FLOOR_MAX = 10;
/**
 * The relative floor must never starve a question of candidates: if it would
 * leave fewer than this, backfill with the best-scoring ones it cut. The cost of
 * under-serving is the agent calling explore again — a whole round-trip. See the
 * backfill itself for the two strengths it runs at (thin vs. empty).
 */
const SCORE_FLOOR_KEEP_MIN = 3;

// ── Score-proportional byte allocation (CG-12 / #1500) ─────────────────────
//
// The score floor above decides WHICH files reach the response. This decides how
// the byte envelope is SPLIT among them — and until this existed, it wasn't
// really decided at all: every admitted file was capped at the same
// `maxCharsPerFile`, and the whole-file rule handed anything under
// `maxCharsPerFile * 3` its entire contents. So allocation followed FILE SIZE,
// not relevance. On this repo's own "how does explore allocate its output budget
// across files", `src/mcp/tools.ts` (score 41, 4x the graph mass, 3x the distinct
// term hits — it literally holds the allocator) was clipped at 3,800 while a
// score-18 file shipped whole at 5,672 and took 51% of the envelope, purely for
// being small. On the #1500 Go fixture, two generated CRUD files shipped whole at
// ~4.5K each and consumed the tier's 4 file slots, so `BuildPayslip` — the
// hand-written half of "create and calculate payslips" — never appeared at all.
//
// The replacement: reserve each file a share of the envelope proportional to what
// it is worth, up front, before anything renders. Three consequences:
//
//   1. A reservation is a GUARANTEE, not a race. The old loop spent the envelope
//      first-come-first-served in rank order, so the top two files could exhaust
//      it and every later file hit a `budget-90pct` skip regardless of merit.
//   2. A file below the cliff gets ZERO source — its path, symbols and line
//      numbers only. It costs ~100 chars instead of ~4,500, and (crucially) it
//      does not consume a `maxFiles` slot, so the slot goes to a file that earns
//      its bytes. This is the concentration lever.
//   3. The per-file cap stops being the primary guard. It survives only as
//      `ALLOC_MAX_SHARE`, a safety valve against a single god-file — which the
//      proportional split already bounds, since a file's share can't exceed its
//      weight share.
export const EXPLORE_ALLOCATION = {
  /**
   * A file whose weight is under this fraction of the top file's gets no source.
   *
   * Calibrated between the two shapes the fixtures pin: the #1500 generated CRUD
   * lands at 10–11% of the top weight (penalised twice — once into the score by
   * `rankPenalty`, once again here) and must cliff; a genuinely peripheral but
   * hand-written flow file — `payslip_builder.go`, the direct callee of the
   * workflow entry — lands at 25% and must NOT. Everything in between is a
   * judgement call the agent can undo for ~0 cost, because a cliffed file is
   * still NAMED in the response and one follow-up explore fetches it.
   */
  CLIFF_FRACTION: 0.15,
  /**
   * Ceiling on the cliff, in the same units as `SCORE_FLOOR_MAX` — and for the
   * same reason. A file whose weight clears a full-strength direct match is never
   * incidental, so no amount of concentration elsewhere may zero it: one
   * overwhelming top file (a 99-scoring god-file among score-10 peers) otherwise
   * puts the cliff at 14.9 and silences every peer the score floor had just
   * deliberately admitted. The cliff is a RELATIVE prune of weak evidence, not a
   * second admission gate — the score floor already owns admission.
   */
  CLIFF_MAX: SCORE_FLOOR_MAX,
  /**
   * Floor on a useful reservation — every admitted file gets this much before
   * the proportional split divides the rest. Under it a slice can't hold one
   * complete method, and a fragment is strictly worse than a pointer: it forces
   * the Read this tool exists to prevent.
   *
   * It is a FLOOR, not a second cliff. Cliffing the starved file instead
   * cascades: removing the smallest raises everyone else's share by so little
   * that the next-smallest starves too, and a query with two dominant files ate
   * six legitimately-ranked peers one at a time. Concentration is the relative
   * cliff's job; this only keeps a served file's slice usable.
   */
  MIN_CHARS: 700,
  /**
   * Safety valve, as a fraction of the envelope. Not the primary guard any more —
   * the proportional split is — so this only has to stop a pathological
   * single-file response.
   */
  MAX_SHARE: 0.7,
  /**
   * Markdown overhead charged per rendered file (header + fences + blank lines),
   * matching the render loop's own `+ 200` accounting. Held out of the pool
   * before the split so the reservations plus their overhead fit the envelope —
   * without this the last file's reservation is always the one that doesn't fit.
   */
  FILE_OVERHEAD: 200,
  /**
   * Flow-spine files are weighted up and are exempt from the cliff. Clipping the
   * spine causes the Read fallback (it IS the answer to a flow question);
   * clipping a peripheral file does not. This makes the existing advisory spine
   * handling — `hasSpine`, `SPINE_CEILING` — strict at the allocation layer.
   */
  SPINE_WEIGHT_BOOST: 2,
  /**
   * Slack allowed on the whole-file rule: a file a little over its reservation
   * still ships WHOLE rather than as clusters, because slicing off that last
   * sliver saves ~1% of the envelope and costs a Read — the trade the whole-file
   * rule exists to refuse. Proportional (with an absolute ceiling) because a
   * "sliver" is relative: a flat 800 is 15% of a 5K reservation but 31% of a 2.5K
   * one, and at the small end that overshoot is exactly what the file below then
   * loses.
   */
  WHOLE_FILE_GRACE_FRACTION: 0.15,
  WHOLE_FILE_GRACE_MAX: 800,
  /**
   * A reservation that already covers this fraction of a file BUYS THE WHOLE
   * FILE (CG-21), even though the file is bigger than the reservation.
   *
   * The grace above is calibrated as a *sliver* — it only rescues a file that
   * essentially fits. Below it there is a hole the render loop cannot fill:
   * express's `lib/utils.js` (5,293 B) was the TOP-ranked file, reserved 3,870,
   * declined the whole-file render at a 4,450 grace bound, and then spent 583 on
   * a three-symbol cluster render. The other 3,287 chars of its reservation were
   * neither redistributed nor delivered — the envelope shrank by a third against
   * an unchanged budget and the agent Read the file back four times.
   *
   * So the rule is not "does the file fit the reservation" but "has the
   * reservation already bought most of the file": at 0.6 the loop pays at most
   * two-thirds of a reservation extra to avoid losing the whole thing, and it
   * spends bytes it was going to spend anyway on a file that already earned
   * them. Below the fraction the shortfall is real — the file is several times
   * its reservation, clustering is the right answer, and the carry-forward
   * (`reservedSoFar`/`sourceSpent` in the render loop) hands whatever it cannot
   * spend to the next file down.
   */
  WHOLE_FILE_BUY_FRACTION: 0.6,
  /**
   * The buy rule's overshoot is funded from ONE pool for the whole response,
   * sized as this fraction of the envelope — deliberately the same 15% as
   * `WHOLE_FILE_GRACE_FRACTION`, one level up: the grace is a sliver of a
   * FILE's reservation, this is a sliver of the RESPONSE's envelope.
   *
   * Per-file funding is the version that fails, and it fails the same way the
   * bug being fixed does. The merit test is a RATIO, so wherever several files
   * sit near it they all qualify, and N independent overshoots inflate the
   * response until the render ceiling drops whatever is last. Measured on the
   * #1500 payroll fixture: three files bought whole and `payslip_builder.go` —
   * the file that computes the payslip the question asks about, rank #6 — was
   * dropped entirely so three higher-ranked files could each ship their final
   * sliver. A dropped section is strictly worse than a clustered one, so one
   * shared pool, spent in rank order, is the bound that matters.
   */
  WHOLE_FILE_BUY_OVERSHOOT_FRACTION: 0.15,
} as const;

/** One candidate file's allocation inputs, in final rank order. */
export interface ExploreAllocationCandidate {
  path: string;
  /** Post-`rankPenalty` relevance score from the ranking pass. */
  score: number;
  /**
   * How much this file's BYTES are worth, independent of how well it matched.
   * Ranking answers "is this file about the query"; allocation answers "will
   * these bytes teach the agent anything". Generated CRUD can legitimately rank
   * (it name-collides on every domain word) while its bytes stay mechanical
   * boilerplate the agent gains nothing from reading — so `rankPenalty` is
   * applied a SECOND time here. That is what finally sinks the #1500 generated
   * layer below the cliff: it survived CG-10's single penalty because the sort's
   * leading keys (entry-point, graph mass) are structural, and a big densely
   * self-referential generated file scores well on both.
   */
  worth: number;
  /** Carries a symbol on the rendered flow spine. */
  spine: boolean;
  /**
   * The query named this file by PATH (see query-paths.ts). Pinned files are
   * never cliffed or trimmed, and weigh at least as much as the strongest
   * candidate — the agent asked for the file itself, so starving it on text/
   * graph scores (which a pure-path query doesn't produce) defeats the ask.
   */
  pinned?: boolean;
}

export interface ExploreAllocation {
  /** path → chars of source it may render. Only holds admitted files. */
  allowances: Map<string, number>;
  /** Files the cliff zeroed, in rank order — pointers, not bytes. */
  cliffed: string[];
  /** The weight threshold the cliff fired at (0 when nothing was cliffed). */
  cliffAt: number;
  /** Chars actually split among the admitted files. */
  pool: number;
}

/**
 * Split `budget.maxOutputChars` across ranked candidates in proportion to
 * relevance, with a hard relative cliff.
 *
 * `candidates` must arrive in FINAL RANK ORDER — `maxFiles` is applied to the
 * survivors of the cliff, in that order, so cliffing genuinely hands a slot to
 * the next file down rather than leaving it unused.
 *
 * Tier invariant (`getExploreOutputBudget`): a larger tier must never allow less
 * per file than a smaller one. It holds here by construction — every bound is a
 * fraction of `maxOutputChars` or of `maxCharsPerFile`, both monotonic across
 * tiers — except `MIN_CHARS`, which is an absolute floor and so identical at
 * every tier.
 */
export function allocateExploreBudget(
  candidates: readonly ExploreAllocationCandidate[],
  budget: ExploreOutputBudget,
  maxFiles: number,
): ExploreAllocation {
  const A = EXPLORE_ALLOCATION;
  const empty: ExploreAllocation = { allowances: new Map(), cliffed: [], cliffAt: 0, pool: 0 };
  if (candidates.length === 0) return empty;

  // A non-finite weight is treated as no evidence rather than propagated: an
  // Infinity score would otherwise make every share `Infinity/Infinity` = NaN and
  // hand the render loop a NaN allowance. Scores are finite sums in the real
  // pipeline, so this only has to fail safe.
  const weightOf = (c: ExploreAllocationCandidate) => {
    const w = Math.max(0, c.score) * Math.max(0, Math.min(1, c.worth)) * (c.spine ? A.SPINE_WEIGHT_BOOST : 1);
    return Number.isFinite(w) ? w : 0;
  };

  // Pinned files weigh at least as much as the strongest raw candidate: their
  // score is whatever the stripped query happened to match (for a pure-path
  // query, nearly nothing), and a proportional split on that would fund the
  // named file worst of all. Floor of 1 covers the all-pinned/zero-score case.
  const rawWeights = new Map(candidates.map((c) => [c.path, weightOf(c)]));
  const topRaw = Math.max(...rawWeights.values());
  const weights = new Map(candidates.map((c) => [
    c.path,
    c.pinned ? Math.max(rawWeights.get(c.path) ?? 0, topRaw, 1) : (rawWeights.get(c.path) ?? 0),
  ]));
  const topWeight = Math.max(...weights.values());
  if (!(topWeight > 0)) return empty;

  // Cliff over the WHOLE candidate list, before `maxFiles` — otherwise the file
  // cap fills with cliff-bound files and the slot they free is never handed on.
  const cliffAt = Math.min(topWeight * A.CLIFF_FRACTION, A.CLIFF_MAX);
  const cliffed: string[] = [];
  let admitted: ExploreAllocationCandidate[] = [];
  for (const c of candidates) {
    if (!c.spine && !c.pinned && (weights.get(c.path) ?? 0) < cliffAt) cliffed.push(c.path);
    else admitted.push(c);
  }
  // Never cliff every candidate: an empty response costs a whole round-trip.
  if (admitted.length === 0) {
    admitted = [candidates[0]!];
    cliffed.splice(cliffed.indexOf(candidates[0]!.path), 1);
  }
  for (const c of admitted.slice(maxFiles)) cliffed.push(c.path);
  admitted = admitted.slice(0, maxFiles);

  // Serve fewer files well rather than many badly: the envelope has to afford
  // MIN_CHARS for everything admitted. When it can't, cliff the lowest-weight
  // files (never a spine file, never the last one) in one deterministic trim —
  // not one at a time, which is how the old starvation rule snowballed.
  const affordable = Math.max(1, Math.floor(budget.maxOutputChars / (A.MIN_CHARS + A.FILE_OVERHEAD)));
  if (admitted.length > affordable) {
    const byWeight = [...admitted].sort((a, b) => (weights.get(b.path) ?? 0) - (weights.get(a.path) ?? 0));
    const keep = new Set(byWeight.slice(0, affordable).map((c) => c.path));
    for (const c of admitted) if (c.spine || c.pinned) keep.add(c.path);
    for (const c of admitted) if (!keep.has(c.path)) cliffed.push(c.path);
    admitted = admitted.filter((c) => keep.has(c.path));
  }

  const allowances = new Map<string, number>();
  const pool = Math.max(0, budget.maxOutputChars - A.FILE_OVERHEAD * admitted.length);
  const total = admitted.reduce((s, c) => s + (weights.get(c.path) ?? 0), 0);
  if (total <= 0 || admitted.length === 0) return { allowances, cliffed, cliffAt, pool };
  // Everyone gets MIN_CHARS; the REMAINDER is what splits by weight. The floor
  // is what keeps a diffuse survey question returning a useful spread, and the
  // remainder is what concentrates a precise one — the top file's slice grows
  // with its weight share, uncapped by any flat per-file limit.
  const ceiling = Math.round(budget.maxOutputChars * A.MAX_SHARE);
  const floors = Math.min(pool, A.MIN_CHARS * admitted.length);
  const remainder = Math.max(0, pool - floors);
  // Both parts FLOOR: a sum of rounded shares can exceed the remainder that fed
  // it (by up to half a char per file), and the reservations must fit the pool
  // exactly — the render loop spends them, so an over-allocation is an over-long
  // response the hard ceiling then has to truncate. Flooring costs at most one
  // char per file.
  for (const c of admitted) {
    const share = Math.floor(floors / admitted.length)
      + Math.floor((remainder * (weights.get(c.path) ?? 0)) / total);
    allowances.set(c.path, Math.min(share, ceiling));
  }
  return { allowances, cliffed, cliffAt, pool };
}

/**
 * Whether `codegraph_explore` should prefix source lines with their line
 * numbers (cat -n style: `<num>\t<code>`).
 *
 * Line numbers let the agent cite `file:line` straight from the explore
 * payload instead of re-Reading the file just to find a line number — the
 * dominant residual cost on precise-tracing questions (#185 follow-up).
 *
 * Defaults ON. Set `CODEGRAPH_EXPLORE_LINENUMS=0` to disable (used by the
 * A/B harness to measure the payload-cost vs. read-savings tradeoff).
 */
function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== '0';
}

/**
 * Adaptive explore sizing (default ON). `codegraph_explore` skeletonizes OFF-SPINE
 * polymorphic-sibling files — a file whose class is one of ≥3 interchangeable
 * implementations of a shared interface (e.g. OkHttp's `: Interceptor` classes) —
 * to class + member signatures (bodies elided), keeping the on-spine exemplar full.
 * This sizes the response to the answer instead of the budget cap on sibling-heavy
 * flows (OkHttp interceptor-chain explore 28.5k→16.6k, ~28% cheaper than native
 * search, reads flat). It is PROVABLY INERT elsewhere: distinct pipeline steps (no
 * ≥3-implementer supertype, e.g. Excalidraw's `renderStaticScene`) and on-spine
 * files keep full source — output is byte-identical to shipped on excalidraw /
 * tokio / django / vscode / gin. Set `CODEGRAPH_ADAPTIVE_EXPLORE=0` to disable.
 */
function adaptiveExploreEnabled(): boolean {
  return process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== '0' && process.env.CODEGRAPH_ADAPTIVE_EXPLORE !== 'false';
}

/**
 * How long the FIRST tool call waits on the post-open catch-up reconcile before
 * giving up and serving anyway (issue #905). On a normal repo the reconcile
 * finishes in well under this, so the gate is fully honored and nothing changes.
 * On a very large repo (~100k files) the reconcile takes minutes — blocking the
 * first call on all of it presents as a multi-minute hang — so we wait briefly
 * for a clean answer, then serve and let the reconcile finish in the background
 * (it yields to the event loop, so a concurrent read still runs).
 *
 * `CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS` overrides the default; `0` restores the
 * old unbounded-wait behavior (always block until the reconcile completes).
 */
const DEFAULT_CATCHUP_GATE_TIMEOUT_MS = 3000;
function resolveCatchUpGateTimeoutMs(): number {
  const raw = process.env.CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS;
  if (raw === undefined || raw === '') return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CATCHUP_GATE_TIMEOUT_MS;
  return Math.floor(n);
}

/**
 * Prefix each line of a source slice with its 1-based line number, matching
 * the Read tool's `cat -n` convention (number + tab) so the agent treats it
 * the same way it treats Read output.
 *
 * @param slice  contiguous source text (already extracted from the file)
 * @param firstLineNumber  the 1-based line number of the slice's first line
 */
function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split('\n');
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join('\n');
}

/**
 * Unique line-prefix for a per-file source section in codegraph_explore output.
 * Issue #778: tool results dropped ATX headings (`####`, `##`, `###`) for bold
 * labels so Markdown-rendering MCP clients (e.g. the Claude Code VSCode
 * extension) stop blowing every header up to H1–H4. The path is bold + a code
 * span so it still reads as a header, and the leading ``**` `` stays a UNIQUE,
 * greppable marker — no other explore line begins with it — that the explore
 * truncation boundary (`handleExplore`) keys off to cut on whole file sections.
 */
const FILE_SECTION_PREFIX = '**`';
// Placeholder for codegraph_explore's "Found N symbols across M files." line.
// The honest N/M can only be known after the final truncation drops trailing
// sections (#1046), so the header is emitted as this sentinel and substituted
// at the very end. This bracketed token never occurs in rendered source or a
// file path, so the final string-replace can't collide.
const SUMMARY_SENTINEL = '[[codegraph-explore-summary]]';
function fileSectionHeader(filePath: string, suffix: string): string {
  return suffix
    ? `${FILE_SECTION_PREFIX}${filePath}\`** — ${suffix}`
    : `${FILE_SECTION_PREFIX}${filePath}\`**`;
}

/** Header of `codegraph_explore`'s trailing pointer list. */
const POINTER_HEADER = '**Not shown above — explore these names for their source**';
/** Most files the pointer list ever names one-per-line; the rest are a count. */
const POINTER_MAX_FILES = 10;
/**
 * One pointer line: the file plus enough symbol names to make it NAMEABLE in a
 * follow-up explore. Capped — an un-capped list ran to ~1.9K on the #1500
 * fixture (12 generated CRUD symbols on one line), meta-text bought at the
 * price of the source bytes this section exists to point away from.
 */
function pointerLineFor(filePath: string, nodes: readonly Node[]): string {
  const POINTER_SYMBOLS = 6;
  const named = nodes.filter((n) => n.kind !== 'import' && n.kind !== 'export');
  const pool = named.length > 0 ? named : nodes;
  const shown = pool.slice(0, POINTER_SYMBOLS);
  const more = pool.length - shown.length;
  const symbols = shown.map((n) => `${n.name}:${n.startLine}`).join(', ')
    + (more > 0 ? `, +${more} more` : '');
  return `- ${filePath}: ${symbols}`;
}
/**
 * Emitted when the response was too full to carry ANY of its pointer list. It
 * is the one line the epilogue floor is reserved for: the list itself can be
 * traded away, but the agent must still be told that an uncovered area exists
 * and that another explore — not a Read — is how to reach it.
 */
const EPILOGUE_LOST_NOTE = '> (Trailing pointer list omitted for size. The source above is complete and verbatim — treat it as already Read. For anything this call did not cover, run another codegraph_explore with the specific names rather than reading those files.)';

/**
 * Per-file staleness banner emitted at the top of a tool response when the
 * file watcher has pending events for files referenced by the response.
 * The agent uses this to fall back to Read for those specific files
 * without waiting for the debounced sync (issue #403).
 */
export function formatStaleBanner(stale: PendingFile[]): string {
  const now = Date.now();
  const lines = stale.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their codegraph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/**
 * Compact footer listing pending files that are NOT referenced in this
 * response. Gives the agent a complete project-wide freshness picture
 * without bloating the main banner.
 */
export function formatStaleFooter(stale: PendingFile[]): string {
  const MAX = 5;
  const now = Date.now();
  const shown = stale.slice(0, MAX);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = stale.length > MAX ? `\n  - …and ${stale.length - MAX} more` : '';
  return (
    `(Note: ${stale.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Whole-index degradation banner (issue #876). Emitted at the top of a read
 * tool response when live watching has permanently stopped — at which point
 * `getPendingFiles()` is empty, so the per-file banner above can't fire even
 * though the index is now FROZEN and silently drifting stale. Leads with the
 * agent-actionable instruction (Read directly) and carries the reason, which
 * already names the operator remedy (`codegraph sync` / git hooks).
 */
export function formatDegradedBanner(reason: string | null): string {
  return (
    '⚠️ CodeGraph auto-sync is DISABLED — live file watching stopped, so the index is ' +
    'frozen and any file edited since then is stale here. Read files directly to confirm ' +
    'current content before relying on it.' +
    (reason ? `\n  Reason: ${reason}` : '')
  );
}

/**
 * MCP Tool definition
 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, PropertySchema>;
    required?: string[];
  };
  /** Behavioral hints for clients (see {@link ToolAnnotations}). */
  annotations?: ToolAnnotations;
}

/**
 * MCP ToolAnnotations — behavioral hints a client MAY use to decide how, or
 * whether, to run a tool (introduced in the 2025-03-26 spec, carried in
 * 2025-06-18). They are advisory and never to be trusted for security, but
 * clients gate on them: Cursor's Ask mode, for one, refuses any MCP tool that
 * doesn't advertise `readOnlyHint: true` (issue #1018).
 *
 * The field is purely additive — a client that predates annotations ignores it
 * — so codegraph advertises these even though `initialize` still negotiates the
 * 2024-11-05 protocol version.
 *
 * https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations
 */
export interface ToolAnnotations {
  /** Human-readable title for the tool. */
  title?: string;
  /** If true, the tool does not modify its environment. Default (unset): false. */
  readOnlyHint?: boolean;
  /** Meaningful only when NOT read-only: may the tool perform destructive updates? */
  destructiveHint?: boolean;
  /** If true, repeat calls with the same arguments have no additional effect. */
  idempotentHint?: boolean;
  /** If true, the tool interacts with an open world of external entities. */
  openWorldHint?: boolean;
}

interface PropertySchema {
  type: string;
  description: string;
  enum?: string[];
  default?: unknown;
}

/**
 * Tool execution result
 */
export interface ToolResult {
  content: Array<{
    type: 'text';
    text: string;
  }>;
  isError?: boolean;
  /**
   * INTERNAL side-channel (CG-17): what a `codegraph_explore` call actually put
   * on the wire — files, line ranges, bytes. It rides the result because the
   * call may have run on a query-pool worker, while the session state it feeds
   * lives on the main thread. {@link ToolHandler.execute} records it and DELETES
   * it, so nothing here ever reaches the client. Keyed by
   * {@link EXPLORE_EMISSION_KEY}; the two must stay in sync.
   */
  _cgExploreEmission?: ExploreEmission;
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Absolute path to the project to query (or any directory inside it) — codegraph uses the nearest .codegraph/ index at or above that path. Omit to use this session\'s default project. Pass it to query a second codebase, or when the server root has no index of its own (e.g. a monorepo where only sub-projects are indexed, so there is no default project).',
};

/**
 * EVERY codegraph tool is query-only: it reads the pre-built index and never
 * mutates the workspace (indexing is the user's explicit CLI call, never the
 * agent's). Advertising this read-only contract lets clients that gate on it run
 * the tools where a possibly-mutating tool would be blocked — most concretely,
 * Cursor's Ask mode, which rejects any MCP tool lacking `readOnlyHint: true`
 * (issue #1018). `idempotentHint`: a repeated query has no additional effect.
 * `openWorldHint: false`: the domain is the closed local index, not an open
 * external world. Shared so the contract is declared once; a hypothetical
 * mutating tool would simply not reference it.
 */
const READ_ONLY_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_explore as the primary tool
 * (one call usually answers the whole question), and only use other tools for
 * targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use codegraph_explore instead to get the actual source / understand an area in one call.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol name or partial name (e.g., "auth", "signIn", "UserService")',
        },
        kind: {
          type: 'string',
          description: 'Filter by node kind',
          enum: ['function', 'method', 'class', 'interface', 'type', 'variable', 'route', 'component'],
        },
        limit: {
          type: 'number',
          description: 'Maximum results (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_callers',
    description: 'List functions that call <symbol>. For the full flow, use codegraph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist (e.g. one UserService per app in a monorepo)',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callers to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_callees',
    description: 'List functions that <symbol> calls. For the full flow, use codegraph_explore.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of callees to return (default: 20)',
          default: 20,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_impact',
    description: 'List symbols affected by changing <symbol>. Use before a refactor.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to analyze impact for',
        },
        file: {
          type: 'string',
          description: 'Narrow to the definition in this file (path or suffix) when several same-named symbols exist',
        },
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_node',
    description: 'Two modes. (1) READ A FILE — use INSTEAD of the Read tool: pass `file` (a path or basename) with no `symbol` and it returns that file\'s current on-disk source with line numbers, exactly the shape Read gives you (`<n>\\t<line>`, safe to Edit from), narrowable with `offset`/`limit` just like Read — PLUS a one-line note of which files depend on it. Same bytes as Read, faster (served from the index), with the blast radius attached. Use it whenever you would Read a source file. (2) ONE SYMBOL you can name — its location, signature, verbatim source (includeCode=true) and caller/callee trail in one call, so before changing it you see what calls it and what your edit would break. For an AMBIGUOUS name it returns EVERY matching definition\'s body in one call (so you never Read a file to find the right overload); pass `file`/`line` to pin one. Use codegraph_explore for several related symbols or the full flow.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to read (symbol mode). Omit it and pass `file` alone to read a whole file like Read.',
        },
        includeCode: {
          type: 'boolean',
          description: 'Symbol mode: include the symbol\'s full body (default: false). Ignored in file mode, which always returns source unless `symbolsOnly` is set.',
          default: false,
        },
        file: {
          type: 'string',
          description: 'A file path or basename (e.g. "harness.rs", "src/auth/session.ts"). Pass it ALONE (no symbol) to READ the file like the Read tool — its full source with line numbers + which files depend on it. Or pass it WITH a symbol to disambiguate an overloaded name to the definition in this file.',
        },
        offset: {
          type: 'number',
          description: 'File mode: 1-based line to start reading from, exactly like Read\'s offset. Defaults to the start of the file.',
        },
        limit: {
          type: 'number',
          description: 'File mode: maximum number of lines to return, exactly like Read\'s limit. Defaults to the whole file (capped at 2000 lines, like Read).',
        },
        symbolsOnly: {
          type: 'boolean',
          description: 'File mode: return just the file\'s symbol map + dependents (a cheap structural overview) instead of its source.',
          default: false,
        },
        line: {
          type: 'number',
          description: 'Symbol mode only: disambiguate to the definition at/around this line (use with the file:line a trail showed you).',
        },
        projectPath: projectPathProperty,
      },
      required: [],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_explore',
    description: 'PRIMARY TOOL — call FIRST for almost any question OR before an edit: how does X work, architecture, a bug, where/what is X, surveying an area, or the symbols you are about to change. Returns the verbatim source of the relevant symbols grouped by file in ONE capped call (Read-equivalent — treat the shown source as already Read; do NOT re-open those files), plus the call path among them. Query can be a natural-language question OR a bag of symbol/file names. Usually the ONLY call you need — more accurate context, in far fewer tokens and round-trips than a search/Read/Grep loop.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). For a flow question, name the symbols spanning the flow (e.g. "mutateElement renderScene"). A natural-language question works too — no prior codegraph_search needed.',
        },
        maxFiles: {
          type: 'number',
          description: 'Maximum number of files to include source code from (default: 12)',
          default: 12,
        },
        projectPath: projectPathProperty,
      },
      required: ['query'],
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_status',
    description: 'Index health check (files / nodes / edges). Skip unless debugging.',
    inputSchema: {
      type: 'object',
      properties: {
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_files',
    description: 'Indexed file tree with language + symbol counts. Faster than Glob for project layout.',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Filter to files under this directory path (e.g., "src/components"). Returns all files if not specified.',
        },
        pattern: {
          type: 'string',
          description: 'Filter files matching this glob pattern (e.g., "*.tsx", "**/*.test.ts")',
        },
        format: {
          type: 'string',
          description: 'Output format: "tree" (hierarchical, default), "flat" (simple list), "grouped" (by language)',
          enum: ['tree', 'flat', 'grouped'],
          default: 'tree',
        },
        includeMetadata: {
          type: 'boolean',
          description: 'Include file metadata like language and symbol count (default: true)',
          default: true,
        },
        maxDepth: {
          type: 'number',
          description: 'Maximum directory depth to show (default: unlimited)',
        },
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_export',
    description: 'Export code knowledge graph or symbol call graph to Mermaid, DOT, or JSON format for visualization.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Optional symbol name to export its call/impact graph. If omitted, exports top project structure.',
        },
        format: {
          type: 'string',
          description: 'Export format: "mermaid" (default), "dot", "json"',
          enum: ['mermaid', 'dot', 'json'],
          default: 'mermaid',
        },
        direction: {
          type: 'string',
          description: 'Mermaid/DOT layout direction: "TD" (default) or "LR"',
          enum: ['TD', 'LR'],
          default: 'TD',
        },
        depth: {
          type: 'number',
          description: 'Traversal depth for symbol mode (default: 2)',
          default: 2,
        },
        mode: {
          type: 'string',
          description: 'Symbol export mode: "callgraph" (default) or "impact"',
          enum: ['callgraph', 'impact'],
          default: 'callgraph',
        },
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  {
    name: 'codegraph_metrics',
    description: 'Get architectural metrics (Afferent/Efferent coupling, Instability index, and top structural hotspots).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Number of hotspots to return (default: 10)',
          default: 10,
        },
        projectPath: projectPathProperty,
      },
    },
    annotations: READ_ONLY_ANNOTATIONS,
  },
];


/**
 * Return `defs` with `projectPath` marked `required` in each tool's inputSchema.
 *
 * Used for the NO-DEFAULT-PROJECT tool surface (issue #993): when the MCP server
 * has no default project to fall back to — a gateway server started outside any
 * repo, or a monorepo root whose `.codegraph/` indexes live only in sub-projects
 * — every call MUST carry an explicit `projectPath`, so the schema should say so.
 * A `required` field is a HIGH-salience channel (MCP clients surface and often
 * validate it), unlike the instructions text the reporter found too weak to stop
 * the agent omitting the param. When a default project IS open, callers leave
 * projectPath optional and never call this.
 *
 * Pure: clones each tool's schema rather than mutating the shared module-level
 * `tools` array (reused by every session and the static surface). A tool that
 * doesn't expose projectPath, or already requires it, is returned untouched;
 * explore's `['query']` becomes `['query', 'projectPath']`, and a tool with no
 * `required` list (status/files) gains `['projectPath']`.
 */
function withRequiredProjectPath(defs: ToolDefinition[]): ToolDefinition[] {
  return defs.map((tool) => {
    if (!tool.inputSchema.properties.projectPath) return tool;
    const required = tool.inputSchema.required ?? [];
    if (required.includes('projectPath')) return tool;
    return {
      ...tool,
      inputSchema: { ...tool.inputSchema, required: [...required, 'projectPath'] },
    };
  });
}

/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-CodeGraph case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.CODEGRAPH_MCP_TOOLS;
  if (!raw || !raw.trim()) {
    return tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^codegraph_/, '')));
  }
  const allow = new Set(raw.split(',').map(s => s.trim().replace(/^codegraph_/, '')).filter(Boolean));
  return allow.size ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, ''))) : tools;
}

/**
 * The MCP tools served by DEFAULT (short names). Pared to ONLY `codegraph_explore`
 * — the single tool that reliably earns its place: one capped call returns the
 * verbatim source of the relevant symbols grouped by file. Every other tool is a
 * narrower slice of what explore already does, and presence itself steers
 * mis-picks, so they are no longer LISTED to agents.
 *
 * The other defined tools (`node`, `search`, `callers`, plus callees/impact/files/
 * status) remain fully functional — handlers stay, the library API and CLI are
 * untouched, and `CODEGRAPH_MCP_TOOLS=explore,node,...` re-enables any of them.
 */
const DEFAULT_MCP_TOOLS = new Set(['explore']);

/**
 * Tool handler that executes tools against a CodeGraph instance
 *
 * Supports cross-project queries via the projectPath parameter.
 * Other projects are opened on-demand and cached for performance.
 */
export class ToolHandler {
  // Cache of opened CodeGraph instances for cross-project queries
  private projectCache: Map<string, CodeGraph> = new Map();
  // The directory the server last searched for a default project. Surfaced in
  // the "not initialized" error so users can see why detection missed.
  private defaultProjectHint: string | null = null;
  // Indexed sub-projects the engine's bounded down-scan saw below the search
  // base when no default project resolved (#1607). Listed in the "not
  // initialized" error so the fact is reachable through the protocol, not just
  // the host's stderr capture. Engine-maintained (initial resolve + throttled
  // retry) — tool calls themselves never scan.
  private knownSubprojects: string[] = [];
  private knownSubprojectsBase: string | null = null;
  // Per-start-path cache of the git worktree/index mismatch (issue #155). The
  // mismatch is a fixed property of (where the request came from → which
  // .codegraph/ it resolves to), so the up-to-two `git rev-parse` spawns run
  // once and every later tool call reuses the result — never shelling out to
  // git on the hot path. `undefined` = not computed yet; `null` = no mismatch.
  private worktreeMismatchCache: Map<string, WorktreeIndexMismatch | null> = new Map();
  // Gate that the MCP engine pokes after `cg.open()` so the first tool call
  // blocks on the post-open filesystem reconcile (catch-up sync). Without
  // this, a tool call that races past `catchUpSync()` serves rows for files
  // that were deleted (or edited) while no MCP server was running — and the
  // per-file staleness banner can't help, because `getPendingFiles()` is
  // populated by the watcher, not by catch-up. The wait is time-boxed
  // (see {@link resolveCatchUpGateTimeoutMs}) so a minutes-long reconcile on a
  // huge repo can't hang the first call (#905); cleared on first await so
  // subsequent calls don't pay any cost.
  private catchUpGate: Promise<void> | null = null;
  // Optional worker-thread pool for off-loop read-tool dispatch (daemon mode).
  // When set + healthy, the heavy read tools run on a worker so the daemon's
  // main loop stays free for the MCP transport under concurrent load. Null in
  // direct/in-process mode (one client, no concurrency to parallelize).
  private queryPool: QueryPool | null = null;

  constructor(private cg: CodeGraph | null) {}

  /**
   * Engine-only: attach (or detach with null) the worker-thread query pool. The
   * shared daemon sets this once its default project is open; the workers each
   * hold their own WAL read connection and run {@link executeReadTool}. A
   * worker's own ToolHandler never has a pool, so there is no nested off-loading.
   */
  setQueryPool(pool: QueryPool | null): void {
    this.queryPool = pool;
  }

  /**
   * Update the default CodeGraph instance (e.g. after lazy initialization)
   */
  setDefaultCodeGraph(cg: CodeGraph): void {
    this.cg = cg;
  }

  /**
   * Engine-only: register the catch-up sync promise so the next `execute()`
   * call awaits it before serving. The handler swallows rejections (the
   * engine logs them) so a sync failure never propagates as a tool error;
   * we still want to serve a best-effort result over the same potentially-
   * stale data, which is what would have happened without the gate.
   */
  setCatchUpGate(p: Promise<void> | null): void {
    this.catchUpGate = p;
  }

  /**
   * Await the catch-up gate, but no longer than the configured timeout (#905).
   * If the reconcile settles first, we got the fully-reconciled answer. If the
   * timeout wins, we serve the call now and let the reconcile finish in the
   * background — it yields to the event loop (see SYNC_RECONCILE_YIELD_INTERVAL),
   * so a concurrent read still runs against the same connection. Never throws:
   * a failed reconcile is logged by the engine, and we serve best-effort over
   * the same potentially-stale data the un-gated path would have.
   */
  private async awaitCatchUpGate(gate: Promise<void>): Promise<void> {
    const timeoutMs = resolveCatchUpGateTimeoutMs();
    if (timeoutMs <= 0) {
      // 0 = opt back into the original unbounded wait.
      try { await gate; } catch { /* engine already logged */ }
      return;
    }
    let timer: NodeJS.Timeout | undefined;
    const timedOut = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
      timer.unref?.();
    });
    try {
      const outcome = await Promise.race([
        gate.then(() => 'done' as const, () => 'done' as const),
        timedOut,
      ]);
      if (outcome === 'timeout') {
        process.stderr.write(
          `[CodeGraph MCP] Catch-up reconcile still running after ${timeoutMs}ms; serving this tool call now and finishing the reconcile in the background (#905). ` +
          `Set CODEGRAPH_CATCHUP_GATE_TIMEOUT_MS=0 to always wait for it.\n`
        );
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
  }

  /**
   * Engine-only: record the indexed sub-projects the workspace down-scan saw
   * when it could not adopt a default project (#1606/#1607). An empty list
   * clears any previous note.
   */
  setKnownSubprojects(roots: string[], base: string): void {
    this.knownSubprojects = roots;
    this.knownSubprojectsBase = base;
  }

  /** One message line naming the indexed sub-projects, or '' when none known. */
  private formatKnownSubprojects(): string {
    if (this.knownSubprojects.length === 0) return '';
    const base = this.knownSubprojectsBase;
    const rels = this.knownSubprojects.map((r) => (base ? relativePath(base, r) || '.' : r));
    return (
      `Indexed sub-projects were found below it: ${rels.join(', ')} — ` +
      'pass one of them (absolute, or resolved against that directory) as projectPath.\n'
    );
  }

  /**
   * Whether a default CodeGraph instance is available
   */
  hasDefaultCodeGraph(): boolean {
    return this.cg !== null;
  }

  /**
   * Optional allowlist of exposed tools, parsed from the CODEGRAPH_MCP_TOOLS
   * env var (comma-separated short names, e.g. "trace,search,node,context").
   * Unset/empty → every tool is exposed. Lets an operator (or an A/B harness)
   * trim the tool surface without rebuilding the client config; the ablated
   * tool is then truly absent from ListTools rather than merely denied on call.
   * Matching is on the short form, so "node" and "codegraph_node" both work.
   */
  private toolAllowlist(): Set<string> | null {
    const raw = process.env.CODEGRAPH_MCP_TOOLS;
    if (!raw || !raw.trim()) return null;
    const short = (s: string) => s.trim().replace(/^codegraph_/, '');
    const set = new Set(raw.split(',').map(short).filter(Boolean));
    return set.size ? set : null;
  }

  /** Whether a tool name passes the CODEGRAPH_MCP_TOOLS allowlist (if any). */
  private isToolAllowed(name: string): boolean {
    const allow = this.toolAllowlist();
    return !allow || allow.has(name.replace(/^codegraph_/, ''));
  }

  /**
   * Get tool definitions with dynamic descriptions based on project size.
   * The codegraph_explore tool description includes a budget recommendation
   * scaled to the number of indexed files. Honors the CODEGRAPH_MCP_TOOLS
   * allowlist so a trimmed surface is reflected in ListTools.
   */
  getTools(): ToolDefinition[] {
    const allow = this.toolAllowlist();
    // No explicit allowlist → the default 4-tool surface (see
    // DEFAULT_MCP_TOOLS for the evidence). An allowlist replaces the
    // default entirely, so any defined tool can be re-enabled.
    let visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, '')))
      : tools.filter(t => DEFAULT_MCP_TOOLS.has(t.name.replace(/^codegraph_/, '')));
    // No default project loaded → no-root-index case (#993): a gateway server
    // started outside any repo, or a monorepo root whose indexes live in
    // sub-projects. With nothing to fall back to, EVERY call needs an explicit
    // projectPath, so mark it required in the schema — a high-salience nudge the
    // agent acts on, where SERVER_INSTRUCTIONS_NO_ROOT_INDEX's prose alone
    // wasn't enough (the reporter had to add an AGENTS.md note). `this.cg` is
    // settled by `retryInitIfNeeded()` before `handleToolsList` calls us, so a
    // null here means "genuinely no default", not a startup race. When a default
    // IS open we leave projectPath optional (below): a bare call falls back to
    // it, exactly as in the common single-project launch.
    if (!this.cg) return withRequiredProjectPath(visible);

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      // Tiny-repo tool gating: on projects under TINY_REPO_FILE_THRESHOLD
      // files, only expose the core trio (search, node, explore) — one
      // below even the 4-tool default: at this scale callers, too, reduces
      // to one grep. (Historical note: the audit below ran when context and
      // trace still existed; its "5 core tools" are today's trio.)
      //
      // n=2 audits ruled out cutting below 5 tools:
      // - 3-tool gate (search + context + trace): cost regressed on
      //   cobra/ky/sinatra. The agent fell back to raw Reads to cover
      //   what codegraph_node + codegraph_explore would have answered.
      // - 1-tool gate (search only): catastrophic regression — express
      //   went from -43% WIN to +107% LOSS. With only search, the agent
      //   can't navigate the call graph structurally and reads everything.
      //
      // 5 is the empirical lower bound. Tools beyond search/context/
      // node/explore/trace pay overhead that the agent doesn't recoup
      // on tiny-repo flow questions.
      // ITER4: raise threshold 150 → 500 so single-file frameworks
      // (sinatra at 159, slim_framework around 200) also get the
      // 5-tool surface. The empirical 5-tool floor was set on <150
      // probes; iter3 measurement showed sinatra is structurally the
      // SAME problem as cobra (single-file WITHOUT-arm Read wins),
      // so it deserves the same gating.
      const TINY_REPO_FILE_THRESHOLD = 500;
      const TINY_REPO_CORE_TOOLS = new Set([
        'codegraph_explore',
        'codegraph_search',
        'codegraph_node',
      ]);
      if (stats.fileCount < TINY_REPO_FILE_THRESHOLD) {
        visible = visible.filter(t => TINY_REPO_CORE_TOOLS.has(t.name));
      }

      return visible.map(tool => {
        if (tool.name === 'codegraph_explore') {
          return {
            ...tool,
            description: `${tool.description} Budget: make at most ${budget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).`,
          };
        }
        return tool;
      });
    } catch {
      return visible;
    }
  }

  /**
   * Get CodeGraph instance for a project
   *
   * If projectPath is provided, opens that project's CodeGraph (cached).
   * Otherwise returns the default CodeGraph instance.
   *
   * Walks up parent directories to find the nearest .codegraph/ folder,
   * similar to how git finds .git/ directories.
   */
  private getCodeGraph(projectPath?: string): CodeGraph {
    if (!projectPath) {
      if (!this.cg) {
        const searched = this.defaultProjectHint ?? process.cwd();
        throw new NotIndexedError(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          this.formatKnownSubprojects() +
          'Either the server root has no index of its own (e.g. a monorepo where only ' +
          "sub-projects are indexed), or the MCP client launched the server outside your " +
          'project without reporting the workspace root. Either way, target the project ' +
          'explicitly:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project" ' +
          '(any project that has a .codegraph/ — including a sub-project of a monorepo)\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]\n' +
          'If a project simply has no index, use your built-in tools (Read/Grep/Glob) for THAT ' +
          "project (the user can run 'codegraph init' there to enable it) — you can still query " +
          'other indexed projects by projectPath in the same session.'
        );
      }
      return this.freshen(this.cg);
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new PathRefusalError(pathError);
      }
    }

    // Always RE-RESOLVE the nearest .codegraph/ from the input path. The walk
    // is cheap (a few existsSync up the tree) and is the only thing that
    // notices a path whose index root CHANGED since it was first seen — most
    // importantly a git worktree that gained its own .codegraph/ after the
    // (long-lived) server first resolved it up to the parent checkout. We used
    // to short-circuit on a `projectCache[projectPath]` entry before resolving,
    // which pinned that first resolution for the server's whole lifetime, so a
    // worktree kept being served the parent checkout's index until restart
    // (#926). The DB connection itself is still cached (by resolved root,
    // below), so re-resolving costs only the stat walk, never a reopen.
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new NotIndexedError(
        `The project at ${projectPath} isn't indexed with codegraph (no .codegraph/ directory found ` +
        'walking up from it), so codegraph cannot query it. Use your built-in tools (Read/Grep/Glob) ' +
        "for that codebase instead, and don't call codegraph for it again this session. " +
        "Indexing is the user's decision — they can run 'codegraph init' in that project to enable it."
      );
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; when WAL isn't in effect (e.g. a filesystem without shared-memory
    // support) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. The
    // default instance is owned/closed by the server, so it's never cached.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.freshen(this.cg);
    }

    // Cache the open DB connection by RESOLVED ROOT only — never by the input
    // path. One key per instance means closeAll() closes each exactly once, and
    // a changed resolution maps to a different entry instead of a stale hit.
    const cached = this.projectCache.get(resolvedRoot);
    if (cached) return this.freshen(cached);

    const cg = loadCodeGraph().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    return cg;
  }

  /**
   * Heal a long-lived connection whose `.codegraph/` was removed and recreated
   * at the same path (a worktree recreated, or `rm -rf .codegraph` + re-init)
   * before handing it to a tool. Otherwise the daemon keeps serving the
   * pre-removal snapshot from its now-unlinked file handle until restart — and
   * because the daemon registry is keyed by path, a same-path recreate routes
   * new clients straight back to this same stale daemon (#925). The check is one
   * stat() and a no-op unless the inode actually changed; it never throws into a
   * tool call.
   */
  private freshen(cg: CodeGraph): CodeGraph {
    try {
      if (cg.reopenIfReplaced()) {
        process.stderr.write(
          '[CodeGraph MCP] The index was replaced on disk (e.g. a git worktree ' +
          'recreated at the same path); reopened the live database in place.\n'
        );
      }
    } catch {
      // Best-effort self-heal — a failed reopen must never break the tool call;
      // the (still stale) handle keeps serving and the next call retries.
    }
    return cg;
  }

  /**
   * Close all cached project connections
   */
  closeAll(): void {
    for (const cg of this.projectCache.values()) {
      cg.close();
    }
    this.projectCache.clear();
    this.worktreeMismatchCache.clear();
  }

  /**
   * Validate that a value is a non-empty string within length bounds.
   *
   * The `maxLength` cap protects against MCP clients that ship huge
   * payloads (10MB+ query strings either by accident or maliciously).
   * Without this, a single oversized input can pin the FTS5 index or
   * exhaust memory before any real work runs.
   */
  private validateString(
    value: unknown,
    name: string,
    maxLength: number = MAX_INPUT_LENGTH
  ): string | ToolResult {
    if (typeof value !== 'string' || value.length === 0) {
      return this.errorResult(`${name} must be a non-empty string`);
    }
    if (value.length > maxLength) {
      return this.errorResult(
        `${name} exceeds maximum length of ${maxLength} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Validate an optional path-like string input. Returns the value if
   * valid (or undefined), or a ToolResult with the error.
   */
  private validateOptionalPath(
    value: unknown,
    name: string
  ): string | undefined | ToolResult {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'string') {
      return this.errorResult(`${name} must be a string`);
    }
    if (value.length > MAX_PATH_LENGTH) {
      return this.errorResult(
        `${name} exceeds maximum length of ${MAX_PATH_LENGTH} characters (got ${value.length})`
      );
    }
    return value;
  }

  /**
   * Cached git worktree/index mismatch for a tool call's effective project.
   *
   * The "effective project" is what the request targets: an explicit
   * `projectPath` arg, else the directory the server resolved its default
   * project from (`defaultProjectHint`), else cwd. Memoized per start path —
   * see `worktreeMismatchCache`. Best-effort: if the project can't be resolved
   * (e.g. nothing initialized yet), it reports "no mismatch" so a tool is never
   * broken by this check.
   */
  private worktreeMismatchFor(projectPath?: string): WorktreeIndexMismatch | null {
    const startPath = projectPath ?? this.defaultProjectHint ?? process.cwd();

    // The verdict depends on BOTH the start path AND the index root it resolves
    // to, so the cache must be keyed on the pair. Resolve the index root first
    // (cheap — getCodeGraph re-walks to the nearest .codegraph/, no git), then
    // key on `(startPath, indexRoot)`. The moment that root changes — most
    // importantly when a git worktree gains its own index and the walk-up stops
    // there instead of at the parent checkout — the key changes and the verdict
    // is recomputed, instead of serving the stale "borrowed the parent's index"
    // warning for the server's whole lifetime. Keying on startPath alone pinned
    // that first verdict until restart (#926).
    let indexRoot: string;
    try {
      indexRoot = this.getCodeGraph(projectPath).getProjectRoot();
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      return null;
    }

    const cacheKey = `${startPath}\u0000${indexRoot}`;
    const cached = this.worktreeMismatchCache.get(cacheKey);
    if (cached !== undefined) return cached;

    const mismatch = detectWorktreeIndexMismatch(startPath, indexRoot);
    this.worktreeMismatchCache.set(cacheKey, mismatch);
    return mismatch;
  }

  /**
   * Prefix a successful read-tool result with a compact worktree-mismatch
   * notice when the resolved index belongs to a different git working tree than
   * the caller's (issue #155). Without this, an agent in a nested worktree
   * silently trusts main-branch results. No-op on error results and when there
   * is no mismatch. `codegraph_status` is excluded — it embeds its own verbose
   * warning — so it stays out of this path.
   */
  private withWorktreeNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;
    const mismatch = this.worktreeMismatchFor(projectPath);
    if (!mismatch) return result;

    const notice = worktreeMismatchNotice(mismatch);
    const [first, ...rest] = result.content;
    if (first && first.type === 'text') {
      return { ...result, content: [{ type: 'text', text: `${notice}\n\n${first.text}` }, ...rest] };
    }
    return result;
  }

  /**
   * Annotate a successful read-tool result with per-file staleness — the
   * non-blocking answer to issue #403. The file watcher tracks every event
   * it sees per path; here we intersect "files referenced in this response"
   * against that pending set and prepend a compact banner so the agent can
   * fall back to Read for those *specific* files without waiting for the
   * debounced sync to fire. Other pending files in the project (not
   * referenced by this response) get a small footer so the agent has a
   * complete picture without bloating the banner.
   *
   * Cost when nothing is pending — the common case — is one boolean check.
   * No I/O, no parsing of markdown beyond a per-pending-file substring scan.
   */
  private driftCache = new Map<string, { at: number; stale: boolean }>();
  private static readonly DRIFT_TTL_MS = 2000;

  /**
   * On-disk drift check for a single indexed file (issue #1474). The code
   * renderers slice CURRENT bytes at INDEXED line ranges; when the file
   * changed after its last index sync those ranges can point at a DIFFERENT
   * symbol's code — served under the requested name with `isError: false`.
   * The watcher-based pending/degraded banners can't cover this for a
   * project reached via `projectPath` (cross-project instances have no
   * watcher, by construction), so freshness is verified here, at the point
   * of emission, from data the index already stores.
   *
   * Cheap and precise: one stat() per file (size + mtime, the same
   * comparison the sync fast path uses); only on a stat mismatch is the
   * content hashed (sha256, matching extraction's `hashContent`) so a
   * touch/checkout that rewrote identical bytes never false-positives.
   * Results are memoized briefly so one response rendering the same file in
   * several sections pays for the check once.
   *
   * Returns true when the on-disk file differs from what was indexed —
   * i.e. indexed line ranges for it are NOT trustworthy. Any failure
   * (missing files-table row, stat/read error) reports false: those cases
   * are handled by the existing not-found paths, and a wrong "stale" flag
   * would needlessly push the agent back to Read.
   */
  private isFileStaleOnDisk(cg: CodeGraph, relPath: string, content?: string): boolean {
    let root: string;
    try {
      root = cg.getProjectRoot();
    } catch {
      return false;
    }
    const key = `${root}\0${relPath}`;
    const now = Date.now();
    const hit = this.driftCache.get(key);
    if (hit && now - hit.at < ToolHandler.DRIFT_TTL_MS) return hit.stale;
    let stale = false;
    try {
      const rec = cg.getFile(relPath);
      const absPath = rec ? validatePathWithinRoot(root, relPath) : null;
      if (rec && absPath && existsSync(absPath)) {
        const st = statSync(absPath);
        // Same freshness test as the sync fast path (extraction/index.ts):
        // equal size + equal floored mtime ⇒ unchanged, no read needed.
        if (st.size !== rec.size || Math.floor(st.mtimeMs) !== Math.floor(rec.modifiedAt)) {
          const data = content ?? readFileSync(absPath, 'utf-8');
          // Must stay byte-identical to extraction's `hashContent` (sha256 over
          // the utf-8 string) — the identical-rewrite test in
          // mcp-stale-slice.test.ts pins the parity. Inlined (not imported)
          // to keep the extraction module off the MCP startup path.
          stale = createHash('sha256').update(data).digest('hex') !== rec.contentHash;
        }
      }
    } catch {
      stale = false;
    }
    this.driftCache.set(key, { at: now, stale });
    return stale;
  }

  private withStalenessNotice(result: ToolResult, projectPath?: string): ToolResult {
    if (result.isError) return result;

    let cg: CodeGraph;
    try {
      cg = this.getCodeGraph(projectPath);
    } catch {
      return result; // no default project — leave as is
    }

    // Cross-project `projectPath` calls open a cached CodeGraph WITHOUT a
    // watcher (watchers are only attached to the default session project).
    // When the cross-project path happens to be the same project as the
    // default cg, the cached instance is the wrong one — its pendingFiles is
    // permanently empty. Detect the equal-path case and prefer the default
    // cg so the staleness signal still fires when an agent passes the
    // explicit projectPath form of its own project.
    if (this.cg && cg !== this.cg) {
      try {
        const sameProject =
          resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot());
        if (sameProject) cg = this.cg;
      } catch {
        /* getProjectRoot may throw on a closed instance — leave cg as is */
      }
    }

    // Whole-index degradation (#876): once live watching has permanently
    // stopped, getPendingFiles() is empty so the per-file banner below can't
    // fire — but the index is now FROZEN and silently drifting stale. Surface
    // one global notice instead, so the agent Reads for current content rather
    // than trusting a response off a no-longer-updating index. (Cross-project
    // calls open a watcher-less CodeGraph, so this is false there — correct: we
    // only know degraded state for the default session project.)
    let degraded = false;
    try {
      degraded = cg.isWatcherDegraded?.() ?? false;
    } catch {
      degraded = false;
    }
    if (degraded) {
      const [head, ...tail] = result.content;
      if (!head || head.type !== 'text') return result;
      let reason: string | null = null;
      try {
        reason = cg.getWatcherDegradedReason?.() ?? null;
      } catch {
        reason = null;
      }
      const composed = `${formatDegradedBanner(reason)}\n\n${head.text}`;
      return { ...result, content: [{ type: 'text', text: composed }, ...tail] };
    }

    // Defensive: some test fakes inject a partial CodeGraph stub without the
    // newer pending-files API. Treat missing/throwing as "no pending files."
    let pending: PendingFile[] = [];
    try {
      pending = cg.getPendingFiles?.() ?? [];
    } catch {
      return result;
    }
    if (pending.length === 0) return result;

    const [first, ...rest] = result.content;
    if (!first || first.type !== 'text') return result;

    const text = first.text;
    const inResponse: PendingFile[] = [];
    const elsewhere: PendingFile[] = [];
    for (const p of pending) {
      // Substring match against the project-relative POSIX path — that's
      // exactly the format both the watcher and every codegraph response
      // emit, so a plain includes() is sufficient and avoids regex pitfalls.
      if (text.includes(p.path)) inResponse.push(p);
      else elsewhere.push(p);
    }

    let banner = '';
    if (inResponse.length > 0) {
      banner = formatStaleBanner(inResponse);
    }
    let footer = '';
    if (elsewhere.length > 0) {
      footer = formatStaleFooter(elsewhere);
    }
    if (!banner && !footer) return result;

    const composed = [banner, text, footer].filter(Boolean).join('\n\n');
    return { ...result, content: [{ type: 'text', text: composed }, ...rest] };
  }

  /**
   * Execute a tool by name.
   *
   * `sessionState` is the CALLER's per-session explore history (CG-17). The
   * daemon shares one ToolHandler across every connected session, so this state
   * cannot live on the handler — each session owns one and hands it in, which is
   * what keeps two sessions on one daemon from ever seeing each other's calls.
   * Omit it (the CLI does) and explore behaves exactly as before, untracked.
   */
  async execute(
    toolName: string,
    args: Record<string, unknown>,
    sessionState?: ExploreSessionState,
  ): Promise<ToolResult> {
    try {
      // Block the first tool call on the engine's post-open reconcile so we
      // never serve rows for files deleted/edited while no MCP server was
      // running. The wait is time-boxed (#905): a huge-repo reconcile takes
      // minutes, and blocking the first call on all of it reads as a hang, so
      // we wait briefly then serve and let it finish in the background. The
      // gate is cleared after first await — subsequent calls pay nothing.
      // Catch-up failures are logged by the engine; we proceed regardless so a
      // transient sync error never breaks tools.
      if (this.catchUpGate) {
        const gate = this.catchUpGate;
        this.catchUpGate = null;
        await this.awaitCatchUpGate(gate);
      }
      // Honor the optional tool allowlist (CODEGRAPH_MCP_TOOLS): a trimmed
      // surface rejects ablated tools defensively even if a client cached them.
      if (!this.isToolAllowed(toolName)) {
        return this.errorResult(`Tool ${toolName} is disabled via CODEGRAPH_MCP_TOOLS`);
      }
      // Cross-cutting input validation. All tools accept an optional
      // `projectPath` and most accept either `query`, `task`, or
      // `symbol` — bound their lengths centrally so individual handlers
      // can stay focused on tool-specific logic.
      const pathCheck = this.validateOptionalPath(args.projectPath, 'projectPath');
      if (typeof pathCheck === 'object' && pathCheck !== undefined) {
        return pathCheck;
      }
      // The `path` and `pattern` properties used by codegraph_files are
      // also path-shaped — apply the same cap.
      if (args.path !== undefined) {
        const check = this.validateOptionalPath(args.path, 'path');
        if (typeof check === 'object' && check !== undefined) return check;
      }
      if (args.pattern !== undefined) {
        const check = this.validateOptionalPath(args.pattern, 'pattern');
        if (typeof check === 'object' && check !== undefined) return check;
      }

      // codegraph_status reports watcher state (pending files, degraded mode,
      // worktree warning) and embeds its own sections — it must run on the MAIN
      // thread against the watched default instance, so it is NEVER off-loaded to
      // a worker (whose read connection has no watcher). It also skips the
      // auto-banner wrapper to avoid duplicating its own pending-files section.
      if (toolName === 'codegraph_status') {
        return await this.handleStatus(args);
      }

      // Read tools: off-load the CPU-heavy dispatch to the worker pool when one
      // is attached, healthy, AND has finished its first cold start (daemon
      // mode), so the daemon's single event loop stays free for the MCP
      // transport under concurrent load — otherwise N concurrent explores
      // serialize AND starve the transport until the whole batch drains
      // (clients then time out). Before the first worker is warm, calls run
      // in-process: a call queued behind a cold start sat invisible until the
      // 45s busy backstop — the daemon's first tool call stalling for however
      // long a worker spawn takes on a loaded machine (the #662 flake). With
      // no pool (direct mode) or a degraded one, dispatch runs in-process
      // exactly as before. Either way the result flows through the
      // cross-cutting notices — worktree-index mismatch (#155) and per-file
      // staleness (#403) — which need the watched MAIN instance and so are
      // always applied here, never in the worker.
      //
      // Explore also carries the session's own call history down (CG-17) and its
      // emission record back up. Both travel as plain properties — on the args
      // object down, on the ToolResult up — because either leg may cross a
      // structured-clone boundary into a worker, where a closure or a handler
      // field could not follow.
      const dispatchArgs = this.withSessionView(toolName, args, sessionState);
      const raw = (this.queryPool && this.queryPool.healthy && this.queryPool.ready)
        ? await this.queryPool.run(toolName, dispatchArgs)
        : await this.executeReadTool(toolName, dispatchArgs);
      // Record + STRIP before anything else touches the result: the emission is
      // internal bookkeeping and must never reach the client, whether or not a
      // caller passed session state.
      const result = this.takeExploreEmission(raw, sessionState);
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      return this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    } catch (err) {
      // Expected condition, not a malfunction: answer as a SUCCESS so the
      // agent keeps trusting the toolset for projects that ARE indexed.
      // (An isError here teaches session-long abandonment — see NotIndexedError.)
      if (err instanceof NotIndexedError) {
        return this.textResult(err.message);
      }
      // Security refusal: a clean error, no retry encouragement.
      if (err instanceof PathRefusalError) {
        return this.errorResult(err.message);
      }
      return this.errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'This is an internal codegraph error — retry the call once; if it persists, ' +
        'continue without codegraph for this task.'
      );
    }
  }

  /**
   * Attach the caller's session view to an explore call's args (CG-17), on a
   * COPY so the caller's object is never mutated. Nothing else sees it: a
   * non-explore tool, or a caller with no session state, gets the args
   * unchanged and pays nothing.
   *
   * A client that spells the internal key itself is stripped rather than
   * trusted — the view decides what source a later call may withhold, so it has
   * to come from the server's own record, never from the wire.
   */
  private withSessionView(
    toolName: string,
    args: Record<string, unknown>,
    sessionState: ExploreSessionState | undefined,
  ): Record<string, unknown> {
    if (!(EXPLORE_SESSION_VIEW_ARG in args) && (!sessionState || toolName !== 'codegraph_explore')) {
      return args;
    }
    const copy = { ...args };
    delete copy[EXPLORE_SESSION_VIEW_ARG];
    if (sessionState && toolName === 'codegraph_explore') {
      copy[EXPLORE_SESSION_VIEW_ARG] = sessionState.view();
    }
    return copy;
  }

  /**
   * Record an explore call's emission into the caller's session state and strip
   * it from the result (CG-17).
   *
   * Unconditional strip: the property is internal, so it comes off even when
   * there is no session state to record it into (the CLI path) — that is what
   * keeps the agent-facing response byte-identical. Recording is wrapped
   * because a bookkeeping bug must never fail a tool call that already
   * succeeded.
   */
  private takeExploreEmission(
    result: ToolResult,
    sessionState: ExploreSessionState | undefined,
  ): ToolResult {
    const emission = result?.[EXPLORE_EMISSION_KEY];
    if (emission === undefined) return result;
    delete result[EXPLORE_EMISSION_KEY];
    if (sessionState) {
      try {
        sessionState.record(emission);
      } catch { /* bookkeeping only — never fail a served call */ }
    }
    return result;
  }

  /**
   * Run a single read tool to completion and return its raw {@link ToolResult},
   * classifying expected failures the same way {@link execute}'s catch does so
   * the SHAPE is identical whether dispatch runs in-process or on a worker:
   * NotIndexed → success-shaped guidance, PathRefusal → clean error, anything
   * else → internal-error-with-retry. Never throws.
   *
   * This is the worker thread's entry point (see {@link ./query-worker}) and the
   * in-process fallback for {@link execute}. It deliberately does NOT run the
   * catch-up gate or the staleness/worktree notices — those need the daemon's
   * watched main instance and stay on the main thread. Cross-cutting allowlist +
   * path validation already ran in {@link execute} before routing here.
   */
  async executeReadTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      return await this.dispatchTool(toolName, args);
    } catch (err) {
      if (err instanceof NotIndexedError) {
        return this.textResult(err.message);
      }
      if (err instanceof PathRefusalError) {
        return this.errorResult(err.message);
      }
      return this.errorResult(
        `Tool execution failed: ${err instanceof Error ? err.message : String(err)}. ` +
        'This is an internal codegraph error — retry the call once; if it persists, ' +
        'continue without codegraph for this task.'
      );
    }
  }

  /**
   * Pure dispatch over the read tools — the switch, with no gate, no notices, no
   * allowlist/validation (the caller owns those). `codegraph_status` is handled
   * on the main thread in {@link execute} and never reaches here. May throw
   * NotIndexed/PathRefusal, which {@link executeReadTool} classifies.
   */
  private async dispatchTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    switch (toolName) {
      case 'codegraph_search': return await this.handleSearch(args);
      case 'codegraph_callers': return await this.handleCallers(args);
      case 'codegraph_callees': return await this.handleCallees(args);
      case 'codegraph_impact': return await this.handleImpact(args);
      case 'codegraph_explore': return await this.handleExplore(args);
      case 'codegraph_node': return await this.handleNode(args);
      case 'codegraph_files': return await this.handleFiles(args);
      case 'codegraph_export': return await this.handleExport(args);
      case 'codegraph_metrics': return await this.handleMetrics(args);
      default: return this.errorResult(`Unknown tool: ${toolName}`);
    }

  }

  /**
   * Handle codegraph_export
   */
  private async handleExport(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const symbol = typeof args.symbol === 'string' && args.symbol.trim() ? args.symbol.trim() : undefined;
    const format = (args.format as 'mermaid' | 'dot' | 'json') || 'mermaid';
    const direction = (args.direction as 'TD' | 'LR') || 'TD';
    const depth = clamp(Number(args.depth) || 2, 1, 10);
    const mode = (args.mode as 'callgraph' | 'impact') || 'callgraph';

    try {
      let output: string;
      if (symbol) {
        output = cg.exportSymbolGraph(symbol, { format, direction, depth, mode });
      } else {
        const files = cg.getFiles();
        const fullSubgraph = {
          nodes: new Map(),
          edges: [] as any[],
          roots: [] as string[],
        };
        for (const f of files) {
          const fnodes = cg.getNodesInFile(f.path);
          for (const fn of fnodes) {
            fullSubgraph.nodes.set(fn.id, fn);
            for (const oe of cg.getOutgoingEdges(fn.id)) {
              fullSubgraph.edges.push(oe);
            }
          }
        }
        output = cg.exportGraph(fullSubgraph, { format, direction, title: 'Project Structure' });
      }
      return this.textResult(this.truncateOutput(output));
    } catch (err) {
      return this.textResult(`Export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_metrics
   */
  private async handleMetrics(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp(Number(args.limit) || 10, 1, 50);
    const metrics = cg.getMetrics(limit);

    const lines: string[] = [
      `### Project Architecture Metrics`,
      `- **Total Files:** ${metrics.summary.totalFiles}`,
      `- **Total Symbols:** ${metrics.summary.totalSymbols}`,
      `- **Total Edges:** ${metrics.summary.totalEdges}`,
      `- **Avg Afferent Coupling (Ca):** ${metrics.summary.avgAfferentCoupling} (incoming dependencies)`,
      `- **Avg Efferent Coupling (Ce):** ${metrics.summary.avgEfferentCoupling} (outgoing dependencies)`,
      `- **Avg Instability Index (I):** ${metrics.summary.avgInstability} (0.0=stable, 1.0=volatile)`,
    ];

    if (metrics.topHotspots.length > 0) {
      lines.push('', '### Top Structural Hotspots (High Fan-in / Blast Radius):');
      for (const h of metrics.topHotspots) {
        const loc = h.startLine ? `:${h.startLine}` : '';
        lines.push(`- **${h.name}** (${h.kind}) — \`${h.filePath}${loc}\` | Fan-in: ${h.fanIn}, Fan-out: ${h.fanOut}, Blast Radius: ${h.blastRadius}`);
      }
    }

    return this.textResult(this.truncateOutput(lines.join('\n')));
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {

    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const rawKind = args.kind as string | undefined;
    // The schema enum says 'type' (what agents naturally reach for); the
    // NodeKind is 'type_alias'. Without the mapping, kind: "type" silently
    // matched nothing — a filter value we advertise must work.
    const kind = rawKind === 'type' ? 'type_alias' : rawKind;
    const rawLimit = Number(args.limit) || 10;
    const limit = clamp(rawLimit, 1, 100);

    const results = cg.searchNodes(query, {
      limit,
      kinds: kind ? [kind as NodeKind] : undefined,
    });

    if (results.length === 0) {
      return this.textResult(`No results found for "${query}"`);
    }

    // Down-rank generated files within the FTS-returned set so a search
    // for "Send" surfaces the hand-written keeper before .pb.go stubs
    // that share the name. Stable: only reorders generated vs. not.
    const isGen = cg.generatedFilePredicate(results.map((r) => r.node.filePath));
    const ranked = [...results].sort((a, b) => {
      const aGen = isGen(a.node.filePath) ? 1 : 0;
      const bGen = isGen(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const formatted = this.formatSearchResults(ranked);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Group symbol matches into DISTINCT DEFINITIONS — one group per
   * (filePath, qualifiedName), so same-file overloads stay together while
   * unrelated same-named classes across a monorepo's apps (#764: one
   * `UserService` per NestJS app) are kept apart. Optionally narrowed by a
   * `file` path/suffix first.
   */
  private groupDefinitions(
    nodes: Node[],
    fileFilter: string | undefined
  ): { groups: Node[][]; filteredOut: boolean } {
    let pool = nodes;
    let filteredOut = false;
    if (fileFilter) {
      const wanted = fileFilter.replace(/^\.\//, '');
      const narrowed = pool.filter(
        (n) => n.filePath === wanted || n.filePath.endsWith(wanted) || n.filePath.endsWith(`/${wanted}`)
      );
      if (narrowed.length > 0) {
        pool = narrowed;
      } else {
        filteredOut = true;
      }
    }
    const byDef = new Map<string, Node[]>();
    for (const n of pool) {
      const key = `${n.filePath}|${n.qualifiedName}`;
      const group = byDef.get(key);
      if (group) group.push(n);
      else byDef.set(key, [n]);
    }
    return { groups: [...byDef.values()], filteredOut };
  }

  /** Section heading for one distinct definition in grouped output. */
  private definitionHeading(group: Node[]): string {
    const head = group[0]!;
    const line = head.startLine ? `:${head.startLine}` : '';
    return `**${head.qualifiedName}** (${head.kind}) — ${head.filePath}${line}`;
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callers: Node[] = [];
      const labels = new Map<string, string>();
      for (const node of defNodes) {
        for (const c of cg.getCallers(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callers.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
        }
      }
      return { callers, labels };
    };

    // Single definition (or same-file overloads): the familiar flat list.
    if (groups.length === 1) {
      const { callers, labels } = collect(groups[0]!);
      if (callers.length === 0) {
        return this.textResult(`No callers found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // A successful `file` narrowing makes the multi-symbol aggregation note
      // stale — suppress it.
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const formatted = this.formatNodeList(callers.slice(0, limit), `Callers of ${symbol}`, labels) + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): one section per definition so an
    // agent never mistakes one app's callers for another's. Narrow with
    // `file` to focus a single definition.
    const lines: string[] = [
      `**Callers of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const { callers, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callers.length === 0) {
        lines.push('- (no callers)');
        continue;
      }
      for (const node of callers.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const collect = (defNodes: Node[]) => {
      const seen = new Set<string>();
      const callees: Node[] = [];
      const labels = new Map<string, string>();
      for (const node of defNodes) {
        for (const c of cg.getCallees(node.id)) {
          if (!seen.has(c.node.id)) {
            seen.add(c.node.id);
            callees.push(c.node);
            const label = this.edgeLabel(c.edge);
            if (label) labels.set(c.node.id, label);
          }
        }
      }
      return { callees, labels };
    };

    if (groups.length === 1) {
      const { callees, labels } = collect(groups[0]!);
      if (callees.length === 0) {
        return this.textResult(`No callees found for "${symbol}"${allMatches.note}${filterNote}`);
      }
      // A successful `file` narrowing makes the multi-symbol aggregation note
      // stale — suppress it.
      const note = fileFilter && !filteredOut ? '' : allMatches.note;
      const formatted = this.formatNodeList(callees.slice(0, limit), `Callees of ${symbol}`, labels) + note + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): per-definition sections.
    const lines: string[] = [
      `**Callees of ${symbol} — ${groups.length} distinct definitions (narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const { callees, labels } = collect(group);
      lines.push('', this.definitionHeading(group));
      if (callees.length === 0) {
        lines.push('- (no callees)');
        continue;
      }
      for (const node of callees.slice(0, limit)) {
        const location = node.startLine ? `:${node.startLine}` : '';
        const label = labels.get(node.id);
        lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`);
      }
    }
    return this.textResult(this.truncateOutput(lines.join('\n') + filterNote));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);
    const fileFilter = typeof args.file === 'string' ? args.file : undefined;

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    const { groups, filteredOut } = this.groupDefinitions(allMatches.nodes, fileFilter);
    const filterNote = filteredOut
      ? `\n\n> **Note:** no definition of "${symbol}" matches file "${fileFilter}" — showing all definitions instead.`
      : '';

    const impactOf = (defNodes: Node[]) => {
      const mergedNodes = new Map<string, Node>();
      const mergedEdges: Edge[] = [];
      const seenEdges = new Set<string>();
      for (const node of defNodes) {
        const impact = cg.getImpactRadius(node.id, depth);
        for (const [id, n] of impact.nodes) {
          mergedNodes.set(id, n);
        }
        for (const e of impact.edges) {
          const key = `${e.source}->${e.target}:${e.kind}`;
          if (!seenEdges.has(key)) {
            seenEdges.add(key);
            mergedEdges.push(e);
          }
        }
      }
      return { nodes: mergedNodes, edges: mergedEdges, roots: defNodes.map((n) => n.id) };
    };

    // Single definition (or same-file overloads): the familiar merged report.
    if (groups.length === 1) {
      const formatted = this.formatImpact(symbol, impactOf(groups[0]!)) + (fileFilter && !filteredOut ? "" : allMatches.note) + filterNote;
      return this.textResult(this.truncateOutput(formatted));
    }

    // Multiple DISTINCT definitions (#764): a blast radius PER definition —
    // merging unrelated same-named classes (one UserService per monorepo app)
    // overstated impact and confused agents. Narrow with `file`.
    const sections: string[] = [
      `**Impact of ${symbol} — ${groups.length} distinct definitions (each with its own blast radius; narrow with \`file\`)**`,
    ];
    for (const group of groups) {
      const head = group[0]!;
      const line = head.startLine ? `:${head.startLine}` : '';
      sections.push(
        '',
        this.formatImpact(`${head.qualifiedName} (${head.filePath}${line})`, impactOf(group))
      );
    }
    return this.textResult(this.truncateOutput(sections.join('\n') + filterNote));
  }

  /**
   * Describe a synthesized (dynamic-dispatch) edge for human output: how the
   * callback was wired up — the bridge static parsing can't see. Returns null
   * for ordinary static edges. Used by trace + the node trail so a synthesized
   * hop reads as "registered via onUpdate at App.tsx:3148", not a bare arrow.
   */
  private synthEdgeNote(edge: Edge | null): { label: string; compact: string; registeredAt?: string } | null {
    if (!edge || edge.provenance !== 'heuristic') return null;
    const m = edge.metadata as Record<string, unknown> | undefined;
    const registeredAt = typeof m?.registeredAt === 'string' ? m.registeredAt : undefined;
    const at = registeredAt ? ` @${registeredAt}` : '';
    if (m?.synthesizedBy === 'callback') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a registrar';
      const field = m.field ? ` on .${String(m.field)}` : '';
      return {
        label: `callback — registered via ${via}${field} (dynamic dispatch)`,
        compact: `dynamic: callback via ${via}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'event-emitter') {
      const ev = m.event ? `\`${String(m.event)}\`` : 'an event';
      return {
        label: `event ${ev} — emit → handler (dynamic dispatch)`,
        compact: `dynamic: event ${ev}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'react-render') {
      return {
        label: `React re-render — \`setState\` re-runs render() (dynamic dispatch)`,
        compact: `dynamic: React re-render via setState${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'jsx-render') {
      const child = m.via ? `<${String(m.via)}>` : 'a child component';
      return {
        label: `renders ${child} (JSX child — dynamic dispatch)`,
        compact: `dynamic: renders ${child}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'vue-handler') {
      const ev = m.event ? `@${String(m.event)}` : 'a template event';
      return {
        label: `Vue template handler — bound to ${ev} (dynamic dispatch)`,
        compact: `dynamic: Vue ${ev} handler`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'interface-impl') {
      return {
        label: `interface/abstract dispatch — runs the implementation override (dynamic dispatch)`,
        compact: `dynamic: interface → impl${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'closure-collection') {
      const field = m.field ? `\`${String(m.field)}\`` : 'a collection';
      return {
        label: `closure collection — runs handlers appended to ${field} (dynamic dispatch)`,
        compact: `dynamic: runs ${field} handlers${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'fn-pointer-dispatch') {
      const via = m.via ? `\`${String(m.via)}\`` : 'a function pointer';
      return {
        label: `function-pointer dispatch via ${via} (dynamic dispatch)`,
        compact: `dynamic: fn-pointer ${m.via ? String(m.via) : ''}${at}`,
        registeredAt,
      };
    }
    if (m?.synthesizedBy === 'goframe-route') {
      const route = m.route ? `\`${String(m.route)}\`` : 'a route';
      return {
        label: `GoFrame route ${route} — reflective Bind → controller method (dynamic dispatch)`,
        compact: `dynamic: GoFrame route ${m.route ? String(m.route) : ''}${at}`,
        registeredAt,
      };
    }
    // Generic fallback for any other synthesizer (redux-thunk, gin-middleware-chain,
    // flutter-build, …): a synthesized hop must never read as a bare static `calls`.
    // It's a dynamic-dispatch bridge — label it as one and keep its wiring site.
    if (typeof m?.synthesizedBy === 'string') {
      const kind = m.synthesizedBy.replace(/-/g, ' ');
      return { label: `${kind} (dynamic dispatch)`, compact: `dynamic: ${kind}${at}`, registeredAt };
    }
    return null;
  }

  /**
   * Flow-from-named-symbols: an agent's codegraph_explore query is a bag of
   * symbol names that usually spans the flow it's investigating (e.g.
   * "PmsProductController getList PmsProductService list PmsProductServiceImpl").
   * Surface the longest call chain AMONG those named symbols — scoped to what the
   * agent explicitly named, so (unlike a fuzzy relevance set) there's no
   * wrong-feature wandering. Rides synthesized edges, so controller→service-
   * interface→impl shows up. Returns '' if no chain of >=3 nodes exists.
   *
   * Ambiguous tokens (Java `list` → dozens of nodes) are disambiguated by
   * CO-NAMING: the agent names the class too, so we keep only `list` candidates
   * whose qualifiedName contains another named token (`PmsProductServiceImpl::list`),
   * dropping unrelated `OmsOrderService::list`.
   */
  private buildFlowFromNamedSymbols(cg: CodeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string>; spineCallSites: Map<string, number> } {
    // spineCallSites: for each spine node, the line where it CALLS the next hop —
    // lets the source assembler window an oversize spine method (e.g. n8n's 962-line
    // processRunExecutionData) to the call site instead of dumping the whole body.
    const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>(), spineCallSites: new Map<string, number>() };
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      if (tokens.length < 2) return EMPTY;
      // Pool of name SEGMENTS (Class + method from every token) used to
      // disambiguate an ambiguous SIMPLE name: keep a candidate only if its
      // CONTAINER class is itself named in the query.
      const segPool = new Set<string>();
      for (const t of tokens) for (const s of t.toLowerCase().split(/::|\./)) if (s) segPool.add(s);
      const named = new Map<string, Node>();
      // Nodes whose token is SPECIFIC — a (near-)unique callable name (<=3 defs in
      // the whole graph). These are safe to SPARE a file on: the agent named THIS
      // method (`getResponseWithInterceptorChain`, 1 def). A hyper-polymorphic name
      // (`as_sql`, 110 defs across every Expression/Compiler subclass) is NOT here,
      // so naming it doesn't keep every backend variant full and flood the budget.
      const uniqueNamedNodeIds = new Set<string>();
      // token → resolved node ids: drives the token-coverage check that gates
      // the dynamic-boundary scan (a token is covered when ANY of its nodes
      // lands on the main chain — overloads off the chain don't count against).
      const tokenNodes = new Map<string, string[]>();
      // token → its full same-name callable family (before the container filter).
      // A LARGE family that fails to connect on the chain is a polymorphic
      // interface/registry dispatch — surfaced by buildPolymorphicBoundaries below.
      const tokenFamily = new Map<string, Node[]>();
      // Non-callable endpoints (CONSTANT/VARIABLE/FIELD) connected by a SYNTHESIZED
      // edge. RTK thunks are `const X = createAsyncThunk(...)`, so a thunk→thunk hop
      // is constant→constant — the CALLABLE-only `named` set can't hold it, and
      // without this the hop is invisible to the Flow path at every tier (the
      // Relationships section catches it only on repos ≥500 files). Kept SEPARATE
      // from `named` (which drives the call-chain + source sizing, callable-only);
      // fed only to the dynamic-dispatch-links scan below.
      const dynNamed = new Map<string, Node>();
      const DYN_KINDS = new Set(['constant', 'variable', 'field', 'property']);
      // Nodes resolved from a SHAPE-PRECISE token (camelCase / PascalCase /
      // snake_case / qualified) — the same test the gather path uses. It is the
      // difference between "the agent named this symbol" and "an ordinary English
      // word in a prose question collided with a callable", and it is what makes
      // the narrative-less return below safe (see `identityOnly`).
      const isPreciseToken = (x: string) =>
        /[._$]|::|\//.test(x) || /[a-z][A-Z]/.test(x) || /^[A-Z]/.test(x);
      const preciseNamedIds = new Set<string>();
      const hasHeuristicEdge = (id: string): boolean =>
        [...cg.getCallers(id), ...cg.getCallees(id)].some(({ edge }) => edge.provenance === 'heuristic');
      for (const t of tokens) {
        const hits = this.findAllSymbols(cg, t).nodes;
        const cands = hits.filter((n) => CALLABLE.has(n.kind));
        tokenFamily.set(t, cands);
        // A qualified or otherwise-specific name (<=3 hits) keeps all; an
        // ambiguous simple name keeps only candidates whose container is named.
        const specific = cands.length <= 3;
        const pick = specific
          ? cands
          : cands.filter((n) => {
              const segs = (n.qualifiedName || '').toLowerCase().split(/::|\./).filter(Boolean);
              const container = segs.length >= 2 ? segs[segs.length - 2] : '';
              return !!container && segPool.has(container);
            });
        const kept = pick.slice(0, 6);
        tokenNodes.set(t, kept.map((n) => n.id));
        const precise = isPreciseToken(t);
        for (const n of kept) {
          named.set(n.id, n);
          if (specific) uniqueNamedNodeIds.add(n.id);
          if (precise) preciseNamedIds.add(n.id);
        }
        // Same token, non-callable synth endpoints (capped, precision-gated on an
        // actual heuristic edge so plain config constants never qualify).
        // Per-token sub-cap so one token's many endpoints (10 nix option writes
        // of `programs.git.enable` across test configs) can't fill the pool
        // before later tokens (`home.file`) get a slot.
        if (dynNamed.size < 12) {
          let tokenDyn = 0;
          for (const n of hits) {
            if (CALLABLE.has(n.kind) || !DYN_KINDS.has(n.kind) || dynNamed.has(n.id)) continue;
            if (hasHeuristicEdge(n.id)) {
              dynNamed.set(n.id, n);
              if (precise) preciseNamedIds.add(n.id);
              tokenDyn++;
            }
            if (dynNamed.size >= 12 || tokenDyn >= 4) break;
          }
        }
        if (named.size > 40) break;
      }
      // Surface synthesized (heuristic) edges incident to a named symbol — INCLUDING
      // the non-callable CONSTANT endpoints in `dynNamed`. `skipInChain` drops a hop
      // already shown in the rendered main chain (a 2-node chain renders nothing, so a
      // direct named→named synth hop still surfaces — #687).
      const collectSynthLinks = (skipInChain: ((e: Edge) => boolean) | null): string[] => {
        const synthLines: string[] = [];
        const synthSeen = new Set<string>();
        for (const n of [...named.values(), ...dynNamed.values()]) {
          if (synthLines.length >= 6) break;
          for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
            if (synthLines.length >= 6) break;
            if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
            if (skipInChain && skipInChain(edge)) continue;
            const src = edge.source === n.id ? n : other;
            const tgt = edge.source === n.id ? other : n;
            const key = `${src.name}>${tgt.name}`;
            if (synthSeen.has(key)) continue;
            synthSeen.add(key);
            const note = this.synthEdgeNote(edge);
            synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
          }
        }
        return synthLines;
      };
      /**
       * No narrative to print — but the agent still NAMED symbols, and their
       * identity is a separate output from the prose (CG-38).
       *
       * `namedNodeIds` is not decoration: downstream it injects the named def into
       * the file's cluster ranges and ranks it importance 9, which is the whole
       * mechanism behind "a symbol the agent named renders" (the assembler's
       * named-def injection). Returning EMPTY here threw that away whenever the
       * named symbols happened not to form a call chain — two sibling closures in
       * one factory (`queueMessage` / `flushQueuedMessages`, neither calling the
       * other) produce no chain, no synth hop and no dispatch boundary, so BOTH
       * defs lost importance 9 and the file rendered from its head instead: the
       * agent got the `QueuedMessage` interface at L70 and had to Read the file
       * for the functions at L1087/L1102 it had asked for by name.
       *
       * Restricted to SHAPE-PRECISE tokens. With a narrative present the prose is
       * itself corroboration that the resolution was right, so that path keeps
       * every named id as before; with nothing corroborating it, only an
       * unambiguous symbol reference may promote — an English word in a prose
       * question that happens to exact-match a callable must not earn importance 9.
       * Same distinction, same test, as the gather path's `isPreciseToken`.
       */
      const identityOnly = () => (preciseNamedIds.size === 0 ? EMPTY : {
        text: '',
        pathNodeIds: new Set<string>(),
        namedNodeIds: new Set<string>(preciseNamedIds),
        uniqueNamedNodeIds: new Set<string>([...uniqueNamedNodeIds].filter((id) => preciseNamedIds.has(id))),
        spineCallSites: new Map<string, number>(),
      });
      if (named.size < 2) {
        // <2 CALLABLES resolved. Two recoveries before giving up: (1) synthesized
        // edges among named CONSTANT/VARIABLE endpoints — RTK thunk→thunk is
        // constant→constant, so `named` can be empty while `dynNamed` holds the
        // whole chain; (2) the one resolved callable's body may hold the
        // dynamic-dispatch site that EXPLAINS a half-connected flow.
        const synthLines = collectSynthLinks(null);
        const boundaries = named.size === 0 ? '' : (this.buildDynamicBoundaries(cg, [...named.values()], named) || '');
        if (synthLines.length === 0 && !boundaries) return identityOnly();
        const out: string[] = [];
        if (synthLines.length) out.push(
          '**Dynamic-dispatch links among your symbols**',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '', ...synthLines, '');
        if (boundaries) out.push(boundaries);
        out.push('> Full source for these symbols is below.\n');
        return { text: out.join('\n'), pathNodeIds: new Set(), namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites: new Map<string, number>() };
      }
      const MAX_HOPS = 7;
      let best: Array<{ node: Node; edge: Edge | null }> | null = null;
      // BFS the full call graph (incl. synth edges) from each named seed, but
      // only ACCEPT a sink that is also named — both ends anchored to symbols the
      // agent named, so the chain stays on-topic while bridging intermediates
      // (e.g. the exact interface overload) that the token resolution missed.
      for (const seed of [...named.values()].slice(0, 8)) {
        const parent = new Map<string, { prev: string | null; edge: Edge | null; node: Node }>();
        parent.set(seed.id, { prev: null, edge: null, node: seed });
        const q: Array<{ id: string; depth: number; streak: number }> = [{ id: seed.id, depth: 0, streak: 0 }];
        let deep: string | null = null, deepDepth = 0;
        const MAX_BRIDGE = 1; // ≤1 consecutive UNNAMED hop: bridge one missing intermediate, never wander a god-function's fan-out
        for (let h = 0; h < q.length && parent.size < 1500; h++) {
          const { id, depth, streak } = q[h]!;
          if (id !== seed.id && named.has(id) && depth > deepDepth) { deep = id; deepDepth = depth; }
          if (depth >= MAX_HOPS - 1) continue;
          for (const c of cg.getCallees(id)) {
            if (c.edge.kind !== 'calls' || parent.has(c.node.id)) continue;
            const newStreak = named.has(c.node.id) ? 0 : streak + 1;
            if (newStreak > MAX_BRIDGE) continue;
            parent.set(c.node.id, { prev: id, edge: c.edge, node: c.node });
            q.push({ id: c.node.id, depth: depth + 1, streak: newStreak });
          }
        }
        if (!deep) continue;
        const chain: Array<{ node: Node; edge: Edge | null }> = [];
        let cur: string | null = deep;
        while (cur) { const p = parent.get(cur); if (!p) break; chain.push({ node: p.node, edge: p.edge }); cur = p.prev; }
        chain.reverse();
        if (!best || chain.length > best.length) best = chain;
      }
      const hasMain = !!best && best.length >= 3;
      const pathIds = new Set((best ?? []).map((s) => s.node.id));
      // Where each spine node calls the NEXT hop (best[i+1].edge is the edge from
      // best[i] → best[i+1]; its line is the call site inside best[i]'s body). Lets
      // the assembler window an oversize spine method to the call instead of dumping it.
      const spineCallSites = new Map<string, number>();
      if (best) for (let i = 0; i < best.length - 1; i++) {
        const ln = best[i + 1]?.edge?.line;
        if (ln && ln > 0 && !spineCallSites.has(best[i]!.node.id)) spineCallSites.set(best[i]!.node.id, ln);
      }

      // Dynamic-boundary scan (#687) — fires ONLY when the flow the agent
      // asked about did not fully connect: some token resolved to nodes but
      // none of them sit on the main chain (or there is no chain at all). A
      // healthy flow skips this entirely. Scan order: the chain's dead end
      // first (where the partial flow stops), then the disconnected symbols,
      // agent-specific (unique-named) ones first.
      let boundaryText = '';
      {
        const uncovered: Node[] = [];
        if (!hasMain) {
          // No rendered chain — but a 2-node chain still CONNECTS its two
          // endpoints (e.g. via one synthesized hop, surfaced below as a
          // dynamic-dispatch link). Only nodes off that short chain are
          // unexplained breaks worth scanning.
          for (const n of named.values()) if (!pathIds.has(n.id)) uncovered.push(n);
        } else {
          for (const ids of tokenNodes.values()) {
            if (ids.length === 0 || ids.some((id) => pathIds.has(id))) continue;
            for (const id of ids) { const n = named.get(id); if (n) uncovered.push(n); }
          }
        }
        if (uncovered.length > 0) {
          const scanList: Node[] = [];
          if (hasMain) scanList.push(best![best!.length - 1]!.node);
          scanList.push(...uncovered.sort((a, b) =>
            (uniqueNamedNodeIds.has(b.id) ? 1 : 0) - (uniqueNamedNodeIds.has(a.id) ? 1 : 0)));
          boundaryText = this.buildDynamicBoundaries(cg, scanList, named);
        }
      }

      // Interface/registry-dispatch announcement (extends #687 to GRAPH-visible
      // polymorphism). A method the agent NAMED that resolves to a large same-name
      // family AND did not land on the main chain is almost always a runtime
      // dispatch (plugin/strategy/handler interface): the concrete target is chosen
      // at runtime from N implementations, so no single static edge is the answer.
      // The body-scan above can't see this — `nodeType.execute()` is textually an
      // ordinary call; the polymorphism lives in the graph (implements edges), so
      // detect it there. Fires ONLY for an uncovered named token; a connected flow
      // stays silent.
      let polyText = '';
      {
        const POLY_MIN_FAMILY = 8; // smaller families are overload sets, not dispatch
        const polyCands: Array<{ token: string; family: Node[] }> = [];
        for (const [t, fam] of tokenFamily) {
          if (fam.length < POLY_MIN_FAMILY) continue;
          const ids = tokenNodes.get(t) || [];
          if (ids.some((id) => pathIds.has(id))) continue; // covered by the flow — silent
          polyCands.push({ token: t, family: fam });
        }
        if (polyCands.length) polyText = this.buildPolymorphicBoundaries(cg, polyCands, named);
      }

      // Supplementary: dynamic-dispatch (synthesized) edges incident to a named
      // symbol (incl. the non-callable CONSTANT endpoints in `dynNamed`) — the
      // indirect hops an agent would otherwise grep/Read to reconstruct ("where do
      // the appended `validators` actually run?"). Surfaced even when the OTHER end
      // wasn't named. The skip drops a hop already in the rendered main chain; a
      // 2-node chain renders nothing (hasMain false) so a direct named→named synth
      // hop still surfaces — too short for Flow, but #687-visible here.
      const synthLines = collectSynthLinks(
        hasMain ? (e: Edge) => pathIds.has(e.source) && pathIds.has(e.target) : null
      );

      if (!hasMain && synthLines.length === 0 && !boundaryText && !polyText) return identityOnly();
      const out: string[] = [];
      if (hasMain) {
        out.push('**Flow (call path among the symbols you queried)**', '');
        for (let i = 0; i < best!.length; i++) {
          const step = best![i]!;
          if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
          out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
        }
        out.push('');
      }
      if (synthLines.length) {
        out.push(
          '**Dynamic-dispatch links among your symbols**',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '',
          ...synthLines,
          ''
        );
      }
      if (boundaryText) out.push(boundaryText);
      if (polyText) out.push(polyText);
      out.push('> Full source for these symbols is below — the call flow among them, followed by their bodies.', '');
      // namedNodeIds = every callable the agent explicitly named (a superset of
      // the spine). A file holding one is something the agent asked to SEE, so it
      // must keep full source even if it's an off-spine polymorphic sibling — the
      // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
      // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
      return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set<string>([...named.keys(), ...dynNamed.keys()]), uniqueNamedNodeIds, spineCallSites };
    } catch {
      return EMPTY;
    }
  }

  /**
   * Dynamic-boundary surfacing (#687): when the flow among the agent's named
   * symbols does not fully connect, scan the disconnected symbols' bodies for
   * dynamic-dispatch sites (computed member calls, getattr, reflection, typed
   * message buses, runtime-keyed emits) and ANNOUNCE the boundary — the exact
   * site, the form, and (when a key is statically visible) candidate targets —
   * instead of guessing edges. The answer to "how does A reach B" when no
   * static path exists IS the dispatch site: that's where the flow continues
   * at runtime. Query-time, deterministic, zero graph mutation; a fully
   * connected flow never reaches this method.
   */
  private buildDynamicBoundaries(cg: CodeGraph, scanList: Node[], named: Map<string, Node>): string {
    const MAX_NOTES = 4;       // boundary bullets per explore
    const MAX_SCAN = 8;        // bodies scanned
    const MAX_TOTAL_CHARS = 200_000;
    let projectRoot: string;
    try { projectRoot = cg.getProjectRoot(); } catch { return ''; }
    const notes: string[] = [];
    const seenNode = new Set<string>();
    const seenSite = new Set<string>();
    let scanned = 0, charsScanned = 0;
    for (const node of scanList) {
      if (notes.length >= MAX_NOTES || scanned >= MAX_SCAN || charsScanned > MAX_TOTAL_CHARS) break;
      if (seenNode.has(node.id) || !node.startLine || !node.endLine) continue;
      seenNode.add(node.id);
      const absPath = validatePathWithinRoot(projectRoot, node.filePath);
      if (!absPath || !existsSync(absPath)) continue;
      let content: string;
      try { content = readFileSync(absPath, 'utf-8'); } catch { continue; }
      const body = content.split('\n').slice(node.startLine - 1, node.endLine).join('\n');
      scanned++;
      charsScanned += body.length;
      for (const m of scanDynamicDispatch(body, node.language || '', node.startLine)) {
        if (notes.length >= MAX_NOTES) break;
        const siteKey = `${node.filePath}:${m.line}:${m.form}`;
        if (seenSite.has(siteKey)) continue;
        seenSite.add(siteKey);
        const more = m.moreSites ? ` (+${m.moreSites} more such site${m.moreSites > 1 ? 's' : ''} in this body)` : '';
        notes.push(`- \`${node.name}\` (${node.filePath}:${m.line}) — ${m.label}: \`${m.snippet}\`${more}`);
        if (m.key) {
          const cand = this.boundaryCandidates(cg, m.key, !!m.keyIsType, named, node.id);
          if (cand) notes.push(`  ${cand}`);
        }
      }
    }
    if (notes.length === 0) return '';
    return [
      '**Dynamic boundaries (the static path ends at runtime dispatch)**',
      '',
      ...notes,
      '',
      '> These sites choose their call target at runtime (registry / bus / reflection) — the site shown IS where the flow continues. To follow it, run codegraph_explore or codegraph_node on a candidate; source for the sites above is included below.',
      '',
    ].join('\n');
  }

  /**
   * Interface/registry-dispatch announcement — #687 extended to GRAPH-visible
   * polymorphism (the body-scan can't see it: `nodeType.execute()` is textually
   * an ordinary call; the polymorphism lives in the `implements`/`extends` edges).
   *
   * A method the agent named that resolves to a large same-name family whose
   * definers overwhelmingly implement/extend ONE supertype is a runtime dispatch:
   * the concrete target is chosen at runtime from N implementations, so no single
   * static edge is "the answer" — the implementations ARE the continuations. We
   * announce the supertype, its TRUE implementer count, and a few concrete targets,
   * then steer to codegraph_explore. Graph-only, query-time, zero mutation; the
   * caller fires it ONLY for an UNCOVERED named token, so a connected flow is silent.
   *
   * Robust to FTS sampling bias: the same-name family is a capped FTS sample that
   * over-represents whatever FTS ranks first (n8n: DB `TableOperation.execute`
   * outnumbered `INodeType.execute` in the sample 7:6 even though INodeType has
   * 611 implementers vs a handful). So candidate supertypes are ranked by their
   * TRUE graph-wide implementer count, NOT their frequency in the sample.
   */
  private buildPolymorphicBoundaries(cg: CodeGraph, candidates: Array<{ token: string; family: Node[] }>, named: Map<string, Node>): string {
    const CLASSY = new Set(['class', 'struct', 'interface', 'trait', 'protocol', 'abstract']);
    const MIN_IMPL = 8;     // a supertype needs >= this many implementers to count as "polymorphic"
    const MIN_SUPPORT = 2;  // >= this many sampled definers must share the supertype (ties it to the token)
    const SAMPLE = 40;      // family members inspected per token
    const MAX_NOTES = 3;
    const rel = (p: string) => p.replace(/\\/g, '/');
    const containerOf = (m: Node): Node | null => {
      try { const ce = cg.getIncomingEdges(m.id).find((e) => e.kind === 'contains'); return ce ? cg.getNode(ce.source) : null; }
      catch { return null; }
    };
    const notes: string[] = [];
    const seenSuper = new Set<string>();
    for (const { token, family } of candidates) {
      if (notes.length >= MAX_NOTES) break;
      // supertype id → how many sampled definers share it + a few example definers
      const supers = new Map<string, { node: Node; count: number; targets: Node[] }>();
      for (const m of family.slice(0, SAMPLE)) {
        const container = containerOf(m);
        if (!container || !CLASSY.has(container.kind)) continue;
        let sups: Node[] = [];
        try {
          sups = cg.getOutgoingEdges(container.id)
            .filter((e) => e.kind === 'implements' || e.kind === 'extends')
            .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
            .filter((n): n is Node => !!n && CLASSY.has(n.kind) && (n.name?.length || 0) >= 3);
        } catch { /* no supertypes — free function or unresolved */ }
        for (const s of sups) {
          const e = supers.get(s.id) || { node: s, count: 0, targets: [] };
          e.count++;
          if (e.targets.length < 6) e.targets.push(m);
          supers.set(s.id, e);
        }
      }
      // Pick the supertype with the most TRUE implementers (graph-wide), among
      // those genuinely shared by the token's definers.
      let best: { node: Node; impl: number; targets: Node[] } | null = null;
      for (const { node, count, targets } of supers.values()) {
        if (count < MIN_SUPPORT) continue;
        let impl = 0;
        try { impl = cg.getIncomingEdges(node.id).filter((e) => e.kind === 'implements' || e.kind === 'extends').length; }
        catch { /* leave 0 — gated out below */ }
        if (impl < MIN_IMPL) continue;
        if (!best || impl > best.impl) best = { node, impl, targets };
      }
      if (!best || seenSuper.has(best.node.id)) continue;
      seenSuper.add(best.node.id);
      const namedNames = new Set([...named.values()].map((n) => n.name));
      const eg = best.targets.slice(0, 4).map((m) => {
        const cont = containerOf(m);
        const disp = cont ? `${cont.name}.${m.name}` : (m.qualifiedName || m.name);
        const mark = cont && namedNames.has(cont.name) ? ' ← you named this' : '';
        return `\`${disp}\` (${rel(m.filePath)}:${m.startLine})${mark}`;
      });
      const more = best.impl > eg.length ? ` +${best.impl - eg.length} more` : '';
      notes.push(`- \`${token}\` → runtime dispatch to **${best.impl}** types implementing \`${best.node.name}\` — the static path ends here, the target is chosen at runtime. e.g. ${eg.join(', ')}${more}`);
    }
    if (notes.length === 0) return '';
    return [
      '**Interface dispatch (a named method has many implementations)**',
      '',
      ...notes,
      '',
      '> The method above is dispatched at runtime to one of the listed implementations (a registry / plugin / strategy interface) — there is no single static caller→callee edge; the implementations ARE the continuations. To follow one, run codegraph_explore on a listed target.',
      '',
    ].join('\n');
  }

  /**
   * Shortlist candidate runtime targets for a dispatch key surfaced by
   * {@link buildDynamicBoundaries}. Exact conventional names first (`save` →
   * `onSave`/`handleSave`; `CreateCmd` → `CreateCmdHandler`), then FTS, with a
   * normalized-containment post-filter (FTS camel-splitting is fuzzier than a
   * candidate list should be). Symbols the agent already named sort first and
   * are marked — that's the "you were right, here's the wiring" case.
   */
  private boundaryCandidates(cg: CodeGraph, key: string, keyIsType: boolean, named: Map<string, Node>, selfId: string): string {
    const CALLABLE = new Set(['method', 'function', 'component', 'constructor', 'class']);
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const keyNorm = norm(key);
    if (keyNorm.length < 3) return '';
    const cands = new Map<string, Node>();
    const consider = (n: Node | undefined | null) => {
      if (!n || n.id === selfId || !CALLABLE.has(n.kind) || cands.has(n.id)) return;
      const nameNorm = norm(n.name || '');
      if (nameNorm.length < 3) return;
      if (!nameNorm.includes(keyNorm) && !keyNorm.includes(nameNorm)) return;
      cands.set(n.id, n);
    };
    const cap = key.charAt(0).toUpperCase() + key.slice(1);
    const probes = keyIsType
      ? [`${key}Handler`, key]
      : [key, `on${cap}`, `handle${cap}`, `${key}Handler`, `handle_${key}`];
    for (const p of probes) {
      try { for (const n of cg.getNodesByName(p)) consider(n); } catch { /* exact probe miss is fine */ }
    }
    let raw = 0;
    try {
      const results = cg.searchNodes(key, { limit: 12 });
      raw = results.length;
      for (const r of results) consider(r.node);
    } catch { /* FTS syntax edge — exact probes already ran */ }
    if (cands.size === 0) {
      return raw >= 12 && key.length < 5 ? `key \`${key}\` is too generic to shortlist (${raw}+ matches)` : '';
    }
    // A constructor candidate duplicates its class: extractors emit ctors as
    // METHOD nodes named like the class (C#/Java `Foo::Foo`) — keep the class.
    const all = [...cands.values()];
    const classKey = new Set(all.filter((n) => n.kind === 'class').map((n) => `${n.name}|${n.filePath}`));
    const namedNames = new Set([...named.values()].map((n) => n.name));
    const isNamed = (n: Node) => named.has(n.id) || namedNames.has(n.name); // the flow's named set holds callables only — transfer the mark to the class
    const list = all
      .filter((n) => !(n.kind !== 'class' && classKey.has(`${n.name}|${n.filePath}`)))
      .sort((a, b) => (isNamed(b) ? 1 : 0) - (isNamed(a) ? 1 : 0))
      .slice(0, 4)
      .map((n) => {
        // Typed-bus convention: the runtime target is the candidate class's
        // Handle/Execute/Consume method — name the exact node, not just the class.
        let display = n.qualifiedName || n.name;
        let at = `${n.filePath}:${n.startLine}`;
        if (keyIsType && n.kind === 'class') {
          try {
            const HANDLER_METHODS = /^(handle|handleAsync|execute|executeAsync|consume|consumeAsync|run|__invoke)$/i;
            const method = cg.getOutgoingEdges(n.id)
              .filter((e) => e.kind === 'contains')
              .map((e) => { try { return cg.getNode(e.target); } catch { return null; } })
              .find((c): c is Node => !!c && c.kind === 'method' && HANDLER_METHODS.test(c.name));
            if (method) { display = `${n.name}.${method.name}`; at = `${method.filePath}:${method.startLine}`; }
          } catch { /* class without resolvable members — show the class itself */ }
        }
        return `\`${display}\` (${at})${isNamed(n) ? ' ← you named this' : ''}`;
      });
    return `candidates for key \`${key}\`: ${list.join(', ')}`;
  }

  /**
   * Compact "blast radius" for the entry symbols of an explore result: who
   * depends on each (callers) and which test files cover it — LOCATIONS ONLY,
   * no source, so the agent knows what to update / re-verify before editing
   * without reaching for a separate impact call. Always-on, but skips symbols
   * that have no dependents (nothing to warn about), and returns '' when none
   * qualify so a leaf-only exploration stays clean.
   */
  private buildBlastRadiusSection(cg: CodeGraph, subgraph: Subgraph): string {
    const ROOT_CAP = 5; // only the symbols the query actually targeted
    const FILE_CAP = 4; // caller files listed per symbol before "+N more"
    const MEANINGFUL = new Set<string>([
      'function', 'method', 'class', 'interface', 'struct', 'union', 'trait', 'protocol',
      'enum', 'type_alias', 'component', 'constant', 'variable', 'property', 'field',
    ]);
    const rel = (p: string) => p.replace(/\\/g, '/');

    const roots = subgraph.roots
      .map((id) => subgraph.nodes.get(id))
      .filter((n): n is Node => !!n && MEANINGFUL.has(n.kind))
      .slice(0, ROOT_CAP);
    if (roots.length === 0) return '';

    const entries: string[] = [];
    for (const root of roots) {
      let callers: Array<{ node: Node }> = [];
      try { callers = cg.getCallers(root.id) as Array<{ node: Node }>; } catch { /* skip this root */ }

      const seen = new Set<string>();
      const uniq: Node[] = [];
      for (const c of callers) {
        if (c?.node && !seen.has(c.node.id)) { seen.add(c.node.id); uniq.push(c.node); }
      }
      if (uniq.length === 0) continue; // no blast radius → nothing to flag

      const callerFiles = [...new Set(uniq.map((n) => rel(n.filePath)))];
      const testFiles = callerFiles.filter((f) => isTestFile(f));
      const nonTest = callerFiles.filter((f) => !isTestFile(f));

      const shown = nonTest.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
      const more = nonTest.length > FILE_CAP ? ` +${nonTest.length - FILE_CAP} more` : '';
      const where = nonTest.length > 0 ? ` in ${shown}${more}` : '';
      const tests = testFiles.length > 0
        ? `; tests: ${testFiles.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ')}${testFiles.length > FILE_CAP ? ` +${testFiles.length - FILE_CAP}` : ''}`
        : this.indirectTestNote(cg, uniq, rel);

      entries.push(
        `- \`${root.name}\` (${rel(root.filePath)}:${root.startLine}) — ${uniq.length} caller${uniq.length === 1 ? '' : 's'}${where}${tests}`,
      );
    }
    if (entries.length === 0) return '';

    return [
      '**Blast radius — what depends on these (update/verify before editing)**',
      '',
      ...entries,
      '',
    ].join('\n');
  }

  /**
   * Test-coverage note for a blast-radius entry whose DIRECT callers include no
   * test file. A helper called only by production code can still be exercised
   * by tests further up the caller chain (#1475: 40% of directly-unflagged
   * symbols had a test within 2-3 hops), so walk up to 2 more hops before
   * claiming anything — and even then claim only what was measured.
   */
  private indirectTestNote(cg: CodeGraph, directCallers: Node[], rel: (p: string) => string): string {
    const MAX_HOPS = 3; // direct callers are hop 1
    const BUDGET = 64;  // getCallers lookups per entry — bounds god-fan-in symbols
    const FILE_CAP = 2;
    let budget = BUDGET;
    const visited = new Set(directCallers.map((n) => n.id));
    let frontier = directCallers;
    for (let hop = 2; hop <= MAX_HOPS && frontier.length > 0 && budget > 0; hop++) {
      const next: Node[] = [];
      const found = new Set<string>();
      for (const node of frontier) {
        if (budget-- <= 0) break;
        let callers: Array<{ node: Node }> = [];
        try { callers = cg.getCallers(node.id) as Array<{ node: Node }>; } catch { continue; }
        for (const c of callers) {
          const n = c?.node;
          if (!n || visited.has(n.id)) continue;
          visited.add(n.id);
          const f = rel(n.filePath);
          if (isTestFile(f)) found.add(f);
          else next.push(n);
        }
      }
      if (found.size > 0) {
        const files = [...found];
        const shown = files.slice(0, FILE_CAP).map((f) => `\`${f}\``).join(', ');
        const more = files.length > FILE_CAP ? ` +${files.length - FILE_CAP}` : '';
        return `; tested via callers: ${shown}${more}`;
      }
      frontier = next;
    }
    // Budget exhaustion means hops 2-3 weren't fully searched — fall back to
    // the weaker claim that IS established by the direct-caller check.
    return budget > 0
      ? `; no tests found within ${MAX_HOPS} caller hops`
      : '; no test calls this directly';
  }

  /**
   * Graph-connectivity relevance via Random-Walk-with-Restart (personalized
   * PageRank) from the query's matched SEED nodes over the call/reference graph.
   *
   * This is the ranking signal text search (FTS/bm25) CANNOT provide, and it's
   * codegraph's home turf: relevance by STRUCTURE, not words. A file whose
   * symbols are call-connected to the matched cluster accrues walk mass and
   * ranks high; a lone TEXT match — e.g. `LensSwitcher.swift` matched the word
   * "switch" from `switchOrganization`, but calls none of `setUser`/`fetchUser`
   * — gets only its own restart probability and ranks ~0. Immune to the
   * tokenization trap that fools term matching, deterministic, no embeddings.
   *
   * Undirected adjacency (reachability both ways), restart α=0.25 to the seeds,
   * power iteration to convergence. Bounded to the already-relevant subgraph, so
   * it's a few hundred nodes × ~25 iterations — negligible cost.
   */
  private computeGraphRelevance(
    nodeIds: string[],
    edges: Edge[],
    seedIds: Set<string>,
  ): Map<string, number> {
    const out = new Map<string, number>();
    const n = nodeIds.length;
    if (n === 0) return out;
    const idx = new Map<string, number>();
    for (let i = 0; i < n; i++) idx.set(nodeIds[i]!, i);

    const RANK_EDGES = new Set<string>([
      'calls', 'references', 'extends', 'implements', 'overrides',
      'instantiates', 'returns', 'type_of', 'imports',
    ]);
    const adj: number[][] = Array.from({ length: n }, () => []);
    for (const e of edges) {
      if (!RANK_EDGES.has(e.kind)) continue;
      const i = idx.get(e.source);
      const j = idx.get(e.target);
      if (i === undefined || j === undefined || i === j) continue;
      adj[i]!.push(j);
      adj[j]!.push(i); // undirected — reachable either direction
    }

    // Restart vector: uniform over seeds present in the candidate set. (Falls
    // back to uniform-over-all if no seed landed in the set, so we never return
    // all-zero.)
    const r = new Array<number>(n).fill(0);
    let rsum = 0;
    for (const id of seedIds) {
      const i = idx.get(id);
      if (i !== undefined) { r[i] = 1; rsum += 1; }
    }
    if (rsum === 0) { for (let i = 0; i < n; i++) r[i] = 1; rsum = n; }
    for (let i = 0; i < n; i++) r[i]! /= rsum;

    const alpha = 0.25;
    let s = r.slice();
    for (let iter = 0; iter < 25; iter++) {
      const next = new Array<number>(n).fill(0);
      for (let i = 0; i < n; i++) {
        const si = s[i]!;
        if (si === 0) continue;
        const d = adj[i]!.length;
        if (d === 0) { next[i]! += si; continue; } // dangling: keep its mass
        const share = si / d;
        for (const j of adj[i]!) next[j]! += share;
      }
      for (let i = 0; i < n; i++) s[i] = (1 - alpha) * next[i]! + alpha * r[i]!;
    }
    for (let i = 0; i < n; i++) out.set(nodeIds[i]!, s[i]!);
    return out;
  }

  /**
   * Handle codegraph_explore — deep exploration in a single call
   *
   * Strategy: find relevant symbols via graph traversal, group by file,
   * then read contiguous file sections covering all symbols per file.
   * This replaces multiple codegraph_node + Read calls.
   *
   * Output size is adaptive to project file count via
   * `getExploreOutputBudget` — see #185 for why a fixed 35k cap was a
   * tax on small projects while earning its keep on large ones.
   */
  private async handleExplore(args: Record<string, unknown>): Promise<ToolResult> {
    const rawQuery = this.validateString(args.query, 'query');
    if (typeof rawQuery !== 'string') return rawQuery;
    // One normalization point so the flow-builder, relevance search, and
    // ranking all see the same canonical spelling (Erlang `mod:fn/arity`).
    const query = normalizeQuerySpelling(rawQuery);

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    let indexedFileCount = -1;
    try {
      indexedFileCount = cg.getStats().fileCount;
      budget = getExploreOutputBudget(indexedFileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // File paths named in the query become PINNED files: guaranteed admission,
    // top of the rank order, funded first — and their span is REMOVED from the
    // matching query. Runs on the RAW query (normalizeQuerySpelling strips
    // `/digits` tails, which would mangle numeric path segments). Without this,
    // a SvelteKit path like `runs/[runId]/+page.svelte` was shredded by the
    // seeding tokenizer (splits on brackets → `runId` seeded as a "named
    // symbol") and by FTS (`page`/`runs` fragments admitted every sibling
    // `+page.svelte`), starving the very files the agent asked for.
    let pinnedFiles: string[] = [];
    let unresolvedPathSpans: string[] = [];
    let matchQuery = query;
    if (queryMightContainPaths(rawQuery)) {
      try {
        const extraction = extractQueryPaths(
          rawQuery,
          cg.getFiles().map((f) => f.path),
          { maxPins: maxFiles },
        );
        if (extraction.pinnedFiles.length > 0 || extraction.unresolvedPathSpans.length > 0) {
          pinnedFiles = extraction.pinnedFiles;
          unresolvedPathSpans = extraction.unresolvedPathSpans;
          matchQuery = normalizeQuerySpelling(extraction.strippedQuery);
        }
      } catch { /* path pinning must never fail an explore call */ }
    }
    const pinnedSet = new Set(pinnedFiles);
    const pinnedOrder = new Map(pinnedFiles.map((p, i) => [p, i]));

    // Per-file allocation diagnostic (CG-4). `null` unless CODEGRAPH_EXPLORE_DEBUG
    // is set — every `diag?.` below is then a no-op and the response is
    // byte-identical. It only OBSERVES: it must never feed back into rendering.
    const diag = ExploreDiagnostics.start(query, projectRoot, budget, maxFiles, indexedFileCount);

    // What this session has already been served for THIS project (CG-17), and
    // whether this call may act on it (CG-18). Dedup is off on the session's
    // first call by construction — there is nothing to point back AT — and off
    // entirely under `CODEGRAPH_EXPLORE_DEDUP=0`.
    const priorCalls = viewForProject(readExploreSessionView(args), projectRoot);
    diag?.noteSession(priorCalls);
    const dedupEnabled = exploreDedupEnabled() && (priorCalls?.calls.length ?? 0) > 0;

    // Cross-call dedup accounting (CG-18). `newSourceChars` is the load-bearing
    // one: a response whose source is ENTIRELY back-references is the shape that
    // reads as a failure, so the loop keeps the top suppressed file's real
    // section in hand and restores it if nothing new made it in — see
    // `suppressedFallback` below.
    let newSourceChars = 0;
    const backReferencedFiles: string[] = [];

    // What this call ends up emitting, per file — the record handed back to the
    // session state on the main thread. Filled by every render path below, then
    // filtered to the files that SURVIVE the final hard-ceiling cut, so the
    // record is what the agent actually received rather than what the loop
    // hoped to send.
    //
    // Back-referenced spans are recorded too, with zero bytes (CG-18): the
    // record means "source the agent HOLDS for this file", not "bytes this call
    // spent". Re-recording them refreshes them inside the retained-call window,
    // so a file pointed at across many calls doesn't age out of the history and
    // get re-served for no reason.
    const emittedByFile = new Map<
      string,
      { ranges: ExploreLineRange[]; bytes: number; fingerprint?: string }
    >();
    const noteEmitted = (
      fp: string,
      ranges: ExploreLineRange[],
      bytes: number,
      fingerprint?: string,
    ): void => {
      const existing = emittedByFile.get(fp);
      if (existing) {
        existing.ranges.push(...ranges);
        existing.bytes += bytes;
        if (fingerprint) existing.fingerprint = fingerprint;
      } else {
        emittedByFile.set(fp, { ranges: [...ranges], bytes, fingerprint });
      }
    };

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    // Matching runs on the path-stripped query; `query` stays for display.
    const subgraph = await cg.findRelevantContext(matchQuery, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    // Pinned files' symbols enter the gather unconditionally — the agent named
    // the file itself, so its contents ARE the answer regardless of what the
    // stripped query text matched (which, for a pure-path query, is nothing).
    const PINNED_FILE_NODE_CAP = 300;
    for (const fp of pinnedFiles) {
      let fileNodes: Node[] = [];
      try { fileNodes = cg.getNodesInFile(fp); } catch { continue; }
      fileNodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
        .sort((a, b) => a.startLine - b.startLine)
        .slice(0, PINNED_FILE_NODE_CAP)
        .forEach((n) => { if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n); });
    }

    if (subgraph.nodes.size === 0) {
      diag?.finishEmpty('no relevant code found — empty subgraph');
      const missNote = unresolvedPathSpans.length > 0
        ? ` (no indexed file uniquely matches ${unresolvedPathSpans.map((s) => `\`${s}\``).join(', ')})`
        : '';
      const empty = `No relevant code found for "${query}"${missNote}`;
      // Still an explore call, so it is still recorded: an empty answer spends a
      // call against the tier budget even though it emits no source.
      return this.exploreResult(empty, {
        projectRoot, query, files: [], sourceBytes: 0, responseBytes: empty.length,
      });
    }

    // Graph-aware glue: findRelevantContext builds the subgraph from name/text
    // search, so a method that BRIDGES named symbols — e.g. App.tsx's
    // triggerRender, which calls the named triggerUpdate — is never a search hit
    // and gets missed, forcing the agent to Read the file to trace it. Pull in
    // the callers/callees of the entry (root) nodes, but ONLY those that live in
    // files the subgraph already surfaces (where the agent reads to fill gaps),
    // so we add wiring without dragging in unrelated files. These get an
    // importance boost below so they survive the per-file cluster budget.
    const glueNodeIds = new Set<string>();
    const subgraphFiles = new Set<string>();
    for (const n of subgraph.nodes.values()) subgraphFiles.add(n.filePath);
    const GLUE_NODE_CAP = 60;
    for (const rootId of subgraph.roots) {
      if (glueNodeIds.size >= GLUE_NODE_CAP) break;
      let neighbors: Node[] = [];
      try {
        neighbors = [
          ...cg.getCallers(rootId).map(c => c.node),
          ...cg.getCallees(rootId).map(c => c.node),
        ];
      } catch {
        continue;
      }
      for (const nb of neighbors) {
        if (glueNodeIds.size >= GLUE_NODE_CAP) break;
        if (subgraph.nodes.has(nb.id)) continue;
        if (!subgraphFiles.has(nb.filePath)) continue;
        subgraph.nodes.set(nb.id, nb);
        glueNodeIds.add(nb.id);
      }
    }

    // Named-symbol seeding: findRelevantContext is an FTS/text rank, so a query
    // that's a BAG of symbol names skewed toward one phase (Alamofire: 5 build
    // terms, each a high-frequency name, vs 3 validate terms) lets the
    // lower-frequency names fall below the search cut — their definitions, and
    // whole files (Validation.swift), never get gathered, so they can never
    // render and the agent Reads them. Resolve EACH named token to its
    // substantive definition (skip empty stubs + test files, same relevance the
    // trace endpoint picker uses) and inject it as an entry, so every symbol the
    // agent explicitly named is in the subgraph and its file is scored.
    const namedSeedIds = new Set<string>();
    // The subset of named seeds that earns the named-FIRST sort tier. We still
    // SEED every ≤3-def name (so RWR / flow ranking is unchanged), but only the
    // most-substantive def is tiered — a bare name's unrelated namesakes (Go's
    // `NewClient` = real client + test fake + xds pool) must not fill the tier
    // and crowd out the real answer file (grpc's `dialoptions.go`). Corroborated
    // overloads (the query also named the type) all earn it. (#1064)
    const tierSeedIds = new Set<string>();
    // Files declaring a TYPE the query named by name — the counter-case guard
    // for the declaration-only penalty (CG-28). Populated in the token loop.
    const namedTypeFiles = new Set<string>();
    {
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte|astro|erl|hrl)$/i;
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Variables/constants seed too: in Svelte/React a `$state` variable
      // (`chatAtBottom`, `feedAtBottom`) is exactly the kind of symbol an agent
      // names in a query, and the exact-name search channel already returns
      // them — only this seeding tier was callable-only. The NL-stopword guard
      // below applies unchanged, so bare English words still can't seed a
      // same-named local. Callables keep priority via the body-size sort.
      const SEEDABLE = new Set([...CALLABLE, 'variable', 'constant']);
      const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
      const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      const callerCount = (n: Node) => { try { return cg.getCallers(n.id).length; } catch { return 0; } };
      const tokens = [...new Set(
        matchQuery.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      // PascalCase tokens in the query are type/file disambiguators — when the
      // agent writes "DataRequest task validate", the `task`/`validate` it wants
      // are DataRequest's, NOT the same-named overloads in Validation.swift /
      // Concurrency.swift / the abstract base. Used below to bias overloaded
      // names toward the file/class the query also names. EXCLUDE the project
      // name (a PascalCase token a user naturally includes) — it names the whole
      // repo, so biasing toward it just pulls overloads to whichever stack
      // embeds it, re-burying the rest (#720).
      const projectNameTokens = cg.getProjectNameTokens();
      const typeTokens = tokens.filter(
        (o) => /^[A-Z][A-Za-z0-9]{3,}/.test(o) && !projectNameTokens.has(normalizeNameToken(o)),
      );
      const inNamedContext = (n: Node) =>
        typeTokens.some((ct) => {
          const lc = ct.toLowerCase();
          return n.filePath.toLowerCase().includes(lc) || n.qualifiedName.toLowerCase().includes(lc);
        });
      // NL-stopword guard: this seeding treats every token as "a symbol the
      // agent named", but explore also takes natural-language questions, whose
      // ordinary English words collide with real callables — "…check the latest
      // version…" exact-matched a lone `check()` method, which then earned the
      // named-FIRST sort tier and displaced the corroborated answer files from
      // the whole render budget (the agent fell back to Read). A shape-precise
      // token (camelCase, PascalCase, snake_case, qualified) is an unambiguous
      // symbol reference and seeds unconditionally; a BARE lowercase word seeds
      // only where the query corroborates the file — another query token is
      // itself a symbol defined in that same file (the "check drain fire"
      // sibling-bag case), which an incidental English-word collision never is.
      const lcTokens = new Set(tokens.map((x) => x.toLowerCase()));
      const isPreciseToken = (x: string) =>
        /[._$]|::|\//.test(x) || /[a-z][A-Z]/.test(x) || /^[A-Z]/.test(x);
      const fileNameSets = new Map<string, Set<string>>();
      const coNamedInFile = (t: string, fp: string): boolean => {
        let names = fileNameSets.get(fp);
        if (!names) {
          names = new Set<string>();
          try {
            for (const n of cg.getNodesInFile(fp)) names.add(n.name.toLowerCase());
          } catch { /* unreadable file entry — treat as uncorroborated */ }
          fileNameSets.set(fp, names);
        }
        const self = t.toLowerCase();
        for (const o of lcTokens) {
          if (o !== self && names.has(o)) return true;
        }
        return false;
      };
      for (const t of tokens) {
        // Enumerate ALL defs of a bare token via the direct index, not FTS — a
        // 50+-overload name (tokio `poll`) ranks the wanted def (`Harness::poll`)
        // below the FTS cut, so findAllSymbols would never see it and the
        // type-token bias below couldn't pick the harness.rs one. (Same fix as
        // codegraph_node's findSymbolMatches.) Qualified tokens keep findAllSymbols.
        const isQual = /[.\/]|::/.test(t);
        const raw = isQual ? this.findAllSymbols(cg, t).nodes : cg.getNodesByName(t);
        // A query that NAMES a declared type is a question ABOUT that type, and
        // must still reach its declaration file at full weight — so record the
        // files those declarations live in and exempt them from the
        // declaration-only penalty below (CG-28). Only PRECISE tokens count, by
        // the same NL-stopword reasoning as the seeding above: "…the file body…"
        // must not exempt a `Body` interface it never meant to name. Kept
        // separate from `namedSeedIds`, which is callable-only by construction —
        // a type never becomes a named seed, so it cannot be the guard here.
        if (isPreciseToken(t)) {
          for (const n of raw) {
            if (DECLARATION_KINDS.has(n.kind) && n.name.toLowerCase() === t.toLowerCase()) {
              namedTypeFiles.add(n.filePath);
            }
          }
        }
        let cands = raw
          .filter((n) => SEEDABLE.has(n.kind) && !isTestPath(n.filePath))
          .sort((a, b) => (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a));
        // Field-name seeding fallback (#1196): a camelCase token that names NO
        // definition of its own is usually an object-literal key / API field
        // (`profileInfo`) — no node exists, so it contributed zero seeds and
        // the files that DEFINE it (`getProfileInfoV2` in profileController)
        // never surfaced. Seed its camel-infix definers instead: seedable
        // symbols (callables + variables — `atBottom` must reach the `$state`
        // variables `feedAtBottom`/`chatAtBottom`) whose name contains the
        // token at a hump boundary or as a prefix.
        // Exact-empty + camel-shaped only (bare words keep the NL-stopword
        // guard below), shortest-first, capped so a hot infix can't flood.
        if (cands.length === 0 && !isQual && /[a-z][A-Z]/.test(t)) {
          const lcToken = t.toLowerCase();
          cands = cg
            .getNodesByNameSubstring(t, {
              kinds: ['function', 'method', 'component', 'variable', 'constant'],
              limit: 60,
            })
            .filter((n) => SEEDABLE.has(n.kind) && !isTestPath(n.filePath))
            .filter((n) => {
              const idx = n.name.toLowerCase().indexOf(lcToken);
              if (idx < 0) return false;
              if (idx === 0) return n.name.length > t.length; // prefix definer
              return /[A-Z]/.test(n.name.charAt(idx)); // camel-hump boundary
            })
            .sort((a, b) => a.name.length - b.name.length)
            .slice(0, 3);
        }
        // Bare lowercase words only seed defs their query-siblings corroborate
        // (see the NL-stopword guard above). Filtering CANDS (not picks) applies
        // the guard uniformly to both branches below, including the >3-def
        // single-pick fallback — an uncorroborated bare `run` must not tier its
        // most-substantive namesake any more than a 1-def `check` may.
        if (!isPreciseToken(t)) {
          cands = cands.filter((n) => coNamedInFile(t, n.filePath));
        }
        // A specific name (<=3 defs) injects all its defs. An overloaded name
        // (`validate` = 10, `request` = 44) would flood the subgraph, so inject
        // only: the overloads whose file/class the query ALSO names (the agent
        // told us which one it wants — DataRequest's, not Validation.swift's),
        // capped; else fall back to the single most-substantive def. This is the
        // explore-side mirror of codegraph_node's overload disambiguation.
        let picks: Node[];
        let tierPicks: Node[]; // subset that earns the named-first tier (#1064)
        if (cands.length <= 3) {
          picks = cands;
          // Centrality de-noise: tier the most-substantive def PLUS any co-named
          // def of comparable centrality (a real overload/wrapper — excalidraw's
          // `mutateElement` lives in mutateElement.ts, App.tsx AND Scene.ts, all
          // within ~2x callers). EXCLUDE a vastly-less-central namesake (Go's
          // `NewClient`: real client 492 callers vs xds-pool 11, test-fake 3 →
          // ratio <0.025) so it doesn't fill the tier and crowd out the answer.
          const counts = new Map(cands.map((c) => [c.id, callerCount(c)]));
          const maxCallers = Math.max(1, ...counts.values());
          tierPicks = cands.filter((c, i) => i === 0 || (counts.get(c.id) ?? 0) >= maxCallers * 0.25);
        } else {
          const ctx = cands.filter(inNamedContext);
          picks = ctx.length > 0 ? ctx.slice(0, 4) : cands.slice(0, 1);
          tierPicks = picks; // corroborated overloads (or the single fallback) all earn it
        }
        for (const n of picks) {
          if (!subgraph.nodes.has(n.id)) subgraph.nodes.set(n.id, n);
          // Mark as a named seed EVEN IF the FTS gather already had it — being
          // "named by the agent" is independent of whether search happened to
          // surface it, and it drives the +50 score, the gate, and the
          // named-file sort below. (Previously only NEW injections were marked,
          // so a named symbol FTS already gathered never sorted to the top.)
          namedSeedIds.add(n.id);
        }
        for (const n of tierPicks) tierSeedIds.add(n.id);
      }
    }

    // Step 2: Group nodes by file, score by relevance
    // `peripheral` accumulates separately so it can be capped — see
    // PERIPHERAL_SCORE_CAP; it is folded into `score` once the loop is done.
    const fileGroups = new Map<string, { nodes: Node[]; score: number; peripheral: number }>();
    const entryNodeIds = new Set([...subgraph.roots, ...namedSeedIds]);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    // Usage degree within the subgraph, for the weak-kind isolation test below.
    // Free (the edges are already in hand) and it answers most cases; only a
    // weak-kind node that looks isolated HERE pays for a DB probe.
    const subgraphUsageDegree = new Map<string, number>();
    for (const edge of subgraph.edges) {
      if (!RELEVANCE_USAGE_EDGES.has(edge.kind) || edge.source === edge.target) continue;
      subgraphUsageDegree.set(edge.source, (subgraphUsageDegree.get(edge.source) ?? 0) + 1);
      subgraphUsageDegree.set(edge.target, (subgraphUsageDegree.get(edge.target) ?? 0) + 1);
    }

    /**
     * Relevance weight for one matched symbol: its NodeKind, further discounted
     * when it is a weak kind that NOTHING uses. The DB probe (full-graph, since
     * a usage can sit outside the traversal) is paid for only by weak-kind
     * symbols in the top two tiers — the ones whose weight can carry a whole
     * file. A `connectedToEntry` or peripheral node is worth <= 3 either way, so
     * probing it would buy nothing.
     */
    const isolationCache = new Map<string, boolean>();
    const isUsageIsolated = (node: Node): boolean => {
      if ((subgraphUsageDegree.get(node.id) ?? 0) > 0) return false;
      const cached = isolationCache.get(node.id);
      if (cached !== undefined) return cached;
      let isolated = true;
      try {
        const used = (e: Edge) => RELEVANCE_USAGE_EDGES.has(e.kind);
        isolated = !cg.getIncomingEdges(node.id).some(used)
          && !cg.getOutgoingEdges(node.id).some(used);
      } catch {
        isolated = false; // a probe failure must not manufacture a penalty
      }
      isolationCache.set(node.id, isolated);
      return isolated;
    };
    const relevanceWeight = (node: Node, probeIsolation: boolean): number => {
      const weight = RELEVANCE_KIND_WEIGHT[node.kind] ?? DEFAULT_RELEVANCE_KIND_WEIGHT;
      if (!probeIsolation || !WEAK_RELEVANCE_KINDS.has(node.kind)) return weight;
      return isUsageIsolated(node) ? ISOLATED_WEAK_KIND_WEIGHT : weight;
    };

    // CHANGE SURFACE (#1064): a named method's signature types — its parameter
    // and return types — are part of what you'd edit to "add a parameter to X",
    // yet they can be lexically dissimilar to the query ("add a parameter to
    // NewClient" shares no words with `dialoptions.go`, which defines NewClient's
    // `DialOption`) and sit a hop away. COLLECT them here from each named-seed
    // callable's outgoing signature edges (full graph — the type is often not in
    // the subgraph); the decision to surface one is DEFERRED to the buried-rescue
    // pass below, which fires only when the type's file would otherwise be
    // dropped — so a well-connected type (excalidraw's element types, Alamofire's
    // `DataRequest` on a flow query) is left to rank on its own and never
    // displaces a flow-central file. Bounded: only the few named seeds, only the
    // types in their signatures.
    const CALLABLE_KINDS = new Set(['method', 'function', 'component', 'constructor']);
    const TYPE_KINDS = new Set(['class', 'struct', 'union', 'interface', 'trait', 'protocol', 'enum', 'type_alias']);
    const SIG_EDGE = new Set(['references', 'type_of', 'returns']);
    const changeSurfaceCandidates: Node[] = [];
    const seenChangeSurface = new Set<string>();
    for (const seedId of tierSeedIds) {
      const seedNode = subgraph.nodes.get(seedId);
      if (!seedNode || !CALLABLE_KINDS.has(seedNode.kind)) continue;
      let outs: Edge[] = [];
      try { outs = cg.getOutgoingEdges(seedId); } catch { continue; }
      for (const e of outs) {
        if (!SIG_EDGE.has(e.kind)) continue;
        const tgt = cg.getNode(e.target);
        if (!tgt || !TYPE_KINDS.has(tgt.kind) || namedSeedIds.has(tgt.id)) continue;
        if (seenChangeSurface.has(tgt.id)) continue;
        seenChangeSurface.add(tgt.id);
        changeSurfaceCandidates.push(tgt);
      }
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;
      // SECURITY (#383): never render the on-disk source of a config-leaf
      // (Spring application.{yml,properties} key) — its line is `key = <secret>`,
      // so whole-file/cluster rendering here would push secrets into context
      // unbidden. The key still appears in the flow/symbol listing above.
      if (isConfigLeafNode(node)) continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0, peripheral: 0 };
      group.nodes.push(node);
      // Score: a NAMED-SEED node (a symbol the agent named that FTS missed, now
      // injected) is worth far more than a mere reference — its file is where the
      // answer lives. Without this, an incidental file that name-drops the flow
      // (Combine.swift references request/task → score 23 from connected nodes)
      // outranks the file that DEFINES a named symbol (Validation.swift's
      // `validate` → 10) and steals its render slot. Definition ≫ reference.
      //
      // Each tier is then scaled by WHAT was matched (RELEVANCE_KIND_WEIGHT): the
      // tier says how the symbol reached us, the kind weight says whether the
      // match is evidence. A file whose only claim is an unused local `explore`
      // constant is a name collision, not an answer (#1500).
      if (namedSeedIds.has(node.id)) {
        group.score += 50 * relevanceWeight(node, true);
      } else if (entryNodeIds.has(node.id)) {
        group.score += 10 * relevanceWeight(node, true);
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3 * relevanceWeight(node, false);
      } else {
        // Peripheral: in the subgraph but ≥2 hops from anything the query
        // matched. Accumulated separately and capped below, so a file cannot
        // buy relevance with size alone.
        group.peripheral += relevanceWeight(node, false);
      }
      fileGroups.set(node.filePath, group);
    }

    // Extract query terms for relevance checking (path-stripped: a pinned
    // file's own path fragments must not count as "term hits" everywhere)
    const queryTerms = matchQuery.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Test/spec/icon/i18n file detector — used by the pre-floor hard filter, the
    // rank penalty, and the comparator deprioritization.
    //
    // The directory pattern is anchored at `^` as well as `/`: a repo-ROOT
    // `test/` or `spec/` directory (express, cobra, and most of npm/Go) produced
    // paths like `test/express.raw.js`, which the old leading-`/` form could
    // never match — so express's routing question spent 59% of its envelope on
    // three test files while `lib/router/index.js` never rendered.
    const isLowValue = (p: string) => {
      const lp = p.toLowerCase();
      return (
        /(?:^|\/)(tests?|__tests?__|specs?)\//.test(lp) ||
        /_test\.go$/.test(lp) ||
        /(?:^|\/)test_[^/]+\.py$/.test(lp) ||
        /_test\.py$/.test(lp) ||
        /_spec\.rb$/.test(lp) ||
        /_test\.rb$/.test(lp) ||
        /\.(test|spec)\.[jt]sx?$/.test(lp) ||
        /(test|spec|tests)\.(java|kt|scala)$/.test(lp) ||
        /(tests?|spec)\.cs$/.test(lp) ||
        /tests?\.swift$/.test(lp) ||
        /_test\.dart$/.test(lp) ||
        /\bicons?\b/.test(lp) ||
        /\bi18n\b/.test(lp)
      );
    };

    // One DB probe over every file the query touched, then O(1) per lookup.
    // Unions the index-time content-banner flag (CG-5) with the filename
    // convention, so a Go monorepo's generated CRUD (`payroll.go` carrying a
    // DO-NOT-EDIT banner and nothing in its name) down-ranks the same way
    // `.pb.go` always has (#1500). Covers the whole subgraph, not just the
    // grouped files, because the graph-mass penalty below is keyed on it too.
    const penaltyCandidates = new Set([
      ...fileGroups.keys(),
      ...[...subgraph.nodes.values()].map((n) => n.filePath),
    ]);
    const isGeneratedCandidate = cg.generatedFilePredicate(penaltyCandidates);
    // Second bounded probe over the same set: files declaring nothing but types
    // that nothing in the index depends on (CG-28). A query that NAMED one of
    // those types is asking about the declaration, so its file is exempt and
    // ranks at full weight.
    const isAmbientDeclaration = cg.ambientDeclarationFilePredicate(penaltyCandidates);
    const isDampedDeclaration = (filePath: string): boolean =>
      isAmbientDeclaration(filePath) && !namedTypeFiles.has(filePath);

    /**
     * Rank penalty for a file, applied to its relevance score AND (below) to its
     * graph mass — the two signals the sort actually keys on. Applying it to the
     * score alone would leave the #1500 case unfixed: the generated CRUD carries
     * MORE graph mass than the hand-written use-case, and graph mass outranks
     * score in the comparator.
     *
     * Generated and ambient-declaration are taken as the STRONGER of the two,
     * never multiplied: a generated `.d.ts` has one property — "not the
     * implementation" — that both signals happen to see, and charging it twice is
     * how a file gets cliffed out of answers where it is genuinely relevant
     * (CG-28). The low-value multiplier is orthogonal (a test file that is also
     * generated is two independent reasons) and still compounds.
     */
    const rankPenalty = (filePath: string): number =>
      Math.min(
        isGeneratedCandidate(filePath) ? GENERATED_RANK_PENALTY : 1,
        isDampedDeclaration(filePath) ? AMBIENT_DECLARATION_RANK_PENALTY : 1,
      )
      * (isLowValue(filePath) ? LOW_VALUE_RANK_PENALTY : 1);

    for (const [filePath, group] of fileGroups) {
      group.score = (group.score + Math.min(PERIPHERAL_SCORE_CAP, group.peripheral))
        * rankPenalty(filePath);
    }

    // Hard-exclude test/spec files (ALL tiers — the per-tier `excludeLowValueFiles`
    // flag this used to be gated on was dead config and is gone). One slipped test
    // file dominates the per-file budget on small repos (cobra's `command_test.go`
    // displaced `args.go`) AND wastes budget on large ones (Django's
    // `custom_lookups/tests.py` ate ~2.3 KB of the 28 KB cap, crowding out the
    // SQLCompiler mechanism the agent then Read). A test file almost never answers
    // an architecture question. Skip when the query itself is about tests — the
    // legitimate "explore the tests" case — and only cut if ≥2 non-test candidates
    // remain (else tests are the only signal for this area).
    //
    // Runs BEFORE the score floor, on the whole gather. Judging "are there other
    // candidates?" on the post-floor set was too late: express's routing question
    // left one non-test file past the floor, the guard stood down, and the floor's
    // keep-minimum then pulled two test files back in as the "spread".
    let candidateFiles = [...fileGroups.entries()];
    {
      const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(matchQuery);
      if (!queryMentionsTests) {
        // A pinned file is exempt: naming a test file by path IS asking for it.
        const nonLow = candidateFiles.filter(([p]) => !isLowValue(p) || pinnedSet.has(p));
        if (nonLow.length >= 2) {
          candidateFiles = nonLow;
        }
      }
      diag?.setLowValueFiltered(fileGroups.size, candidateFiles.length);
    }

    // Relative score floor — see SCORE_FLOOR_* for why it is a fraction of the
    // best file's score and why that fraction is clamped at both ends.
    const topScore = Math.max(0, ...candidateFiles.map(([, g]) => g.score));
    const scoreFloor = Math.max(
      SCORE_FLOOR_ABSOLUTE,
      Math.min(SCORE_FLOOR_MAX, topScore * SCORE_FLOOR_FRACTION_OF_TOP),
    );
    let relevantFiles = candidateFiles.filter(
      ([fp, group]) => group.score >= scoreFloor || pinnedSet.has(fp),
    );
    if (relevantFiles.length < SCORE_FLOOR_KEEP_MIN) {
      // Backfill from what the RELATIVE floor cut, best first, at two strengths:
      //
      //  - THIN (1-2 files survived): only files with real evidence. A file whose
      //    entire claim is one isolated variable scores 0.8 and stays out —
      //    express's `examples/route-middleware` matched nothing but a local
      //    `app` and would otherwise have taken 48% of that envelope. Padding a
      //    precise answer with a wrong file doesn't save the agent the follow-up
      //    call it would pad against.
      //  - EMPTY (nothing survived): take the best of whatever matched. Returning
      //    "no relevant code found" when the gather DID find candidates is the
      //    worst outcome on the board — the agent falls straight back to grep.
      const minEvidence = relevantFiles.length === 0 ? Number.EPSILON : SCORE_FLOOR_ABSOLUTE;
      relevantFiles = candidateFiles
        .filter(([fp, group]) => group.score >= minEvidence || pinnedSet.has(fp))
        .sort((a, b) =>
          (pinnedSet.has(b[0]) ? 1 : 0) - (pinnedSet.has(a[0]) ? 1 : 0)
          || b[1].score - a[1].score
          || b[1].nodes.length - a[1].nodes.length)
        .slice(0, Math.max(SCORE_FLOOR_KEEP_MIN, relevantFiles.length));
    }
    diag?.setScoreFloor(scoreFloor, relevantFiles.length);

    // Secondary signal: how many DISTINCT query terms each file matches (path +
    // symbol names). Kept only as a tiebreak — the PRIMARY relevance is graph
    // connectivity below. (Term counting alone tied the real central file with
    // incidental same-word matches; it's a weak text signal, not the ranker.)
    const uniqueQueryTerms = [...new Set(queryTerms)].filter(t => t.length >= 3);
    const fileTermHits = new Map<string, number>();
    for (const [fp, group] of relevantFiles) {
      const hay = fp.toLowerCase() + ' ' + group.nodes.map(n => n.name.toLowerCase()).join(' ');
      let hits = 0;
      for (const t of uniqueQueryTerms) if (hay.includes(t)) hits++;
      fileTermHits.set(fp, hits);
    }

    // PRIMARY relevance: graph connectivity (Random-Walk-with-Restart from the
    // matched seeds — see computeGraphRelevance). Aggregate each file's nodes'
    // walk mass. This is the signal text search lacks: the real cluster
    // (org-user.storage.ts, call-connected to the matches) accrues mass; a lone
    // text match (LensSwitcher.swift, matched "switch" but calls nothing in the
    // flow) gets only its restart probability → ~0, and is dropped by the gate.
    const nodeRwr = this.computeGraphRelevance(
      [...subgraph.nodes.keys()], subgraph.edges, entryNodeIds,
    );
    //
    // Carries `rankPenalty` too, so generated/low-value files are demoted on the
    // sort's PRIMARY key rather than only at the tiebreak. Everything downstream
    // (centrality, the relevance gate, the buried-rescue test, the comparator)
    // reads this map, so the penalty applies once and applies everywhere.
    const fileGraphScore = new Map<string, number>();
    for (const node of subgraph.nodes.values()) {
      fileGraphScore.set(
        node.filePath,
        (fileGraphScore.get(node.filePath) ?? 0) + (nodeRwr.get(node.id) ?? 0),
      );
    }
    for (const [fp, mass] of fileGraphScore) fileGraphScore.set(fp, mass * rankPenalty(fp));
    const maxGraph = Math.max(0, ...fileGraphScore.values());

    // Central file(s): the 1-2 most graph-central files that also match the
    // query textually (so a connected hub-utility with no term match isn't
    // mistaken for the subject). The heart of the answer — they earn the larger
    // WHOLE-FILE ceiling below (a god-file central file still exceeds it and
    // falls to generous full-method sectioning — never a whole dump).
    const centralFiles = new Set(
      [...fileGraphScore.entries()]
        .filter(([fp, g]) => g > 0 && (fileTermHits.get(fp) ?? 0) >= 1)
        .sort((a, b) => b[1] - a[1] || (fileTermHits.get(b[0]) ?? 0) - (fileTermHits.get(a[0]) ?? 0))
        .slice(0, 2)
        .map(([f]) => f),
    );

    // Files that DEFINE a symbol the agent named (or a subgraph root). These are
    // the highest-relevance files there are — the agent asked for them by name —
    // so the connectivity gate below must never drop them, even when their RWR
    // mass is low (a leaf family file like codec.ts is call-connected to little
    // but is exactly what the agent queried). Without this protection the gate
    // prunes a named file and the agent Reads it back.
    const entryFiles = new Set<string>();
    for (const id of entryNodeIds) {
      const n = subgraph.nodes.get(id);
      if (n) entryFiles.add(n.filePath);
    }
    // Buried-rescue pass (#1064): surface a named method's signature type ONLY
    // when its file is genuinely buried — near-zero graph mass AND not lexically
    // matched. That is the invisible case (grpc's `DialOption` → `dialoptions.go`,
    // g≈0, 0 term hits): reachable but ranked nowhere, so the agent greps. A
    // well-connected type file (excalidraw element types, Alamofire `DataRequest`)
    // is NOT buried and is left alone — rescuing it would displace a flow-central
    // file (App.tsx, Validation.swift). Buried is judged on the PRE-rescue graph,
    // so injecting the type below can't make it look connected. A rescued file is
    // injected (so it renders), force-kept (gate + relevantFiles), and tiered.
    const changeSurfaceFiles = new Set<string>();
    for (const t of changeSurfaceCandidates) {
      const fp = t.filePath;
      const buried = (fileGraphScore.get(fp) ?? 0) < maxGraph * 0.06
        && (fileTermHits.get(fp) ?? 0) < 2;
      if (!buried) continue;
      changeSurfaceFiles.add(fp);
      if (!subgraph.nodes.has(t.id)) subgraph.nodes.set(t.id, t);
      let group = fileGroups.get(fp);
      if (!group) { group = { nodes: [], score: 0, peripheral: 0 }; fileGroups.set(fp, group); }
      if (!group.nodes.some((n) => n.id === t.id)) group.nodes.push(t);
      group.score = Math.max(group.score, 45);
      if (!relevantFiles.some(([f]) => f === fp)) relevantFiles.push([fp, group]);
    }

    // Relevance gate (so the generous budget is a CEILING, not a target): keep a
    // file only if it is STRUCTURALLY relevant by ANY of:
    //   - graph score within a fraction of the top (it's on/near the flow), OR
    //   - central (a query entry-point lives here), OR
    //   - it DEFINES a symbol the agent named (entryFiles), OR
    //   - it matches >= 2 DISTINCT named query terms — a strong text signal that
    //     the agent is asking about this file even when nothing calls it (codec.ts:
    //     the agent named `encode`/`Codec`/`JsonCodec`, all leaf classes with zero
    //     RWR mass — graph alone wrongly drops it).
    // A lone text match on one shared word (LensSwitcher: term=1, g~0) is still
    // dropped, so the budget never fills with incidental files. Guarded so it
    // never prunes below 2.
    if (maxGraph > 0) {
      const gated = relevantFiles.filter(([fp]) =>
        pinnedSet.has(fp)
        || (fileGraphScore.get(fp) ?? 0) >= maxGraph * 0.06
        || centralFiles.has(fp)
        || entryFiles.has(fp)
        || changeSurfaceFiles.has(fp)
        || (fileTermHits.get(fp) ?? 0) >= 2,
      );
      if (gated.length >= 2) relevantFiles = gated;
      diag?.setRelevanceGate(maxGraph, maxGraph * 0.06, gated.length >= 2, relevantFiles.length);
    } else {
      diag?.setRelevanceGate(maxGraph, 0, false, relevantFiles.length);
    }

    // Sort files: graph-central first, then distinct-term match, then the
    // existing low-value/generated/score tiebreaks.
    // Files that DEFINE a symbol the agent NAMED. These sort first — ahead of
    // graph connectivity — because the agent asked for them by name. Without
    // this, a named leaf override reached only by dynamic dispatch (Alamofire's
    // `DataRequest.task`/`validate`, low RWR mass) sorts below the high-
    // connectivity abstract base (`Request.swift`) and the same-named overloads
    // in other files (`Validation.swift`), falls outside the budget, and the
    // agent Reads it. The named file is the answer — rank it at the top.
    const namedSeedFiles = new Set<string>();
    for (const id of tierSeedIds) {
      const n = subgraph.nodes.get(id);
      if (n) namedSeedFiles.add(n.filePath);
    }
    // A rescued change-surface file (only the genuinely-buried ones — see the
    // buried-rescue pass) is the lexically-dissimilar answer; give it the named
    // tier so it isn't buried under files that merely share surface words (#1064).
    for (const fp of changeSurfaceFiles) namedSeedFiles.add(fp);

    // Multi-term corroboration tier: a file that is BOTH (a) an entry/central file
    // (a search root, named seed, or graph-central hub — i.e. structurally part of
    // the answer) AND (b) matched by ≥2 DISTINCT query terms must not be buried by
    // graph-centrality mass that accrued to a denser-but-off-topic cluster. In a
    // cross-layer monorepo (an API server alongside a much larger, internally dense
    // frontend that mirrors the same domain words) the Random-Walk-with-Restart mass
    // — seeded from text matches that skew to the bigger layer — floats hits=0
    // frontend files above the hits=2/3 backend service that IS the answer (its many
    // callers don't help: it's call-isolated from the frontend seed cluster). The
    // entry/central GUARD keeps this safe: an INCIDENTAL multi-term file that is
    // neither entry nor central (a type/util file that matches "element"+x but isn't
    // the flow) is NOT promoted, so it can't displace the graph-central answer file
    // (hits=1) the way a blunt hits-only tier would. Single-layer repos with one
    // cluster are unaffected (no competing mass). Set CODEGRAPH_RANK_NO_MULTITERM=1
    // to disable.
    const MULTITERM_OFF = process.env.CODEGRAPH_RANK_NO_MULTITERM === '1';
    const isCorroborated = (fp: string) =>
      !MULTITERM_OFF &&
      (fileTermHits.get(fp) ?? 0) >= 2 &&
      (entryFiles.has(fp) || centralFiles.has(fp));

    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Pinned files first of all — the agent named the FILE by path, which is
      // even more explicit than naming a symbol in it. Among pins, keep the
      // order they appeared in the query.
      const aPin = pinnedSet.has(a[0]) ? 1 : 0;
      const bPin = pinnedSet.has(b[0]) ? 1 : 0;
      if (aPin !== bPin) return bPin - aPin;
      if (aPin && bPin) return (pinnedOrder.get(a[0]) ?? 0) - (pinnedOrder.get(b[0]) ?? 0);

      // Agent-named files next (it asked for a symbol defined here by name).
      const aNamed = namedSeedFiles.has(a[0]) ? 1 : 0;
      const bNamed = namedSeedFiles.has(b[0]) ? 1 : 0;
      if (aNamed !== bNamed) return bNamed - aNamed;

      // Corroborated (entry/central + ≥2 terms) tier, above the graph signal.
      const aCorr = isCorroborated(a[0]) ? 1 : 0;
      const bCorr = isCorroborated(b[0]) ? 1 : 0;
      if (aCorr !== bCorr) return bCorr - aCorr;

      // Graph connectivity is the next key (small epsilon so near-ties fall
      // through to the text signal rather than coin-flipping on float noise).
      const aG = fileGraphScore.get(a[0]) ?? 0;
      const bG = fileGraphScore.get(b[0]) ?? 0;
      if (Math.abs(aG - bG) > maxGraph * 0.01) return bG - aG;

      const aHits = fileTermHits.get(a[0]) ?? 0;
      const bHits = fileTermHits.get(b[0]) ?? 0;
      if (aHits !== bHits) return bHits - aHits;

      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      // Deprioritize generated source (.pb.go / .pulsar.go / _mocks.go / …) —
      // the agent rarely needs to see the protobuf scaffold or gomock output
      // when asking about the actual flow, and dumping their bodies inflates
      // the response (the cosmos Q3 explore otherwise leads with
      // `expected_keepers_mocks.go`, displacing the real `tally.go` content
      // and forcing the agent to Read tally.go anyway). Both this and the
      // low-value key above are now BACKSTOPS: `rankPenalty` has already scaled
      // the score and the graph mass these files reach this comparison with, so
      // a generated file no longer outranks a hand-written one just by scoring
      // higher (#1500). This still settles the exact ties the penalty leaves.
      const aGen = isGeneratedCandidate(a[0]);
      const bGen = isGeneratedCandidate(b[0]);
      if (aGen !== bGen) return aGen ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `**Exploration: ${query}**`,
      '',
      // Curated summary — filled in after the source loop (see below). We do NOT
      // report `subgraph.nodes.size` / `fileGroups.size` here: that's the raw
      // candidate gather, which a broad natural-language query inflates wildly
      // (260 symbols / 124 files on a 636-file repo) even though only a handful
      // render. Reporting the pool read as "260 results to wade through" when the
      // real, correctly-ranked answer is the few files below (#1046).
      '',
      '',
    ];
    const summaryLineIdx = 2;

    // Blast radius (always-on, compact): for the entry symbols, who depends on
    // them + which tests cover them — locations only, no source — so the agent
    // knows what to update/verify before editing without a separate call.
    const blastRadius = this.buildBlastRadiusSection(cg, subgraph);
    if (blastRadius) lines.push(blastRadius);

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('**Relationships**');
      lines.push('');

      // Group edges by kind for readability
      const byKind = new Map<string, Array<{ source: string; target: string }>>();
      for (const edge of significantEdges) {
        const sourceNode = subgraph.nodes.get(edge.source);
        const targetNode = subgraph.nodes.get(edge.target);
        if (!sourceNode || !targetNode) continue;

        const group = byKind.get(edge.kind) || [];
        group.push({ source: sourceNode.name, target: targetNode.name });
        byKind.set(edge.kind, group);
      }

      for (const [kind, edges] of byKind) {
        const cap = budget.maxEdgesPerRelationshipKind;
        const shown = edges.slice(0, cap);
        lines.push(`**${kind}:**`);
        for (const e of shown) {
          lines.push(`- ${e.source} → ${e.target}`);
        }
        if (edges.length > cap) {
          lines.push(`- ... and ${edges.length - cap} more`);
        }
        lines.push('');
      }
    }

    // Step 4: Read contiguous file sections
    // Compute the flow spine once — used both to prepend the Flow section (below)
    // and to gate adaptive source sizing: files on the spine get full source,
    // off-spine peers skeletonize.
    const flow = this.buildFlowFromNamedSymbols(cg, matchQuery);

    // Snapshot every ranked candidate's scoring inputs, in final sort order, so
    // the diagnostic can show what each file's share of the envelope was BOUGHT
    // with (score, graph mass, term hits, flags) — not just what it cost.
    if (diag) {
      const kindMix = (nodes: Node[]): string => {
        const counts = new Map<string, number>();
        for (const n of nodes) counts.set(n.kind, (counts.get(n.kind) ?? 0) + 1);
        return [...counts.entries()]
          .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
          .map(([k, c]) => `${k}:${c}`)
          .join(' ');
      };
      sortedFiles.forEach(([fp, group], i) => {
        diag.noteCandidate(fp, {
          rank: i + 1,
          score: group.score,
          graphScore: fileGraphScore.get(fp) ?? 0,
          termHits: fileTermHits.get(fp) ?? 0,
          nodes: group.nodes.length,
          pinned: pinnedSet.has(fp),
          named: namedSeedFiles.has(fp),
          central: centralFiles.has(fp),
          entry: entryFiles.has(fp),
          spine: group.nodes.some((n) => flow.pathNodeIds.has(n.id)),
          lowValue: isLowValue(fp),
          generated: isGeneratedCandidate(fp),
          ambientDeclaration: isAmbientDeclaration(fp),
          penalty: rankPenalty(fp),
          kinds: kindMix(group.nodes),
        });
      });
    }

    // Score-proportional byte allocation (CG-12). Every file's share of the
    // envelope is reserved HERE, before a single byte renders, so the render loop
    // spends a reservation instead of racing for whatever the files above it left.
    const allocation = allocateExploreBudget(
      sortedFiles.map(([fp, group]) => ({
        path: fp,
        score: group.score,
        // A pinned file's bytes are worth full price by definition — the agent
        // asked for the file itself, generated/test or not.
        worth: pinnedSet.has(fp) ? 1 : rankPenalty(fp),
        spine: group.nodes.some((n) => flow.pathNodeIds.has(n.id)),
        pinned: pinnedSet.has(fp),
      })),
      budget,
      maxFiles,
    );
    diag?.setAllocation(allocation.allowances, allocation.cliffed, allocation.cliffAt, allocation.pool);
    // Cliffed files ship as pointers — path, symbols, line numbers — so the agent
    // can name one in a follow-up explore. Rendered below with the other
    // not-shown files, and force-enabled even on tiers that suppress that list:
    // a file we deliberately withheld source for must still be nameable.
    const cliffedFiles = new Set(allocation.cliffed);

    // Polymorphic-sibling detector for adaptive sizing. A class that implements/
    // extends a supertype shared by >= MIN_SIBLINGS classes is one of many
    // INTERCHANGEABLE implementations (OkHttp's 14 `: Interceptor` classes —
    // showing one + the rest as signatures is enough), as opposed to a DISTINCT
    // pipeline step (Excalidraw's `renderStaticScene`, which shares no supertype and
    // must stay full or the agent loses real content). Only off-spine sibling files
    // skeletonize; distinct steps and on-spine files keep full source. Cache
    // supertype→(has ≥N implementers) so this stays a handful of edge queries.
    const MIN_SIBLINGS = 3;
    const siblingSuper = new Map<string, boolean>();
    const isPolymorphicSibling = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        for (const e of cg.getOutgoingEdges(n.id)) {
          if (e.kind !== 'implements' && e.kind !== 'extends') continue;
          let many = siblingSuper.get(e.target);
          if (many === undefined) {
            many = cg.getIncomingEdges(e.target)
              .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
            siblingSuper.set(e.target, many);
          }
          if (many) return true;
        }
      }
      return false;
    };

    // A file that DEFINES a polymorphic supertype (a class/interface with ≥
    // MIN_SIBLINGS implementers) AND co-locates its subclasses is a redundant
    // "family" file — Django's compiler.py holds `SQLCompiler` + its 4 subclasses
    // (SQLInsert/Update/Delete/AggregateCompiler) in 2,266 lines. Such files are
    // huge and read-anyway, so they should STILL skeletonize even when the agent
    // named a method in them: a full one eats ~6.5K of the explore budget (Django
    // is pinned at the 28K cap, truncating), starving the sibling files the agent
    // then Reads. This flag OVERRIDES the named-callable spare below — it does NOT
    // by itself spare a file. (OkHttp's RealCall implements the `Lockable` mixin
    // but defines no ≥3-impl supertype, so the named spare keeps it full.)
    const superMany = new Map<string, boolean>();
    const definesPolymorphicSupertype = (nodes: Node[]): boolean => {
      for (const n of nodes) {
        if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct' && n.kind !== 'union'
            && n.kind !== 'trait' && n.kind !== 'protocol' && n.kind !== 'type_alias') continue;
        let many = superMany.get(n.id);
        if (many === undefined) {
          many = cg.getIncomingEdges(n.id)
            .filter((x) => x.kind === 'implements' || x.kind === 'extends').length >= MIN_SIBLINGS;
          superMany.set(n.id, many);
        }
        if (many) return true;
      }
      return false;
    };

    lines.push('**Source Code**');
    lines.push('');
    // Recorded so the drift pass below (#1474) can append a per-file exception
    // to this guarantee after the render loop knows which files drifted.
    const verbatimHeaderIdx = lines.length;
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');

    // The response's absolute cap. It MUST stay under the host's inline
    // tool-result limit (~25K chars): above it the result is externalized to a
    // file the agent Reads back (a 35K vscode explore did exactly this in the
    // n=4 A/B).
    const hardCeiling = Math.min(Math.round(budget.maxOutputChars * 1.5), 25000);
    // What the epilogue is OWED — the part of it the loop must not spend (CG-26).
    // Not a flat margin: the old 600 was neither the epilogue's size (1,064 on
    // gin, 2,231 on excalidraw) nor a bound on it, so the loop budgeted for a
    // thing that did not exist and the response then discarded the whole
    // epilogue to fit. The floor is what the epilogue owes the AGENT rather
    // than what it costs us:
    //   - the one-line note that says an uncovered area exists (always), and
    //   - a pointer for every file whose source was deliberately WITHHELD.
    //     A cliffed file's bytes were traded away on the promise that the agent
    //     can still name it in a follow-up call (CG-12); if the ceiling then
    //     eats that name the trade was a silent drop.
    // Everything above the floor — the rest of the pointer list, the reminders
    // — is elastic and fitted to the room that is actually left, at the end of
    // this method. Sized from the REAL strings, never tuned: a constant swept
    // against the suite is what CG-30's record warns about.
    const cliffPointerFloor = [...cliffedFiles]
      .slice(0, POINTER_MAX_FILES)
      .reduce((n, fp) => {
        const g = fileGroups.get(fp);
        return g ? n + pointerLineFor(fp, g.nodes).length + 1 : n;
      }, cliffedFiles.size > 0 ? POINTER_HEADER.length + 2 : 0);
    const epilogueFloor = EPILOGUE_LOST_NOTE.length + 2 + cliffPointerFloor;
    // Absolute stop for the render loop. Reservations already fit the envelope, so
    // this only catches their bounded overshoot (the whole-file grace, an oversize
    // first cluster) — and catches it HERE, where a file can be skipped cleanly and
    // a later one still render, instead of at the final truncation, which lops off
    // whichever section happened to land last.
    const renderCeiling = hardCeiling - epilogueFloor;
    // `flow.text` is PART of the response — it is prepended to `lines` to make
    // the final output — so the render loop has to spend against it, and it
    // never did. Counting it is what makes `renderCeiling` the ceiling it
    // claims to be: without it the loop believed it had room for a trailing
    // section the final truncation then threw away whole, and (CG-31) the
    // displacement guard dutifully held bytes back to pay for that section —
    // taking them off a file the agent DOES receive and handing them to one it
    // never sees.
    let totalChars = flow.text.length + lines.join('\n').length;
    let filesIncluded = 0;
    // Paths we actually render source for below. Drives the curated header count
    // (#1046) — it must reflect what we show, not the raw candidate gather.
    const renderedFilePaths: string[] = [];
    let anyFileTrimmed = false;
    // Files that changed on disk after their last index sync (#1474). Their
    // indexed line ranges are untrustworthy, so sliced renders (adaptive /
    // skeleton / clusters) are OFF for them: a small drifted file still ships
    // whole (current bytes, correct by construction → staleRendered), a big one
    // is omitted with an explicit notice (→ staleOmitted) — honest absence
    // instead of a different symbol's code under the requested name.
    const staleRendered: string[] = [];
    const staleOmitted: string[] = [];
    // Anti-abandonment hold-back (CG-18). The first file dedup suppressed
    // ENTIRELY, kept with its real section so it can be put back if the loop
    // ends with no new source anywhere. A response made only of pointers is the
    // shape that reads as "codegraph has nothing" — and one such response early
    // in a session is enough to make an agent stop calling the tool at all — so
    // the highest-ranked suppressed file is restored rather than risk it. It
    // costs a re-serve of one file, on the one call shape where dedup would
    // otherwise have saved everything: the safe direction.
    type SuppressedFallback = {
      filePath: string;
      /** Index in `lines` where this file's pointer block starts. */
      at: number;
      /** How many `lines` entries the pointer block occupies. */
      replacing: number;
      /** The full, undeduped section to splice back in. */
      section: string[];
      sourceChars: number;
      overhead: number;
      ranges: ExploreLineRange[];
      fingerprint: string;
    };
    let suppressedFallback: SuppressedFallback | null = null;
    // Reservation carry-forward (CG-21). A reservation is a promise the render
    // loop has to KEEP, not a cap it may quietly under-use: a file that cannot
    // spend what it was given — thin matched-symbol set, unreadable, drifted off
    // disk, skipped for the ceiling — must hand the difference DOWN the rank
    // order, not drop it. Tracked as two running totals rather than a `spent`
    // variable threaded through the dozen `continue`s below, so no exit path can
    // forget to account: everything the loop has PROMISED so far, and everything
    // it has actually EMITTED. Their gap is the slack the next file may add to
    // its own reservation.
    //
    // Symmetric on the other side: a whole-file buy that overshoots makes
    // `sourceSpent` outrun `reservedSoFar`, which suppresses slack until a later
    // under-spend covers the debt. So the pool is conserved in both directions,
    // and no file is ever cut BELOW the reservation it was promised.
    let reservedSoFar = 0;
    let sourceSpent = 0;
    // Funding line for the whole-file BUY rule: the response's SOURCE may reach
    // everything the allocator promised plus one bounded overshoot, and no more.
    // Measured against the promise rather than `renderCeiling` on purpose — the
    // ceiling sits 50% above the envelope and says nothing about who is owed
    // what, so funding a buy from it just moves the shortfall to whichever file
    // the loop reaches last. See WHOLE_FILE_BUY_OVERSHOOT_FRACTION.
    const reservedTotal = [...allocation.allowances.values()].reduce((sum, n) => sum + n, 0);
    const sourceCeiling = reservedTotal + Math.round(
      budget.maxOutputChars * EXPLORE_ALLOCATION.WHOLE_FILE_BUY_OVERSHOOT_FRACTION,
    );
    /**
     * What a file's section costs BESIDES its source, in render space: the
     * header (path + up to `maxSymbolsInFileHeader` symbol names) plus the code
     * fence and the blank lines around them (CG-26).
     *
     * `EXPLORE_ALLOCATION.FILE_OVERHEAD` is the ALLOCATOR's constant — the flat
     * 200 it charges each admitted file when it splits the envelope — and using
     * it here too was a category error worth ~250 chars per pending file: the
     * render loop then held back a file's reservation but not the header that
     * reservation has to arrive under, so the last admitted file was left just
     * short of the room it needed and skipped whole. Estimated from the file's
     * own candidate symbols, which is what the header is actually built from.
     */
    const overheadCache = new Map<string, number>();
    const sectionOverhead = (filePath: string, nodes: readonly Node[]): number => {
      const hit = overheadCache.get(filePath);
      if (hit !== undefined) return hit;
      const names = [...new Set(
        nodes.filter((n) => n.kind !== 'import' && n.kind !== 'export')
          .map((n) => `${n.name}(${n.kind})`),
      )].slice(0, budget.maxSymbolsInFileHeader);
      // header + blank, then ```lang / body / ``` / blank around the source.
      const cost = fileSectionHeader(filePath, names.join(', ')).length + 2
        + (nodes[0]?.language?.length ?? 0) + 11;
      overheadCache.set(filePath, cost);
      return cost;
    };
    /**
     * How much of what is still owed BELOW `fileIndex` the response can actually
     * still PAY, in render-space chars (CG-31).
     *
     * Not the same as the sum of those reservations. The allocator splits the
     * envelope; the render loop spends against a ceiling that also has to hold
     * the response's own prose, so on a saturated response the promises are
     * OVER-SUBSCRIBED and the tail is going to be dropped whatever happens
     * above it. Bytes held back for a file that then gets dropped are bytes
     * nobody ever receives — measured on django, holding the full owed sum cost
     * the rank-#1 file 2,126 chars and handed them to a rank-#6 section the
     * hard ceiling threw away. So walk the remaining files in RANK order and
     * hold back only the prefix that fits `budgetLeft`; the first one that does
     * not fit ends it, because everything after it is further out of reach.
     *
     * Conservative and self-correcting: it assumes each file below spends its
     * whole reservation, and when they do not, the carry-forward hands the
     * difference to whoever comes next anyway.
     */
    const owedPayableBelow = (fileIndex: number, budgetLeft: number): number => {
      let held = 0;
      for (let j = fileIndex + 1; j < sortedFiles.length; j++) {
        const path = sortedFiles[j]![0];
        const r = allocation.allowances.get(path);
        if (r === undefined) continue;
        const overhead = sectionOverhead(path, sortedFiles[j]![1].nodes);
        const need = r + overhead;
        if (held + need > budgetLeft) {
          // PART of a reservation is still a delivered file (CG-26). Holding
          // all-or-nothing zeroed the last admitted file whenever its full
          // reservation no longer fit: on the precise-query fixture the rank-5
          // file took 4,134 chars against a 2,948 reservation while rank 6 —
          // admitted, reserved 2,539 — was left 4 chars and skipped. Hold the
          // remainder instead, but only while it is still worth a section:
          // under MIN_CHARS a slice cannot hold one complete method, and a
          // fragment forces the Read this tool exists to prevent.
          const partial = budgetLeft - held;
          if (partial >= EXPLORE_ALLOCATION.MIN_CHARS + overhead) held += partial;
          break;
        }
        held += need;
      }
      return held;
    };

    for (let fileIndex = 0; fileIndex < sortedFiles.length; fileIndex++) {
      const [filePath, group] = sortedFiles[fileIndex]!;
      if (filesIncluded >= maxFiles) {
        if (diag) for (const [fp] of sortedFiles) diag.recordSkip(fp, 'max-files');
        break;
      }
      // Below the relevance cliff: no source, no `maxFiles` slot. It is still
      // named — with its matched symbols and their line numbers — in the
      // not-shown list, so one follow-up explore fetches it in full.
      if (cliffedFiles.has(filePath)) {
        diag?.recordSkip(filePath, 'cliff');
        continue;
      }
      // This file's reserved share of the envelope. Every render path below is
      // bounded by it instead of by the flat per-file cap, which is what stops
      // allocation from following file size: a small weakly-relevant file no
      // longer ships whole while the strongly-relevant one is clipped.
      const reserved = allocation.allowances.get(filePath);
      if (reserved === undefined) {
        diag?.recordSkip(filePath, 'max-files');
        continue;
      }
      // What this file may actually spend: its own reservation PLUS whatever the
      // files above it left on the table. Every render bound below reads this,
      // never `reserved` — that is what makes the carry-forward reach the render
      // paths instead of being bookkeeping. Slack flows to the next file in RANK
      // order because that is the only file a single-pass loop can still pay;
      // `MAX_SHARE` keeps that from turning a weak tail file into the response,
      // so the allocator's share ceiling holds end-to-end and not just at
      // reservation time.
      const allowance = Math.min(
        reserved + Math.max(0, reservedSoFar - sourceSpent),
        Math.max(reserved, Math.round(budget.maxOutputChars * EXPLORE_ALLOCATION.MAX_SHARE)),
      );
      reservedSoFar += reserved;
      diag?.recordSpendable(filePath, allowance);
      // DISPLACEMENT GUARD, in render space (CG-31). `allowance` says what this
      // file MAY spend; it does not say the bytes are still there to spend. The
      // hard ceiling is shared with every file the loop has not reached yet, and
      // their reservations are promises the allocator already made — so what is
      // left before the ceiling is not all ours. Holding that back is the same
      // inequality the whole-file BUY arm enforces with `owedBelow` (see below),
      // moved into the units the cluster path actually spends in: source PLUS
      // the per-section overhead each pending file will charge.
      //
      // Held back only where it can be PAID — see `owedPayableBelow`. A promise
      // the ceiling cannot reach is not a claim on this file's bytes; honouring
      // it anyway just moves source from a file the agent gets to one it does
      // not.
      //
      // Floored at this file's OWN reservation, never below: a kept promise is
      // not a displacement, and cutting a file under what it earned is the
      // failure this whole allocation layer exists to prevent.
      //
      // Slack still reaches the file: a file above that under-spends leaves
      // `totalChars` lower, which raises `headroom` one-for-one, so the
      // carry-forward the `allowance` line grants is exactly the carry-forward
      // this bound funds.
      const headroom = Math.max(0, renderCeiling - totalChars - sectionOverhead(filePath, group.nodes));
      const fundedHeadroom = Math.max(
        Math.min(reserved, headroom),
        headroom - owedPayableBelow(fileIndex, Math.max(0, headroom - reserved)),
      );
      diag?.recordFunded(filePath, fundedHeadroom);
      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) {
        diag?.recordSkip(filePath, 'unreadable');
        continue;
      }

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        diag?.recordSkip(filePath, 'unreadable');
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';
      const withLineNumbers = exploreLineNumbersEnabled();
      // Language-neutral separator between two non-contiguous slices of one file
      // (no `//` — not a comment in Python, Ruby, etc.). With line numbers on,
      // the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

      // Cross-call dedup (CG-18). `served` is what THIS session already sent the
      // agent for THIS file, and it is empty unless the file still hashes to the
      // bytes those spans were sliced from — an edit between calls means the
      // agent's copy is wrong, so nothing is withheld. Every render path below
      // routes its spans through `dedupeSpans`, which is the only place a span
      // is ever dropped.
      const fingerprint = fileFingerprint(fileContent);
      const served = dedupEnabled ? servedRangesForFile(priorCalls, filePath, fingerprint) : [];
      /** Render one line span exactly as the render paths do. */
      const renderSpan = (r: ExploreLineRange): string => {
        const slice = fileLines.slice(r.start - 1, r.end).join('\n');
        return withLineNumbers ? numberSourceLines(slice, r.start) : slice;
      };
      /**
       * Apply the session history to a set of spans-with-text. A span the agent
       * already holds is dropped and reported in `covered`; a partially-held one
       * is re-rendered down to its new lines. Text is rebuilt from the surviving
       * spans rather than sliced out of the original string — the spans ARE the
       * contract with the session record, so rebuilding from them is what keeps
       * what we claim to have sent and what we sent the same thing.
       */
      const dedupeSpans = (
        parts: ReadonlyArray<{ range: ExploreLineRange; text: string }>,
      ): { parts: Array<{ range: ExploreLineRange; text: string }>; covered: ExploreLineRange[] } => {
        if (served.length === 0) return { parts: [...parts], covered: [] };
        const kept: Array<{ range: ExploreLineRange; text: string }> = [];
        const covered: ExploreLineRange[] = [];
        for (const part of parts) {
          const split = dedupeRange(part.range, served);
          if (split.covered.length === 0) {
            kept.push(part);
            continue;
          }
          covered.push(...split.covered);
          for (const r of split.emit) kept.push({ range: r, text: renderSpan(r) });
        }
        return { parts: kept, covered: mergeRanges(covered) };
      };
      const coveredChars = (spans: ReadonlyArray<ExploreLineRange>): number =>
        spans.reduce((sum, r) => sum + fileLines.slice(r.start - 1, r.end).join('\n').length, 0);
      /**
       * Emit one file's section — header, the back-reference for whatever the
       * agent already holds, and the fence for what is new. Every render path
       * ends here so that the dedup bookkeeping (freed bytes, freed `maxFiles`
       * slot, the session record, the diagnostic) is written in exactly one
       * place and no path can forget a piece of it.
       *
       * A fully-held file emits its header and pointer and NO fence, and
       * deliberately does not consume a `maxFiles` slot: that is half of where
       * the reclaimed budget goes (the other half is `sourceSpent`, which the
       * carry-forward pool hands down the rank order). Both send bytes to files
       * the agent has NOT seen, which is the whole point.
       */
      const emitFileSection = (opts: {
        header: string;
        /** Deduped source. Empty ⇒ the agent already holds all of it. */
        body: string;
        /** Spans `body` covers. */
        ranges: ExploreLineRange[];
        /** Spans replaced by the back-reference. */
        covered: ExploreLineRange[];
        /**
         * Chars charged on top of the body by the ANTI-ABANDONMENT RESTORE path
         * only (it re-splices a section after the loop and needs one number for
         * it). The loop itself charges the real cost — see `sectionCost`.
         */
        overhead: number;
        mode: 'whole' | 'clusters' | 'focused' | 'skeleton';
        clipped: boolean;
        /** The undeduped render, kept for the no-new-source fallback. */
        fullBody: string;
        fullRanges: ExploreLineRange[];
      }): void => {
        // A remainder too small to be worth a fence is folded into the pointer
        // (see MIN_DELTA_CHARS). Its ranges are then NOT recorded — the record
        // must only ever claim source that was actually sent.
        const folded = opts.covered.length > 0 && opts.body.length < EXPLORE_DEDUP.MIN_DELTA_CHARS;
        const body = folded ? '' : opts.body;
        const ranges = folded ? [] : opts.ranges;
        const at = lines.length;
        lines.push(opts.header, '');
        // Charge what the section ACTUALLY costs, not a flat 200 (CG-26). A
        // header carries the path plus up to `maxSymbolsInFileHeader` symbol
        // names and routinely runs 300–500 chars, so the flat charge made the
        // loop believe it had room it did not have: okhttp rendered 26,601
        // chars against a 24,400 ceiling and the final truncation threw a
        // fully-rendered section away. Everything downstream is expressed in
        // these units — `headroom`, `fundedHeadroom`, every fit test — so an
        // under-count is not a rounding error, it funds a promise out of bytes
        // that do not exist and starves whoever the loop reaches last.
        totalChars += opts.header.length + 2;
        if (opts.covered.length > 0) {
          const pointer = formatBackReference(
            filePath,
            opts.covered,
            symbolsInSpans(group.nodes, opts.covered),
            { partial: body.length > 0 },
          );
          lines.push(pointer, '');
          totalChars += pointer.length + 2;
          backReferencedFiles.push(filePath);
        }
        if (body.length > 0) {
          lines.push('```' + lang, body, '```', '');
          // ```lang \n body \n ``` \n '' \n — exact, same as the header above.
          totalChars += body.length + lang.length + 11;
          sourceSpent += body.length;
          newSourceChars += body.length;
          diag?.recordRender(filePath, opts.mode, body.length, opts.clipped || opts.covered.length > 0);
          if (opts.covered.length > 0) diag?.recordDedup(filePath, coveredChars(opts.covered), opts.covered);
          noteEmitted(filePath, [...ranges, ...opts.covered], body.length, fingerprint);
          renderedFilePaths.push(filePath);
          filesIncluded++;
          return;
        }
        // Fully held. The section is the pointer; the slot and the bytes go to a
        // file the agent has not seen. The spans are still recorded (at zero
        // bytes) because the record means "source the agent HAS", not "bytes
        // this call spent" — refreshing them keeps a long session from ageing
        // them out of the retained window and re-serving them for nothing.
        // (The header is already charged above; a fully-held section is the
        // header plus the pointer and nothing else.)
        diag?.recordRender(filePath, 'backref', 0, false);
        diag?.recordDedup(filePath, coveredChars(opts.covered), opts.covered);
        noteEmitted(filePath, opts.covered, 0, fingerprint);
        renderedFilePaths.push(filePath);
        if (!suppressedFallback && opts.fullBody.length > 0) {
          suppressedFallback = {
            filePath,
            at,
            replacing: lines.length - at,
            section: [opts.header, '', '```' + lang, opts.fullBody, '```', ''],
            sourceChars: opts.fullBody.length,
            overhead: opts.overhead,
            ranges: opts.fullRanges,
            fingerprint,
          };
        }
      };

      // Disk-drift gate (#1474): every render branch below except whole-file
      // slices fileContent (CURRENT bytes) at INDEXED line ranges. Content is
      // already in hand, so the check costs one stat (hash only on mismatch).
      const fileStale = this.isFileStaleOnDisk(cg, filePath, fileContent);

      // Adaptive sizing (CODEGRAPH_ADAPTIVE_EXPLORE, default on): collapse a file
      // to a per-symbol view when it's a redundant member of a polymorphic family.
      // Engages iff ALL hold:
      //   1. a flow spine exists,
      //   2. no symbol in the file is on that spine (it's not the mechanism path),
      //   3. it IS a polymorphic sibling (≥ MIN_SIBLINGS impls of a shared supertype),
      //   4. it is NOT SPARED, where a file is spared iff the agent named a
      //      (near-)UNIQUE callable in it (`getResponseWithInterceptorChain`, 1 def →
      //      keep RealCall.kt full) UNLESS the file DEFINES the family supertype (a
      //      base+subclasses "family" file like Django's compiler.py — collapse it).
      //      Uniqueness matters: `as_sql` has 110 defs across every Compiler/Expression
      //      subclass; naming it must NOT keep every backend variant + test file full
      //      and flood the budget. That's why the spare reads uniqueNamedNodeIds.
      // Within a collapsed file the render is PER-SYMBOL (condition B): a method the
      // agent NAMED or that's on the spine is shown with its FULL body (so the agent
      // doesn't Read the file back for it — Django's SQLCompiler.execute_sql/as_sql);
      // every other symbol is just its signature. So the base mechanism survives while
      // the file's other ~80 symbols + the redundant subclasses collapse to one line each.
      const spareNamed = group.nodes.some(n => flow.uniqueNamedNodeIds.has(n.id));
      const fileDefinesSuper = definesPolymorphicSupertype(group.nodes);
      const spared = spareNamed && !fileDefinesSuper;
      const CALLABLE_BODY = new Set(['method', 'function', 'constructor', 'component']);
      const hasSpineNode = group.nodes.some(n => flow.pathNodeIds.has(n.id));
      // On-spine god-file: the flow path runs THROUGH this file, but it also holds
      // many OTHER named methods, and rendering all of them in full blows the
      // per-file budget and starves the other flow files (Alamofire: the agent
      // names ~7 Session.swift methods — the build spine PLUS off-path
      // task/didCompleteTask — far past the whole response budget). Engage the
      // per-symbol view to keep the SPINE full and collapse the off-path named
      // methods to signatures. Only when there IS off-path content to shed —
      // otherwise the spine is irreducible (a sequential flow has no redundancy),
      // so leave it to the normal full render.
      const namedBodyChars = group.nodes
        .filter(n => CALLABLE_BODY.has(n.kind) && (flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id)))
        .reduce((s, n) => s + fileLines.slice(n.startLine - 1, n.endLine).join('\n').length, 0);
      const onSpineGodFile = hasSpineNode
        && namedBodyChars > allowance
        && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
      if (!fileStale && adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
          && (onSpineGodFile || (!hasSpineNode && isPolymorphicSibling(group.nodes) && !spared))) {
        const syms = group.nodes
          .filter(n => n.kind !== 'import' && n.kind !== 'export' && n.startLine > 0)
          .sort((a, b) => a.startLine - b.startLine);
        // Pass 1: choose which symbols get a FULL body, by priority, greedily within
        // a per-file body cap — so one huge family file can't body every named method
        // and crowd out the other flow files (Django's query.py). A symbol earns a
        // body if it's on-spine, or UNIQUELY named (`SQLCompiler.execute_sql`), or a
        // co-named method WHEN this file DEFINES the family supertype (so the base
        // `SQLCompiler.as_sql` body shows, but the 110 leaf `as_sql` overrides — and
        // OkHttp's 5 `intercept`s if the agent names `intercept` — stay signatures).
        const prio = (n: Node) => !CALLABLE_BODY.has(n.kind) ? 99
          : flow.pathNodeIds.has(n.id) ? 0
          : flow.uniqueNamedNodeIds.has(n.id) ? 1
          : (fileDefinesSuper && flow.namedNodeIds.has(n.id)) ? 2 : 99;
        // One WINDOW per file, sized by this file's RESERVATION. syms are taken by
        // priority (spine first, then uniquely-named, then family-base), and the cap
        // applies to ALL of them — including the spine — so a big-spine god-file
        // (tokio's worker.rs: run→run_task→next_task→steal_work) can't eat the whole
        // response and starve the co-flow file (harness.rs's poll). The native agent
        // windows such a file too (~190 lines at a time), so this mimics, not
        // truncates. Always emit ≥1 (never an empty section).
        //
        // Held to `fundedHeadroom` as well (CG-31) so this path cannot spend a
        // reservation still owed below it either. It never exceeds `allowance`
        // today, so the bound only bites once the ceiling is genuinely tight —
        // but "every render path" has to mean every one, or the guard is just a
        // detour the next god-file takes.
        const bodyCap = Math.min(allowance, fundedHeadroom);
        const bodyIds = new Set<string>();
        let bodyChars = 0;
        for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
          const sz = fileLines.slice(n.startLine - 1, n.endLine).join('\n').length;
          if (bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
          bodyIds.add(n.id);
          bodyChars += sz;
        }
        // Pass 2: render in line order — full body for chosen symbols, else the
        // signature line (capped, with a "+N more" tail so the structure map of a
        // god-file doesn't itself bloat the budget).
        const skel: Array<{ range: ExploreLineRange; text: string }> = [];
        let coveredUntil = 0; // skip symbols already inside an emitted body
        let sigCount = 0, sigDropped = 0;
        const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
        for (const n of syms) {
          if (n.startLine <= coveredUntil) continue;
          if (bodyIds.has(n.id)) {
            const end = n.endLine;
            const body = fileLines.slice(n.startLine - 1, end).join('\n');
            skel.push({
              range: { start: n.startLine, end },
              text: withLineNumbers ? numberSourceLines(body, n.startLine) : body,
            });
            coveredUntil = end;
          } else {
            // Elide the body, emit the signature. node.startLine can point at a
            // decorator/annotation, so scan forward for the line that names the symbol.
            let lineNo = n.startLine;
            for (let k = 0; k < 4; k++) {
              if ((fileLines[n.startLine - 1 + k] || '').includes(n.name)) { lineNo = n.startLine + k; break; }
            }
            if (lineNo <= coveredUntil) continue;
            if (sigCount >= SIG_MAX) { sigDropped++; continue; }
            const sig = (fileLines[lineNo - 1] || '').trim();
            if (sig) {
              skel.push({
                range: { start: lineNo, end: lineNo },
                text: withLineNumbers ? `${lineNo}\t${sig}` : sig,
              });
              sigCount++;
            }
          }
        }
        const sigTail = sigDropped > 0 ? `… +${sigDropped} more (signatures elided)` : '';
        if (skel.length > 0) {
          const names = [...new Set(group.nodes.filter(n => n.kind !== 'import' && n.kind !== 'export').map(n => n.name))]
            .slice(0, budget.maxSymbolsInFileHeader).join(', ');
          // Steer the agent to codegraph_explore for an elided body — NEVER to
          // Read. The old "Read for more" / "Read for a full body" tags invited
          // a Read of the very file just skeletonized; on a central, wanted file
          // (Session.swift, DataRequest.swift) that fired an over-investigation
          // spiral (the agent Read the skeletonized file, then kept digging).
          // CLAUDE.md: explore output must never tell the agent to Read.
          const tag = bodyIds.size > 0
            ? 'focused (the methods you named in full, the rest as signatures — codegraph_explore a signature by name for its body; do NOT Read)'
            : 'skeleton (signatures only — codegraph_explore a name for its full body; do NOT Read)';
          // Dedup runs on the per-symbol parts, so a body the agent already has
          // becomes a pointer while the signature map around it survives intact
          // (a one-line signature is far under MIN_COVERED_LINES and is never
          // withheld — the structure map is what makes this render legible).
          const dd = dedupeSpans(skel);
          const withTail = (parts: ReadonlyArray<{ text: string }>) =>
            [...parts.map((p) => p.text), ...(sigTail ? [sigTail] : [])].join('\n');
          emitFileSection({
            header: fileSectionHeader(filePath, `${names} · ${tag}`),
            body: dd.parts.length > 0 ? withTail(dd.parts) : '',
            ranges: dd.parts.map((p) => p.range),
            covered: dd.covered,
            overhead: 120,
            mode: bodyIds.size > 0 ? 'focused' : 'skeleton',
            // Always "clipped": the per-symbol view elides bodies by construction.
            clipped: true,
            fullBody: withTail(skel),
            fullRanges: skel.map((p) => p.range),
          });
          continue;
        }
      }

      // Whole-file rule: if a relevant file is small enough to afford, return it
      // ENTIRELY instead of clustering. Clustering exists to tame god-files
      // (App.tsx ~13k lines); on a ~134-line component a cluster is a lossy
      // subset of a file the agent will just Read in full anyway — costing a
      // round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      //
      // CENTRAL files (where the query's entry points live) get a larger — but
      // bounded — ceiling: they're the heart of the answer, the file(s) the agent
      // would Read whole, so a genuinely small one comes back whole rather than as
      // thin clusters. A LARGE central file (the 791-line org-user store) exceeds
      // the ceiling and falls through to sectioning/clustering below — full method
      // bodies + signatures — so we never dump (or overflow on) a whole god-file.
      const isCentralFile = centralFiles.has(filePath);
      // A file ships whole when it fits its RESERVATION (plus a small grace — see
      // WHOLE_FILE_GRACE). This is the site of the #1500 allocation bug: the
      // peripheral bound used to be a flat `maxCharsPerFile * 3`, so ANY file under
      // ~11K shipped its entire contents regardless of relevance, while a
      // high-scoring file too big for that window was clipped to `maxCharsPerFile`
      // — a 3x swing decided by file size alone. Tying both bounds to the
      // reservation removes the swing without touching the rule's purpose (a small
      // file sliced is a lossy subset the agent just Reads in full anyway).
      const WHOLE_FILE_MAX_LINES = isCentralFile ? 280 : 220;
      // Two bounds, whichever is larger (CG-21):
      //   GRACE — the reservation plus a sliver, for a file that essentially fits;
      //   BUY   — the reservation already covers most of the file, so the rest is
      //           cheaper to ship than to lose. A file between the two used to
      //           fall through to clustering and then spend a FRACTION of its
      //           reservation, and the remainder was neither delivered nor
      //           redistributed. See WHOLE_FILE_BUY_FRACTION.
      //
      // The BUY arm is two independent tests, and keeping them apart is the whole
      // design. MERIT reads `reserved` — did THIS file's own relevance earn most
      // of itself? — so borrowed slack can never promote a weak file to whole.
      // FUNDING reads the shared overshoot pool, so the bytes exist to pay for it.
      // Slack still reaches the file through `allowance`: it raises the GRACE arm
      // and shrinks what a buy has to borrow.
      const graceBound = allowance + Math.min(
        EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_MAX,
        Math.round(allowance * EXPLORE_ALLOCATION.WHOLE_FILE_GRACE_FRACTION),
      );
      // FUNDING, as one inequality: after this file ships whole, does the source
      // still fit the promise-plus-overshoot line WITH every reservation below
      // it left payable? `owedBelow` is what makes it a displacement guard
      // rather than a size cap — a buy that fits the line only by spending a
      // lower-ranked file's reservation is the trade that dropped
      // `payslip_builder.go`, and it is refused here. Self-limiting: each buy
      // grows `sourceSpent`, so the pool cannot be spent twice. The cluster path
      // below enforces the same inequality in render space — see
      // `fundedHeadroom` / `owedPayableBelow` (CG-31).
      const owedBelow = Math.max(0, reservedTotal - reservedSoFar);
      // Third condition on the BUY arm only: it must also FIT. A whole render
      // that overruns the ceiling is skipped ENTIRELY (the branch refuses to
      // slice a file mid-method), so attempting a buy that cannot fit trades a
      // clustered section for NO section — the same trade the funding pool
      // exists to refuse, arriving by a different route. Failing the test here
      // instead drops through to the cluster path, which is bounded by
      // `fundedHeadroom` and always renders something.
      //
      // Measured against `fundedHeadroom`, not against `renderCeiling - totalChars`
      // (CG-26). The two differ by exactly the displacement term: room before
      // the ceiling belongs to every file the loop has not reached yet, and
      // this arm used to read the raw room while its source-space sibling
      // (`owedBelow`, above) refused the same trade. Source-space alone was not
      // enough — the funding line is `reservedTotal + 0.15 * envelope` (~27.2K
      // when a medium repo saturates) while the render ceiling is ~24.2K, so a
      // buy can clear `sourceCeiling` and still take its bytes out of a
      // lower-ranked file's reservation on the way to the ceiling. Now both
      // arms enforce the same inequality in their own units, and the invariant
      // holds on every path.
      //
      // The GRACE arm keeps its own bound (a file within a sliver of its
      // reservation) but is fit-tested on the render it actually produces, at
      // the emission site below, so it cannot displace either.
      const buysWhole = fileContent.length <= graceBound
        || (reserved >= fileContent.length * EXPLORE_ALLOCATION.WHOLE_FILE_BUY_FRACTION
            && sourceSpent + fileContent.length + owedBelow <= sourceCeiling
            && fileContent.length <= fundedHeadroom);
      // Set by the whole-file arm when it actually emits. A whole render that
      // does not FIT no longer ends the file's turn (CG-26) — it falls through
      // to the cluster path below, which is bounded by `fundedHeadroom` and
      // renders something. Skipping outright was the trade the funding pool
      // exists to refuse: a clustered section traded for no section at all.
      let renderedWhole = false;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && buysWhole) {
        const body = fileContent.replace(/\n+$/, '');
        const wholeRange: ExploreLineRange = { start: 1, end: body.split('\n').length };
        const fullSection = withLineNumbers ? numberSourceLines(body, 1) : body;
        // The buy decision above was made on the file's FULL size on purpose: it
        // asks "did this file's relevance earn all of itself", which dedup does
        // not change. Dedup then only ever makes the render smaller, so a buy
        // that was funded stays funded.
        const ddWhole = dedupeSpans([{ range: wholeRange, text: fullSection }]);
        const wholeSection = ddWhole.parts.map((p) => p.text).join(GAP_MARKER);
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        // A drifted file rendered WHOLE is still correct (current bytes,
        // numbered from 1) — only the index-derived symbol list / line refs to
        // it elsewhere in this response may be shifted (#1474). Flag that.
        const staleSuffix = fileStale ? ' · ⚠ changed since last index sync — source below is current; the symbol list may be outdated' : '';
        const wholeHeader = fileSectionHeader(filePath, (omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')) + staleSuffix);

        // The fit test, on the bytes this render ACTUALLY costs (the numbered
        // body, after dedup) rather than on the raw file — and against
        // `fundedHeadroom`, so a whole render can no more spend a pending
        // file's reservation than a clustered one can (CG-26). Both whole-file
        // arms come through here, which is what closes the invariant on the
        // GRACE path: grace is measured against this file's own allowance and
        // says nothing about whether the bytes are still there to spend.
        // Two tests, and they are different questions. `fundedHeadroom` is the
        // DISPLACEMENT bound — may these bytes be spent without taking a
        // pending file's reservation. `sectionCost` is the CEILING bound — do
        // the header, fences and body actually fit what is left. The second one
        // is exact now that the loop charges real section costs.
        const wholeCost = wholeHeader.length + 2 + wholeSection.length + lang.length + 11;
        if (wholeSection.length <= fundedHeadroom && totalChars + wholeCost <= renderCeiling) {
          emitFileSection({
            header: wholeHeader,
            body: wholeSection,
            // The whole file, minus any trailing blank lines the render trimmed.
            ranges: ddWhole.parts.map((p) => p.range),
            covered: ddWhole.covered,
            overhead: 200,
            mode: 'whole',
            clipped: false,
            fullBody: fullSection,
            fullRanges: [wholeRange],
          });
          if (fileStale) staleRendered.push(filePath);
          renderedWhole = true;
        } else {
          // Doesn't fit whole — don't slice a whole file mid-method here; fall
          // through and let the cluster path pick body-shaped pieces of it.
          anyFileTrimmed = true;
        }
      }
      if (renderedWhole) continue;

      // Drifted file too big for the whole-file window (#1474): the cluster /
      // skeleton renders below would slice current bytes at indexed ranges —
      // on a shifted file that serves a DIFFERENT symbol's code under the
      // requested name. Omit the source with an explicit notice instead;
      // never render a possibly-wrong slice.
      if (fileStale) {
        staleOmitted.push(filePath);
        const staleHeader = fileSectionHeader(filePath, '⚠ changed on disk after the last index sync — source omitted (indexed line ranges no longer match, so a slice could show the wrong code). Read this file directly for current content; the change is picked up on that project\'s next index sync.');
        lines.push(staleHeader, '');
        totalChars += staleHeader.length + 2;
        diag?.recordRender(filePath, 'stale-omitted', 0, true);
        continue;
      }

      // Cluster nearby symbols to avoid reading huge gaps between distant symbols.
      // Sort by start line, then merge overlapping/adjacent ranges (within the
      // adaptive gap threshold). Include both node ranges AND edge source
      // locations so template sections with component usages/calls are
      // covered (not just script block symbols).
      //
      // Each range carries an `importance` score so we can rank clusters
      // when the per-file budget forces us to drop some: entry-point nodes
      // are worth 10, directly-connected nodes 3, peripheral nodes 1, and
      // bare edge-source lines 2 (less than a connected node but more than
      // a peripheral one — they hint at a reference but aren't a definition).
      // Container kinds whose body can span most/all of a file. When such a
      // node covers most of the file we drop it from the ranges: keeping it
      // would merge every method inside it into one giant cluster spanning
      // the whole file, which then tail-trims down to just the container's
      // opening lines (its header/declarations) and buries the methods the
      // query actually asked about (#185 follow-up — Session.swift in
      // Alamofire is the canonical case: the `Session` class spans ~1,400
      // lines). We want the granular symbols inside, not the envelope.
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'union', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
      // Cluster from this file's gathered nodes PLUS any callable the agent NAMED that
      // lives here. Explore's relevance gather can miss a named method def in a huge
      // non-sibling file — Django's query.py is 3,040 lines and `_fetch_all` (L2237)
      // was gathered only as call-reference edges, never as a def, so it formed no
      // cluster and the agent Read it back. Inject named defs directly and rank them
      // ABOVE connected/glue nodes (importance 9) so their cluster wins the per-file
      // budget — the agent explicitly asked for these symbols.
      const rangeNodes = new Map<string, Node>();
      for (const n of group.nodes) if (n.startLine > 0 && n.endLine > 0) rangeNodes.set(n.id, n);
      for (const id of flow.namedNodeIds) {
        if (rangeNodes.has(id)) continue;
        const n = cg.getNode(id);
        if (n && n.filePath === filePath && n.startLine > 0 && n.endLine > 0) rangeNodes.set(id, n);
      }
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number; spine: boolean; spineCallLine?: number }> = [...rangeNodes.values()]
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (flow.namedNodeIds.has(n.id)) importance = 9; // agent named it → keep its cluster
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          // On the rendered call-path spine? That IS the flow answer — its cluster
          // must never be dropped by the per-file budget (n8n's huge workflow-execute.ts:
          // processRunExecutionData, the named flow ENTRY at L1562, is a large
          // low-density method that lost the budget to denser blocks and got cut, so
          // the agent Read it back — the very thing explore exists to prevent).
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance, spine: flow.pathNodeIds.has(n.id), spineCallLine: flow.spineCallSites.get(n.id) };
        });

      // Add edge source locations in this file — captures template references
      // (component usages, event handlers) that aren't nodes themselves.
      // Query edges directly from the DB (not just the subgraph) because BFS
      // traversal may have pruned template reference targets due to node budget.
      const edgeLines = new Set<string>(); // dedup by "line:name"
      for (const node of group.nodes) {
        const outgoing = cg.getOutgoingEdges(node.id);
        for (const edge of outgoing) {
          if (!edge.line || edge.line <= 0 || edge.kind === 'contains') continue;
          const key = `${edge.line}:${edge.target}`;
          if (edgeLines.has(key)) continue;
          edgeLines.add(key);
          // Look up target name from subgraph first, fall back to edge kind
          const targetNode = subgraph.nodes.get(edge.target);
          const targetName = targetNode?.name ?? edge.kind;
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2, spine: false });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) {
        diag?.recordSkip(filePath, 'no-ranges');
        continue;
      }

      const gapThreshold = budget.gapThreshold;
      type ExploreRange = typeof ranges[number];
      type ExploreCluster = {
        start: number; end: number; symbols: string[]; score: number;
        maxImportance: number; hasSpine: boolean; spineCallLine?: number;
        /** The whole symbol ranges this cluster merged — the unit an oversize
         *  cluster is shrunk by, so shrinking never cuts through a body. */
        members: ExploreRange[];
      };
      const clusters: ExploreCluster[] = [];
      let current: ExploreCluster = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
        hasSpine: ranges[0]!.spine,
        spineCallLine: ranges[0]!.spineCallLine,
        members: [ranges[0]!],
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
          current.hasSpine = current.hasSpine || r.spine;
          current.spineCallLine = current.spineCallLine ?? r.spineCallLine;
          current.members.push(r);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
            hasSpine: r.spine,
            spineCallLine: r.spineCallLine,
            members: [r],
          };
        }
      }
      clusters.push(current);

      // Build file section output from clusters, capped by per-file budget.
      // The pathological case (#185): a file like Session.swift where every
      // method is adjacent collapses into one cluster spanning the whole
      // file, and dumping that into the agent's context is most of the
      // token cost on small projects. We pick clusters in priority order
      // until the per-file char cap is hit. Truly enormous single clusters
      // get tail-trimmed with a marker.
      const contextPadding = 3;
      // An oversize spine method (the call path runs THROUGH a god-method — n8n's
      // processRunExecutionData is 962 lines) is windowed to its next-hop CALL site
      // plus the signature head, NOT dumped whole. Without this the cluster is too big
      // for any per-file cap and gets dropped, so the agent Reads the method back —
      // the exact gap this closes. Bounded, so a god-method can't blow the budget yet
      // the spine's call still appears in context.
      const OVERSIZE_SPINE_LINES = 200;
      const SPINE_WINDOW = 28; // lines each side of the next-hop call site
      // Returns the rendered text as SPAN-KEYED PARTS. Every part carries the
      // exact line range its text was sliced from, which two things depend on:
      // the session record (CG-17) — a record claiming lines it never sent would
      // withhold them from a later call, costing a Read — and cross-call dedup
      // (CG-18), which rebuilds a part's text from a narrower span when the
      // agent already holds the rest. Both read the spans from the function that
      // does the slicing; a second function mirroring these window/padding rules
      // would drift.
      type SectionPart = { range: ExploreLineRange; text: string };
      const sectionText = (parts: ReadonlyArray<SectionPart>): string =>
        parts.map((p) => p.text).join(GAP_MARKER);
      const buildSection = (
        c: { start: number; end: number; hasSpine?: boolean; spineCallLine?: number },
      ): SectionPart[] => {
        if (c.hasSpine && c.spineCallLine && (c.end - c.start + 1) > OVERSIZE_SPINE_LINES) {
          const call = c.spineCallLine;
          const winStart = Math.max(c.start, call - SPINE_WINDOW);
          const winEnd = Math.min(c.end, call + SPINE_WINDOW);
          const parts: SectionPart[] = [];
          // Signature head, only when it sits clearly above the window (else the
          // window already covers the method opening).
          const headEnd = Math.min(c.start + 4, winStart - 2);
          if (headEnd >= c.start) {
            const head = fileLines.slice(c.start - 1, headEnd).join('\n');
            parts.push({
              range: { start: c.start, end: headEnd },
              text: withLineNumbers ? numberSourceLines(head, c.start) : head,
            });
          }
          const win = fileLines.slice(winStart - 1, winEnd).join('\n');
          parts.push({
            range: { start: winStart, end: winEnd },
            text: withLineNumbers ? numberSourceLines(win, winStart) : win,
          });
          return parts;
        }
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return [{
          range: { start: startIdx + 1, end: endIdx },
          text: withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice,
        }];
      };

      /**
       * Shrink an oversize cluster to the highest-importance symbols inside it
       * that fit `cap`, rendered in source order with gap markers (CG-12).
       *
       * A cluster is a MERGE of whole symbol ranges, and on a densely-packed file
       * every symbol merges into one blob spanning the file — cycle.go's 209-line
       * `Service` is one cluster covering `RunCycle`, `runPayrollCycleAll` and
       * seven incidental accessors. The old rule took the top-ranked cluster whole
       * however big it was, so a single-cluster file simply ignored its budget:
       * it took ~40% more than it was allotted, and the file below it was then
       * dropped for lack of room (that is how `BuildPayslip` — the "calculate"
       * half of the #1500 query — went missing entirely). Shrinking by MEMBER
       * keeps every rule that matters: only whole symbol ranges are emitted, so a
       * body is never cut, and the members are chosen by the same importance the
       * cluster ranking uses. Returns null when nothing needed shrinking.
       *
       * `sizeOf` measures the RAW source span, while the render adds
       * `contextPadding` around every block and a line-number prefix to every
       * line — so this over-keeps (measured ~60% under on a 1,414-line file:
       * 16.5K accounted, 26.3K rendered). That is deliberate, not an oversight:
       * `bound()` clamps the result to the ceiling exactly, so the slack costs no
       * bytes, and making the estimate exact instead measured WORSE — it stops at
       * the last member that fits whole, and the released bytes carry forward to
       * lower-ranked files (payroll-go's `runPayrollCycleAll` body lost its
       * `s.store.Upsert` call to a rank-5 file). What the slack must NOT do is
       * decide WHICH members survive: that is the ceiling trim's job, and CG-38 is
       * why that trim now protects the named spans instead of cutting in source
       * order. See `docs/benchmarks/explore-tail-render-cg38.md`.
       */
      const shrinkCluster = (c: ExploreCluster, cap: number): SectionPart[] | null => {
        if (c.members.length < 2) return null;
        const byImportance = [...c.members].sort((a, b) =>
          b.importance - a.importance || (a.end - a.start) - (b.end - b.start) || a.start - b.start);
        const sizeOf = (r: ExploreRange) => fileLines.slice(r.start - 1, r.end).join('\n').length;
        const keep: ExploreRange[] = [];
        let kept = 0;
        for (const r of byImportance) {
          const sz = sizeOf(r) + GAP_MARKER.length;
          // Always keep the most important range, even if it alone is oversize —
          // an empty section sends the agent to Read, which costs far more. How
          // far it may overshoot is bounded by the caller's ceiling (CG-30), which
          // windows a runaway member instead of dropping it.
          if (keep.length > 0 && kept + sz > cap) continue;
          keep.push(r);
          kept += sz;
        }
        if (keep.length === c.members.length) return null;
        // Re-merge the kept ranges in source order so adjacent survivors read as
        // one block rather than a stutter of one-symbol fragments.
        keep.sort((a, b) => a.start - b.start);
        const merged: Array<{ start: number; end: number }> = [];
        for (const r of keep) {
          const last = merged[merged.length - 1];
          if (last && r.start <= last.end + gapThreshold) last.end = Math.max(last.end, r.end);
          else merged.push({ start: r.start, end: r.end });
        }
        return merged.flatMap((m) => buildSection(m));
      };

      /**
       * Bounded overshoot for one cluster's render (CG-30).
       *
       * `shrinkCluster` keeps the highest-importance member whole even when that
       * member alone is oversize — an empty file section sends the agent to Read,
       * which is exactly what explore exists to prevent. But "never empty" is not
       * "any size": with nothing bounding it, one 22K member rendered against a
       * 9K reservation (2.4x), which collapses the headroom every file ranked
       * below it draws from. Past the ceiling the member is WINDOWED rather than
       * dropped — a leading window (signature + head of the body), plus a window
       * on the spine's call site when the head misses it, since on a flow cluster
       * the call path IS the answer.
       */
      const MIN_WINDOW_LINES = 12;
      /** Rendered cost of one source line, line numbering included. */
      const lineCost = (ln: number): number =>
        (fileLines[ln - 1] ?? '').length + 1 + (withLineNumbers ? String(ln).length + 1 : 0);
      /**
       * Longest prefix of `r` that fits `room`. `minLines` is the never-empty
       * floor — it may overrun `room`, so it is only ever asked for when nothing
       * else has been emitted and the alternative is an empty section.
       */
      const headWindowOf = (
        r: ExploreLineRange, room: number, minLines = 0,
      ): ExploreLineRange | null => {
        let end = r.start - 1;
        let chars = 0;
        for (let ln = r.start; ln <= r.end; ln++) {
          const cost = lineCost(ln);
          if (chars + cost > room && end - r.start + 1 >= minLines) break;
          chars += cost;
          end = ln;
        }
        return end >= r.start ? { start: r.start, end } : null;
      };
      /** Widest window around `line` inside [lo, hi] that fits `room`. */
      const centeredWindowOf = (
        line: number, lo: number, hi: number, room: number,
      ): ExploreLineRange | null => {
        if (line < lo || line > hi) return null;
        let start = line, end = line, chars = lineCost(line);
        for (let grown = true; grown;) {
          grown = false;
          if (end + 1 <= hi && chars + lineCost(end + 1) <= room) { end += 1; chars += lineCost(end); grown = true; }
          if (start - 1 >= lo && chars + lineCost(start - 1) <= room) { start -= 1; chars += lineCost(start); grown = true; }
        }
        return { start, end };
      };
      /**
       * Reduce rendered parts to fit `ceiling`, never to nothing. Whole parts are
       * kept while they fit; the first part that overruns is cut to a leading
       * window on whole lines (a body is never cut mid-line), and everything past
       * it is dropped. The GAP_MARKER between surviving parts — and the line-number
       * jump — is what tells the agent the cut happened.
       *
       * A partial window shorter than MIN_WINDOW_LINES is not worth emitting, and
       * emitting one is actively harmful: the session record then claims a 4-line
       * sliver, and the NEXT call's dedup has to either shred a whole block around
       * it or re-send it. Below that floor the part is simply dropped — unless
       * nothing has been emitted at all, where the floor wins over the ceiling
       * because an empty section is the one outcome worse than an oversize one.
       *
       * `focusLines` are the lines this trim must not lose: the spine's next-hop
       * call site (CG-30) and every definition the agent NAMED inside the cluster
       * (CG-38). The head fill is source-ordered, so a named def in the TAIL of a
       * large file is otherwise always the first thing an over-ceiling render
       * drops — the one span the agent asked for by name, cut in favour of
       * head-of-file filler it did not ask for. The full-ceiling fill is tried
       * FIRST and the 60% hold-back applies only when a focus line is actually
       * left uncovered, so a cluster whose head already reaches its focus keeps
       * the whole ceiling for source.
       */
      const windowToCeiling = (
        parts: ReadonlyArray<SectionPart>,
        ceiling: number,
        focusLines: ReadonlyArray<number> = [],
      ): SectionPart[] => {
        const inParts = (line: number) =>
          parts.some((p) => line >= p.range.start && line <= p.range.end);
        const focus = [...new Set(focusLines)]
          .filter((l) => typeof l === 'number' && l > 0 && inParts(l))
          .sort((a, b) => a - b);
        /** Source-ordered fill of whole parts, the overrunning one cut to a head window. */
        const fill = (room: number): { emit: ExploreLineRange[]; used: number } => {
          const emit: ExploreLineRange[] = [];
          let used = 0;
          for (const p of parts) {
            const join = emit.length > 0 ? GAP_MARKER.length : 0;
            if (used + join + p.text.length <= room) {
              emit.push(p.range);
              used += join + p.text.length;
              continue;
            }
            const first = emit.length === 0;
            const win = headWindowOf(
              p.range, Math.max(0, room - used - join), first ? MIN_WINDOW_LINES : 0);
            if (win && (first || win.end - win.start + 1 >= MIN_WINDOW_LINES)) {
              emit.push(win);
              used += join + renderSpan(win).length;
            }
            break;
          }
          return { emit, used };
        };
        let { emit, used } = fill(ceiling);
        const reached = () => (emit.length ? emit[emit.length - 1]!.end : 0);
        if (focus.some((l) => l > reached())) {
          // Hold room back for the focus windows so the head can't eat all of it.
          ({ emit, used } = fill(Math.floor(ceiling * 0.6)));
        }
        // What is left is SPLIT between the uncovered focus lines rather than
        // handed to them in order. Greedy-in-source-order reproduces the very bug
        // this guards: on a prose query resolving four focus lines, the two
        // earliest took the whole reserve and `flushQueuedMessages` at L1102 —
        // named in the question — was dropped again. A skipped or undersized
        // window returns its share to the pool for the ones after it.
        let covered = reached();
        let room = Math.max(0, ceiling - used);
        const pending = focus.filter((l) => l > covered);
        for (let i = 0; i < pending.length; i++) {
          const line = pending[i]!;
          if (line <= covered) continue; // an earlier window already reached it
          const share = Math.floor(room / (pending.length - i)) - GAP_MARKER.length;
          if (share <= 0) continue;
          const host = parts.find((p) => line >= p.range.start && line <= p.range.end)!;
          const lo = Math.max(host.range.start, line - SPINE_WINDOW, covered + 1);
          const hi = Math.min(host.range.end, line + SPINE_WINDOW);
          const win = centeredWindowOf(line, lo, hi, share);
          // Same sliver floor as the head window — a two-line peek at the call
          // site teaches the next call's dedup to shred the block around it.
          if (!win || win.end - win.start + 1 < MIN_WINDOW_LINES) continue;
          emit.push(win);
          const cost = GAP_MARKER.length + renderSpan(win).length;
          used += cost;
          room -= cost;
          covered = win.end;
        }
        // Never empty: a section with no source sends the agent to Read.
        if (emit.length === 0 && parts.length > 0) {
          const first = headWindowOf(parts[0]!.range, ceiling, MIN_WINDOW_LINES);
          if (first) emit.push(first);
        }
        return emit
          .sort((a, b) => a.start - b.start)
          .map((r) => ({ range: r, text: renderSpan(r) }));
      };

      /**
       * The lines a ceiling trim of this cluster must not lose: the spine's
       * next-hop call site, and the definition line of every member the agent
       * NAMED or that is a query entry point (importance >= 9). Capped, because
       * each one costs a window and too many turn a section into confetti; the
       * most important come first, source order within a tier so the windows read
       * top-down.
       */
      const MAX_FOCUS_LINES = 6;
      const focusLinesOf = (c: ExploreCluster): number[] => {
        const named = c.members
          .filter((m) => m.importance >= 9)
          .sort((a, b) => b.importance - a.importance || a.start - b.start)
          .slice(0, MAX_FOCUS_LINES)
          .map((m) => m.start);
        return c.spineCallLine ? [c.spineCallLine, ...named] : named;
      };

      /**
       * One cluster's final parts: built, shrunk if it overruns `cap`, then
       * passed through the session history (CG-18).
       *
       * The shrink decision reads the DEDUPED length on purpose. A cluster whose
       * bytes the agent already holds costs this response nothing, so shrinking
       * it on its raw size would drop new symbols to make room for source that
       * is not being sent — spending the file's budget on nothing.
       */
      const renderCluster = (
        c: ExploreCluster,
        cap: number,
        /**
         * Hard bound on the rendered result (CG-30). `cap` is what selection asks
         * for; this is how far a single oversize member is allowed to overshoot it
         * before being windowed. Always >= `cap`, so a cluster that already fits is
         * never touched.
         */
        ceiling: number = Infinity,
      ): { parts: SectionPart[]; covered: ExploreLineRange[]; shrunk: boolean } => {
        const base = dedupeSpans(buildSection(c));
        const bound = (
          r: { parts: SectionPart[]; covered: ExploreLineRange[]; shrunk: boolean },
        ) => {
          if (!Number.isFinite(ceiling) || sectionText(r.parts).length <= ceiling) return r;
          // Windows are subsets of spans dedupeSpans already cleared, so the record
          // still only ever claims source that was actually sent.
          const parts = windowToCeiling(r.parts, ceiling, focusLinesOf(c));
          return { parts, covered: r.covered, shrunk: true };
        };
        if (sectionText(base.parts).length <= cap) {
          return { parts: base.parts, covered: base.covered, shrunk: false };
        }
        const shrunk = shrinkCluster(c, cap);
        if (shrunk === null) {
          return bound({ parts: base.parts, covered: base.covered, shrunk: false });
        }
        const dd = dedupeSpans(shrunk);
        return bound({ parts: dd.parts, covered: dd.covered, shrunk: true });
      };

      // Rank clusters for inclusion under the per-file cap. Entry-point
      // clusters come first: a cluster containing a query entry point
      // (importance 10) must outrank a dense block of mere declarations,
      // otherwise on a large file like Session.swift the top-of-file class
      // header + property list (many adjacent low-importance nodes, high
      // density) wins the budget and buries the actual methods the query
      // asked about (perform/didCreateURLRequest/task live deep in the
      // file). Within the same importance tier, prefer density (score per
      // line) so we still favor focused clusters over sprawling ones, then
      // smaller span as a cheap-to-include tiebreak.
      const rankedClusters = clusters
        .map((c, i) => ({ idx: i, span: c.end - c.start + 1, c }))
        .sort((a, b) => {
          // Spine clusters first — the rendered call path IS the flow answer, so it
          // outranks any denser block of peripheral declarations (a low-density entry
          // method must not lose the budget to them). Within spine / within non-spine,
          // the existing importance → density → score → span order holds.
          if (a.c.hasSpine !== b.c.hasSpine) return (b.c.hasSpine ? 1 : 0) - (a.c.hasSpine ? 1 : 0);
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      // Per-file budget is this file's RESERVATION, bounded by what's left before
      // the hard ceiling — so selection (which ranks by importance) keeps the
      // high-importance clusters and drops peripheral ones, instead of the
      // downstream source-order trim slicing off whatever comes last in the file.
      // That source-order slice is what cut Django's `_fetch_all` (L2237, importance
      // 9 — agent-named) when query.py was the last of four big files to be emitted.
      // It used to be `min(maxCharsPerFile, remaining)`: a flat cap that clipped the
      // top-scoring file at the same 3,800 as the weakest one, while the whole-file
      // branch above handed a small file 3x that. The reservation is the whole point
      // of CG-12 — bytes follow relevance, not file size.
      //
      // `fundedHeadroom`, not `headroom` (CG-31): what is left before the hard
      // ceiling includes every unreached file's reservation, and spending that
      // is how one clustered file zeroed five admitted peers. It is ≤ `headroom`
      // by construction, so it is the only bound these three lines need.
      const fileBudget = Math.min(allowance, fundedHeadroom);
      // Spine ceiling: a flow-path cluster may exceed the reservation (the call path
      // IS the answer and clipping it forces the Read), but bounded — 1.5x the
      // reservation and never past the ceiling — so a pathological long in-file
      // spine can't run away or starve co-flow files entirely. The 1.5x is drawn
      // from the shared envelope, so it is exactly the overshoot the displacement
      // guard has to fund: past `fundedHeadroom` the extra half-reservation is
      // another file's, not spare room.
      const SPINE_CEILING = Math.min(Math.round(allowance * 1.5), fundedHeadroom);
      const chosenIndices = new Set<number>();
      // Final renders (deduped, shrunk where oversize) by cluster index. Computed
      // during selection and reused at emission so the two never disagree.
      const renderedClusters = new Map<number, ReturnType<typeof renderCluster>>();
      let anyClusterShrunk = false;
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        // The top-ranked cluster is always taken — an empty file section sends the
        // agent to Read, negating the savings. But "always taken" is not "taken at
        // any size": when it overruns the reservation it is SHRUNK to the
        // highest-importance whole symbol ranges inside it, so a single-cluster
        // god-file spends its allotment instead of the whole response's.
        const first = chosenIndices.size === 0;
        // A spine cluster (the rendered call path) is the flow answer — it may run
        // past the per-file budget up to the spine ceiling; non-spine clusters obey
        // the normal per-file budget.
        const cap = rc.c.hasSpine ? SPINE_CEILING : fileBudget;
        // CG-30: shrinking keeps the top member whole however big it is, so bound
        // how far that member may overshoot — the same 1.5x-of-reservation bound
        // SPINE_CEILING already draws, never below `cap` (a cluster that fits its
        // cap is never windowed). A spine cluster's cap already IS that bound, so
        // this holds it to it rather than letting the member rule walk past it.
        const ceiling = Math.max(cap, SPINE_CEILING);
        if (first) {
          const section = renderCluster(rc.c, cap, ceiling);
          renderedClusters.set(rc.idx, section);
          anyClusterShrunk = anyClusterShrunk || section.shrunk;
          chosenIndices.add(rc.idx);
          projectedChars += sectionText(section.parts).length;
          continue;
        }
        // Later clusters used to be all-or-nothing: rendered whole, then taken
        // only if the whole thing fit the remainder. On a file whose top-ranked
        // cluster is TRIVIAL that discards the answer and leaves the reservation
        // unspent — django's `sql/query.py` keeps a 22-line glue cluster (one
        // importance-6 bridging symbol) and drops the 624-line `Query` body
        // beneath it whole, spending 1,923 of 7,947; the slack then carries
        // forward to a file scoring a fifth as much (CG-36). Same shape in
        // okhttp's `RealInterceptorChain.kt`, where an import header displaces
        // the chain itself.
        //
        // So a later cluster is shrunk INTO the remainder by the same whole-member
        // rule the first one already uses — CG-26's between-FILES lesson ("hold the
        // remainder while it is still worth a section; zeroing it delivers
        // nothing") applied between CLUSTERS. Below `MIN_CHARS` the remainder can't
        // hold one readable block, so it stays a drop rather than a stutter of
        // fragments the next call's dedup then has to shred around.
        const room = cap - projectedChars - GAP_MARKER.length;
        if (room < EXPLORE_ALLOCATION.MIN_CHARS) continue;
        const section = renderCluster(rc.c, room, room);
        const text = sectionText(section.parts);
        if (text.length === 0) continue;
        // The never-empty floors inside the windowing may overrun `room` (a
        // 12-line minimum window on a file of very long lines). The first cluster
        // is allowed that overshoot — an empty section is worse — but a later one
        // is not: it would be spending a lower-ranked FILE's reservation for a
        // fragment. Drop it, exactly as before.
        if (projectedChars + text.length + GAP_MARKER.length > cap) continue;
        renderedClusters.set(rc.idx, section);
        anyClusterShrunk = anyClusterShrunk || section.shrunk;
        chosenIndices.add(rc.idx);
        projectedChars += text.length + GAP_MARKER.length;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      // Assembled through a function because it may have to run more than once:
      // the fit test below trims the weakest cluster and re-assembles rather
      // than skipping the file (CG-26).
      const assembleSection = (chosen: ReadonlySet<number>) => {
        let text = '';
        const symbols: string[] = [];
        const ranges: ExploreLineRange[] = [];
        const covered: ExploreLineRange[] = [];
        for (let i = 0; i < clusters.length; i++) {
          if (!chosen.has(i)) continue;
          const cluster = clusters[i]!;
          const section = renderedClusters.get(i)!;
          const part = sectionText(section.parts);
          if (part.length > 0) {
            if (text.length > 0) text += GAP_MARKER;
            text += part;
          }
          ranges.push(...section.parts.map((p) => p.range));
          covered.push(...section.covered);
          symbols.push(...cluster.symbols);
        }
        return { text, symbols, ranges, covered };
      };
      let assembled = assembleSection(chosenIndices);

      // A chosen cluster is a COMPLETE method-range — we never cut through a body,
      // and a shrunk cluster drops WHOLE members for the same reason. An oversize
      // single MEMBER (one long monolithic function) is kept whole for as long as
      // it fits the bounded overshoot (half a method is useless — the agent just
      // Reads the rest, the fallback explore exists to prevent); past that bound it
      // is WINDOWED on whole lines rather than dropped (CG-30), so a god-method
      // can neither be silently lost nor spend the response's whole envelope.
      if (chosenIndices.size < clusters.length || anyClusterShrunk) {
        anyFileTrimmed = true;
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const headerFor = (symbols: readonly string[]): string => {
        const symbolCounts = new Map<string, number>();
        for (const s of symbols) symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
        const sortedSymbols = [...symbolCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([name]) => name);
        const headerSymbols = sortedSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omittedCount = sortedSymbols.length - headerSymbols.length;
        return fileSectionHeader(filePath, omittedCount > 0
          ? `${headerSymbols.join(', ')}, +${omittedCount} more`
          : headerSymbols.join(', '));
      };

      // Last stop before the hard ceiling. The reservation already bounded cluster
      // selection above, so reaching this means the bounded overshoot (an oversize
      // first cluster, taken whole rather than sliced mid-method) ran the response
      // out of room.
      //
      // Exact, like the whole-file arm above (CG-26): header + fences + body,
      // not body + a flat 200. The displacement half of the invariant is
      // already enforced on the body itself (`bodyCap` / `SPINE_CEILING` read
      // `fundedHeadroom`); this is the ceiling half. And because it is exact it
      // now bites at the margin — a header runs 300–500 chars where the body
      // budget assumed 200 — so an overrun TRIMS the weakest cluster and
      // re-assembles instead of skipping the file whole. Skipping a file over a
      // ~300-char accounting difference is starvation by rounding: the file was
      // admitted, reserved and rendered, and would have delivered nothing.
      // Only when the top-ranked cluster alone cannot fit is the file skipped —
      // that one is never sliced mid-method.
      let fileHeader = headerFor(assembled.symbols);
      let chosenNow = chosenIndices;
      const costOfSection = (header: string, body: string) =>
        header.length + 2 + (body.length > 0 ? body.length + lang.length + 11 : 0);
      // The weakest cluster is SHRUNK into the room that is left before it is
      // dropped (CG-36). Dropping it whole makes this loop as all-or-nothing as
      // the selection above it was, and at the same cost: on excalidraw's
      // `typeChecks.ts` the estimate missed by 13 chars and a 1,512-char cluster
      // — the file's highest-SCORING one, last only because rank breaks ties on
      // density — was thrown away to pay for it. Below MIN_CHARS the remainder
      // cannot hold a readable block, and only then is the cluster dropped.
      const reshrunkOnce = new Set<number>();
      while (totalChars + costOfSection(fileHeader, assembled.text) > renderCeiling
             && chosenNow.size > 1) {
        // Weakest first: `rankedClusters` is best-first, so walk it backwards.
        let weakest = -1;
        for (let i = rankedClusters.length - 1; i >= 0; i--) {
          const idx = rankedClusters[i]!.idx;
          if (chosenNow.has(idx)) { weakest = idx; break; }
        }
        if (weakest < 0) break;
        const over = totalChars + costOfSection(fileHeader, assembled.text) - renderCeiling;
        const current = renderedClusters.get(weakest)!;
        const currentLen = sectionText(current.parts).length;
        const room = currentLen - over;
        let reduced = false;
        // One attempt per cluster: a second pass means the first re-render did
        // not buy enough (the header moved with it), and the cluster is then
        // dropped rather than whittled a few chars at a time.
        if (room >= EXPLORE_ALLOCATION.MIN_CHARS && !reshrunkOnce.has(weakest)) {
          reshrunkOnce.add(weakest);
          const reshrunk = renderCluster(clusters[weakest]!, room, room);
          const reshrunkLen = sectionText(reshrunk.parts).length;
          // Strictly smaller, or this loop cannot make progress and would spin.
          if (reshrunkLen > 0 && reshrunkLen < currentLen) {
            renderedClusters.set(weakest, reshrunk);
            anyClusterShrunk = true;
            reduced = true;
          }
        }
        if (!reduced) {
          const trimmed = new Set(chosenNow);
          trimmed.delete(weakest);
          chosenNow = trimmed;
        }
        assembled = assembleSection(chosenNow);
        fileHeader = headerFor(assembled.symbols);
        anyFileTrimmed = true;
      }
      // One cluster left and still over — by the header estimate's error, at
      // most a few hundred chars. Re-render it INTO the room that is actually
      // left rather than skip the file: the same whole-line windowing an
      // oversize cluster already gets (CG-30), just against an exact bound.
      // The header is built from the cluster's symbols, not its text, so
      // re-rendering cannot move the target.
      if (totalChars + costOfSection(fileHeader, assembled.text) > renderCeiling
          && chosenNow.size === 1) {
        const idx = [...chosenNow][0]!;
        const room = renderCeiling - totalChars
          - (fileHeader.length + 2 + lang.length + 11);
        if (room > 0) {
          const reshrunk = renderCluster(clusters[idx]!, room, room);
          renderedClusters.set(idx, reshrunk);
          anyClusterShrunk = anyClusterShrunk || reshrunk.shrunk;
          assembled = assembleSection(chosenNow);
          anyFileTrimmed = true;
        }
      }
      if (totalChars + costOfSection(fileHeader, assembled.text) > renderCeiling) {
        anyFileTrimmed = true;
        diag?.recordSkip(filePath, 'budget-clusters');
        continue;
      }
      const fileSection = assembled.text;
      const sectionRanges = assembled.ranges;
      const coveredRanges = assembled.covered;

      // The undeduped render of the same clusters, needed only if this file ends
      // up fully back-referenced AND the whole call finds nothing new to say —
      // see `suppressedFallback`. Built lazily: on every other call it is dead
      // weight.
      const fullClusterParts = fileSection.length === 0
        ? clusters.flatMap((c, i) => (chosenNow.has(i) ? buildSection(c) : []))
        : [];
      emitFileSection({
        header: fileHeader,
        body: fileSection,
        ranges: sectionRanges,
        covered: mergeRanges(coveredRanges),
        overhead: 200,
        mode: 'clusters',
        // Windowing an oversize member elides source too — reporting it as
        // unclipped would hide exactly the cut the diagnostic exists to show.
        clipped: chosenNow.size < clusters.length || anyClusterShrunk,
        fullBody: sectionText(fullClusterParts),
        fullRanges: fullClusterParts.map((p) => p.range),
      });
    }

    // Anti-abandonment restore (CG-18). Dedup withheld everything and nothing new
    // took its place — the response would be pointers only, which is the shape
    // that reads as "codegraph found nothing" and sends the agent to Read for
    // good. Put the top suppressed file back, in full, and keep its pointer off.
    // Deliberately checked against `newSourceChars` (source THIS call emitted)
    // rather than the response length: the flow and blast-radius sections are
    // always there, and they are not what makes a response feel sufficient.
    // Cast, not annotation: the only writer is the render loop's `emitFileSection`
    // closure, which TypeScript's flow analysis cannot see, so it narrows the
    // variable to `null` here and the truthiness check below would be `never`.
    const restore = suppressedFallback as SuppressedFallback | null;
    if (newSourceChars === 0 && restore) {
      if (totalChars + restore.sourceChars + restore.overhead <= renderCeiling) {
        lines.splice(restore.at, restore.replacing, ...restore.section);
        totalChars += restore.sourceChars + restore.overhead;
        sourceSpent += restore.sourceChars;
        newSourceChars += restore.sourceChars;
        filesIncluded++;
        const idx = backReferencedFiles.indexOf(restore.filePath);
        if (idx >= 0) backReferencedFiles.splice(idx, 1);
        emittedByFile.set(restore.filePath, {
          ranges: [...restore.ranges],
          bytes: restore.sourceChars,
          fingerprint: restore.fingerprint,
        });
        diag?.recordRender(restore.filePath, 'clusters', restore.sourceChars, false);
        diag?.recordDedup(restore.filePath, 0, []);
      }
    }

    // The back-reference convention, stated once where the verbatim guarantee is
    // (#1474 does the same for drift). Without it a pointer reads as an
    // apology for missing source rather than as an index into source the agent
    // already has.
    if (backReferencedFiles.length > 0) {
      lines[verbatimHeaderIdx] += ` (Files marked **"Already sent earlier in this conversation"** are not repeated: their source came back on an earlier codegraph_explore call in THIS conversation and the file has not changed since, so that copy is exact and current — scroll back for it rather than re-fetching or Reading.)`;
    }

    // Drift epilogue (#1474). The "verbatim / do not Read" guarantee above
    // stays TRUE for everything actually rendered (drifted files ship whole or
    // not at all — never as a possibly-wrong slice), but two caveats must be
    // explicit: omitted files need Reading, and index-derived LINE REFERENCES
    // to any drifted file (flow steps, blast radius, trail) may be shifted.
    if (staleOmitted.length > 0) {
      lines[verbatimHeaderIdx] += ' (Exception: files flagged "⚠ changed on disk" below drifted from the index after their last sync — their source is omitted rather than risk a mis-sliced block; Read those specific files.)';
    }
    const staleAll = [...new Set([...staleOmitted, ...staleRendered])];
    if (staleAll.length > 0) {
      lines.push(
        '',
        `> ⚠ Changed on disk after the last index sync: ${staleAll.join(', ')}. Line numbers referencing ${staleAll.length === 1 ? 'this file' : 'these files'} elsewhere in this response (flow steps, blast radius, symbol lists) may be shifted until that project's next sync re-indexes ${staleAll.length === 1 ? 'it' : 'them'}.`,
      );
    }

    // Everything pushed from here on is EPILOGUE — meta-text ABOUT the response
    // rather than part of it. Marked so the hard-ceiling cut at the end can
    // spend it before it spends a rendered file section (CG-31): a section is
    // source the agent otherwise has to Read; the epilogue is a pointer list and
    // two reminders, and the note that replaces it carries their instruction.
    //
    // Drawn AFTER the drift warning on purpose — that one is an honesty claim
    // about source we did render, not a note about the response, so it is never
    // the thing we drop. Lines already in `lines` are only MUTATED from here on
    // (the verbatim header, the summary sentinel), never re-ordered, so the
    // index stays valid.
    const epilogueStart = lines.length;

    // The curated header count is computed from the files that SURVIVE the final
    // truncation (see end of method) — `filesIncluded` can over-count when the
    // hard ceiling drops trailing sections — so leave a sentinel here and fill it
    // in once the output is final.
    lines[summaryLineIdx] = SUMMARY_SENTINEL;

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead. But a
    // CLIFFED file is source we deliberately withheld, so the list is forced on
    // whenever there is one: withholding a file's bytes is only cheap if the agent
    // can still name it in a follow-up call (CG-12).
    // The epilogue's three blocks are BUILT here and FITTED below (CG-26) —
    // they are not pushed straight into `lines` any more. The render loop
    // budgets for the epilogue floor it committed to (`EPILOGUE_FLOOR`); what
    // the response can afford above that floor is only known now, so the
    // blocks are assembled against the room that actually remains, in priority
    // order, instead of being emitted whole and then discarded whole.
    const pointerEntries: string[] = [];
    let pointerOmitted = 0;
    if (budget.includeAdditionalFiles || cliffedFiles.size > 0) {
      // Everything ranked that didn't render, in rank order — cliffed files first,
      // since they outrank whatever the file cap cut. (Indexing by `filesIncluded`
      // would be wrong now that cliffed files are skipped without consuming a slot.)
      const rendered = new Set(renderedFilePaths);
      const remainingRelevant = sortedFiles.filter(([fp]) => !rendered.has(fp));
      // Ranked files are already covered by `remainingRelevant`; the rest of the
      // gather (below the floor) becomes the pointer list. The Set guards the
      // one overlap case — a file the SCORE_FLOOR_KEEP_MIN fallback pulled in
      // despite scoring under the relative floor.
      const rankedPaths = new Set(sortedFiles.map(([fp]) => fp));
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([fp, group]) => group.score < scoreFloor && !rankedPaths.has(fp))
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      for (const [filePath, group] of remainingFiles.slice(0, POINTER_MAX_FILES)) {
        pointerEntries.push(pointerLineFor(filePath, group.nodes));
      }
      pointerOmitted = Math.max(0, remainingFiles.length - pointerEntries.length);
    }

    // Completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    const completenessBlock: string[] = budget.includeCompletenessSignal
      ? ['', '---', `> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`]
      : anyFileTrimmed
        ? ['', `> Some file sections were trimmed for size. For a specific symbol you still need, run another \`codegraph_explore\` (or \`codegraph_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`]
        : [];

    // Explore budget note based on project size.
    let budgetBlock: string[] = [];
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        budgetBlock = ['', `> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`];
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // FIT THE EPILOGUE (CG-26). Before this, the epilogue was emitted whole and
    // then, on a saturated response, discarded whole by the hard ceiling — four
    // of six suite repos shipped with no pointer list and no reminders at all,
    // and the render loop had "budgeted" 600 chars for something that measures
    // 1,064–2,231. Neither number was the real one, because the epilogue is not
    // one thing: a fixed floor the loop reserves for (the cut note, plus a
    // pointer for every file whose bytes were deliberately WITHHELD — CG-12
    // makes those names load-bearing) and an elastic tail that takes what is
    // left. Assembled in priority order — the do-not-re-read reminder first,
    // then pointers in rank order, then the budget note — and emitted in
    // document order.
    const roomFor = (block: readonly string[]): number =>
      block.reduce((n, s) => n + s.length + 1, 0);
    let room = hardCeiling - (flow.text.length + lines.join('\n').length);

    const keepCompleteness = completenessBlock.length > 0
      && roomFor(completenessBlock) <= room;
    if (keepCompleteness) room -= roomFor(completenessBlock);

    const pointerBlock: string[] = [];
    if (pointerEntries.length > 0) {
      const head = [POINTER_HEADER, ''];
      let left = room - roomFor(head);
      if (left >= 0) {
        let taken = 0;
        for (const entry of pointerEntries) {
          // Every entry we do NOT take has to be confessed by the tail line, so
          // the tail's cost is part of taking one less than all of them.
          const dropped = pointerEntries.length - taken - 1 + pointerOmitted;
          const tail = dropped > 0 ? roomFor([`- ... and ${dropped} more files`]) : 0;
          if (entry.length + 1 + tail > left) break;
          left -= entry.length + 1;
          taken++;
        }
        if (taken > 0) {
          pointerBlock.push(...head, ...pointerEntries.slice(0, taken));
          const dropped = pointerEntries.length - taken + pointerOmitted;
          if (dropped > 0) pointerBlock.push(`- ... and ${dropped} more files`);
          room -= roomFor(pointerBlock);
        }
      }
    }
    // Nothing of the pointer list survived, but there WAS one — say so, in the
    // one line that carries its instruction forward.
    const pointersLost = pointerEntries.length > 0 && pointerBlock.length === 0;

    const keepBudgetNote = budgetBlock.length > 0 && roomFor(budgetBlock) <= room;
    if (keepBudgetNote) room -= roomFor(budgetBlock);

    lines.push(...pointerBlock);
    if (keepCompleteness) lines.push(...completenessBlock);
    if (keepBudgetNote) lines.push(...budgetBlock);
    if (pointersLost && roomFor([EPILOGUE_LOST_NOTE, '']) <= room) {
      lines.push('', EPILOGUE_LOST_NOTE);
    }

    const output = flow.text + lines.join('\n');
    let finalText: string;
    // The epilogue costs less than a file section, so it is cut FIRST (CG-31).
    // Dropping a trailing section throws away source the render loop had already
    // set that file's reservation aside for — the exact starvation the
    // displacement guard exists to prevent, arriving after the guard has done
    // its work. The epilogue is a pointer list and two reminders; its own
    // "explore these names" instruction survives in the note below.
    const epilogueOnlyCut = epilogueStart < lines.length
      ? flow.text + lines.slice(0, epilogueStart).join('\n')
      : null;
    const EPILOGUE_CUT_NOTE = '\n\n> (Trailing notes omitted for size. The source above is complete and verbatim — treat it as already Read. For anything this call did not cover, run another codegraph_explore with the specific names rather than reading those files.)';

    if (output.length > hardCeiling
        && epilogueOnlyCut !== null
        && epilogueOnlyCut.length + EPILOGUE_CUT_NOTE.length <= hardCeiling) {
      finalText = epilogueOnlyCut + EPILOGUE_CUT_NOTE;
    } else if (output.length > hardCeiling) {
      // Still over with the epilogue gone: cut at a FILE-SECTION boundary (the
      // last ``**` `` file header before the ceiling) so we drop whole trailing
      // file-sections rather than slicing
      // through a method body — a half-rendered method just forces the Read this
      // tool exists to prevent. Fall back to a line boundary only if no section
      // header sits in the back half (degenerate single-giant-section case).
      const cut = output.slice(0, hardCeiling);
      const lastSection = cut.lastIndexOf('\n' + FILE_SECTION_PREFIX);
      const boundary = lastSection > hardCeiling * 0.5 ? lastSection : cut.lastIndexOf('\n');
      const safe = boundary > 0 ? cut.slice(0, boundary) : cut;
      finalText = safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)';
    } else {
      finalText = output;
    }

    // Curated header (#1046): substitute the sentinel with the count of files
    // whose source SURVIVES in the final text — not `subgraph`/`fileGroups` (the
    // raw gather a broad query inflates) and not `filesIncluded` (which can
    // over-count when the ceiling above drops trailing sections). A file counts
    // only if its section header is still present; its relevant (non-import)
    // symbols are summed for N. Files we couldn't fit are still named under "Not
    // shown above" + the budget note, so nothing is silently dropped.
    const survivors = renderedFilePaths.filter((fp) =>
      finalText.includes(`${FILE_SECTION_PREFIX}${fp}\``));
    const shownSymbols = survivors.reduce((sum, fp) => {
      const g = fileGroups.get(fp);
      if (!g) return sum;
      return sum + new Set(
        g.nodes.filter((n) => n.kind !== 'import' && n.kind !== 'export').map((n) => n.id),
      ).size;
    }, 0);
    let summaryLine = survivors.length > 0
      ? `Found ${shownSymbols} symbol${shownSymbols === 1 ? '' : 's'} across ${survivors.length} file${survivors.length === 1 ? '' : 's'}.`
      : `Found ${subgraph.nodes.size} symbol${subgraph.nodes.size === 1 ? '' : 's'} across ${fileGroups.size} file${fileGroups.size === 1 ? '' : 's'}.`;
    // Path pinning is visible, not silent: say which query-named files were
    // honored, and which path spans matched nothing so the agent can correct
    // them instead of trusting a response that quietly ignored the path.
    const pinnedShown = pinnedFiles.filter((fp) => survivors.includes(fp)).length;
    if (pinnedShown > 0) {
      summaryLine += ` ${pinnedShown} file${pinnedShown === 1 ? '' : 's'} pinned from the query.`;
    }
    if (unresolvedPathSpans.length > 0) {
      summaryLine += ` No indexed file uniquely matches ${unresolvedPathSpans.map((s) => `\`${s}\``).join(', ')}.`;
    }
    finalText = finalText.replace(SUMMARY_SENTINEL, summaryLine);

    // Emit the allocation diagnostic from the FINAL text, so per-file bytes and
    // shares account for the hard-ceiling truncation above (CG-4).
    diag?.finish(finalText, output.length, hardCeiling, filesIncluded);

    // Session record (CG-17): only the files that SURVIVED the hard ceiling —
    // a section the truncation dropped was never delivered, and recording it
    // would let a later call withhold source the agent has never seen.
    //
    // A back-referenced file records its spans at ZERO bytes (CG-18) — it is
    // still source the agent holds for this file, which is what the record
    // means; dropping it would let the span age out of the retained window and
    // be re-served for nothing.
    const emittedFiles: ExploreFileEmission[] = [];
    let sourceBytes = 0;
    for (const fp of survivors) {
      const emitted = emittedByFile.get(fp);
      if (!emitted || emitted.ranges.length === 0) continue;
      emittedFiles.push({
        path: fp,
        ranges: emitted.ranges,
        bytes: emitted.bytes,
        fingerprint: emitted.fingerprint,
      });
      sourceBytes += emitted.bytes;
    }
    return this.exploreResult(finalText, {
      projectRoot,
      query,
      files: emittedFiles,
      sourceBytes,
      responseBytes: finalText.length,
    });
  }

  /**
   * An explore response plus the record of what it emitted (CG-17). The record
   * rides the result only as far as {@link execute}, which files it into the
   * calling session's state and deletes it — see {@link EXPLORE_EMISSION_KEY}.
   */
  private exploreResult(text: string, emission: ExploreEmission): ToolResult {
    const result = this.textResult(text);
    result[EXPLORE_EMISSION_KEY] = emission;
    return result;
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;
    const fileHint = typeof args.file === 'string' && args.file.trim() ? args.file.trim() : undefined;
    const lineHint = typeof args.line === 'number' && args.line > 0 ? args.line : undefined;
    const offset = typeof args.offset === 'number' && args.offset > 0 ? Math.floor(args.offset) : undefined;
    const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : undefined;
    const symbolsOnly = args.symbolsOnly === true;
    const symbolRaw = typeof args.symbol === 'string' ? args.symbol.trim() : '';

    // FILE READ MODE: a `file` with no `symbol` reads that file like the Read
    // tool — its current on-disk source with line numbers, narrowable with
    // `offset`/`limit` exactly as Read does — PLUS a one-line blast-radius
    // header (which files depend on it). `symbolsOnly` returns just the
    // structural map instead. Backed by the index: same bytes Read gives you.
    if (!symbolRaw && fileHint) {
      return this.handleFileView(cg, fileHint, { offset, limit, symbolsOnly });
    }

    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    let matches = this.findSymbolMatches(cg, symbol);
    if (matches.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Disambiguate a heavily-overloaded name to a specific definition the caller
    // pinned by file/line (the `file:line` a trail or another tool showed it) —
    // so it can fetch e.g. `Harness::poll` at harness.rs:153 out of 50+ `poll`s
    // instead of Reading. file matches by path suffix/substring; line prefers the
    // def whose body contains it, else the nearest start. Only narrows (never
    // empties — if a hint matches nothing it's ignored).
    if (matches.length > 1 && (fileHint || lineHint !== undefined)) {
      const norm = (p: string) => p.replace(/\\/g, '/').toLowerCase();
      let narrowed = matches;
      if (fileHint) {
        const fh = norm(fileHint);
        const byFile = narrowed.filter((n) => norm(n.filePath).endsWith(fh) || norm(n.filePath).includes(fh));
        if (byFile.length > 0) narrowed = byFile;
      }
      if (lineHint !== undefined && narrowed.length > 1) {
        const containing = narrowed.filter((n) => n.startLine <= lineHint && (n.endLine ?? n.startLine) >= lineHint);
        narrowed = containing.length > 0
          ? containing
          : [...narrowed].sort((a, b) => Math.abs(a.startLine - lineHint) - Math.abs(b.startLine - lineHint)).slice(0, 1);
      }
      if (narrowed.length > 0) matches = narrowed;
    }

    // Single definition — the common case.
    if (matches.length === 1) {
      return this.textResult(this.truncateOutput(await this.renderNodeSection(cg, matches[0]!, includeCode)));
    }

    // Multiple definitions share this name — overloads, or same-named methods on
    // different types (Alamofire `didCompleteTask`/`task`/`validate`, gin
    // `reset`). Returning ONE forces the agent to guess, and when it guesses
    // wrong it READS the file to find the right overload — the dominant
    // codegraph_node read cause on Swift/Go. So return them ALL: pack as many
    // FULL bodies as fit a char budget (the agent gets the one it needs in this
    // one call, no follow-up parameter to learn), and list any remainder by
    // file:line so a large overload set can't overflow the per-tool cap.
    const header = `**${matches.length} definitions named "${symbol}"**`;
    if (!includeCode) {
      const list = matches.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`);
      return this.textResult(this.truncateOutput(
        [header, '', 'Re-query with `includeCode: true` to get every body in one call — no need to pick one first.', '', ...list].join('\n'),
      ));
    }

    const BODY_BUDGET = 12000; // leaves room under MAX_OUTPUT_LENGTH for the header + list
    // The CHAR budget is the real limiter — keep the count cap high so a set of
    // SHORT overloads (Alamofire's 10 `validate` variants, each a few lines) all
    // render in full rather than relegating the one the agent wanted to a
    // bodiless list. Only a set of many LARGE bodies hits the char budget first.
    const HARD_CAP = 16;
    const rendered: string[] = [];
    const listed: Node[] = [];
    let used = 0;
    for (const n of matches) {
      if (rendered.length >= HARD_CAP) { listed.push(n); continue; }
      const section = await this.renderNodeSection(cg, n, true);
      // Always emit the first; emit the rest only while within the char budget.
      if (rendered.length === 0 || used + section.length <= BODY_BUDGET) {
        rendered.push(section);
        used += section.length;
      } else {
        listed.push(n);
      }
    }

    const out: string[] = [
      header,
      `Returning ${rendered.length} in full${listed.length ? `; ${listed.length} more listed below` : ''} — pick the one you need (no Read required).`,
      '',
      rendered.join('\n\n---\n\n'),
    ];
    if (listed.length) {
      const LIST_CAP = 20;
      const shownList = listed.slice(0, LIST_CAP);
      out.push(
        '',
        '**Other definitions**',
        ...shownList.map((n) => `- \`${n.name}\` (${n.kind}) — ${n.filePath}:${n.startLine}`),
      );
      if (listed.length > LIST_CAP) out.push(`- … +${listed.length - LIST_CAP} more`);
      out.push(
        '',
        `> Need one of these in full? Call codegraph_node again with \`file\` (e.g. \`"${listed[0]!.filePath.split('/').pop()}"\`) or \`line\` — do NOT Read it.`,
      );
    }
    return this.textResult(this.truncateOutput(out.join('\n')));
  }

  /**
   * FILE READ MODE: resolve `fileArg` (path or basename) to an indexed file and
   * read it like the Read tool — its current on-disk source with line numbers,
   * narrowable with `offset`/`limit` exactly as Read's are — preceded by a
   * one-line blast-radius header (which files depend on it). `symbolsOnly`
   * returns just the structural map (symbols + dependents) instead of source.
   *
   * Parity goal: the numbered source block is byte-for-byte the shape Read
   * returns (`<n>\t<line>`, no padding), so the agent treats it as a Read — only
   * faster (served from the index) and with the blast radius attached. Security:
   * yaml/properties files are summarized by key, never dumped (#383); reads go
   * through validatePathWithinRoot (#527).
   */
  private async handleFileView(
    cg: CodeGraph,
    fileArg: string,
    opts: { offset?: number; limit?: number; symbolsOnly?: boolean } = {},
  ): Promise<ToolResult> {
    const normalize = (p: string) => p.replace(/\\/g, '/').replace(/^(?:\.?\/+)+/, '').replace(/\/+$/, '');
    const wantLower = normalize(fileArg).toLowerCase();
    const allFiles = cg.getFiles();
    if (allFiles.length === 0) return this.textResult('No files indexed. Run `codegraph index` first.');

    let resolved = allFiles.find((f) => f.path.toLowerCase() === wantLower);
    let candidates: typeof allFiles = [];
    if (!resolved) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().endsWith('/' + wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length === 0) {
      candidates = allFiles.filter((f) => f.path.toLowerCase().includes(wantLower));
      if (candidates.length === 1) resolved = candidates[0];
    }
    if (!resolved && candidates.length > 1) {
      return this.textResult(
        [`"${fileArg}" matches ${candidates.length} indexed files — pass a longer path:`, '',
          ...candidates.slice(0, 25).map((f) => `- ${f.path}`)].join('\n'),
      );
    }
    if (!resolved) {
      return this.textResult(
        `No indexed file matches "${fileArg}". Codegraph indexes source files; configs/docs it doesn't parse won't appear — Read those directly.`,
      );
    }

    const filePath = resolved.path;
    const nodes = cg.getNodesInFile(filePath)
      .filter((n) => n.kind !== 'file' && n.kind !== 'import' && n.kind !== 'export')
      .sort((a, b) => a.startLine - b.startLine);
    const dependents = cg.getFileDependents(filePath);

    // Compact, one-line blast radius (codegraph's value-add over a plain Read).
    const depSummary = dependents.length
      ? `used by ${dependents.length} file${dependents.length === 1 ? '' : 's'}: ${dependents.slice(0, 8).join(', ')}${dependents.length > 8 ? `, +${dependents.length - 8} more` : ''}`
      : 'no other indexed file depends on it';

    // Symbol-map renderer — for symbolsOnly, the config fallback, and read errors.
    const symbolMap = (heading: string, limit = 200): string[] => {
      const lines: string[] = [heading];
      for (const n of nodes.slice(0, limit)) {
        const sig = n.signature ? ` ${n.signature.replace(/\s+/g, ' ').trim()}` : '';
        lines.push(`- \`${n.name}\` (${n.kind})${sig} — :${n.startLine}`);
      }
      if (nodes.length > limit) lines.push(`- … +${nodes.length - limit} more`);
      return lines;
    };

    // symbolsOnly → the cheap structural overview, no source.
    if (opts.symbolsOnly) {
      const out = [`**${filePath}** — ${nodes.length} symbol${nodes.length === 1 ? '' : 's'}, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Symbols**'));
      else out.push('_No indexed symbols in this file._');
      out.push('', '> Drop `symbolsOnly` (or pass `offset`/`limit`) to read the source, like Read.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // SECURITY (#383): never dump a raw config/data file — a yaml/properties
    // line is `key: <secret>`. Summarize by key and point to a real Read.
    if (CONFIG_LEAF_LANGUAGES.has(resolved.language)) {
      const out = [`**${filePath}** — configuration/data file, ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Keys (values withheld for safety)**'));
      out.push('', '> Values may be secrets, so codegraph indexes keys only. Read the file directly if you need a value.');
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Read the current bytes from disk through the security chokepoint
    // (validatePathWithinRoot: blocks `../` traversal and symlink escapes, #527).
    const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
    let content: string | null = null;
    if (abs) {
      try { content = readFileSync(abs, 'utf-8'); } catch { content = null; }
    }
    if (content === null) {
      const out = [`**${filePath}** — could not read from disk (it may have moved since indexing). ${depSummary}`, ''];
      if (nodes.length) out.push(...symbolMap('**Symbols**'));
      out.push('', `> Read \`${filePath}\` directly for its current content.`);
      return this.textResult(this.truncateOutput(out.join('\n')));
    }

    // Split exactly as Read does — keep the trailing empty line a final newline
    // produces (Read numbers it too), so line numbers line up byte-for-byte.
    const fileLines = content.split('\n');
    const total = fileLines.length;

    // Read-parity windowing: `offset`/`limit` mean exactly what they do on Read
    // (1-based start line; max line count). Default: the whole file, capped like
    // Read at 2000 lines and bounded by a char budget that tracks explore's
    // proven-safe ~38k response ceiling. Overflow is stated explicitly (Read
    // paginates too) — never the silent 15k truncateOutput chop.
    const CHAR_BUDGET = 38000;
    const DEFAULT_LIMIT = 2000;
    const offset = Math.max(1, opts.offset ?? 1);
    if (offset > total) {
      return this.textResult(`**${filePath}** has ${total} line${total === 1 ? '' : 's'} — offset ${offset} is past the end. ${depSummary}`);
    }
    const maxLines = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
    const start = offset - 1; // 0-based
    const header = `**${filePath}** — ${total} lines, ${nodes.length} symbol${nodes.length === 1 ? '' : 's'} · ${depSummary}`;

    // Numbered lines, byte-for-byte Read's shape: `<n>\t<line>`, no left-pad.
    const numbered: string[] = [];
    let used = header.length + 8;
    let i = start;
    for (; i < total && numbered.length < maxLines; i++) {
      const ln = `${i + 1}\t${fileLines[i]}`;
      if (used + ln.length + 1 > CHAR_BUDGET && numbered.length > 0) break;
      numbered.push(ln);
      used += ln.length + 1;
    }
    const shownEnd = start + numbered.length;
    const complete = offset === 1 && shownEnd >= total;

    const out: string[] = [header, '', ...numbered];
    if (!complete) {
      out.push(
        '',
        `(lines ${offset}–${shownEnd} of ${total} — pass \`offset\`/\`limit\` for another range, or \`codegraph_node <symbol>\` for one symbol in full)`,
      );
    }
    // Self-bounded to CHAR_BUDGET — do NOT route through truncateOutput (15k).
    return this.textResult(out.join('\n'));
  }

  /** Render one symbol: details + (optional) body/outline + its caller/callee trail. */
  private async renderNodeSection(cg: CodeGraph, node: Node, includeCode: boolean): Promise<string> {
    // Disk-drift gate (issue #1474): the body below is CURRENT bytes sliced at
    // INDEXED line ranges. If the file changed since its last index sync, that
    // slice can be a DIFFERENT symbol's code served under this node's name —
    // confidently wrong, with no watcher banner to catch it on a `projectPath`
    // (cross-project) target. Never emit a slice from a drifted file.
    if (this.isFileStaleOnDisk(cg, node.filePath)) {
      return this.renderStaleNodeSection(cg, node, includeCode);
    }
    let code: string | null = null;
    let outline: string | null = null;
    if (includeCode) {
      // For container symbols (class/interface/struct/…), the full body is the
      // sum of every method body — a wall of source. Return a structural outline
      // (members + signatures + line numbers) instead; leaf symbols return their
      // full body.
      if (CONTAINER_NODE_KINDS.has(node.kind)) {
        outline = this.buildContainerOutline(cg, node);
      }
      if (!outline) {
        code = await cg.getCode(node.id);
      }
    }
    return this.formatNodeDetails(node, code, outline) + this.formatTrail(cg, node);
  }

  // Whole-file fallback caps for a drifted file (#1474): small enough to fit
  // codegraph_node's output cap (MAX_OUTPUT_LENGTH) with headroom for the
  // header + trail. A file within these bounds is served WHOLE and CURRENT
  // (Read-parity, correct by construction) instead of a possibly-wrong slice.
  private static readonly STALE_WHOLE_FILE_MAX_LINES = 300;
  private static readonly STALE_WHOLE_FILE_MAX_CHARS = 12000;

  /**
   * codegraph_node render for a symbol whose file changed on disk after the
   * last index sync (issue #1474). The indexed line range is no longer
   * trustworthy, so no slice is emitted: a small file gets its full CURRENT
   * source (Read-parity — sufficiency preserved, the agent still doesn't need
   * Read); a large one gets an explicit notice steering to the tool's own
   * file-read mode (or Read) — honest absence instead of confident wrongness.
   * Location/signature stay (they're the index's answer) but are flagged as
   * possibly shifted.
   */
  private renderStaleNodeSection(cg: CodeGraph, node: Node, includeCode: boolean): string {
    const lines: string[] = [
      `**${node.name}** (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${node.startLine ? `:${node.startLine}` : ''} — ⚠ as of the last index sync; the file has changed on disk since, so this line may be shifted`,
    ];
    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }
    lines.push('');
    let embedded = false;
    if (includeCode) {
      try {
        const absPath = validatePathWithinRoot(cg.getProjectRoot(), node.filePath);
        if (absPath && existsSync(absPath) && !isConfigLeafNode(node)) {
          const content = readFileSync(absPath, 'utf-8');
          const body = content.replace(/\n+$/, '');
          if (
            body.length <= ToolHandler.STALE_WHOLE_FILE_MAX_CHARS &&
            body.split('\n').length <= ToolHandler.STALE_WHOLE_FILE_MAX_LINES
          ) {
            lines.push(
              `> ⚠ \`${node.filePath}\` changed on disk after it was last indexed, so the indexed line range for this symbol may no longer match. Showing the file's full CURRENT source instead (Read-parity — treat it as already Read):`,
              '',
              '```' + (node.language || ''),
              numberSourceLines(body, 1),
              '```',
            );
            embedded = true;
          }
        }
      } catch {
        /* fall through to the notice */
      }
    }
    if (!embedded) {
      lines.push(
        `> ⚠ \`${node.filePath}\` changed on disk after it was last indexed — the indexed line range for this symbol no longer reliably matches, so its body is omitted rather than risk showing a different symbol's code. For current content, call codegraph_node with \`file: "${node.filePath}"\` (no symbol; \`offset\`/\`limit\` narrow it like Read), or Read the file. The change is picked up automatically on that project's next index sync.`,
      );
    }
    return lines.join('\n') + this.formatTrail(cg, node);
  }

  /**
   * Build the "trail" for a symbol: its direct callees (what it calls) and
   * callers (what calls it), each with file:line — so codegraph_node doubles as
   * the structural Grep→Read→expand primitive: a spot PLUS where to go next.
   * Capped to stay cheap. Walk the graph by calling codegraph_node on a trail
   * entry; no Read needed for covered hops. Empty edges on a non-leaf often mean
   * dynamic dispatch the static graph couldn't resolve — that absence is itself
   * a signal (read that one hop) rather than a dead end.
   */
  private formatTrail(cg: CodeGraph, node: Node): string {
    const TRAIL_CAP = 12;
    const fmt = (e: { node: Node; edge: Edge }) => {
      const base = `${e.node.name} (${e.node.filePath}:${e.node.startLine})`;
      const synth = this.synthEdgeNote(e.edge);
      return synth ? `${base} [${synth.compact}]` : base;
    };
    const collect = (edges: Array<{ node: Node; edge: Edge }>): Array<{ node: Node; edge: Edge }> => {
      const seen = new Set<string>([node.id]);
      const out: Array<{ node: Node; edge: Edge }> = [];
      for (const e of edges) {
        if (seen.has(e.node.id)) continue;
        seen.add(e.node.id);
        out.push(e);
      }
      return out;
    };
    const callees = collect(cg.getCallees(node.id));
    const callers = collect(cg.getCallers(node.id));
    if (callees.length === 0 && callers.length === 0) return '';
    const lines: string[] = ['', '**Trail — codegraph_node any of these to follow it (no Read needed)**'];
    if (callees.length > 0) {
      lines.push(`**Calls →** ${callees.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callees.length > TRAIL_CAP ? `, +${callees.length - TRAIL_CAP} more` : ''}`);
    }
    if (callers.length > 0) {
      lines.push(`**Called by ←** ${callers.slice(0, TRAIL_CAP).map(fmt).join(', ')}${callers.length > TRAIL_CAP ? `, +${callers.length - TRAIL_CAP} more` : ''}`);
    }
    return lines.join('\n');
  }

  /**
   * Handle codegraph_status
   */
  private async handleStatus(args: Record<string, unknown>): Promise<ToolResult> {
    let cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Same trick as withStalenessNotice — when an explicit projectPath
    // resolves to the same project as the default session cg, prefer the
    // default so getPendingFiles() (only populated by the default's watcher)
    // is non-empty when there are pending edits.
    if (this.cg && cg !== this.cg) {
      try {
        if (resolvePath(this.cg.getProjectRoot()) === resolvePath(cg.getProjectRoot())) {
          cg = this.cg;
        }
      } catch { /* closed instance — leave as is */ }
    }
    const stats = cg.getStats();

    // Warn when this index actually belongs to a different git working tree
    // (e.g. the server resolved up from a nested worktree to the main checkout).
    // Queries then reflect that tree's branch, not the worktree being edited.
    // status shows the verbose, multi-line form; the read tools get the compact
    // one-liner via withWorktreeNotice. Both share the cached detection.
    const mismatch = this.worktreeMismatchFor(args.projectPath as string | undefined);

    const lines: string[] = [
      '**CodeGraph Status**',
      '',
    ];
    if (mismatch) {
      lines.push(`> ⚠ ${worktreeMismatchWarning(mismatch).replace(/\n/g, '\n> ')}`, '');
    }
    lines.push(
      `**Files indexed:** ${stats.fileCount}`,
      `**Total nodes:** ${stats.nodeCount}`,
      `**Total edges:** ${stats.edgeCount}`,
      `**Database size:** ${(stats.dbSizeBytes / 1024 / 1024).toFixed(2)} MB`,
    );

    // Surface the active SQLite backend (node:sqlite, Node's built-in real
    // SQLite — full WAL + FTS5, no native build).
    lines.push(`**Backend:** node:sqlite (Node built-in) — full WAL + FTS5`);

    // Effective journal mode. 'wal' ⇒ concurrent reads never block on a writer;
    // anything else ⇒ they can ("database is locked"). node:sqlite supports WAL
    // everywhere, so a non-wal mode means the filesystem can't (network/
    // virtualized mounts, WSL2 /mnt). See issue #238.
    const journalMode = cg.getJournalMode();
    if (journalMode === 'wal') {
      lines.push(`**Journal mode:** wal (concurrent reads safe)`);
    } else {
      lines.push(
        `**Journal mode:** ⚠ ${journalMode || 'unknown'} — WAL not active, so reads ` +
        `can block on a concurrent write (WAL appears unsupported on this filesystem)`
      );
    }

    // A newer release exists (#1243) — status is where users and agents look
    // when something seems off, so surface the drift here too. Cheap memoized
    // cache read; absent entirely when up to date or opted out.
    const updateNotice = getUpdateNotice();
    if (updateNotice) {
      lines.push(`**Update available:** ${updateNotice}`);
    }

    // Non-zero at rest means a resolution pass was interrupted mid-run, so
    // some files' call/impact edges are missing until the next sync sweeps
    // the leftovers (#1187). Surface it — an agent trusting an incomplete
    // blast radius is worse than one that knows to re-sync.
    const pendingRefs = cg.getPendingReferenceCount();
    if (pendingRefs > 0) {
      lines.push(
        `**Pending resolution:** ⚠ ${pendingRefs} references from an interrupted ` +
        `index run — some caller/impact edges are missing until the next sync ` +
        `(any file change triggers it, or run \`codegraph sync\`)`
      );
    }

    lines.push('', '**Nodes by Kind:**');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '**Languages:**');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Whole-index degradation (#876): when live watching has permanently
    // stopped, getPendingFiles() is empty (so no "Pending sync" section below)
    // but the index is frozen — call that out explicitly here, the one place an
    // agent asks "is the index caught up?".
    if (cg.isWatcherDegraded()) {
      lines.push(
        '',
        '**Auto-sync disabled:**',
        `- ${cg.getWatcherDegradedReason() ?? 'live file watching stopped'}`,
        '- The index is frozen; Read files directly for current content.'
      );
    }

    // Per-file freshness — the inverse of the auto-prepended staleness banner
    // (issue #403). Surfacing it inside `status` gives the agent a single
    // place to ask "is the index caught up?" rather than inferring from
    // banners on other tool calls.
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '**Pending sync:**');
      const now = Date.now();
      for (const p of pending) {
        const ageMs = Math.max(0, now - p.lastSeenMs);
        const label = p.indexing ? 'indexing in progress' : 'pending sync';
        lines.push(`- ${p.path} (edited ${ageMs}ms ago, ${label})`);
      }
    }

    return this.textResult(lines.join('\n'));
  }

  /**
   * Handle codegraph_files - get project file structure from the index
   */
  private async handleFiles(args: Record<string, unknown>): Promise<ToolResult> {
    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const pathFilter = args.path as string | undefined;
    const pattern = args.pattern as string | undefined;
    const format = (args.format as 'tree' | 'flat' | 'grouped') || 'tree';
    const includeMetadata = args.includeMetadata !== false;
    const maxDepth = args.maxDepth != null ? clamp(args.maxDepth as number, 1, 20) : undefined;

    // Get all files from the index
    const allFiles = cg.getFiles();

    if (allFiles.length === 0) {
      return this.textResult('No files indexed. Run `codegraph index` first.');
    }

    // Filter by path prefix. Stored paths are project-relative POSIX (e.g.
    // "src/foo.ts"), but agents commonly pass project-root variants like "/",
    // ".", "./", "" or Windows-style "src\foo" — and prefixes with leading
    // "/", "./" or "\". Normalize all of those before matching so the agent
    // gets results instead of falling back to Read/Glob (see #426).
    const normalizedFilter = pathFilter
      ? pathFilter
          .replace(/\\/g, '/')
          .replace(/^(?:\.?\/+)+/, '')
          .replace(/^\.$/, '')
          .replace(/\/+$/, '')
      : '';
    let files = normalizedFilter
      ? allFiles.filter(f => f.path === normalizedFilter || f.path.startsWith(normalizedFilter + '/'))
      : allFiles;

    // Filter by glob pattern
    if (pattern) {
      const regex = this.globToRegex(pattern);
      files = files.filter(f => regex.test(f.path));
    }

    if (files.length === 0) {
      return this.textResult(`No files found matching the criteria.`);
    }

    // Format output
    let output: string;
    switch (format) {
      case 'flat':
        output = this.formatFilesFlat(files, includeMetadata);
        break;
      case 'grouped':
        output = this.formatFilesGrouped(files, includeMetadata);
        break;
      case 'tree':
      default:
        output = this.formatFilesTree(files, includeMetadata, maxDepth);
        break;
    }

    return this.textResult(this.truncateOutput(output));
  }

  /**
   * Convert glob pattern to regex
   */
  private globToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')  // Escape special regex chars except * and ?
      .replace(/\*\*/g, '{{GLOBSTAR}}')       // Temp placeholder for **
      .replace(/\*/g, '[^/]*')                // * matches anything except /
      .replace(/\?/g, '[^/]')                 // ? matches single char except /
      .replace(/\{\{GLOBSTAR\}\}/g, '.*');    // ** matches anything including /
    return new RegExp(escaped);
  }

  /**
   * Format files as a flat list
   */
  private formatFilesFlat(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const lines: string[] = [`**Files (${files.length})**`, ''];

    for (const file of files.sort((a, b) => a.path.localeCompare(b.path))) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format files grouped by language
   */
  private formatFilesGrouped(files: { path: string; language: string; nodeCount: number }[], includeMetadata: boolean): string {
    const byLang = new Map<string, typeof files>();

    for (const file of files) {
      const existing = byLang.get(file.language) || [];
      existing.push(file);
      byLang.set(file.language, existing);
    }

    const lines: string[] = [`**Files by Language (${files.length} total)**`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`**${lang} (${langFiles.length})**`);
      for (const file of langFiles.sort((a, b) => a.path.localeCompare(b.path))) {
        if (includeMetadata) {
          lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
        } else {
          lines.push(`- ${file.path}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Format files as a tree structure
   */
  private formatFilesTree(
    files: { path: string; language: string; nodeCount: number }[],
    includeMetadata: boolean,
    maxDepth?: number
  ): string {
    // Build tree structure
    interface TreeNode {
      name: string;
      children: Map<string, TreeNode>;
      file?: { language: string; nodeCount: number };
    }

    const root: TreeNode = { name: '', children: new Map() };

    for (const file of files) {
      const parts = file.path.split('/');
      let current = root;

      for (let i = 0; i < parts.length; i++) {
        const part = parts[i];
        if (!part) continue;

        if (!current.children.has(part)) {
          current.children.set(part, { name: part, children: new Map() });
        }
        current = current.children.get(part)!;

        // If this is the last part, it's a file
        if (i === parts.length - 1) {
          current.file = { language: file.language, nodeCount: file.nodeCount };
        }
      }
    }

    // Render tree
    const lines: string[] = [`**Project Structure (${files.length} files)**`, ''];

    const renderNode = (node: TreeNode, prefix: string, isLast: boolean, depth: number): void => {
      if (maxDepth !== undefined && depth > maxDepth) return;

      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';

      if (node.name) {
        let line = prefix + connector + node.name;
        if (node.file && includeMetadata) {
          line += ` (${node.file.language}, ${node.file.nodeCount} symbols)`;
        }
        lines.push(line);
      }

      const children = [...node.children.values()];
      // Sort: directories first, then files, both alphabetically
      children.sort((a, b) => {
        const aIsDir = a.children.size > 0 && !a.file;
        const bIsDir = b.children.size > 0 && !b.file;
        if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i]!;
        const nextPrefix = node.name ? prefix + childPrefix : prefix;
        renderNode(child, nextPrefix, i === children.length - 1, depth + 1);
      }
    };

    renderNode(root, '', true, 0);

    return lines.join('\n');
  }

  // =========================================================================
  // Symbol resolution helpers
  // =========================================================================

  /**
   * Find a symbol by name, handling disambiguation when multiple matches exist.
   * Returns the best match and a note about alternatives if any.
   */
  /**
   * Check if a node matches a symbol query.
   *
   * Accepts simple names (`run`) and three flavors of qualifier:
   *   - dotted     `Session.request`         (TS/JS/Python)
   *   - colon-pair `stage_apply::run`        (Rust, C++, Ruby)
   *   - slash      `configurator/stage_apply` (path-ish)
   *
   * Multi-level qualifiers compose: `crate::configurator::stage_apply::run`
   * works. Rust path prefixes (`crate`, `super`, `self`) are stripped so
   * the canonical `crate::module::symbol` form resolves.
   *
   * Resolution order, last part must always equal `node.name`:
   *   1. Suffix-match against `qualifiedName` (handles class-scoped methods
   *      where the extractor builds the qualified name from the AST stack)
   *   2. File-path containment (handles file-derived modules in Rust/
   *      Python — `stage_apply::run` matches a `run` in `stage_apply.rs`)
   */
  private matchesSymbol(node: Node, symbol: string): boolean {
    // Erlang arity spelling (`fn/3`, `mod:fn/3` → normalized `mod.fn/3`): when
    // the node's qualifiedName carries an arity (`mod::fn/3`, #1610), the
    // written arity must match it exactly; the remaining comparison then runs
    // on the arity-less spelling. A node with no arity in its qualifiedName
    // keeps the original symbol (a `/` there means a path-ish name instead).
    const aritySpelling = /^(.+)\/(\d{1,3})$/.exec(symbol);
    if (aritySpelling) {
      const nodeArity = /\/(\d{1,3})$/.exec(node.qualifiedName ?? '')?.[1];
      if (nodeArity !== undefined) {
        if (nodeArity !== aritySpelling[2]) return false;
        symbol = aritySpelling[1]!;
      }
    }
    // Simple name match
    if (node.name === symbol) return true;
    // File basename match (e.g., "product-card" matches "product-card.liquid")
    if (node.kind === 'file' && node.name.replace(/\.[^.]+$/, '') === symbol) return true;

    // Qualified-name lookups: split on any supported separator. `\w` keeps
    // identifier chars (incl. `_`) intact; everything else is treated as
    // a separator we tolerate.
    if (!/[.\/]|::/.test(symbol)) return false;
    const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
    if (parts.length < 2) return false;

    const lastPart = parts[parts.length - 1]!;
    if (node.name !== lastPart) return false;

    // Stage 1: qualified-name suffix match. The extractor joins the
    // semantic hierarchy with `::`, so `Session.request` and
    // `Session::request` both become `Session::request` here.
    const colonSuffix = parts.join('::');
    if (node.qualifiedName.includes(colonSuffix)) return true;

    // Stage 2: file-path containment. Rust modules and Python packages
    // are not in `qualifiedName` — they're encoded in the file path. So
    // `stage_apply::run` matches a `run` in any file whose path
    // contains a `stage_apply` segment (with or without an extension).
    //
    // Filter out Rust path prefixes that have no file-system equivalent.
    const containerHints = parts.slice(0, -1).filter((p) => !RUST_PATH_PREFIXES.has(p));
    if (containerHints.length === 0) return false;

    const segments = node.filePath.split('/').filter((s) => s.length > 0);
    return containerHints.every((hint) =>
      segments.some((seg) => seg === hint || seg.replace(/\.[^.]+$/, '') === hint)
    );
  }

  /**
   * Find ALL definitions matching a name, ranked, so codegraph_node can return
   * every overload instead of guessing one (the wrong guess → a Read). Keepers
   * rank before generated stubs (.pb.go etc.); stable within a group preserves
   * FTS order. Returns [] when nothing matches; a qualified lookup that finds no
   * exact match returns [] rather than a misleading fuzzy file hit (#173); a
   * bare name with no exact match falls back to the single top fuzzy result.
   */
  private findSymbolMatches(cg: CodeGraph, symbol: string): Node[] {
    const isQualified = /[.\/]|::/.test(symbol);

    // For a bare name, enumerate EVERY exact-name definition via the direct index
    // (not FTS, which caps + ranks): tokio's `poll` has 50+ defs and the one the
    // caller wants (`Harness::poll` at harness.rs:153) ranks below any search cut,
    // so it could be neither rendered nor pinned by the file/line disambiguator —
    // and the agent Read it. With the full set, the multi-overload render + the
    // file/line filter can both reach it.
    if (!isQualified) {
      const exact = cg.getNodesByName(symbol);
      if (exact.length > 0) {
        const isGen = cg.generatedFilePredicate(exact.map((n) => n.filePath));
        return [...exact].sort((a, b) => (isGen(a.filePath) ? 1 : 0) - (isGen(b.filePath) ? 1 : 0));
      }
      // No exact match — use the single top fuzzy result (e.g. a file basename).
      const fuzzy = cg.searchNodes(symbol, { limit: 10 });
      return fuzzy[0] ? [fuzzy[0].node] : [];
    }

    // Qualified lookup (`Session.request`, `stage_apply::run`): FTS + matchesSymbol.
    const limit = 50;
    let results = cg.searchNodes(symbol, { limit });

    // FTS strips colons, so `stage_apply::run` searches the literal
    // `stage_applyrun` and finds nothing. Re-search by the bare last part and
    // let `matchesSymbol` filter by qualifier.
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0) return [];

    const exactMatches = results.filter((r) => this.matchesSymbol(r.node, symbol));
    if (exactMatches.length === 0) {
      // No exact match — a qualified lookup must not fall back to a fuzzy file
      // hit (#173); a bare name may use the single top fuzzy result.
      return isQualified ? [] : results[0] ? [results[0].node] : [];
    }

    // Down-rank generated files (.pb.go, .pulsar.go, _grpc.pb.go, and anything
    // whose header declares it generated) so a flow query prefers the keeper
    // implementation over the generated stub.
    const isGen = cg.generatedFilePredicate(exactMatches.map((r) => r.node.filePath));
    return [...exactMatches]
      .sort((a, b) => (isGen(a.node.filePath) ? 1 : 0) - (isGen(b.node.filePath) ? 1 : 0))
      .map((r) => r.node);
  }

  /**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
  private findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
    // Nix option paths: the declaration is stored as `options.<path>` and
    // config writes carry longer/quoted tails (`<path>."git/config".text`),
    // so a dotted option token (`xdg.configFile`, `launchd.user.agents`) has
    // no exact-name node and would degrade to bare-tail FTS soup — burying
    // the declaration hub the nix-option-path edges hang off. Resolve the
    // convention directly: declaration first, then the exact write, then a
    // capped prefix scan of write sites. Three index hits; non-nix graphs
    // fall straight through.
    if (/^[a-z][\w'-]*(?:\.[\w'-]+)+$/.test(symbol)) {
      const optionHits = [
        ...cg.getNodesByName(`options.${symbol}`),
        ...cg.getNodesByName(symbol),
        ...cg.getNodesByNamePrefix(`${symbol}.`, 12),
      ].filter((n) => n.language === 'nix');
      if (optionHits.length > 0) {
        const seen = new Set<string>();
        const nodes = optionHits.filter((n) => !seen.has(n.id) && !!seen.add(n.id)).slice(0, 10);
        return { nodes, note: '' };
      }
    }
    let results = cg.searchNodes(symbol, { limit: 50 });

    // Mirror the fallback in `findSymbol` for qualified queries — FTS
    // strips colons, so a module-qualified lookup needs a second pass
    // by the bare last part.
    if (results.length === 0 && /[.\/]|::/.test(symbol)) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
    }

    if (results.length === 0) {
      return { nodes: [], note: '' };
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length <= 1) {
      const node = exactMatches[0]?.node ?? results[0]!.node;
      return { nodes: [node], note: '' };
    }

    // Same generated-file down-rank as findSymbol — keeps callers/callees
    // /impact aggregation aligned (a query against "Send" returns the
    // hand-written implementations before the protobuf scaffold).
    const isGen = cg.generatedFilePredicate(exactMatches.map((r) => r.node.filePath));
    const ranked = [...exactMatches].sort((a, b) => {
      const aGen = isGen(a.node.filePath) ? 1 : 0;
      const bGen = isGen(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const locations = ranked.map(r =>
      `${r.node.kind} at ${r.node.filePath}:${r.node.startLine}`
    );
    const note = `\n\n> **Note:** Aggregated results across ${ranked.length} symbols named "${symbol}": ${locations.join(', ')}`;
    return { nodes: ranked.map(r => r.node), note };
  }

  /**
   * Truncate output if it exceeds the maximum length
   */
  private truncateOutput(text: string): string {
    if (text.length <= MAX_OUTPUT_LENGTH) return text;
    const truncated = text.slice(0, MAX_OUTPUT_LENGTH);
    const lastNewline = truncated.lastIndexOf('\n');
    const cutPoint = lastNewline > MAX_OUTPUT_LENGTH * 0.8 ? lastNewline : MAX_OUTPUT_LENGTH;
    return truncated.slice(0, cutPoint) + '\n\n... (output truncated)';
  }

  // =========================================================================
  // Formatting helpers (compact by default to reduce context usage)
  // =========================================================================

  private formatSearchResults(results: SearchResult[]): string {
    const lines: string[] = [`**Search Results (${results.length} found)**`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info
      lines.push(`**${node.name}** (${node.kind})`);
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeList(nodes: Node[], title: string, labels?: Map<string, string>): string {
    const lines: string[] = [`**${title} (${nodes.length} found)**`, ''];

    for (const node of nodes) {
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact: just name, kind, location — plus the relationship when it
      // isn't a plain call (callback registration, instantiation, …).
      const label = labels?.get(node.id);
      lines.push(
        `- ${node.name} (${node.kind}) - ${node.filePath}${location}${label ? ` — via ${label}` : ''}`
      );
    }

    return lines.join('\n');
  }

  /**
   * Relationship label for a non-`calls` edge in callers/callees lists. A
   * function-as-value edge (#756) is the high-signal one: `callers(cb)`
   * showing "via callback registration" tells the agent this is where the
   * callback is WIRED, not where it's invoked.
   */
  private edgeLabel(edge: Edge): string | null {
    if (edge.kind === 'calls') return null;
    if (edge.metadata?.fnRef === true) return 'callback registration';
    if (edge.kind === 'instantiates') return 'instantiation';
    if (edge.kind === 'imports') return 'import';
    if (edge.kind === 'references') return 'reference';
    return edge.kind;
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `**Impact: "${symbol}" affects ${nodeCount} symbols**`,
      '',
    ];

    // Group by file
    const byFile = new Map<string, Node[]>();
    for (const node of impact.nodes.values()) {
      const existing = byFile.get(node.filePath) || [];
      existing.push(node);
      byFile.set(node.filePath, existing);
    }

    for (const [file, nodes] of byFile) {
      lines.push(`**${file}:**`);
      // Compact: inline list
      const nodeList = nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
      lines.push(nodeList);
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build a compact structural outline of a container symbol from its
   * indexed children (methods, fields, properties, …) — name, kind,
   * line number, and signature — so the agent gets the shape of a class
   * without the full source of every method. Returns '' when the container
   * has no indexed children, so the caller can fall back to full source.
   */
  private buildContainerOutline(cg: CodeGraph, node: Node): string {
    const children = cg.getChildren(node.id)
      .filter(c => c.kind !== 'import' && c.kind !== 'export')
      .sort((a, b) => (a.startLine ?? 0) - (b.startLine ?? 0));
    if (children.length === 0) return '';

    const lines = [`**Members (${children.length}):**`, ''];
    for (const c of children) {
      const loc = c.startLine ? `:${c.startLine}` : '';
      const sig = c.signature ? ` — \`${c.signature}\`` : '';
      lines.push(`- ${c.name} (${c.kind})${loc}${sig}`);
    }
    return lines.join('\n');
  }

  private formatNodeDetails(node: Node, code: string | null, outline?: string | null): string {
    const location = node.startLine ? `:${node.startLine}` : '';
    const lines: string[] = [
      `**${node.name}** (${node.kind})`,
      '',
      `**Location:** ${node.filePath}${location}`,
    ];

    if (node.signature) {
      lines.push(`**Signature:** \`${node.signature}\``);
    }

    // Only include docstring if it's short and useful
    if (node.docstring && node.docstring.length < 200) {
      lines.push('', node.docstring);
    }

    if (outline) {
      lines.push('', outline, '',
        `> Structural outline only. Read \`${node.filePath}\` or call codegraph_node on a specific member for its body.`);
    } else if (code) {
      // Line-numbered (cat -n style, like codegraph_explore and Read) so the
      // agent can cite/edit exact lines without re-Reading the file for them.
      const numbered = node.startLine ? numberSourceLines(code, node.startLine) : code;
      lines.push('', '```' + node.language, numbered, '```');
    }

    return lines.join('\n');
  }

  private textResult(text: string): ToolResult {
    return {
      content: [{ type: 'text', text }],
    };
  }

  private errorResult(message: string): ToolResult {
    return {
      content: [{ type: 'text', text: `Error: ${message}` }],
      isError: true,
    };
  }
}
