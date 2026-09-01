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

Codegraph is a SQLite knowledge graph of every symbol, edge, and file in the
workspace, covering 30+ languages (TypeScript/JavaScript, Python, Go, Rust,
Java, C#, C/C++, PHP, Ruby, Swift, Kotlin, …) — don't assume a language isn't
covered. Reads are sub-millisecond; the index lags writes by ~1s through the
file watcher.

## One tool: codegraph_explore — use it instead of reading files

\`codegraph_explore\` is Read-equivalent. Give it a natural-language question
("how does X work", a bug, "what/where is X", an area survey) or a bag of
symbol/file names; one call returns the **verbatim, line-numbered source** of
the relevant symbols grouped by file — the same \`<n>\\t<line>\` shape \`Read\`
gives you, safe to \`Edit\` from — PLUS the call path among them (including
dynamic-dispatch hops like callbacks, React re-render, and JSX children that
grep can't follow) and a blast-radius summary of what depends on them. For an
overloaded name it returns every matching definition's body in one call.

Use it BEFORE and while writing or editing indexed code, not just for
questions: one to a few calls replace the dozens of round-trips of a
grep + Read loop (or a delegated file-reading sub-task/agent — both repeat
work the index already did). For a flow ("how does X reach/become Y?"), name
the symbols spanning the flow in one query (e.g. \`mutateElement renderScene\`)
— it surfaces the call path between them. Need more? Query again with more
specific names, and treat any source it returned as already Read.

## Anti-patterns

- **Don't re-verify codegraph's results with grep.** They come from a full
  AST parse; grep re-checking is slower, less accurate, and wastes context.
- **Don't grep or Read first** to find or understand indexed code. Raw
  \`Read\`/\`Grep\` is for confirming a specific detail codegraph didn't cover,
  or for what it doesn't index (configs, docs).
- **Don't reconstruct a flow by hand** — name the endpoints in one call.

## Staleness signals

- A response starting "⚠️ Some files referenced below were edited since the last index sync…": the LISTED files are pending re-index — Read those specific files; every file not listed is fresh, so still trust codegraph.
- The rarer "⚠️ CodeGraph auto-sync is DISABLED…" banner: live watching stopped and the whole index is frozen — until resolved, Read files directly to confirm anything that may have changed.
- A file flagged "⚠ changed on disk after the last index sync" drifted from its index (most common via \`projectPath\`, which has no live watcher). Codegraph never serves a possibly-mis-sliced body from such a file: it either shows the file's full CURRENT source (trust it as a Read) or omits the source with this flag — then Read that file, and expect line numbers referencing it elsewhere in the response to be shifted until that project's next sync. Unflagged files remain trustworthy.
- **"Already sent earlier in this conversation" is a pointer, not a gap**: an earlier \`codegraph_explore\` in THIS conversation already returned those exact lines and the file hasn't changed since — scroll back to that copy; don't re-fetch and don't Read. The freed bytes went into source elsewhere in the response you haven't seen yet.

## Limitations

- If a tool reports a project isn't indexed (no \`.codegraph/\`), stop calling
  codegraph tools for that project this session and use built-in tools there.
  Indexing is the user's decision — mention \`codegraph init\` if it comes up,
  but don't run it yourself.
- Cross-file resolution is best-effort name matching; ambiguous calls may
  return multiple candidates.
- No live correctness validation — that's still the compiler / test suite /
  linter's job; codegraph supplements them with structural context.
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
