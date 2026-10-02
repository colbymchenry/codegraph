/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Lead the agent to codegraph_explore for any structural/flow question
 *   - Reinforce "explore instead of Read/Grep" for indexed code
 *   - Anti-patterns (don't re-verify with grep; don't hand-reconstruct flows)
 *
 * HARD BUDGET: Claude Code truncates each server's instructions at 2,048
 * characters by default (https://code.claude.com/docs/en/mcp), and
 * `initializeInstructions` appends the update notice AFTER this text — so
 * this text plus the longest notice must fit in 2,048, or the tail is silently
 * dropped. Order matters for the same reason: rules that are only safe when
 * present (staleness banners, not-indexed) come right after the opening
 * directive. `__tests__/server-instructions.test.ts` pins both.
 *
 * The DEFAULT MCP surface is `codegraph_explore` ALONE (see
 * DEFAULT_MCP_TOOLS in tools.ts) — reference only that tool here. The other
 * tools (node/search/callers/…) stay defined and are re-enablable via
 * CODEGRAPH_MCP_TOOLS, but they are NOT listed to agents, so don't name them.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — indexed code intelligence

Call \`codegraph_explore\` BEFORE and while editing indexed code (30+ languages), instead of grep/Read loops or file-reading sub-agents. Give it a question or symbol/file names: one call returns the verbatim, line-numbered source of the relevant symbols (Read-equivalent, safe to \`Edit\` from) PLUS the call path among them, incl. dynamic-dispatch hops grep can't follow, and their blast radius. Treat it as already Read; don't re-verify with grep.

## Freshness banners — act on them
- "⚠️ Some files referenced below were edited since the last index sync": Read the listed files; the rest is fresh.
- "⚠️ CodeGraph auto-sync is DISABLED" or "…is RECOVERING": the whole index may be stale; Read files to confirm what changed.
- A file flagged "⚠ changed on disk after the last index sync" shows its full current source (trust it) or omits it (Read it); line numbers into it may be shifted.
- "⚠️ CodeGraph cannot answer from this index" is not a tool error: retry after sync or narrow the query.
- "Already sent earlier in this conversation": use that earlier copy; don't re-fetch or Read it.

## Not indexed
If a project has no \`.codegraph/\`, stop calling codegraph for it this session and use built-in tools. Mention \`codegraph init\` if it comes up; never run it yourself.

## How to query
- A flow X → Y: name the symbols spanning it in one query (e.g. \`mutateElement renderScene\`); don't trace it by hand.
- Need more? Query again with narrower names; call counts are advisory, never a quota.
- Read/Grep only for gaps or unindexed files (configs, docs).

## Limitations
Index lags writes by ~1s. Cross-file resolution is best-effort name matching (ambiguous calls → several candidates). No correctness validation (compiler/tests/linter own that).
`;

/**
 * Instructions variant sent when the server's own root has NO codegraph index.
 *
 * The tools are still exposed (gating tool availability on whether `./` has an
 * index is the bug behind #964: it breaks monorepos where only sub-projects are
 * indexed, and a server that started before `codegraph init` never surfaces the
 * tools afterward). Instead of an "inactive" note, this variant tells the agent
 * codegraph works **per project**: there's no default project to query, so pass
 * a `projectPath` to any project that HAS a `.codegraph/`. The full single-
 * project playbook ({@link SERVER_INSTRUCTIONS}) is sent instead when the root
 * IS indexed, so the common case stays tight.
 */
export const SERVER_INSTRUCTIONS_NO_ROOT_INDEX = `# Codegraph — available (per-project; pass projectPath)

Codegraph is a SQLite knowledge graph of a codebase's symbols, edges, and
files (30+ languages): one \`codegraph_explore\` call returns the verbatim, line-numbered source
of the relevant symbols PLUS the call paths between them and a blast-radius
summary — replacing a grep + Read loop with one round-trip.

This server started somewhere with no \`.codegraph/\` of its own, so there is no
default project — but the tools are available and work **per project**:

- To query a project that HAS a \`.codegraph/\` index (e.g. a service inside a
  monorepo, or a second repo), pass its path as \`projectPath\` to
  \`codegraph_explore\` (and any other codegraph tool). Codegraph resolves the
  nearest \`.codegraph/\` at or above that path and answers from it — for as many
  projects as you like in one session.
- For a project with no \`.codegraph/\`, use your built-in tools (Read/Grep/Glob)
  for that project. Indexing is the user's decision — don't run it yourself, but
  if it comes up they can run \`codegraph init\` in a project to enable codegraph
  there (a new index is picked up live, no restart).
`;
