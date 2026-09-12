# MCP Index-Version Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Warn each MCP client once per stale project, while making `codegraph_status` always report index-build and running extraction versions.

**Architecture:** Keep warning bookkeeping in a small state object owned by each MCP client session, because one daemon shares a `ToolHandler` across clients (`src/mcp/session.ts:L107-L122`). Apply the warning in `ToolHandler` after a successful result so direct calls, pooled daemon calls, and proxy fallbacks share one local compatibility check (`src/mcp/tools.ts:L2098-L2184`). Keep initialization unchanged and perform no network request or re-index.

**Tech Stack:** TypeScript, Vitest, MCP JSON-RPC, CodeGraph SQLite metadata.

**Spec:** [upstream issue #1852](https://github.com/colbymchenry/codegraph/issues/1852) (fetched 2026-09-12)

## Global Constraints

- Warn on the first successful MCP tool response for a stale index, once per resolved project root per client session. [#1852](https://github.com/colbymchenry/codegraph/issues/1852)
- Treat explicit `projectPath` projects as independent warning buckets. [#1852](https://github.com/colbymchenry/codegraph/issues/1852)
- Do not warn for current or uninitialized indexes; `CodeGraph.isIndexStale()` already implements that distinction (`src/index.ts:L1233-L1242`).
- Include available package-build and extraction-version details plus `codegraph index` guidance. [#1852](https://github.com/colbymchenry/codegraph/issues/1852)
- Preserve the nonblocking initialize response (`src/mcp/session.ts:L199-L252`) and perform no network access or automatic indexing. [#1852](https://github.com/colbymchenry/codegraph/issues/1852)

---

### Task 1: Session-owned warning state and direct behavior

**Files:**
- Create: `src/mcp/index-version-warning.ts`
- Create: `__tests__/mcp-index-version-warning.test.ts`
- Modify: `src/mcp/tools.ts:1-70,1465-1810,2098-2191,6519-6637`

**Interfaces:**
- Consumes: `CodeGraph.getProjectRoot()`, `getIndexBuildInfo()`, and `isIndexStale()` (`src/index.ts:L1224-L1242`).
- Produces: `IndexVersionWarningState.claim(projectRoot: string): boolean` and `formatIndexVersionWarning(...)`.

- [x] **Step 1: Write failing direct and multi-project tests**

```ts
const state = new IndexVersionWarningState();
const first = await handler.execute('codegraph_search', { query: 'alpha' }, undefined, state);
const second = await handler.execute('codegraph_search', { query: 'alpha' }, undefined, state);
expect(first.content[0].text).toMatch(/index predates/i);
expect(first.content[0].text).toContain('codegraph index');
expect(second.content[0].text).not.toMatch(/index predates/i);

const other = await handler.execute(
  'codegraph_search',
  { query: 'bravo', projectPath: otherRoot },
  undefined,
  state,
);
expect(other.content[0].text).toMatch(/index predates/i);
```

Also assert that an `isError` response does not consume the warning, and that current and never-indexed projects never warn.

- [x] **Step 2: Run the new test and verify RED**

Run: `npx vitest run __tests__/mcp-index-version-warning.test.ts --maxWorkers=1 --minWorkers=1`

Expected: FAIL because `IndexVersionWarningState` and the fourth `execute` argument do not exist.

- [x] **Step 3: Implement the state and response decorator**

```ts
export class IndexVersionWarningState {
  private readonly warnedProjects = new Set<string>();

  claim(projectRoot: string): boolean {
    if (this.warnedProjects.has(projectRoot)) return false;
    this.warnedProjects.add(projectRoot);
    return true;
  }
}
```

In `ToolHandler.execute`, decorate only successful results. Resolve the selected `CodeGraph`, check `isIndexStale()`, key by its resolved root, and prepend the formatted warning only when `claim()` returns true. Apply the decorator after worktree/file-staleness notices and to the `codegraph_status` early-return path.

- [x] **Step 4: Add permanent status details**

```ts
const build = cg.getIndexBuildInfo();
const stale = cg.isIndexStale();
lines.push(
  `**Index built with:** ${formatBuildVersion(build)}`,
  `**Running CodeGraph:** v${CodeGraphPackageVersion} (extraction ${EXTRACTION_VERSION})`,
  `**Re-index recommended:** ${stale ? 'yes — run `codegraph index`' : 'no'}`,
);
```

Assert these lines for both current and stale indexes. Status must retain them on every call even after the one-time banner has been consumed.

- [x] **Step 5: Run focused tests and verify GREEN**

Run: `npx vitest run __tests__/mcp-index-version-warning.test.ts __tests__/mcp-staleness-banner.test.ts __tests__/upgrade.test.ts --maxWorkers=1 --minWorkers=1`

Expected: PASS.

### Task 2: Direct, daemon-session, and proxy-fallback wiring

**Files:**
- Modify: `src/mcp/session.ts:107-313`
- Modify: `src/mcp/proxy.ts:217-290`
- Modify: `__tests__/mcp-index-version-warning.test.ts`
- Modify: `__tests__/mcp-daemon.test.ts`

**Interfaces:**
- Consumes: `ToolHandler.execute(toolName, args, exploreState, indexVersionWarningState)` from Task 1.
- Produces: one `IndexVersionWarningState` for every `MCPSession` and one for each in-process proxy fallback.

- [x] **Step 1: Write failing session-isolation coverage**

```ts
await transportA.deliver(call(1));
await transportA.deliver(call(2));
await transportB.deliver(call(3));
expect(textFor(transportA.results[0])).toMatch(/index predates/i);
expect(textFor(transportA.results[1])).not.toMatch(/index predates/i);
expect(textFor(transportB.results[0])).toMatch(/index predates/i);
```

Use two `MCPSession` objects sharing one engine/handler to model the daemon's one-engine/many-client architecture documented in `src/mcp/engine.ts:L1-L10`.

- [x] **Step 2: Run the session test and verify RED**

Run: `npx vitest run __tests__/mcp-index-version-warning.test.ts --maxWorkers=1 --minWorkers=1`

Expected: FAIL because the shared handler currently has no per-client warning state.

- [x] **Step 3: Wire fresh state into both execution paths**

```ts
private readonly indexVersionWarnings = new IndexVersionWarningState();

const result = await this.engine.getToolHandler().execute(
  toolName,
  toolArgs,
  this.exploreSession,
  this.indexVersionWarnings,
);
```

Instantiate the same state beside `exploreSession` in `runLocalHandshakeProxy` and pass it when the proxy serves locally (`src/mcp/proxy.ts:L237-L275`). Forwarded proxy calls remain byte-transparent and receive the daemon session's state.

- [x] **Step 4: Add one real proxy/daemon regression test**

Start two proxy clients against one stale indexed project. Assert each client's first successful `codegraph_search` response contains the warning, client A's second response does not, and only one daemon was created. This pins the live proxy-to-daemon route already exercised by `__tests__/mcp-daemon.test.ts:L199-L236`.

- [x] **Step 5: Run direct and daemon coverage**

Run: `npx vitest run __tests__/mcp-index-version-warning.test.ts __tests__/mcp-daemon.test.ts --maxWorkers=1 --minWorkers=1`

Expected: PASS. If Windows teardown produces the known upstream `EPERM` failure, preserve the assertion result and cite open PR #1717 rather than changing production behavior.

### Task 3: User-facing release note and verification

**Files:**
- Modify: `CHANGELOG.md:1-30`

**Interfaces:**
- Consumes: warning/status behavior from Tasks 1-2.
- Produces: release-facing explanation of the local warning and manual rebuild command.

- [x] **Step 1: Add changelog text**

```md
- MCP clients now receive a one-time warning per project when an index predates the running extraction engine, including the available build details and the `codegraph index` command needed to rebuild it. `codegraph_status` always reports both versions and whether rebuilding is recommended. Detection is local and never starts a rebuild automatically. (#1852)
```

- [x] **Step 2: Run build and focused regression suite**

Run: `npm run build`

Run: `npx vitest run __tests__/mcp-index-version-warning.test.ts __tests__/mcp-staleness-banner.test.ts __tests__/mcp-daemon.test.ts __tests__/upgrade.test.ts --maxWorkers=1 --minWorkers=1`

Expected: build and focused tests pass, apart from any separately identified upstream baseline failure.

- [x] **Step 3: Audit the diff and artifact references**

Run: `git diff --check`

Run: `git diff upstream/main...HEAD --stat`

Confirm every file named by the changelog or plan either exists in `git ls-tree HEAD` or is part of the pending diff.

- [x] **Step 4: Commit the completed feature**

```bash
git add CHANGELOG.md src/mcp/index-version-warning.ts src/mcp/session.ts src/mcp/proxy.ts src/mcp/tools.ts __tests__/mcp-index-version-warning.test.ts __tests__/mcp-daemon.test.ts docs/superpowers/plans/2026-09-12-mcp-index-version-warning.md
git commit -m "feat(mcp): warn when project indexes need rebuilding"
```
