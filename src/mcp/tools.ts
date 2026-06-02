/**
 * MCP Tool Definitions
 *
 * Defines the tools exposed by the CodeGraph MCP server.
 */

import type CodeGraph from '../index';
import { findNearestCodeGraphRoot } from '../directory';
// Lazy-load the heavy CodeGraph chain off the MCP startup path — see the same
// helper in engine.ts. ToolHandler must load to answer tools/list (static
// schemas), but it must NOT drag in sqlite/query layers before the daemon binds;
// CodeGraph is pulled in only when a tool actually opens a project. require() is
// sync + cached (CommonJS build).
const loadCodeGraph = (): typeof import('../index').default =>
  (require('../index') as typeof import('../index')).default;
import {
  detectWorktreeIndexMismatch,
  worktreeMismatchWarning,
  worktreeMismatchNotice,
  type WorktreeIndexMismatch,
} from '../sync/worktree';
import type { PendingFile } from '../sync';
import type { Node, Edge, SearchResult, Subgraph, TaskContext, NodeKind } from '../types';
import { createHash } from 'crypto';
import {
  constants as fsConstants,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  statSync,
  writeSync,
} from 'fs';
import { clamp, validatePathWithinRoot, validateProjectPath } from '../utils';
import { isGeneratedFile } from '../extraction/generated-detection';
import { tmpdir } from 'os';
import * as pathModule from 'path';
import { join, resolve as resolvePath } from 'path';

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
  'class', 'struct', 'interface', 'trait', 'protocol', 'enum', 'namespace', 'module',
]);

/** Last `::` / `.` / `/`-separated segment of a qualified symbol. */
function lastQualifierPart(symbol: string): string {
  const parts = symbol.split(/::|[./]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? symbol;
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
  /** Max symbols listed in the per-file header (`#### path — sym(kind), ...`). */
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
  /**
   * Hard-drop test/spec/icon/i18n files from the relevant-file set unless
   * the query itself mentions tests. Today they're only deprioritized in
   * the sort, which on tiny repos still lets one slip into the top N (e.g.
   * cobra's `command_test.go` displaced `args.go` and contributed ~10KB of
   * pure noise to "How does cobra parse commands?"). Off by default; on
   * for the very-tiny tier where one slip dominates the budget.
   */
  excludeLowValueFiles: boolean;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  if (fileCount < 150) {
    return {
      // ITER3: revert iter2's aggressive body shrink (forced Read fallback —
      // the per-file 2.5K cap pushed the agent to Read instead of node).
      // Back to the iter1 shape (13K/4/3.8K) but keep the test-file
      // hard-exclude. The cost lever for this tier lives in handleContext
      // (steering the agent to stop after 1-2 calls), not in this budget.
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
      excludeLowValueFiles: true,
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
      excludeLowValueFiles: true,
    };
  }
  if (fileCount < 5000) {
    return {
      // Sized so ONE explore can cover a flow that centers on a god-file (e.g.
      // excalidraw's 415 KB App.tsx): the previous 2500/file returned <1% of such
      // a file, forcing the agent to Read it anyway. Per-file must also stay ≥ the
      // smaller <500 tier (3800) — the old 2500 was non-monotonic. Tokens are
      // cheap relative to a 5–10 Read round-trip spiral; favor sufficiency.
      maxOutputChars: 28000,
      defaultMaxFiles: 10,
      maxCharsPerFile: 6500,
      gapThreshold: 12,
      maxSymbolsInFileHeader: 10,
      maxEdgesPerRelationshipKind: 10,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 35000,
      defaultMaxFiles: 12,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
      excludeLowValueFiles: false,
    };
  }
  return {
    maxOutputChars: 38000,
    defaultMaxFiles: 14,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
    excludeLowValueFiles: false,
  };
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
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 *
 * Why the explicit openSync + O_NOFOLLOW dance instead of plain writeFileSync:
 * tmpdir() is world-writable on Linux (mode 1777), so on a shared multi-user
 * machine any other local user can pre-create `codegraph-consulted-<hash>` as
 * a symlink pointing at a file the victim owns. The old `writeFileSync` would
 * happily follow that link and overwrite the target's contents with the ISO
 * timestamp string (CWE-59). The session-id hash provides the predictability
 * gate, but it's defense-in-depth: if a session id ever surfaces in logs,
 * argv, or telemetry the attack becomes trivial, and the right fix is to not
 * follow links from /tmp paths in the first place.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    const hash = createHash('md5').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `codegraph-consulted-${hash}`);
    // Refuse to follow a pre-planted symlink at the marker path (CWE-59).
    // O_NOFOLLOW (below) is the atomic, TOCTOU-free guard on POSIX, but it is
    // `undefined` on Windows (libuv ignores it), so the bitwise-OR silently
    // drops it and openSync would follow the link. This lstat check closes that
    // gap cross-platform; ENOENT (path is free) falls through to create it.
    try {
      if (lstatSync(markerPath).isSymbolicLink()) return;
    } catch {
      // No existing entry (or stat failed) — nothing to refuse; proceed.
    }
    // O_NOFOLLOW makes openSync throw ELOOP if markerPath is already a symlink.
    // O_CREAT + O_TRUNC keep the original "create-or-overwrite" semantics, and
    // mode 0o600 prevents readback by other local users (the marker payload is
    // benign, but narrowing the exposure costs nothing).
    const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW;
    const fd = openSync(markerPath, flags, 0o600);
    try {
      writeSync(fd, new Date().toISOString());
    } finally {
      closeSync(fd);
    }
  } catch {
    // Silently fail - don't break MCP on marker write failure. ELOOP from a
    // planted symlink lands here too, which is the intended behavior: refuse
    // to write rather than overwrite an attacker-chosen target.
  }
}

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
}

/**
 * Common projectPath property for cross-project queries
 */
const projectPathProperty: PropertySchema = {
  type: 'string',
  description: 'Path to a different project with .codegraph/ initialized. If omitted, uses current project. Use this to query other codebases.',
};

/**
 * All CodeGraph MCP tools
 *
 * Designed for minimal context usage - use codegraph_context as the primary tool,
 * and only use other tools for targeted follow-up queries.
 *
 * All tools support cross-project queries via the optional `projectPath` parameter.
 */
export const tools: ToolDefinition[] = [
  {
    name: 'codegraph_search',
    description: 'Quick symbol search by name. Returns locations only (no code). Use codegraph_context instead for comprehensive task context.',
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
  },
  {
    name: 'codegraph_context',
    description: 'PRIMARY TOOL — call FIRST for any "how does X work"/architecture/bug question. Returns entry points + related symbols + key code in one call; usually answers without further search/Read/Grep. Provides CODE context, not product requirements.',
    inputSchema: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Description of the task, bug, or feature to build context for',
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum symbols to include (default: 20)',
          default: 20,
        },
        includeCode: {
          type: 'boolean',
          description: 'Include code snippets for key symbols (default: true)',
          default: true,
        },
        projectPath: projectPathProperty,
      },
      required: ['task'],
    },
  },
  {
    name: 'codegraph_callers',
    description: 'List functions that call <symbol>. For deep flow use codegraph_trace.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callers for',
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
  },
  {
    name: 'codegraph_callees',
    description: 'List functions that <symbol> calls. For deep flow use codegraph_trace.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the function, method, or class to find callees for',
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
        depth: {
          type: 'number',
          description: 'How many levels of dependencies to traverse (default: 2)',
          default: 2,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_node',
    description: 'One symbol\'s location, signature, callers/callees trail. includeCode=true returns the verbatim body. Use codegraph_trace for full paths instead of chaining nodes.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: {
          type: 'string',
          description: 'Name of the symbol to get details for',
        },
        includeCode: {
          type: 'boolean',
          description: 'Include full source code (default: false to minimize context)',
          default: false,
        },
        projectPath: projectPathProperty,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'codegraph_explore',
    description: 'Source of SEVERAL related symbols grouped by file, in one capped call. Query is a bag of symbol/file names (not a question). Returned source is verbatim Read-equivalent — do not re-open shown files. Prefer over chained codegraph_node.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Symbol names, file names, or short code terms to explore (e.g., "AuthService loginUser session-manager", "GraphTraverser BFS impact traversal.ts"). Use codegraph_search first to find relevant names.',
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
  },
  {
    name: 'codegraph_trace',
    description: 'Call path between two symbols — "how does <from> reach <to>?" Returns the chain with each hop\'s body inlined plus the destination\'s callees, in ONE call. Ideal for flow questions (update→render, request→handler, QuerySet→SQL). If no static path exists the chain broke at dynamic dispatch — the failure response inlines both endpoints + their TO-file siblings.',
    inputSchema: {
      type: 'object',
      properties: {
        from: {
          type: 'string',
          description: 'Symbol the flow starts at (e.g., "QuerySet", "handleRequest", "mutateElement")',
        },
        to: {
          type: 'string',
          description: 'Symbol the flow should reach (e.g., "execute_sql", "render", "setState")',
        },
        projectPath: projectPathProperty,
      },
      required: ['from', 'to'],
    },
  },
];

/**
 * Allowlist-filtered tool definitions WITHOUT an engine — the static surface the
 * proxy answers `tools/list` with before any project is open. Mirrors
 * `ToolHandler.getTools()` in the no-CodeGraph case (the dynamic per-repo budget
 * note in a description only adds once `cg` is loaded; the schemas are static).
 */
