/**
 * A parse that answers a request — the viewer's syntax highlighting, the
 * branch guards a Steps or Flow card reads — runs on the server's one thread,
 * so a parse that does not finish takes every other request down with it.
 * Indexing parses in workers it can kill; these cannot be killed, so they are
 * cancelled instead: tree-sitter asks its progress callback as it goes, and a
 * `true` stops the parse. A free-format COBOL window handed to the
 * fixed-format grammar kept cobolcraft's Flow strip — and the whole viewer
 * after it — parsing for good.
 */

import type { Parser, Tree } from 'web-tree-sitter';

/** Longest a request-time parse may run before it is given up — far past any file that parses at all. */
export const REQUEST_PARSE_BUDGET_MS = 3000;

/** `parser.parse(source)`, or null when it runs past the budget. */
export function parseWithinBudget(parser: Parser, source: string, budgetMs = REQUEST_PARSE_BUDGET_MS): Tree | null {
  const deadline = Date.now() + budgetMs;
  // The runtime hands the callback's return value to the parser: `true` cancels.
  const cancel = (() => Date.now() > deadline) as unknown as () => void;
  return parser.parse(source, null, { progressCallback: cancel }) ?? null;
}
