/**
 * Server-level instructions emitted in the MCP `initialize` response.
 *
 * MCP clients (Claude Code, Cursor, opencode, LangChain, OpenAI Agent
 * SDK, …) surface this text in the agent's system prompt automatically,
 * giving the agent a high-level playbook for the codegraph toolset
 * before it sees individual tool descriptions.
 *
 * Goals when editing this:
 *   - Tool selection by intent (which tool for which question)
 *   - Common chains (refactor planning = X then Y)
 *   - Anti-patterns (don't grep when codegraph_search is faster)
 *
 * Keep it tight. The agent reads this every session — long instructions
 * burn tokens. Reference only tools that exist on `main`; gate any
 * conditional tools behind feature checks if/when they ship.
 */
export const SERVER_INSTRUCTIONS = `# Codegraph — code intelligence over an indexed knowledge graph

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in
the workspace — pre-computed structure you would otherwise re-derive by
reading files (cached intelligence: thousands of parse/trace decisions you
don't pay to re-reason each run). Reads are sub-millisecond; the index lags
writes by ~1s through the file watcher. Reach for it BEFORE *and* while
writing or editing code — not just for questions: one call returns the
verbatim source PLUS who calls it and what it affects, so you edit with the
blast radius in view. More accurate context, in far fewer tokens and
round-trips than reading files yourself.

## Use codegraph instead of reading files — for questions AND edits

Whether you're answering "how does X work" or implementing a change (fixing
a bug, adding a feature), reach for codegraph before you Read. For
understanding, answer DIRECTLY — usually with ONE \`codegraph_explore\` call.
\`codegraph_explore\` takes either a natural-language question or a bag of
symbol/file names and returns the verbatim source of the relevant symbols
grouped by file, so it is Read-equivalent and most often the ONLY
codegraph call you need. Codegraph IS the pre-built search index — so
delegating the lookup to a separate file-reading sub-task/agent, or
running your own grep + read loop, repeats work codegraph already did and
costs more for the same answer. Reach for raw Read/Grep only to confirm a
specific detail codegraph didn't cover. A direct codegraph answer is
typically one to a few calls; a grep/read exploration is dozens.

## Tool selection by intent

- **Almost any question — "how does X work", architecture, a bug, "what/where is X", or surveying an area** → \`codegraph_explore\` (PRIMARY — call FIRST; ONE capped call returns the verbatim source of the relevant symbols grouped by file; most often the ONLY call you need)
- **"How does X reach/become Y? / the flow / the path from X to Y"** → \`codegraph_explore\`, naming the symbols that span the flow (e.g. \`mutateElement renderScene\`) — it surfaces the call path among them, including dynamic-dispatch hops (callbacks, React re-render, JSX children) grep can't follow
- **"What is the symbol named X?" (just its location)** → \`codegraph_search\`
- **"What calls this?" / "What does this call?" / "What would changing this break?"** → \`codegraph_callers\` / \`codegraph_callees\` / \`codegraph_impact\`
- **About to read or edit a symbol you can name** → \`codegraph_node\` (SECONDARY — the after-explore depth tool) instead of \`Read\`: it returns the **verbatim current on-disk source** (safe to base an \`Edit\` on) PLUS its caller/callee trail — the same bytes Read gives you, plus who calls it and what your change would break, for fewer tokens. For an OVERLOADED name it returns EVERY matching definition's body in one call, so you never Read a file to find the right overload. Or pass a FILE PATH alone (no symbol) to get that whole file's symbol map + what depends on it — a Read replacement for a source file
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Flow / "how does X reach Y"**: ONE \`codegraph_explore\` with the symbol names spanning the flow — it surfaces the call path among them (riding dynamic-dispatch hops) AND returns their source. No need to reconstruct the path with \`codegraph_search\` + \`codegraph_callers\`.
- **Onboarding / understanding any area**: ONE \`codegraph_explore\` is usually the whole answer. Only follow up — \`codegraph_node\` for a specific symbol — if something is still unclear.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Trust codegraph's results — don't re-verify them with grep.** They come from a full AST parse; re-checking with grep is slower, less accurate, and wastes context.
- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** to understand an area — ONE \`codegraph_explore\` returns the relevant symbols' source together in a single round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **Don't \`Read\` a file just to see or edit a symbol you can name** — \`codegraph_node\` returns the same current source plus its caller/callee trail in one call, for fewer tokens. Reach for raw \`Read\` only for what codegraph doesn't index (configs, docs) or when the staleness banner flags a file as pending re-index.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. \`codegraph_status\` also lists pending files under "Pending sync".

## Limitations

- If a tool reports the project isn't initialized, \`.codegraph/\` doesn't exist yet — offer to run \`codegraph init -i\` to build the index.
- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