export function getStaticTools(): ToolDefinition[] {
  const raw = process.env.CODEGRAPH_MCP_TOOLS;
  if (!raw || !raw.trim()) return tools;
  const allow = new Set(raw.split(',').map(s => s.trim().replace(/^codegraph_/, '')).filter(Boolean));
  return allow.size ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, ''))) : tools;
}

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
  // populated by the watcher, not by catch-up. Cleared on first await so
  // subsequent calls don't pay any cost.
  private catchUpGate: Promise<void> | null = null;

  constructor(private cg: CodeGraph | null) {}

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
   * Record the directory the server tried to resolve the default project from.
   * Used only to make the "no default project" error actionable.
   */
  setDefaultProjectHint(searchedPath: string): void {
    this.defaultProjectHint = searchedPath;
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
   * Matching is on the short form, so "trace" and "codegraph_trace" both work.
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
    let visible = allow
      ? tools.filter(t => allow.has(t.name.replace(/^codegraph_/, '')))
      : tools;
    if (!this.cg) return visible;

    try {
      const stats = this.cg.getStats();
      const budget = getExploreBudget(stats.fileCount);

      // Tiny-repo tool gating: on projects under TINY_REPO_FILE_THRESHOLD
      // files, only expose the 5 core tools (search, context, node,
      // explore, trace). The 5 omitted tools (callers, callees, impact,
      // status, files) reduce to one grep at this scale.
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
        'codegraph_search',
        'codegraph_context',
        'codegraph_node',
        'codegraph_explore',
        'codegraph_trace',
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
        throw new Error(
          'No CodeGraph project is loaded for this session.\n' +
          `Searched for a .codegraph/ directory starting from: ${searched}\n` +
          'The index is likely fine — this is a working-directory detection issue: ' +
          "the MCP client launched the server outside your project and didn't report the " +
          'workspace root. Fix it either way:\n' +
          '  • Pass projectPath to the tool call, e.g. projectPath: "/absolute/path/to/your/project"\n' +
          '  • Or add --path to the server\'s MCP config args: ["serve", "--mcp", "--path", "/absolute/path/to/your/project"]'
        );
      }
      return this.cg;
    }

    // Check cache first (using original path as key)
    if (this.projectCache.has(projectPath)) {
      return this.projectCache.get(projectPath)!;
    }

    // Reject sensitive system directories before opening. Only validate a
    // path that actually exists — a nested or not-yet-created sub-path of a
    // real project must still be allowed to resolve UP to its .codegraph/
    // root below (issue #238), so we don't run the existence-checking
    // validator on paths that are meant to walk up.
    if (existsSync(projectPath)) {
      const pathError = validateProjectPath(projectPath);
      if (pathError) {
        throw new Error(pathError);
      }
    }

    // Walk up parent directories to find nearest .codegraph/
    const resolvedRoot = findNearestCodeGraphRoot(projectPath);

    if (!resolvedRoot) {
      throw new Error(`CodeGraph not initialized in ${projectPath}. Run 'codegraph init' in that project first.`);
    }

    // If the path resolves to the default project, reuse the already-open
    // default instance rather than opening a SECOND connection to the same DB.
    // A duplicate connection serializes reads against the watcher's auto-sync
    // writes; on the wasm backend (no WAL) that surfaces as intermittent
    // "database is locked" on concurrent tool calls. See issue #238. Deliberately
    // not cached under projectPath — the server owns and closes the default
    // instance, so routing it through projectCache.closeAll() would double-close it.
    if (this.cg && this.cg.getProjectRoot() === resolvedRoot) {
      return this.cg;
    }

    // Check if we already have this resolved root cached (different path, same project)
    if (this.projectCache.has(resolvedRoot)) {
      const cg = this.projectCache.get(resolvedRoot)!;
      // Cache under original path too for faster future lookups
      this.projectCache.set(projectPath, cg);
      return cg;
    }

    // Open and cache under both paths
    const cg = loadCodeGraph().openSync(resolvedRoot);
    this.projectCache.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) {
      this.projectCache.set(projectPath, cg);
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
    const cached = this.worktreeMismatchCache.get(startPath);
    if (cached !== undefined) return cached;

    let mismatch: WorktreeIndexMismatch | null = null;
    try {
      mismatch = detectWorktreeIndexMismatch(startPath, this.getCodeGraph(projectPath).getProjectRoot());
    } catch {
      // No resolvable project (or any other resolution error) → nothing to warn.
      mismatch = null;
    }
    this.worktreeMismatchCache.set(startPath, mismatch);
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
   * Execute a tool by name
   */
  async execute(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      // Block the first tool call on the engine's post-open reconcile so we
      // never serve rows for files deleted/edited while no MCP server was
      // running. The gate is cleared after first await — subsequent calls
      // pay nothing. Catch-up failures are logged by the engine; we
      // proceed regardless so a transient sync error never breaks tools.
      if (this.catchUpGate) {
        const gate = this.catchUpGate;
        this.catchUpGate = null;
        try { await gate; } catch { /* engine already logged */ }
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

      // Read tools resolve through a single result variable so cross-cutting
      // notices — worktree-index mismatch (issue #155) and per-file
      // staleness (issue #403) — can be applied in one place. status embeds
      // its own verbose worktree warning but still flows through the
      // staleness wrapper so its pending-files section stays consistent
      // with what the read tools surface.
      let result: ToolResult;
      switch (toolName) {
        case 'codegraph_search':
          result = await this.handleSearch(args); break;
        case 'codegraph_context':
          result = await this.handleContext(args); break;
        case 'codegraph_callers':
          result = await this.handleCallers(args); break;
        case 'codegraph_callees':
          result = await this.handleCallees(args); break;
        case 'codegraph_impact':
          result = await this.handleImpact(args); break;
        case 'codegraph_explore':
          result = await this.handleExplore(args); break;
        case 'codegraph_node':
          result = await this.handleNode(args); break;
        case 'codegraph_status':
          // status embeds the pending-files list as a first-class section
          // (see handleStatus), so we skip the auto-banner wrapper here to
          // avoid duplicating the same info at the top of the response.
          return await this.handleStatus(args);
        case 'codegraph_files':
          result = await this.handleFiles(args); break;
        case 'codegraph_trace':
          result = await this.handleTrace(args); break;
        default:
          return this.errorResult(`Unknown tool: ${toolName}`);
      }
      const withWorktree = this.withWorktreeNotice(result, args.projectPath as string | undefined);
      return this.withStalenessNotice(withWorktree, args.projectPath as string | undefined);
    } catch (err) {
      return this.errorResult(`Tool execution failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Handle codegraph_search
   */
  private async handleSearch(args: Record<string, unknown>): Promise<ToolResult> {
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const kind = args.kind as string | undefined;
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
    const ranked = [...results].sort((a, b) => {
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
      return aGen - bGen;
    });

    const formatted = this.formatSearchResults(ranked);
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_context
   */
  private async handleContext(args: Record<string, unknown>): Promise<ToolResult> {
    const task = this.validateString(args.task, 'task');
    if (typeof task !== 'string') return task;

    // Mark session as consulted (enables Grep/Glob/Bash)
    const sessionId = process.env.CLAUDE_SESSION_ID;
    if (sessionId) {
      markSessionConsulted(sessionId);
    }

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    // On tiny repos (<150 files), trim maxNodes hard — the entire repo
    // is grep-able in a turn so a 20-node context is wasted budget.
    // 8 covers the typical 1-3 entry-point + their immediate neighbors
    // without dragging in the rest of the small codebase.
    let defaultMaxNodes = 20;
    let isTinyRepo = false;
    let isSmallRepo = false;
    try {
      const stats = cg.getStats();
      if (stats.fileCount < 150) { defaultMaxNodes = 8; isTinyRepo = true; }
      else if (stats.fileCount < 500) { isSmallRepo = true; }
    } catch {
      // stats failure — fall back to the standard default
    }
    const maxNodes = (args.maxNodes as number) || defaultMaxNodes;
    const includeCode = args.includeCode !== false;

    const context = await cg.buildContext(task, {
      maxNodes,
      includeCode,
      format: 'markdown',
    });

    // Detect if this looks like a feature request (vs bug fix or exploration)
    const isFeatureQuery = this.looksLikeFeatureRequest(task);
    const reminder = isFeatureQuery
      ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria'
      : '';

    // Auto-trace for flow queries: when the task is asking "how does X
    // reach/flow/propagate from A to B", run the trace internally and
    // append its body to the context response. Saves the agent the
    // follow-up codegraph_trace call that was the #2 cost driver on
    // multi-module flow questions (Q3 / etcd Q2 in the audit).
    const flowTrace = await this.maybeInlineFlowTrace(task, cg);

    // Iter3 — sufficiency steering on small repos.
    //
    // Measured economics on tiny (<150) and small (<500) projects: every
    // additional MCP tool call costs ~$0.02-0.05 in cache-write tokens
    // (5K-15K per response at $3.75/1M). The agent reflexively follows
    // codegraph_context with explore/node even when the context response
    // is already sufficient — that pattern drove the cost gap that
    // smaller bodies (iter2) failed to close (smaller bodies just shifted
    // the agent to Read instead). Direct directive on small-repo
    // responses: tell the agent the context call IS the comprehensive
    // pass for a project of this size and that follow-ups should be
    // narrow (trace from→to, node single-symbol) — not another broad
    // explore that re-bundles the same content.
    // ITER4: unified strong directive for both tiny (<150) and small
    // (<500) tiers — measured iter3 result was that the soft <500
    // wording was IGNORED on sinatra (5 tool calls, +92% loss) while
    // the strong <150 wording was followed on cobra/slim (3 calls,
    // -21%/-22% wins). The single-file-framework problem (sinatra)
    // is structurally the same as cobra's; both deserve the same
    // sufficiency steering.
    let smallRepoTail = '';
    let smallRepoRouteInline = '';
    if (isTinyRepo || isSmallRepo) {
      // Iter12: backend-computed routing manifest for routing queries.
      // Builds a URL → handler map directly from the graph (each route
      // node has a `references` edge to its handler), then inlines the
      // top handler file's source. The agent gets the canonical
      // routing answer in one MCP call — no need to parse framework
      // DSL or grep for handlers.
      //
      // Replaces iter10's raw route-file inline. The manifest is more
      // information-dense (parsed URL→handler map vs raw config DSL)
      // and we still inline the top handler file's source so the agent
      // has the implementation bodies inline too.
      const isRouteQuery = /\b(route|routes|routing|request|handler|endpoint|api|controller|middleware|dispatch|invok)/i.test(task);
      if (isRouteQuery) {
        try {
          const manifest = cg.getRoutingManifest(40);
          if (manifest) {
            // 1) Compact URL→handler list (~30-60 lines, ~1-2KB).
            const lines: string[] = [
              `\n\n## Routing manifest (${manifest.totalRoutes} routes, top handler file holds ${manifest.topHandlerFileCount})`,
              '',
              '| URL | Handler | Location |',
              '|---|---|---|',
            ];
            for (const e of manifest.entries) {
              lines.push(`| \`${e.url}\` | \`${e.handler}\` | ${e.handlerFile}:${e.handlerLine} |`);
            }
            // 2) Inline the top handler file's source.
            if (manifest.topHandlerFile && manifest.topHandlerFileCount >= 2) {
              try {
                const fullPath = pathModule.join(cg.getProjectRoot(), manifest.topHandlerFile);
                const stat = statSync(fullPath);
                if (stat.size > 0 && stat.size <= 16000) {
                  const source = readFileSync(fullPath, 'utf-8');
                  const capped = source.length > 7000 ? source.slice(0, 7000) + '\n... (truncated)' : source;
                  const ext = (manifest.topHandlerFile.match(/\.([a-z]+)$/i)?.[1] || '').toLowerCase();
                  const lang =
                    ext === 'rb' ? 'ruby' : ext === 'py' ? 'python' :
                    ext === 'go' ? 'go' : ext === 'rs' ? 'rust' :
                    ext === 'js' || ext === 'jsx' ? 'javascript' :
                    ext === 'ts' || ext === 'tsx' ? 'typescript' :
                    ext === 'java' ? 'java' : ext === 'kt' ? 'kotlin' :
                    ext === 'cs' ? 'csharp' : ext === 'php' ? 'php' :
                    ext === 'swift' ? 'swift' : ext === 'yml' || ext === 'yaml' ? 'yaml' : '';
                  lines.push('');
                  lines.push(`### Top handler file (\`${manifest.topHandlerFile}\` — ${manifest.topHandlerFileCount}/${manifest.totalRoutes} routes, full source inlined — do NOT Read)`);
                  lines.push('');
                  lines.push('```' + lang);
                  lines.push(capped);
                  lines.push('```');
                }
              } catch { /* file read failed, skip the source inline */ }
            }
            smallRepoRouteInline = lines.join('\n');
          }
        } catch {
          // Manifest build failed — drop silently
        }
      }
      const sizeQualifier = isTinyRepo ? 'under 150' : 'under 500';
      const routingClause = smallRepoRouteInline
        ? ' The URL→handler manifest and top handler file are also inlined above — answer routing questions from them.'
        : '';
      smallRepoTail = `\n\n---\n> **This project is small** (${sizeQualifier} indexed files). The entry points and code above cover the relevant surface — **do NOT call codegraph_explore as a follow-up; its content will largely duplicate this response**. If you need a specific flow, call \`codegraph_trace from→to\`. If you need one specific symbol's body, call \`codegraph_node <name>\`.${routingClause} Otherwise, answer from what is above.`;
    }

    // buildContext returns string when format is 'markdown'
    if (typeof context === 'string') {
      return this.textResult(this.truncateOutput(context + flowTrace + reminder + smallRepoRouteInline + smallRepoTail));
    }

    // If it returns TaskContext, format it
    return this.textResult(this.truncateOutput(this.formatTaskContext(context) + flowTrace + reminder + smallRepoRouteInline + smallRepoTail));
  }

  /**
   * Detect a flow-style task ("how does X reach Y", "trace the path from A to B")
   * and pre-run trace between the most likely endpoints, returning the trace
   * body to splice into the context response. Returns '' for non-flow queries
   * or when no plausible endpoint pair can be extracted.
   *
   * Conservative by design: only fires when the task has both a clear flow
   * keyword AND at least two distinct PascalCase / camelCase identifiers.
   * False positives waste a graph query; false negatives just fall back to
   * the agent calling trace itself (existing path-proximity wiring handles
   * disambiguation either way).
   */
  private async maybeInlineFlowTrace(task: string, cg: CodeGraph): Promise<string> {
    const lower = task.toLowerCase();
    const FLOW_KEYWORDS = [
      'trace ',
      'from ',
      'reach ',
      'flow ',
      'propagat',
      'how does ',
      'how do ',
    ];
    if (!FLOW_KEYWORDS.some((k) => lower.includes(k))) return '';

    // Extract candidate symbols — PascalCase or camelCase identifiers ≥3 chars.
    // Filter out common non-symbol words and the flow keywords themselves.
    const STOP_WORDS = new Set([
      'how', 'does', 'the', 'and', 'from', 'through', 'reach', 'reaches',
      'flow', 'path', 'trace', 'cross', 'module', 'modules', 'where',
      'update', 'updates', 'updated', 'when', 'what', 'this', 'that',
    ]);
    const ids: string[] = [];
    const seen = new Set<string>();
    const re = /\b([A-Z][a-z]+(?:[A-Z][a-z]*)+|[a-z]+[A-Z][a-z]*(?:[A-Z][a-z]*)*)\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(task)) !== null) {
      const sym = m[1]!;
      if (sym.length < 3) continue;
      const key = sym.toLowerCase();
      if (STOP_WORDS.has(key) || seen.has(key)) continue;
      seen.add(key);
      ids.push(sym);
    }

    if (ids.length < 2) return '';

    // The first two distinct symbols, in order of appearance, are the most
    // likely from/to endpoints — "from X ... through to Y" naturally places
    // them in that order in the prose. If the trace fails to connect, it
    // still returns the inlined endpoint bodies (the trace-failure rewrite).
    const fromSym = ids[0]!;
    const toSym = ids[1]!;

    let traceResult: ToolResult;
    try {
      traceResult = await this.handleTrace({
        from: fromSym,
        to: toSym,
        projectPath: cg.getProjectRoot(),
      } as Record<string, unknown>);
    } catch {
      return '';
    }
    // Extract the textual body. Defensive: handleTrace's contract is the
    // standard tool-result shape used elsewhere in this file.
    const body = traceResult.content
      ?.map((c) => (c.type === 'text' ? c.text : ''))
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!body) return '';
    return [
      '',
      '## Inline flow trace',
      '',
      `Auto-traced \`${fromSym}\` → \`${toSym}\` because the query looks like a flow question. No follow-up codegraph_trace is needed for this pair.`,
      '',
      body,
    ].join('\n');
  }

  /**
   * Heuristic to detect if a query looks like a feature request
   */
  private looksLikeFeatureRequest(task: string): boolean {
    const featureKeywords = [
      'add', 'create', 'implement', 'build', 'enable', 'allow',
      'new feature', 'support for', 'ability to', 'want to',
      'should be able', 'need to add', 'swap', 'edit', 'modify'
    ];
    const bugKeywords = [
      'fix', 'bug', 'error', 'broken', 'crash', 'issue', 'problem',
      'not working', 'fails', 'undefined', 'null'
    ];
    const explorationKeywords = [
      'how does', 'where is', 'what is', 'find', 'show me',
      'explain', 'understand', 'explore'
    ];

    const lowerTask = task.toLowerCase();

    // If it's clearly a bug or exploration, not a feature
    if (bugKeywords.some(k => lowerTask.includes(k))) return false;
    if (explorationKeywords.some(k => lowerTask.includes(k))) return false;

    // If it matches feature keywords, it's likely a feature request
    return featureKeywords.some(k => lowerTask.includes(k));
  }

  /**
   * Handle codegraph_callers
   */
  private async handleCallers(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate callers across all matching symbols
    const seen = new Set<string>();
    const allCallers: Node[] = [];
    for (const node of allMatches.nodes) {
      for (const c of cg.getCallers(node.id)) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          allCallers.push(c.node);
        }
      }
    }

    if (allCallers.length === 0) {
      return this.textResult(`No callers found for "${symbol}"${allMatches.note}`);
    }

    const formatted = this.formatNodeList(allCallers.slice(0, limit), `Callers of ${symbol}`) + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_callees
   */
  private async handleCallees(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const limit = clamp((args.limit as number) || 20, 1, 100);

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate callees across all matching symbols
    const seen = new Set<string>();
    const allCallees: Node[] = [];
    for (const node of allMatches.nodes) {
      for (const c of cg.getCallees(node.id)) {
        if (!seen.has(c.node.id)) {
          seen.add(c.node.id);
          allCallees.push(c.node);
        }
      }
    }

    if (allCallees.length === 0) {
      return this.textResult(`No callees found for "${symbol}"${allMatches.note}`);
    }

    const formatted = this.formatNodeList(allCallees.slice(0, limit), `Callees of ${symbol}`) + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_impact
   */
  private async handleImpact(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const depth = clamp((args.depth as number) || 2, 1, 10);

    const allMatches = this.findAllSymbols(cg, symbol);
    if (allMatches.nodes.length === 0) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    // Aggregate impact across all matching symbols
    const mergedNodes = new Map<string, Node>();
    const mergedEdges: Edge[] = [];
    const seenEdges = new Set<string>();

    for (const node of allMatches.nodes) {
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

    const mergedImpact = {
      nodes: mergedNodes,
      edges: mergedEdges,
      roots: allMatches.nodes.map(n => n.id),
    };

    const formatted = this.formatImpact(symbol, mergedImpact) + allMatches.note;
    return this.textResult(this.truncateOutput(formatted));
  }

  /**
   * Handle codegraph_trace — shortest CALL PATH between two symbols.
   *
   * Exposes GraphTraverser.findPath: the chain of functions from `from` to `to`,
   * each hop annotated with file:line and the call-site line. This is the
   * capability grep/Read structurally cannot provide. When no static path
   * exists, the chain has almost certainly broken at dynamic dispatch
   * (callbacks, descriptors, metaclasses) — we say so and surface the start
   * symbol's outgoing calls so the agent bridges the one missing hop with
   * codegraph_node rather than blindly reading.
   */
  private async handleTrace(args: Record<string, unknown>): Promise<ToolResult> {
    const from = this.validateString(args.from, 'from');
    if (typeof from !== 'string') return from;
    const to = this.validateString(args.to, 'to');
    if (typeof to !== 'string') return to;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const fromMatches = this.findAllSymbols(cg, from);
    if (fromMatches.nodes.length === 0) return this.textResult(`Symbol "${from}" not found in the codebase`);
    const toMatches = this.findAllSymbols(cg, to);
    if (toMatches.nodes.length === 0) return this.textResult(`Symbol "${to}" not found in the codebase`);

    // Trace along call edges only — a true call path. Names can map to several
    // nodes, so try a few from×to candidate pairs until a usable path turns up.
    //
    // MAX_HOPS guard: a BFS shortest path longer than this on a dense call graph
    // is almost always a spurious wander through unrelated code (django's
    // `_fetch_all → … → execute_sql` BFS detours through prefetch/filter), not
    // the real execution flow — and a confident-but-wrong 15-hop trace is worse
    // than none. Over-cap paths are rejected and reported as "no direct path"
    // (which, on real code, means the flow breaks at dynamic dispatch).
    const edgeKinds: Edge['kind'][] = ['calls'];
    const MAX_HOPS = 7;
    // Path-proximity pairing: in a multi-module repo a symbol name like
    // `EndBlocker` exists in 20+ modules. FTS picks one almost arbitrarily;
    // the WRONG pair (e.g. simapp's wrapper EndBlocker paired with gov's Tally)
    // has no static path, falls through to the dynamic-dispatch failure branch,
    // and surfaces unrelated bodies — exactly the cosmos-Q3 trace failure mode.
    // Score every from×to combo by shared file-path prefix length; try the
    // most-co-located pair first (e.g. `x/gov/abci.go::EndBlocker` ×
    // `x/gov/keeper/tally.go::Tally` share `x/gov/`).
    //
    // Consider the FULL candidate set, not just the FTS top-5: the right
    // EndBlocker for a gov-module flow may rank 8th in FTS but share the
    // entire `x/gov/` prefix with the destination. Path-proximity supersedes
    // FTS for this disambiguation. Findpath trials are still capped by
    // FINDPATH_PAIR_BUDGET below to bound graph traversal cost.
    const sharedDirPrefixLen = (a: string, b: string): number => {
      const aDir = a.replace(/[^/]+$/, '');
      const bDir = b.replace(/[^/]+$/, '');
      let i = 0;
      while (i < aDir.length && i < bDir.length && aDir[i] === bDir[i]) i++;
      return i;
    };
    // Cosmos-Q3 surfaced a second-order failure: `enterprise/group/x/group/`
    // SHARES MORE of its path with `enterprise/group/x/group/keeper/tally.go`
    // (24 chars) than `x/gov/abci.go` shares with `x/gov/keeper/tally.go`
    // (6 chars), so pure shared-prefix prefers the side-experiment module
    // over the canonical one — even though the user's question is clearly
    // about the main gov module. Penalize candidates living under prefixes
    // that conventionally hold extensions / experiments / vendored code, so
    // the canonical-path pair wins even when its shared prefix is short.
    const isLessCanonicalPath = (p: string): boolean =>
      /^(enterprise|contrib|examples?|sample|playground|vendor|third[_-]?party|deprecated|legacy)\//i.test(p);
    const LESS_CANONICAL_PENALTY = 100; // any canonical candidate beats any less-canonical one
    const scorePair = (a: string, b: string): number =>
      sharedDirPrefixLen(a, b)
      - (isLessCanonicalPath(a) ? LESS_CANONICAL_PENALTY : 0)
      - (isLessCanonicalPath(b) ? LESS_CANONICAL_PENALTY : 0);
    const fromCands = fromMatches.nodes;
    const toCands = toMatches.nodes;
    // Candidate relevance: an overloaded name (Alamofire has 44 `request`s, most
    // of them EMPTY EventMonitor protocol-conformance stubs `func request(…){}`)
    // floods the pool with no-op decls. Shared-dir-prefix alone then MISLEADS —
    // two unrelated `Source/Features/` delegate stubs outscore the real
    // `Source/Core/Session.request` × `Source/Core/…task` pair the agent meant,
    // so trace resolves to stubs, finds no path, and the agent reads by line.
    // Penalize empty stubs and test-file symbols so a substantive entry point
    // wins; among real methods this is ~flat, so path-proximity still decides
    // (cosmos EndBlocker disambiguation is unaffected — none of its candidates
    // are stubs/tests).
    const isTestPath = (p: string): boolean => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
    const nodeRelevance = (n: Node): number => {
      const bodyLines = Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      let s = Math.min(bodyLines, 20);     // a substantive body is more likely the meant symbol
      if (bodyLines <= 1) s -= 40;          // empty/one-line stub (protocol no-op, decl-only) — almost never the trace endpoint
      if (isTestPath(n.filePath)) s -= 150; // a Source/ symbol is meant over a Tests/ same-named one
      return s;
    };
    const pairs: Array<{ f: Node; t: Node; score: number }> = [];
    for (const f of fromCands) {
      for (const t of toCands) {
        pairs.push({ f, t, score: scorePair(f.filePath, t.filePath) + nodeRelevance(f) + nodeRelevance(t) });
      }
    }
    // Sort by shared prefix desc, then by FTS order (already encoded in the
    // pairs' insertion order — both for f and t). The tiebreaker preserves
    // findAllSymbols' generated-file-last ranking.
    pairs.sort((a, b) => b.score - a.score);
    // Cap how many graph-path probes we attempt so a 50×50 cross-product
    // doesn't blow up on a god-named symbol like `Get` (well-named flows have
    // their good pair near the top of the sort anyway).
    const FINDPATH_PAIR_BUDGET = 20;
    const fromTry = fromCands;
    const toTry = toCands;
    let path: Array<{ node: Node; edge: Edge | null }> | null = null;
    let overCap: Array<{ node: Node; edge: Edge | null }> | null = null;
    let bestPair: { f: Node; t: Node } | null = null;
    let triedPairs = 0;
    for (const { f, t } of pairs) {
      if (path) break;
      if (triedPairs >= FINDPATH_PAIR_BUDGET) break;
      triedPairs++;
      const p = cg.findPath(f.id, t.id, edgeKinds);
      if (p && p.length > 1) {
        if (p.length <= MAX_HOPS) { path = p; bestPair = { f, t }; break; }
        if (!overCap || p.length < overCap.length) { overCap = p; bestPair = { f, t }; }
      } else if (!bestPair) {
        // No path yet — remember the top-scored pair so the failure branch
        // surfaces the most-co-located candidates' bodies, not whatever FTS
        // happened to put first.
        bestPair = { f, t };
      }
    }

    if (!path) {
      // No static path — almost always a dynamic-dispatch break. INSTEAD of
      // telling the agent to chase the gap with codegraph_node/callers/callees
      // (which fans out into 3-4 follow-up tool calls + a Read), inline the
      // material those would have returned right here. Measured on cosmos-Q3:
      // the failed-trace + subsequent fan-out used to cost ~2× a single
      // sufficient trace call; this branch closes that gap.
      // Prefer the path-proximity-best pair we identified above (e.g. gov's
      // EndBlocker × gov's Tally) over the FTS top-pick (simapp's wrapper).
      const start = bestPair?.f ?? fromTry[0]!;
      const end = bestPair?.t ?? toTry[0]!;
      const fileCache = new Map<string, string[]>();
      const lines = [
        `No direct static call path from "${from}" to "${to}" — the chain almost certainly breaks at dynamic dispatch (a callback / interface dispatch / framework hook / metaclass). Both endpoint bodies + their immediate neighbors are inlined below; answer from them — a follow-up codegraph_node/callers/callees on these would just return what is already here.`,
        '',
      ];
      if (overCap) {
        lines.push(
          `> Indirect chain of ${overCap.length} hops exists but is over the ${MAX_HOPS}-hop cap (usually a BFS wander through unrelated code, not the real execution flow).`,
          '',
        );
      }

      // Track which node IDs we've already inlined a body for so we don't
      // double-emit when a callee of FROM is also surfaced separately.
      const inlinedBodies = new Set<string>();
      const inlineBody = (n: Node, lineCap: number, charCap: number): boolean => {
        if (inlinedBodies.has(n.id)) return false;
        inlinedBodies.add(n.id);
        const body = this.sourceRangeAt(cg, n.filePath, n.startLine, n.endLine, fileCache, lineCap, charCap);
        if (body) { lines.push(body); return true; }
        return false;
      };

      const inlineEndpoint = (
        label: 'FROM' | 'TO',
        node: Node,
      ) => {
        lines.push(`### ${label}: \`${node.name}\` (${node.filePath}:${node.startLine}-${node.endLine})`);
        inlineBody(node, 120, 3600);
        const callers = cg.getCallers(node.id).slice(0, 6);
        if (callers.length > 0) {
          lines.push(`**Callers of \`${node.name}\`:** ` +
            callers.map(c => `${c.node.name} (${c.node.filePath}:${c.node.startLine})`).join(', '));
        }
        const callees = cg.getCallees(node.id).slice(0, 8);
        if (callees.length > 0) {
          lines.push(`**\`${node.name}\` calls:** ` +
            callees.map(c => `${c.node.name} (${c.node.filePath}:${c.node.startLine})`).join(', '));
        }
        lines.push('');
      };
      inlineEndpoint('FROM', start);
      if (end.id !== start.id) inlineEndpoint('TO', end);

      // Inline the OTHER top-level functions/methods in TO's file — that's
      // where the missing dynamic-dispatch flow usually lives. Concrete
      // measurement from cosmos-Q1: `msgServer.Send` statically calls only
      // utility functions (`StringToBytes`, `Wrapf`); its real next-hop
      // `SendCoins` is invoked via an embedded-interface call (`k.Keeper.SendCoins`)
      // that static parsing CAN'T see. The flow IS in the same file as the
      // destination (`x/bank/keeper/send.go`: SendCoins → subUnlockedCoins →
      // addCoins → setBalance). Pre-inlining those file-mates is what
      // replaces the agent's "trace fail → search SendCoins → node SendCoins
      // → trace again" fan-out.
      const NEIGHBOR_LINES = 40;
      const NEIGHBOR_CHARS = 1200;
      const NEIGHBOR_K = 5;
      const fileSiblings = (anchor: Node): Node[] => {
        // Functions and methods in the same file as the anchor, excluding
        // the anchor itself and anything we've already inlined. Sort by
        // distance from the anchor's startLine so the closest symbols come
        // first (the flow is usually adjacent in the file).
        const sameFile = cg
          .getNodesByKind('function')
          .filter((n) => n.filePath === anchor.filePath)
          .concat(
            cg.getNodesByKind('method').filter((n) => n.filePath === anchor.filePath),
          );
        return sameFile
          .filter((n) => n.id !== anchor.id && !inlinedBodies.has(n.id))
          .sort((a, b) =>
            Math.abs(a.startLine - anchor.startLine) - Math.abs(b.startLine - anchor.startLine),
          )
          .slice(0, NEIGHBOR_K);
      };
      const renderSiblings = (label: string, siblings: Node[]) => {
        if (siblings.length === 0) return;
        lines.push(`### ${label}`);
        for (const sib of siblings) {
          lines.push('');
          lines.push(`- \`${sib.name}\` (${sib.filePath}:${sib.startLine}-${sib.endLine})`);
          inlineBody(sib, NEIGHBOR_LINES, NEIGHBOR_CHARS);
        }
        lines.push('');
      };
      renderSiblings(
        `Other functions in \`${end.filePath}\` (the flow that the dynamic-dispatch hop reaches — bodies inlined)`,
        fileSiblings(end),
      );

      lines.push(
        '> Endpoint bodies + the other functions in the destination\'s file are inlined above. Together they typically cover the missing dynamic-dispatch boundary (interface-method calls like `k.Keeper.SendCoins` that static parsing can\'t follow). **No further codegraph_node / codegraph_callers / codegraph_callees / Read / Grep is needed for any symbol already shown here** — call them again only if you need to walk DEEPER than what is inlined.',
      );
      return this.textResult(this.truncateOutput(lines.join('\n') + fromMatches.note + toMatches.note));
    }

    const lines: string[] = [
      `## Trace: ${from} → ${to}`,
      '',
      `Full execution path below — ${path.length} hops, each with its body, plus what the destination calls. This is the complete flow; answer from it.`,
      '',
      `${path.length} hops:`,
      '',
    ];
    // Inline what each hop needs so the agent doesn't Read/Grep to get it: the
    // call-site source line, the registration site for dynamic-dispatch hops, AND
    // the hop's own body (capped per hop so the trace stays path-scoped). Earlier
    // versions inlined only the call-site line, which left agents calling explore
    // or Read for the bodies — the exact follow-up the ablation experiment measured.
    const fileCache = new Map<string, string[]>();
    for (let i = 0; i < path.length; i++) {
      const step = path[i]!;
      if (step.edge) {
        const synth = this.synthEdgeNote(step.edge);
        if (synth) {
          lines.push(`   ↓ ${synth.label}`);
          if (synth.registeredAt) {
            const regSrc = this.sourceLineAt(cg, synth.registeredAt, fileCache);
            lines.push(`     ↳ registered at ${synth.registeredAt}${regSrc ? `   ${regSrc}` : ''}`);
          }
        } else {
          // The call happens in the PREVIOUS hop's file at edge.line.
          const prev = path[i - 1];
          const ref = prev && step.edge.line ? `${prev.node.filePath}:${step.edge.line}` : undefined;
          const callSrc = this.sourceLineAt(cg, ref, fileCache);
          lines.push(`   ↓ ${step.edge.kind}${step.edge.line ? `@${step.edge.line}` : ''}${callSrc ? `   ${callSrc}` : ''}`);
        }
      }
      lines.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine}-${step.node.endLine})`);
      const body = this.sourceRangeAt(cg, step.node.filePath, step.node.startLine, step.node.endLine, fileCache, 60, 1800);
      if (body) lines.push(body);
    }
    // The "last mile": what the destination does next. Agents otherwise explore/Read
    // for exactly this (e.g. renderStaticScene → _renderStaticScene → the canvas draw),
    // so inlining the destination's callees is what actually stops the investigation —
    // sufficiency, not a "don't explore" instruction.
    const dest = path[path.length - 1]!.node;
    const destCallees = cg.getCallees(dest.id)
      .filter(c => !path.some(p => p.node.id === c.node.id))
      .slice(0, 6);
    if (destCallees.length > 0) {
      lines.push('', `### \`${dest.name}\` then calls (the destination's immediate work):`);
      for (const c of destCallees) {
        lines.push('', `- ${c.node.name} (${c.node.filePath}:${c.node.startLine}-${c.node.endLine})`);
        const body = this.sourceRangeAt(cg, c.node.filePath, c.node.startLine, c.node.endLine, fileCache, 16, 600);
        if (body) lines.push(body);
      }
    }
    lines.push('', '> Full path + every hop body + the destination\'s calls are inlined above — the complete flow. Answer from it; a Read is only needed to chase a specific local variable\'s data-flow.');
    return this.textResult(this.truncateOutput(lines.join('\n')));
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
    return null;
  }

  /**
   * Read one trimmed source line at "relpath:line" (relative to the project
   * root). `cache` holds split file contents so a multi-hop trace reads each
   * file at most once. Returns null if the file/line can't be resolved.
   */
  private sourceLineAt(cg: CodeGraph, ref: string | undefined, cache: Map<string, string[]>): string | null {
    if (!ref) return null;
    const i = ref.lastIndexOf(':');
    if (i < 0) return null;
    const filePath = ref.slice(0, i);
    const line = parseInt(ref.slice(i + 1), 10);
    if (!Number.isFinite(line) || line < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
      if (!abs || !existsSync(abs)) return null;
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, fileLines);
    }
    const raw = fileLines[line - 1];
    if (raw == null) return null;
    const t = raw.trim();
    return t.length > 160 ? t.slice(0, 157) + '…' : t;
  }

  /**
   * Read a hop's body — filePath lines [startLine..endLine] — for inlining into
   * a trace, capped (lines + chars) so the whole path stays path-scoped even on
   * a 7-hop chain. Dedents to the body's own indentation and marks truncation.
   * Shares `cache` with sourceLineAt so each file is read at most once per trace.
   */
  private sourceRangeAt(
    cg: CodeGraph,
    filePath: string,
    startLine: number,
    endLine: number,
    cache: Map<string, string[]>,
    maxLines = 28,
    maxChars = 1200
  ): string | null {
    if (!Number.isFinite(startLine) || startLine < 1) return null;
    let fileLines = cache.get(filePath);
    if (!fileLines) {
      const abs = validatePathWithinRoot(cg.getProjectRoot(), filePath);
      if (!abs || !existsSync(abs)) return null;
      try { fileLines = readFileSync(abs, 'utf-8').split('\n'); } catch { return null; }
      cache.set(filePath, fileLines);
    }
    const end = Number.isFinite(endLine) && endLine >= startLine ? endLine : startLine;
    let slice = fileLines.slice(startLine - 1, end);
    if (slice.length === 0) return null;
    let omitted = 0;
    if (slice.length > maxLines) { omitted = slice.length - maxLines; slice = slice.slice(0, maxLines); }
    const nonBlank = slice.filter(l => l.trim().length > 0);
    const dedent = nonBlank.length ? Math.min(...nonBlank.map(l => l.length - l.trimStart().length)) : 0;
    let text = slice.map((l, i) => `      ${startLine + i}\t${l.slice(dedent)}`).join('\n');
    if (text.length > maxChars) {
      text = text.slice(0, maxChars).replace(/\n[^\n]*$/, '');
      omitted = Math.max(omitted, 1);
    }
    if (omitted > 0) text += `\n      … (+${omitted} more line${omitted === 1 ? '' : 's'})`;
    return text;
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
  private buildFlowFromNamedSymbols(cg: CodeGraph, query: string): { text: string; pathNodeIds: Set<string>; namedNodeIds: Set<string>; uniqueNamedNodeIds: Set<string> } {
    const EMPTY = { text: '', pathNodeIds: new Set<string>(), namedNodeIds: new Set<string>(), uniqueNamedNodeIds: new Set<string>() };
    try {
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      // Strip only a REAL file extension (Create.cs → Create); KEEP qualified
      // names (Class.method / Class::method) — the agent's most precise input,
      // resolved exactly by findAllSymbols. (The old strip mangled Class.method
      // into Class, throwing the method away.)
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
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
      for (const t of tokens) {
        const cands = this.findAllSymbols(cg, t).nodes.filter((n) => CALLABLE.has(n.kind));
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
        for (const n of pick.slice(0, 6)) {
          named.set(n.id, n);
          if (specific) uniqueNamedNodeIds.add(n.id);
        }
        if (named.size > 40) break;
      }
      if (named.size < 2) return EMPTY;
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

      // Supplementary: dynamic-dispatch (synthesized) edges incident to a NAMED
      // symbol — the indirect hops an agent would otherwise grep/Read to
      // reconstruct ("where do the appended `validators` actually run?"). The
      // synth edge IS that answer, so surface it even when the OTHER end wasn't
      // named (e.g. the agent names `validate` but not the `didCompleteTask`
      // that drains the collection). On-topic by construction: only heuristic
      // edges touching a symbol the agent named; skipped when the hop already
      // shows in the main chain.
      const synthLines: string[] = [];
      const synthSeen = new Set<string>();
      for (const n of named.values()) {
        if (synthLines.length >= 6) break;
        for (const { node: other, edge } of [...cg.getCallers(n.id), ...cg.getCallees(n.id)]) {
          if (synthLines.length >= 6) break;
          if (edge.provenance !== 'heuristic' || other.id === n.id) continue;
          if (pathIds.has(edge.source) && pathIds.has(edge.target)) continue; // already in the main chain
          const src = edge.source === n.id ? n : other;
          const tgt = edge.source === n.id ? other : n;
          const key = `${src.name}>${tgt.name}`;
          if (synthSeen.has(key)) continue;
          synthSeen.add(key);
          const note = this.synthEdgeNote(edge);
          synthLines.push(`- ${src.name} → ${tgt.name}   [${note ? note.compact : edge.kind}]`);
        }
      }

      if (!hasMain && synthLines.length === 0) return EMPTY;
      const out: string[] = [];
      if (hasMain) {
        out.push('## Flow (call path among the symbols you queried)', '');
        for (let i = 0; i < best!.length; i++) {
          const step = best![i]!;
          if (step.edge) { const sy = this.synthEdgeNote(step.edge); out.push(`   ↓ ${sy ? sy.compact : step.edge.kind}`); }
          out.push(`${i + 1}. ${step.node.name} (${step.node.filePath}:${step.node.startLine})`);
        }
        out.push('');
      }
      if (synthLines.length) {
        out.push(
          '## Dynamic-dispatch links among your symbols',
          '(synthesized — the indirect hops grep/Read would reconstruct; the `@file:line` is the wiring site)',
          '',
          ...synthLines,
          ''
        );
      }
      out.push('> Full source for these symbols is below; codegraph_trace(from,to) for the exact path between two endpoints.', '');
      // namedNodeIds = every callable the agent explicitly named (a superset of
      // the spine). A file holding one is something the agent asked to SEE, so it
      // must keep full source even if it's an off-spine polymorphic sibling — the
      // agent named `getResponseWithInterceptorChain` / `SQLCompiler.execute_sql`
      // as the mechanism, not as an interchangeable leaf. See the skeleton gate.
      return { text: out.join('\n'), pathNodeIds: pathIds, namedNodeIds: new Set(named.keys()), uniqueNamedNodeIds };
    } catch {
      return EMPTY;
    }
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
    const query = this.validateString(args.query, 'query');
    if (typeof query !== 'string') return query;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    const projectRoot = cg.getProjectRoot();

    // Resolve adaptive output budget from project size. Falls back to the
    // largest-tier defaults if stats aren't available, which preserves
    // pre-#185 behavior for callers that hit the rare stats failure.
    let budget: ExploreOutputBudget;
    try {
      budget = getExploreOutputBudget(cg.getStats().fileCount);
    } catch {
      budget = getExploreOutputBudget(Infinity);
    }
    const maxFiles = clamp((args.maxFiles as number) || budget.defaultMaxFiles, 1, 20);

    // Step 1: Find relevant context with generous parameters.
    // Use a large maxNodes budget — explore has its own 35k char output limit
    // that prevents context bloat, so more nodes just means better coverage
    // across entry points (especially for large files like Svelte components).
    const subgraph = await cg.findRelevantContext(query, {
      searchLimit: 8,
      traversalDepth: 3,
      maxNodes: 200,
      minScore: 0.2,
    });

    if (subgraph.nodes.size === 0) {
      return this.textResult(`No relevant code found for "${query}"`);
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
    {
      const FILE_EXT = /\.(?:java|kt|kts|ts|tsx|js|jsx|mjs|cjs|cs|py|go|rb|php|swift|rs|cpp|cc|cxx|c|h|hpp|scala|lua|dart|vue|svelte)$/i;
      const CALLABLE = new Set(['method', 'function', 'component', 'constructor']);
      const isTestPath = (p: string) => /(^|\/)(tests?|specs?|__tests__|testdata|mocks?|fixtures?)\//i.test(p) || /\.(test|spec)\.[a-z]+$/i.test(p);
      const bodyLines = (n: Node) => Math.max(0, (n.endLine ?? n.startLine) - n.startLine);
      const tokens = [...new Set(
        query.split(/[\s,()[\]]+/)
          .map((t) => t.replace(FILE_EXT, '').trim())
          .filter((t) => t.length >= 3 && /^[A-Za-z_$][\w$]*(?:(?:::|\.)[\w$]+)*$/.test(t))
      )].slice(0, 16);
      for (const t of tokens) {
        const cands = this.findAllSymbols(cg, t).nodes
          .filter((n) => CALLABLE.has(n.kind) && !isTestPath(n.filePath))
          .sort((a, b) => (bodyLines(b) > 1 ? 1 : 0) - (bodyLines(a) > 1 ? 1 : 0) || bodyLines(b) - bodyLines(a));
        // A specific name (<=3 defs) injects all its defs; an overloaded name
        // (`request` = 44, mostly stubs) injects only the single most substantive
        // one, so the build-overload flood doesn't crowd the subgraph.
        for (const n of cands.slice(0, cands.length <= 3 ? cands.length : 1)) {
          if (!subgraph.nodes.has(n.id)) { subgraph.nodes.set(n.id, n); namedSeedIds.add(n.id); }
        }
      }
    }

    // Step 2: Group nodes by file, score by relevance
    const fileGroups = new Map<string, { nodes: Node[]; score: number }>();
    const entryNodeIds = new Set([...subgraph.roots, ...namedSeedIds]);

    // Build a set of nodes directly connected to entry points (depth 1)
    const connectedToEntry = new Set<string>();
    for (const edge of subgraph.edges) {
      if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
      if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
    }

    for (const node of subgraph.nodes.values()) {
      // Skip import/export nodes — they add noise without information
      if (node.kind === 'import' || node.kind === 'export') continue;

      const group = fileGroups.get(node.filePath) || { nodes: [], score: 0 };
      group.nodes.push(node);
      // Score: a NAMED-SEED node (a symbol the agent named that FTS missed, now
      // injected) is worth far more than a mere reference — its file is where the
      // answer lives. Without this, an incidental file that name-drops the flow
      // (Combine.swift references request/task → score 23 from connected nodes)
      // outranks the file that DEFINES a named symbol (Validation.swift's
      // `validate` → 10) and steals its render slot. Definition ≫ reference.
      if (namedSeedIds.has(node.id)) {
        group.score += 50;
      } else if (entryNodeIds.has(node.id)) {
        group.score += 10;
      } else if (connectedToEntry.has(node.id)) {
        group.score += 3;
      } else {
        group.score += 1;
      }
      fileGroups.set(node.filePath, group);
    }

    // Only include files that have entry points or nodes directly connected to entry points
    let relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);

    // Extract query terms for relevance checking
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);

    // Test/spec/icon/i18n file detector — used both for the pre-sort hard
    // filter (tiny tier) and the comparator deprioritization (all tiers).
    const isLowValue = (p: string) => {
      const lp = p.toLowerCase();
      return (
        /\/(tests?|__tests?__|spec)\//.test(lp) ||
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

    // Hard-exclude test/spec files (ALL tiers, not just tiny). One slipped test
    // file dominates the per-file budget on small repos (cobra's `command_test.go`
    // displaced `args.go`) AND wastes budget on large ones (Django's
    // `custom_lookups/tests.py` ate ~2.3 KB of the 28 KB cap, crowding out the
    // SQLCompiler mechanism the agent then Read). A test file almost never answers
    // an architecture question. Skip when the query itself is about tests — the
    // legitimate "explore the tests" case — and only cut if ≥2 non-test candidates
    // remain (else tests are the only signal for this area).
    {
      const queryMentionsTests = /\b(test|tests|testing|spec|verify|verifies)\b/i.test(query);
      if (!queryMentionsTests) {
        const nonLow = relevantFiles.filter(([p]) => !isLowValue(p));
        if (nonLow.length >= 2) {
          relevantFiles = nonLow;
        }
      }
    }

    // Sort files: highest relevance first, deprioritize low-value files
    const sortedFiles = relevantFiles.sort((a, b) => {
      const aPath = a[0].toLowerCase();
      const bPath = b[0].toLowerCase();

      // Check if any node name or file path relates to query terms
      const hasQueryRelevance = (filePath: string, nodes: Node[]) => {
        const fp = filePath.toLowerCase();
        if (queryTerms.some(t => fp.includes(t))) return true;
        return nodes.some(n => queryTerms.some(t => n.name.toLowerCase().includes(t)));
      };

      const aRelevant = hasQueryRelevance(aPath, a[1].nodes);
      const bRelevant = hasQueryRelevance(bPath, b[1].nodes);
      if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

      const aLow = isLowValue(aPath);
      const bLow = isLowValue(bPath);
      if (aLow !== bLow) return aLow ? 1 : -1;

      // Deprioritize generated source (.pb.go / .pulsar.go / _mocks.go / …) —
      // the agent rarely needs to see the protobuf scaffold or gomock output
      // when asking about the actual flow, and dumping their bodies inflates
      // the response (the cosmos Q3 explore otherwise leads with
      // `expected_keepers_mocks.go`, displacing the real `tally.go` content
      // and forcing the agent to Read tally.go anyway).
      const aGen = isGeneratedFile(a[0]);
      const bGen = isGeneratedFile(b[0]);
      if (aGen !== bGen) return aGen ? 1 : -1;

      if (a[1].score !== b[1].score) return b[1].score - a[1].score;
      return b[1].nodes.length - a[1].nodes.length;
    });

    // Step 3: Build relationship map
    const lines: string[] = [
      `## Exploration: ${query}`,
      '',
      `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
      '',
    ];

    // Relationship map — show how symbols connect
    const significantEdges = subgraph.edges.filter(e =>
      e.kind !== 'contains' // skip contains — it's implied by file grouping
    );

    if (budget.includeRelationships && significantEdges.length > 0) {
      lines.push('### Relationships');
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
    const flow = this.buildFlowFromNamedSymbols(cg, query);

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
        if (n.kind !== 'class' && n.kind !== 'interface' && n.kind !== 'struct'
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

    lines.push('### Source Code');
    lines.push('');
    lines.push('> The code below is the **verbatim, current on-disk source** of these files — re-read from disk on this call and line-numbered, byte-for-byte identical to what the Read tool returns. It is NOT a summary, outline, or stale cache. Treat each block as a Read you have already performed: do not Read a file shown here.');
    lines.push('');

    let totalChars = lines.join('\n').length;
    let filesIncluded = 0;
    let anyFileTrimmed = false;

    for (const [filePath, group] of sortedFiles) {
      if (filesIncluded >= maxFiles) break;
      // A file DEFINES a named/spine symbol (the answer) vs merely references the
      // flow. Past 90% budget, stop pulling INCIDENTAL files — but keep scanning
      // for necessary ones, which render even past the cap (bounded by maxFiles).
      // Without this `continue` (was an unconditional `break`), the loop stopped
      // after the build + validators-exec files and never reached the ranked-in
      // validate-logic file (Alamofire's Validation.swift).
      const fileNecessary = group.nodes.some(n =>
        entryNodeIds.has(n.id) || flow.pathNodeIds.has(n.id) || flow.uniqueNamedNodeIds.has(n.id));
      if (!fileNecessary && totalChars > budget.maxOutputChars * 0.9) continue;

      const absPath = validatePathWithinRoot(projectRoot, filePath);
      if (!absPath || !existsSync(absPath)) continue;

      let fileContent: string;
      try {
        fileContent = readFileSync(absPath, 'utf-8');
      } catch {
        continue;
      }

      const fileLines = fileContent.split('\n');
      const lang = group.nodes[0]?.language || '';

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
        .reduce((s, n) => s + fileLines.slice(n.startLine - 1, Math.min(n.endLine, n.startLine + 220)).join('\n').length, 0);
      const onSpineGodFile = hasSpineNode
        && namedBodyChars > budget.maxCharsPerFile
        && group.nodes.some(n => CALLABLE_BODY.has(n.kind) && flow.uniqueNamedNodeIds.has(n.id) && !flow.pathNodeIds.has(n.id));
      if (adaptiveExploreEnabled() && flow.pathNodeIds.size > 0
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
        const bodyCap = budget.maxCharsPerFile * 2;
        const bodyIds = new Set<string>();
        let bodyChars = 0;
        for (const n of syms.filter(n => prio(n) < 99 && n.endLine >= n.startLine).sort((a, b) => prio(a) - prio(b))) {
          const sz = fileLines.slice(n.startLine - 1, Math.min(n.endLine, n.startLine + 220)).join('\n').length;
          // Spine methods (prio 0) ALWAYS get a full body — the cap governs the
          // off-path extras (unique-named, family base), never the flow path itself.
          if (prio(n) > 0 && bodyChars + sz > bodyCap && bodyIds.size > 0) continue;
          bodyIds.add(n.id);
          bodyChars += sz;
        }
        // Pass 2: render in line order — full body for chosen symbols, else the
        // signature line (capped, with a "+N more" tail so the structure map of a
        // god-file doesn't itself bloat the budget).
        const skel: string[] = [];
        let coveredUntil = 0; // skip symbols already inside an emitted body
        let sigCount = 0, sigDropped = 0;
        const SIG_MAX = Math.max(12, budget.maxSymbolsInFileHeader * 2);
        for (const n of syms) {
          if (n.startLine <= coveredUntil) continue;
          if (bodyIds.has(n.id)) {
            const end = Math.min(n.endLine, n.startLine + 220);
            const body = fileLines.slice(n.startLine - 1, end).join('\n');
            skel.push(exploreLineNumbersEnabled() ? numberSourceLines(body, n.startLine) : body);
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
            if (sig) { skel.push(exploreLineNumbersEnabled() ? `${lineNo}\t${sig}` : sig); sigCount++; }
          }
        }
        if (sigDropped > 0) skel.push(`… +${sigDropped} more (signatures elided)`);
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
          lines.push(`#### ${filePath} — ${names} · ${tag}`, '', '```' + lang, skel.join('\n'), '```', '');
          totalChars += skel.join('\n').length + 120;
          filesIncluded++;
          continue;
        }
      }

      // Whole-small-file rule: if a relevant file is small enough to afford,
      // return it ENTIRELY instead of clustering. Clustering exists to tame
      // god-files (App.tsx ~13k lines); on a ~134-line component a cluster is a
      // lossy subset of a file the agent will just Read in full anyway — costing
      // a round-trip and a re-read every later turn. Reserve clustering for files
      // too big to ship whole. Still bounded by the total maxOutputChars check.
      const WHOLE_FILE_MAX_LINES = 220;
      const WHOLE_FILE_MAX_CHARS = budget.maxCharsPerFile * 3;
      if (fileLines.length <= WHOLE_FILE_MAX_LINES && fileContent.length <= WHOLE_FILE_MAX_CHARS) {
        const body = fileContent.replace(/\n+$/, '');
        let wholeSection = exploreLineNumbersEnabled() ? numberSourceLines(body, 1) : body;
        const uniqSymbols = [...new Set(
          group.nodes
            .filter(n => n.kind !== 'import' && n.kind !== 'export')
            .map(n => `${n.name}(${n.kind})`)
        )];
        const headerNames = uniqSymbols.slice(0, budget.maxSymbolsInFileHeader);
        const omitted = uniqSymbols.length - headerNames.length;
        const wholeHeader = `#### ${filePath} — ${omitted > 0 ? `${headerNames.join(', ')}, +${omitted} more` : headerNames.join(', ')}`;

        if (totalChars + wholeSection.length + 200 > budget.maxOutputChars) {
          const remaining = budget.maxOutputChars - totalChars - 200;
          if (remaining < 500) break;
          wholeSection = wholeSection.slice(0, remaining) + '\n... (trimmed) ...';
          anyFileTrimmed = true;
        }
        lines.push(wholeHeader, '', '```' + lang, wholeSection, '```', '');
        totalChars += wholeSection.length + 200;
        filesIncluded++;
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
      const ENVELOPE_KINDS = new Set(['file', 'module', 'class', 'struct', 'interface', 'enum', 'namespace', 'protocol', 'trait', 'component']);
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
      const ranges: Array<{ start: number; end: number; name: string; kind: string; importance: number }> = [...rangeNodes.values()]
        // Drop whole-file envelope nodes (containers covering >50% of the file).
        .filter(n => !(ENVELOPE_KINDS.has(n.kind) && (n.endLine - n.startLine + 1) > fileLines.length * 0.5))
        .map(n => {
          let importance = 1;
          if (entryNodeIds.has(n.id)) importance = 10;
          else if (flow.namedNodeIds.has(n.id)) importance = 9; // agent named it → keep its cluster
          else if (glueNodeIds.has(n.id)) importance = 6; // bridging caller/callee of an entry
          else if (connectedToEntry.has(n.id)) importance = 3;
          return { start: n.startLine, end: n.endLine, name: n.name, kind: n.kind, importance };
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
          ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
        }
      }

      ranges.sort((a, b) => a.start - b.start);

      if (ranges.length === 0) continue;

      const gapThreshold = budget.gapThreshold;
      const clusters: Array<{ start: number; end: number; symbols: string[]; score: number; maxImportance: number }> = [];
      let current = {
        start: ranges[0]!.start,
        end: ranges[0]!.end,
        symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
        score: ranges[0]!.importance,
        maxImportance: ranges[0]!.importance,
      };

      for (let i = 1; i < ranges.length; i++) {
        const r = ranges[i]!;
        if (r.start <= current.end + gapThreshold) {
          current.end = Math.max(current.end, r.end);
          current.symbols.push(`${r.name}(${r.kind})`);
          current.score += r.importance;
          current.maxImportance = Math.max(current.maxImportance, r.importance);
        } else {
          clusters.push(current);
          current = {
            start: r.start,
            end: r.end,
            symbols: [`${r.name}(${r.kind})`],
            score: r.importance,
            maxImportance: r.importance,
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
      const withLineNumbers = exploreLineNumbersEnabled();
      const buildSection = (c: { start: number; end: number }): string => {
        const startIdx = Math.max(0, c.start - 1 - contextPadding);
        const endIdx = Math.min(fileLines.length, c.end + contextPadding);
        const slice = fileLines.slice(startIdx, endIdx).join('\n');
        // startIdx is 0-based, so the slice's first line is line startIdx + 1.
        return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
      };
      // Language-neutral separator (no `//` — not a comment in Python, Ruby,
      // etc.). With line numbers on, the line-number jump also signals the gap.
      const GAP_MARKER = '\n\n... (gap) ...\n\n';

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
          if (b.c.maxImportance !== a.c.maxImportance) return b.c.maxImportance - a.c.maxImportance;
          const densityA = a.c.score / a.span;
          const densityB = b.c.score / b.span;
          if (densityB !== densityA) return densityB - densityA;
          if (b.c.score !== a.c.score) return b.c.score - a.c.score;
          return a.span - b.span;
        });

      // Per-file budget is the SMALLER of the per-file cap and what's left of the
      // total output cap — so selection (which ranks by importance) keeps the
      // high-importance clusters and drops peripheral ones, instead of the
      // downstream source-order trim slicing off whatever comes last in the file.
      // That source-order slice is what cut Django's `_fetch_all` (L2237, importance
      // 9 — agent-named) when query.py was the last of four big files to be emitted.
      const fileBudget = Math.min(budget.maxCharsPerFile, Math.max(0, budget.maxOutputChars - totalChars - 200));
      const chosenIndices = new Set<number>();
      let projectedChars = 0;
      for (const rc of rankedClusters) {
        const sectionLen = buildSection(rc.c).length + (chosenIndices.size > 0 ? GAP_MARKER.length : 0);
        // Always take the top-ranked cluster, even if oversize, so we don't
        // return an empty file section (agent would then re-Read the file,
        // negating the savings).
        if (chosenIndices.size === 0) {
          chosenIndices.add(rc.idx);
          projectedChars += sectionLen;
          continue;
        }
        if (projectedChars + sectionLen > fileBudget) continue;
        chosenIndices.add(rc.idx);
        projectedChars += sectionLen;
      }

      // Emit chosen clusters in source order so the file reads top-to-bottom.
      let fileSection = '';
      const allSymbols: string[] = [];
      let fileTrimmed = false;
      for (let i = 0; i < clusters.length; i++) {
        if (!chosenIndices.has(i)) continue;
        const cluster = clusters[i]!;
        const section = buildSection(cluster);
        if (fileSection.length > 0) fileSection += GAP_MARKER;
        fileSection += section;
        allSymbols.push(...cluster.symbols);
      }

      // If a single chosen cluster is still oversize (long monolithic
      // function), tail-trim it. Better one trimmed view than nothing.
      if (fileSection.length > budget.maxCharsPerFile) {
        fileSection = fileSection.slice(0, budget.maxCharsPerFile) + '\n... (trimmed) ...';
        fileTrimmed = true;
      }
      if (chosenIndices.size < clusters.length || fileTrimmed) {
        anyFileTrimmed = true;
      }

      // Dedupe + cap the symbols list shown in the per-file header. Some
      // files (Session.swift in Alamofire) produced 3.4KB symbol lists
      // from cluster scoring + edge-source lines, dwarfing the per-file
      // body cap. Show top names by frequency, with a "+N more" tail.
      const symbolCounts = new Map<string, number>();
      for (const s of allSymbols) {
        symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);
      }
      const sortedSymbols = [...symbolCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([name]) => name);
      const headerCap = budget.maxSymbolsInFileHeader;
      const headerSymbols = sortedSymbols.slice(0, headerCap);
      const omittedCount = sortedSymbols.length - headerSymbols.length;
      const headerSuffix = omittedCount > 0
        ? `${headerSymbols.join(', ')}, +${omittedCount} more`
        : headerSymbols.join(', ');
      const fileHeader = `#### ${filePath} — ${headerSuffix}`;

      // The total cap bounds INCIDENTAL files only. A file that DEFINES a symbol
      // the agent named (or that's on the flow spine) renders even when the
      // nominal total is used up — it's the answer, and the set is bounded by
      // maxFiles AND by true-spine/named-seeding having already trimmed each file
      // to its necessary content. A file that merely REFERENCES the flow
      // (Combine.swift name-drops request/task) is incidental → still capped, so
      // freed budget never leaks into noise. This is the last god-file layer:
      // build (Session, true-spined) + validators-exec (Request) + validate
      // (DataRequest/Validation) all render, instead of the cap dropping whichever
      // phase the file order happened to put last.
      if (!fileNecessary && totalChars + fileSection.length + 200 > budget.maxOutputChars) {
        const remaining = budget.maxOutputChars - totalChars - 200;
        if (remaining < 500) continue; // incidental file, no room — skip it, keep scanning for necessary ones
        fileSection = fileSection.slice(0, remaining) + '\n... (trimmed) ...';
        anyFileTrimmed = true;
      }

      lines.push(fileHeader);
      lines.push('');
      lines.push('```' + lang);
      lines.push(fileSection);
      lines.push('```');
      lines.push('');

      totalChars += fileSection.length + 200;
      filesIncluded++;
    }

    // Add remaining files as references (from both relevant and peripheral files).
    // Small projects (per budget) skip this — the relevant story already fits
    // in the source section, and a trailing pointer list is pure overhead.
    if (budget.includeAdditionalFiles) {
      const remainingRelevant = sortedFiles.slice(filesIncluded);
      const peripheralFiles = [...fileGroups.entries()]
        .filter(([, group]) => group.score < 3)
        .sort((a, b) => b[1].score - a[1].score);
      const remainingFiles = [...remainingRelevant, ...peripheralFiles];
      if (remainingFiles.length > 0) {
        lines.push('### Not shown above — explore these names for their source');
        lines.push('');
        for (const [filePath, group] of remainingFiles.slice(0, 10)) {
          const symbols = group.nodes.map(n => `${n.name}:${n.startLine}`).join(', ');
          lines.push(`- ${filePath}: ${symbols}`);
        }
        if (remainingFiles.length > 10) {
          lines.push(`- ... and ${remainingFiles.length - 10} more files`);
        }
      }
    }

    // Add completeness signal so agents know they don't need to re-read these files.
    // On small projects the budget gates this off — but if we actually had to
    // trim or drop clusters, surface a brief note so the agent knows it can
    // still Read for more detail.
    if (budget.includeCompletenessSignal) {
      lines.push('');
      lines.push('---');
      lines.push(`> **Complete source for ${filesIncluded} files is included above — do NOT re-read them.** If your question also needs files/symbols listed under "Not shown above" (or any area this call didn't cover), make ANOTHER codegraph_explore targeting those names — it returns the same source with line numbers and is cheaper and more complete than reading. Reserve Read for a single specific line range explore can't surface.`);
    } else if (anyFileTrimmed) {
      lines.push('');
      lines.push(`> Some file sections were trimmed for size. For a specific symbol you still need, run another \`codegraph_explore\` (or \`codegraph_node\`) with its exact name — line-numbered source, cheaper and more complete than Read.`);
    }

    // Add explore budget note based on project size
    if (budget.includeBudgetNote) {
      try {
        const stats = cg.getStats();
        const callBudget = getExploreBudget(stats.fileCount);
        lines.push('');
        lines.push(`> **Explore budget: ${callBudget} calls for this project (${stats.fileCount.toLocaleString()} files indexed).** Each call covers ~6 files; if your question spans more, spend your remaining calls on the uncovered area BEFORE falling back to Read — another explore is cheaper and more complete than reading those files. Synthesize once you've used ${callBudget}.`);
      } catch {
        // Stats unavailable — skip budget note
      }
    }

    // Hard-cap to the adaptive budget. The per-file loop bounds the source
    // sections, but the relationship map, additional-files list, and
    // completeness/budget notes can still push the assembled output past
    // maxOutputChars (observed 30k against a 28k tier cap). A fat explore
    // payload persists in the agent's context and is re-read as cache-input
    // on every subsequent turn, so the overrun is paid many times over.
    // Final ceiling. The render loop is now the authority on WHAT to emit — it
    // renders necessary files (named/spine) even past maxOutputChars and caps
    // only incidental ones, all bounded by maxFiles + per-file true-spine — so
    // this is a SAFETY ceiling above that necessary content, not a hard cut
    // through it. Cutting at a flat maxOutputChars here undid the whole point:
    // Alamofire's loop assembles build+validators-exec+validate (~15K) and a 13K
    // slice dropped the validate phase the agent then Read. Allow necessary
    // overflow up to 1.5× (still bounds a pathological monolith).
    const output = flow.text + lines.join('\n');
    const hardCeiling = Math.round(budget.maxOutputChars * 1.5);
    if (output.length > hardCeiling) {
      const cut = output.slice(0, hardCeiling);
      const lastNewline = cut.lastIndexOf('\n');
      const safe = lastNewline > hardCeiling * 0.8 ? cut.slice(0, lastNewline) : cut;
      return this.textResult(safe + '\n\n... (output truncated to budget; the source above is complete and verbatim — treat it as already Read. For any area not covered, run another codegraph_explore with the specific names — do NOT Read these files.)');
    }
    return this.textResult(output);
  }

  /**
   * Handle codegraph_node
   */
  private async handleNode(args: Record<string, unknown>): Promise<ToolResult> {
    const symbol = this.validateString(args.symbol, 'symbol');
    if (typeof symbol !== 'string') return symbol;

    const cg = this.getCodeGraph(args.projectPath as string | undefined);
    // Default to false to minimize context usage
    const includeCode = args.includeCode === true;

    const match = this.findSymbol(cg, symbol);
    if (!match) {
      return this.textResult(`Symbol "${symbol}" not found in the codebase`);
    }

    let code: string | null = null;
    let outline: string | null = null;

    if (includeCode) {
      // For container symbols (class/interface/struct/…), the full body is the
      // sum of every method body — a wall of source (e.g. a 10k-char class)
      // that bloats context and is rarely needed in full. Return a structural
      // outline (members + signatures + line numbers) instead; the agent can
      // Read or codegraph_node a specific method for its body. Leaf symbols
      // (function/method/etc.) return their full body as before.
      if (CONTAINER_NODE_KINDS.has(match.node.kind)) {
        outline = this.buildContainerOutline(cg, match.node);
      }
      if (!outline) {
        code = await cg.getCode(match.node.id);
      }
    }

    const trail = this.formatTrail(cg, match.node);
    const formatted = this.formatNodeDetails(match.node, code, outline) + trail + match.note;
    return this.textResult(this.truncateOutput(formatted));
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
    const lines: string[] = ['', '### Trail — codegraph_node any of these to follow it (no Read needed)'];
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
      '## CodeGraph Status',
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

    lines.push('', '### Nodes by Kind:');

    for (const [kind, count] of Object.entries(stats.nodesByKind)) {
      if ((count as number) > 0) {
        lines.push(`- ${kind}: ${count}`);
      }
    }

    lines.push('', '### Languages:');
    for (const [lang, count] of Object.entries(stats.filesByLanguage)) {
      if ((count as number) > 0) {
        lines.push(`- ${lang}: ${count}`);
      }
    }

    // Per-file freshness — the inverse of the auto-prepended staleness banner
    // (issue #403). Surfacing it inside `status` gives the agent a single
    // place to ask "is the index caught up?" rather than inferring from
    // banners on other tool calls.
    const pending = cg.getPendingFiles();
    if (pending.length > 0) {
      lines.push('', '### Pending sync:');
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
    const lines: string[] = [`## Files (${files.length})`, ''];

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

    const lines: string[] = [`## Files by Language (${files.length} total)`, ''];

    // Sort languages by file count (descending)
    const sortedLangs = [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);

    for (const [lang, langFiles] of sortedLangs) {
      lines.push(`### ${lang} (${langFiles.length})`);
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
    const lines: string[] = [`## Project Structure (${files.length} files)`, ''];

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

  private findSymbol(cg: CodeGraph, symbol: string): { node: Node; note: string } | null {
    // Use higher limit for qualified lookups (e.g., "Session.request",
    // "stage_apply::run") since the target may rank lower in FTS when
    // there are many partial matches across the qualifier parts.
    const isQualified = /[.\/]|::/.test(symbol);
    const limit = isQualified ? 50 : 10;
    let results = cg.searchNodes(symbol, { limit });

    // FTS strips colons as a special char, so `stage_apply::run` searches
    // for the literal `stage_applyrun` and finds nothing. Re-search by
    // the bare last part and let `matchesSymbol` filter by qualifier.
    if (isQualified && results.length === 0) {
      const tail = lastQualifierPart(symbol);
      if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
    }

    if (results.length === 0 || !results[0]) {
      return null;
    }

    const exactMatches = results.filter(r => this.matchesSymbol(r.node, symbol));

    if (exactMatches.length === 1) {
      return { node: exactMatches[0]!.node, note: '' };
    }

    if (exactMatches.length > 1) {
      // Down-rank generated files (.pb.go, .pulsar.go, _grpc.pb.go, …)
      // so a query like "Send" prefers the keeper implementation over
      // the protobuf-generated interface stub. Stable sort preserves
      // FTS order within each group. See generated-detection.ts.
      const ranked = [...exactMatches].sort((a, b) => {
        const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
        const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
        return aGen - bGen;
      });
      // Multiple exact matches - pick first, note the others
      const picked = ranked[0]!.node;
      const others = ranked.slice(1).map(r =>
        `${r.node.name} (${r.node.kind}) at ${r.node.filePath}:${r.node.startLine}`
      );
      const note = `\n\n> **Note:** ${ranked.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`. Others: ${others.join(', ')}`;
      return { node: picked, note };
    }

    // No exact match. For qualified lookups, don't silently fall back
    // to a fuzzy result — the user typed a specific qualifier, and
    // resolving `stage_apply::nonexistent_fn` to the unrelated
    // `stage_apply.rs` file would be actively misleading (#173).
    if (isQualified) return null;
    return { node: results[0]!.node, note: '' };
  }

  /**
   * Find ALL symbols matching a name. Used by callers/callees/impact to aggregate
   * results across all matching symbols (e.g., multiple classes with an `execute` method).
   */
  private findAllSymbols(cg: CodeGraph, symbol: string): { nodes: Node[]; note: string } {
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
    const ranked = [...exactMatches].sort((a, b) => {
      const aGen = isGeneratedFile(a.node.filePath) ? 1 : 0;
      const bGen = isGeneratedFile(b.node.filePath) ? 1 : 0;
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
    const lines: string[] = [`## Search Results (${results.length} found)`, ''];

    for (const result of results) {
      const { node } = result;
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact format: one line per result with key info
      lines.push(`### ${node.name} (${node.kind})`);
      lines.push(`${node.filePath}${location}`);
      if (node.signature) lines.push(`\`${node.signature}\``);
      lines.push('');
    }

    return lines.join('\n');
  }

  private formatNodeList(nodes: Node[], title: string): string {
    const lines: string[] = [`## ${title} (${nodes.length} found)`, ''];

    for (const node of nodes) {
      const location = node.startLine ? `:${node.startLine}` : '';
      // Compact: just name, kind, location
      lines.push(`- ${node.name} (${node.kind}) - ${node.filePath}${location}`);
    }

    return lines.join('\n');
  }

  private formatImpact(symbol: string, impact: Subgraph): string {
    const nodeCount = impact.nodes.size;

    // Compact format: just list affected symbols grouped by file
    const lines: string[] = [
      `## Impact: "${symbol}" affects ${nodeCount} symbols`,
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
      `## ${node.name} (${node.kind})`,
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

  private formatTaskContext(context: TaskContext): string {
    return context.summary || 'No context found';
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
