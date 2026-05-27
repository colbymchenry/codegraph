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

Codegraph is a SQLite knowledge graph of every symbol, edge, and file
in the workspace. Reads are sub-millisecond; the index lags writes by
about a second through the file watcher. Consult it BEFORE writing or
editing code, not during.

## Answer directly — don't delegate exploration

For "how does X work", architecture, trace, or where-is-X questions,
answer DIRECTLY using 2-3 codegraph calls: \`codegraph_context\` first,
then ONE \`codegraph_explore\` for the source of the symbols it surfaces.
Codegraph IS the pre-built search index — so delegating the lookup to a
separate file-reading sub-task/agent, or running your own grep + read
loop, repeats work codegraph already did and costs more for the same
answer. Reach for raw Read/Grep only to confirm a specific detail
codegraph didn't cover. A direct codegraph answer is typically a handful
of calls; a grep/read exploration is dozens.

## Tool selection by intent

- **"What is the symbol named X?"** → \`codegraph_search\`
- **"What's the deal with this task / feature / area?"** → \`codegraph_context\` (PRIMARY — composes search + node + callers + callees in one call)
- **"How does X reach/become Y? / trace the flow / the path from X to Y"** → \`codegraph_trace\` (ONE call returns the whole call path, including dynamic-dispatch hops — callbacks, React re-render, JSX children — that grep can't follow)
- **"What calls this?"** → \`codegraph_callers\`
- **"What does this call?"** → \`codegraph_callees\`
- **"What would changing this break?"** → \`codegraph_impact\`
- **"Show me this symbol's source / signature / docstring."** → \`codegraph_node\`
- **"Show me several related symbols' source / survey an area."** → \`codegraph_explore\` (ONE capped call; prefer over many codegraph_node/Read)
- **"What's in directory X?"** → \`codegraph_files\`
- **"Is the index ready / what's its size?"** → \`codegraph_status\`

## Common chains

- **Flow / "how does X reach Y"**: \`codegraph_trace\` from→to FIRST — one call returns the entire path with dynamic-dispatch hops bridged. Then ONE \`codegraph_explore\` for the hop bodies if you need them. Do NOT reconstruct the path with \`codegraph_search\` + \`codegraph_callers\` — that's exactly what trace does in a single call.
- **Onboarding**: \`codegraph_context\` first. If still unclear, \`codegraph_explore\` for breadth, then \`codegraph_node\` on specific symbols.
- **Refactor planning**: \`codegraph_search\` → \`codegraph_callers\` → \`codegraph_impact\`. The blast-radius answer comes from impact, not from walking callers manually.
- **Debugging a regression**: \`codegraph_callers\` of the suspected symbol; widen with \`codegraph_impact\` if an unexpected call appears.

## Anti-patterns

- **Don't grep first** when looking up a symbol by name — \`codegraph_search\` is faster and returns kind + location + signature.
- **Don't chain \`codegraph_search\` + \`codegraph_node\`** when you just want context — \`codegraph_context\` is one round-trip.
- **Don't loop \`codegraph_node\` over many symbols** — one \`codegraph_explore\` call returns them all grouped by file, while each separate call re-reads the whole context and costs far more. Use \`codegraph_node\` for a single symbol.
- **After editing, check the staleness banner.** When a tool response starts with "⚠️ Some files referenced below were edited since the last index sync…", the listed files are pending re-index — Read those specific files for accurate content. Every file NOT in that banner is fresh, so still trust codegraph. \`codegraph_status\` also lists pending files under "Pending sync".

## Limitations

- Index lags file writes by ~1 second.
- Cross-file resolution is best-effort name matching; ambiguous calls may return multiple candidates.
- No live correctness validation — that's still the TypeScript compiler / test suite / linter's job. Codegraph supplements those with structural context they don't have.
`;
