/**
 * How long a parse may run before it is given up.
 *
 * A parse that answers a request — the viewer's syntax highlighting, the
 * branch guards a Steps or Flow card reads — runs on the server's one thread,
 * so a parse that does not finish takes every other request down with it. A
 * free-format COBOL window handed to the fixed-format grammar kept
 * cobolcraft's Flow strip — and the whole viewer after it — parsing for good.
 *
 * Indexing parses can't run forever either (#3274). tree-sitter's error
 * recovery can loop without reading on (a half-typed JSX attribute,
 * `<a {{b:>c:d(e f)`, in a .tsx file), and nothing outside a parse can stop
 * it: a sync or the file watcher parses on the process's own thread, and a
 * parse worker's `terminate()` stops JavaScript and wasm but not the native
 * kernel, whose thread kept spinning and kept the process from exiting. So
 * every parse is cancelled instead: tree-sitter asks its progress callback as
 * it goes, and a `true` stops the parse. The file is then recorded as a parse
 * that timed out.
 */

import type { Parser, Tree } from 'web-tree-sitter';
import type { ExtractionResult } from '../types';

/** Longest a request-time parse may run before it is given up — far past any file that parses at all. */
export const REQUEST_PARSE_BUDGET_MS = 3000;

/** Base per-parse timeout for indexing; scaled up for large files (resolveParseBudgetMs). */
export const DEFAULT_PARSE_TIMEOUT_MS = 10_000;
/** Keep the default large-file budget bounded; the parse pool's hard-kill window is 3× this. */
const MAX_SCALED_PARSE_TIMEOUT_MS = 20_000;

/**
 * Resolve the base per-parse timeout from the `CODEGRAPH_PARSE_TIMEOUT_MS`
 * override. Slow storage (HDD, network folders) can need a larger budget; a
 * non-numeric / non-positive value falls back to the default (10s).
 */
export function resolveParseTimeoutMs(envVal: string | undefined): number {
  if (envVal !== undefined && envVal !== '') {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return DEFAULT_PARSE_TIMEOUT_MS;
}

/**
 * Per-file soft timeout. Size scaling helps legitimate large sources, but an
 * uncapped linear budget gave data-only headers near the 1 MiB file limit a
 * 4.5–5 minute hard-kill window (#1555). Explicit larger base overrides remain
 * respected for slow storage.
 */
export function resolveParseBudgetMs(baseMs: number, contentLength: number): number {
  const scaled = baseMs + Math.floor(contentLength / 100_000) * 10_000;
  return Math.min(scaled, Math.max(baseMs, MAX_SCALED_PARSE_TIMEOUT_MS));
}

/** How long indexing gives the parse of a source this long: the parse pool's per-file budget. */
export function indexParseBudgetMs(contentLength: number): number {
  return resolveParseBudgetMs(resolveParseTimeoutMs(process.env.CODEGRAPH_PARSE_TIMEOUT_MS), contentLength);
}

/**
 * `parser.parse(source)`, or null when it runs past the budget. A cancelled
 * parse is reset: the parser would otherwise resume it on its next parse,
 * of whatever file that is.
 */
export function parseWithinBudget(parser: Parser, source: string, budgetMs = REQUEST_PARSE_BUDGET_MS): Tree | null {
  const deadline = Date.now() + budgetMs;
  // The runtime hands the callback's return value to the parser: `true` cancels.
  const cancel = (() => Date.now() > deadline) as unknown as () => void;
  const tree = parser.parse(source, null, { progressCallback: cancel }) ?? null;
  if (!tree) parser.reset();
  return tree;
}

/** The message a parse that ran past its budget records, as the parse pool words its own timeout. */
export function parseTimeoutMessage(budgetMs: number): string {
  return `Parse timed out after ${budgetMs}ms`;
}

/** What indexing stores for a file whose parse ran past its budget: no symbols, one error. */
export function parseTimeoutResult(filePath: string, budgetMs: number): ExtractionResult {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [{ message: parseTimeoutMessage(budgetMs), filePath, severity: 'error', code: 'parse_error' }],
    durationMs: budgetMs,
  };
}
