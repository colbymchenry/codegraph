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
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. The DEFAULT MCP surface is `codegraph_explore` ALONE (see
 * DEFAULT_MCP_TOOLS in tools.ts) — reference only that tool here. The other
 * tools (node/search/callers/…) stay defined and are re-enablable via
 * CODEGRAPH_MCP_TOOLS, but they are NOT listed to agents, so don't name them.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). It indexes 30+ languages
(TypeScript/JavaScript, Python, Go, Rust, Java, C#, C/C++, PHP, Ruby, Swift,
Kotlin, and more) — don't assume a language here isn't covered. Reads are
sub-millisecond; the index lags writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## One tool: codegraph_explore — use it instead of reading files

There is a single tool, \`codegraph_explore\`, and it is Read-equivalent. It
takes either a natural-language question or a bag of symbol/file names and
returns the **verbatim, line-numbered source** of the relevant symbols
grouped by file — the same \`<n>\\t<line>\` shape \`Read\` gives you, safe to
\`Edit\` from — PLUS the call path among them (including dynamic-dispatch hops
like callbacks, React re-render, and JSX children that grep can't follow) and
a blast-radius summary of what depends on them.

Whether you're answering "how does X work" or implementing a change (fixing a
bug, adding a feature), call \`codegraph_explore\` before you Read. ONE call
usually answers the whole question. Codegraph IS the pre-built search index —
so running your own grep + read loop, or delegating the lookup to a separate
file-reading sub-task/agent, repeats work codegraph already did and costs more
for the same answer. A direct codegraph answer is typically one to a few
calls; a grep/read exploration is dozens.

## How to query

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`codegraph_explore\` with a natural-language question or the relevant names. ONE capped call returns the verbatim source grouped by file; most often the ONLY call you need.
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`codegraph_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, riding dynamic-dispatch hops, and returns their source.
- **Reading or editing a file/symbol you can name** → put its name or file path in the \`codegraph_explore\` query — it returns that current line-numbered source (safe to \`Edit\` from) with the call path and blast radius attached, so you don't Read it separately. For an overloaded name it returns every matching definition's body in one call.
- **Need more?** Call \`codegraph_explore\` again with more specific names — treat the source it returns as already Read. Suggested call counts are advisory only, NOT a quota; extra calls are never rejected or rate-limited.
- Qualified symbol names accept dots, \`::\`, or slashes, including containers whose names contain dots (for example, \`AppWeb.Format.group\`).
- Named-symbol call paths require exact matches; partial or mistyped names are never silently substituted as flow endpoints. If a graph query reports a missing symbol with did-you-mean suggestions, query the suggested name explicitly.
- Explore matches names and indexed code words lexically, not by meaning; an empty result reports word matches and may suggest indexed candidate names to retry with \`codegraph_explore\`.

## Anti-patterns

- **Trust codegraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code — ONE \`codegraph_explore\` returns the relevant symbols' source together in a single round-trip. Reach for raw \`Read\`/\`Grep\` only to confirm a specific detail codegraph didn't cover, or for what codegraph doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one \`codegraph_explore\` and it surfaces the path between them, dynamic-dispatch hops included.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. A different, rarer banner — "⚠️ CodeGraph auto-sync is DISABLED…" or "⚠️ CodeGraph auto-sync is RECOVERING…" — means the whole index may be stale; until the full catch-up completes, Read files directly to confirm anything that may have changed. If a response refuses to answer from changed files or says freshness could not be verified within its budget, retry after sync or narrow the query; that refusal is not an error in the tool.
- **A file flagged "⚠ changed on disk after the last index sync" drifted from its index** (most common on projects queried via \`projectPath\`, which have no live watcher). Codegraph never serves a possibly-mis-sliced body from such a file — it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag. When the source was omitted, Read that specific file; line numbers referencing it elsewhere in the response may be shifted until that project's next sync. All unflagged files remain trustworthy.

- **Source is re-served on every call by default**, including for fresh subagents and after context compaction. Cross-call dedup requires \`CODEGRAPH_EXPLORE_DEDUP=1\` and is only suitable for hosts that guarantee one durable context per connection. With that opt-in, **"Already sent earlier in this conversation"** points to exact, unchanged source returned by an earlier \`codegraph_explore\` in that context. Use that copy; don't re-fetch it and don't Read the file. The bytes it freed went into source you have not seen yet, elsewhere in the same response.

## Limitations

- If a tool reports that a verified project isn't indexed (no \`.codegraph/\`) and Codegraph would materially help with structural code work, run \`codegraph init --yes\` in that project root without asking first, then verify index health. Skip initialization for trivial tasks, literal-text searches, documentation-only work, or repos whose local policy forbids generated index state. Ask only when the root or allowed input scope is ambiguous or initialization would create unexpected tracked changes. If initialization fails, use built-in tools and report it.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
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
- For a verified project with no \`.codegraph/\`, run \`codegraph init --yes\`
  without asking first when Codegraph would materially help with structural
  code work, then verify index health. Skip initialization for trivial,
  literal-text, or documentation-only tasks, or when local policy forbids the
  generated index. Ask only when the root or allowed input scope is ambiguous
  or initialization would create unexpected tracked changes. If it fails, use
  built-in tools and report it. A new index is picked up live, with no restart.
`;
