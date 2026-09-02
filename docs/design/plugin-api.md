# Plugin API — surfaces, config, trust, compat

**Status:** design, **signed off**. Independent review pass applied 2026-09-02 —
five findings amended in place (§4.3 rules 4 & 7, §6.5, §7.3 graph equivalence,
Windows notes); the maintainer resolved all six [open questions](#open-questions)
the same day, each as recommended — the *Decision* lines there are binding.
Nothing here is implemented yet.
**Implements:** GH [#1376](https://github.com/colbymchenry/codegraph/issues/1376) · epic CG-62.
**Gates:** CG-64 (internal registry), CG-65 (config), CG-66 (types package), CG-67
(loader), CG-68 (end-to-end), CG-69 (example + harness), CG-70 (docs), CG-71
(validation), CG-72 (language-provider spike).
**Verified against the tree at:** `feature/CG-62`, 2026-09-02. Every file:line in
this doc was read; re-check them before trusting a claim.

Goal, in the issue's words: *implement a plugin → install it → list it in config →
sync*. An internal team ships proprietary framework/route support without forking
core and without waiting on a release. Built-ins register through the same path, so
every release exercises the plugin API.

This doc makes the decisions the rest of the epic implements. Where the issue text
proposed a default, it is either confirmed with a reason or argued down; two
proposals are argued down (`.codegraph/config.json`, and loading through
`CodeGraph.open()`). Genuinely open items are collected in
[Open questions](#open-questions) rather than papered over.

---

## 1. Two surfaces, phased

**v1 ships one surface: framework / semantic plugins.** A plugin contributes:

| Contribution | Interface | Where it runs today |
|---|---|---|
| Framework resolver | `FrameworkResolver` (`src/resolution/types.ts:218`) | parse workers (`extract`), main + resolver workers (`detect`/`resolve`/`claimsReference`/`postExtract`) |
| Synthesis pass | `SynthPassDef` (`src/resolution/callback-synthesizer.ts:3528`) | resolver workers, merged on the main thread |

`FrameworkResolver` is already plugin-shaped — `detect` / `resolve` /
`claimsReference` / `extract` / `postExtract`, all pure over a
`ResolutionContext` — which is why it is the v1 surface and not a new invention.
`SynthPassDef` is the same idea for whole-graph passes: `run(queries, ctx, yield)`
returns edges and persists nothing itself, so a pass is a pure function of
committed graph state. That is ytfh44's `SemanticPlugin.augment(graph) →
GraphPatch` with the names this codebase already uses.

**Language providers are deferred** to spike CG-72. See
[§10](#10-why-language-providers-are-deferred).

Deliberately *not* in v1, and why:

- **Node-synthesis hooks** (the Lombok-style `synthesizeMembers` seam inside
  `extractClass`). A plugin that wants nodes emits them from a framework
  resolver's `extract()`, which already returns `{ nodes, references }`. Opening a
  second node-producing seam before the first one has an external user is
  speculative.
- **Query/read-time hooks.** No plugin code runs when a graph is *read* — see
  [§3](#3-the-fact-everything-else-follows-from-plugins-are-a-write-path-concern).
- **Anything per-request or per-tool-call.** No HTTP hook, no MCP tool
  contribution, no network capability. Same section.

marcelovani's three-layer model (core registry → official built-ins → user
plugins) is adopted as-is for layer 1 and 2 semantics: the registry is the only
registration path, and the ~35 built-in resolvers in
`src/resolution/frameworks/index.ts` go through it (CG-64). Layer 2 as *separate
published packages* is explicitly out of scope per the issue ("splitting every
built-in into its own repo") — built-ins stay in-tree, they just stop being a
hardcoded array.

---

## 2. Where the extension points are today

Read this before the rest; the constraints in §3–§9 come from it.

| Thing | Location | Property that matters |
|---|---|---|
| `FRAMEWORK_RESOLVERS` | `src/resolution/frameworks/index.ts:42` | plain array, **order is semantic** |
| `registerFrameworkResolver()` | `src/resolution/frameworks/index.ts:142` | exists, **zero callers**, replaces by name |
| `detectFrameworks()` | `.../index.ts:116` | already try/catches a throwing `detect` |
| `SYNTH_PASSES` | `src/resolution/callback-synthesizer.ts:3548` | merge order = array order, **first-seen wins** a duplicate `(source,target)` |
| Pass dispatch **by name** into a worker | `src/resolution/resolver-worker.ts:101` | `SYNTH_PASSES.find(p => p.name === msg.pass)` |
| Framework lookup **by name** in a parse worker | `src/extraction/parse-worker.ts:95` | `getAllFrameworkResolvers().filter(r => frameworkNames.includes(r.name))` |
| Project config | `src/project-config.ts` (`codegraph.json`, root, committed) | mtime-cached, **keyed by project root** |
| `.codegraph/` ignore rule | `src/directory.ts:652` | `*` + `!.gitignore` — **everything in it is gitignored** |
| Index staleness stamp | `indexed_with_extraction_version`, `CodeGraph.isIndexStale()` (`src/index.ts:1230`) | the existing "re-index recommended" channel |
| MCP lazy engine load | `src/mcp/engine.ts:22-27`, `:252` | `CodeGraph.open()` is deliberately **off** the MCP startup path |

Two of these are load-bearing and easy to miss:

**Plugins must load in three process contexts, not one.** The main thread detects
frameworks and ships their **names** to parse workers, which look the names up in
their *own* copy of the registry (`parse-worker.ts:95`); resolver workers each
construct a full `ReferenceResolver` and run synth passes looked up by *name*
(`resolver-worker.ts:101`). A plugin registered only on the main thread would have
its `extract()` silently skipped — and worse, `frameworksNeedDecode` would compute
`false`, sending the file down the kernel raw-buffer fast path, so the failure mode
is "no error, fewer nodes". Registration therefore happens in **every** context
that builds a resolver or runs a pass, from one resolved plugin set (§4.4).

**Config is loaded per call site, keyed by root — not threaded through `open()`.**
`loadExtensionOverrides(root)` and friends are module-level, mtime-cached, and
root-keyed precisely so the daemon can host several projects in one process
(`project-config.ts:104`). Plugins follow that pattern (§5.3).

---

## 3. The fact everything else follows from: plugins are a write-path concern

> **A plugin's code runs only while the graph is being written — `index`, `sync`,
> and the watcher's sync. No read path ever loads plugin code.**

Every reader — `codegraph_explore`, `codegraph_node`, the CLI's `query` /
`context` / `affected`, the `ui` server — reads nodes and edges a plugin already
wrote. Their shape is the engine's own (`NodeKind`/`EdgeKind` in `src/types.ts`),
so a reader cannot tell a plugin's edge from a built-in's except by the provenance
metadata it deliberately carries (§4.3).

This single rule settles four otherwise-hard questions at once:

- **MCP attach latency** (§8): zero plugin work on `serve --mcp` startup, zero on a
  tool call. The existing lazy-load of the whole CodeGraph chain off the MCP
  startup path (`engine.ts:22`, worth ~800ms) stays intact because plugins do not
  hang off `open()`.
- **ui-server security** (§6): the loopback server never executes plugin code, so
  the DNS-rebinding boundary in `src/ui-server/security.ts` is untouched and there
  is nothing new behind it. Plugins get no request hook and no network capability
  *by construction* — not by a rule someone must remember.
- **Determinism** (§7): a plugin influences the graph at exactly one point in time
  (a write run), so "same inputs → same graph" is checkable by re-indexing.
- **Blast radius of a broken plugin** (§9): it degrades an index run. It can never
  make a *query* fail, which is what would teach an agent to abandon codegraph.

---

## 4. The plugin contract

### 4.1 Module shape

A plugin package's entry module default-exports a **factory**:

```ts
import type { CodeGraphPlugin, PluginContext, PluginContributions } from '@colbymchenry/codegraph-plugin-api';

export default function plugin(ctx: PluginContext): PluginContributions {
  return {
    frameworks: [acmeRoutesResolver(ctx.options)],
    synthPasses: [],
  };
}
```

```ts
interface PluginContext {
  /** Absolute, resolved project root. */
  projectRoot: string;
  /** The `options` object from this plugin's config entry, verbatim (unvalidated). */
  options: Record<string, unknown>;
  /** Running engine version, for a plugin that wants to feature-detect. */
  engineVersion: string;
  /** Structured diagnostics. Plugins must not write to stdout — it is the MCP transport. */
  log: { warn(msg: string, meta?: object): void; debug(msg: string, meta?: object): void };
}

interface PluginContributions {
  frameworks?: FrameworkResolver[];
  synthPasses?: SynthPass[];
}
```

A factory, not a static object, because options are per-project and the same
package may be loaded for two roots in one daemon process. The factory must be
**cheap and side-effect-free** — it constructs resolvers, it does not scan the
repo. It is called once per (root, plugin) per process.

`ctx.log` exists because `console.log` in a plugin would corrupt the MCP stdio
transport. This is a hard rule for plugin authors, stated in the authoring guide
(CG-70), not enforceable at runtime.

### 4.2 Manifest, and why it lives in `package.json`

```jsonc
// package.json of @acme/codegraph-plugin-internal-routes
{
  "name": "@acme/codegraph-plugin-internal-routes",
  "version": "1.2.0",
  "main": "dist/index.js",
  "codegraph": {
    "id": "acme-internal-routes",
    "apiVersion": 1,
    "engines": ">=1.5.0",
    "capabilities": ["frameworks"]
  }
}
```

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable identifier. Namespaces every contribution (§7.2), appears in diagnostics and in edge provenance. `[a-z0-9][a-z0-9-]*`, ≤ 64 chars. |
| `apiVersion` | yes | Integer major of the plugin API this plugin was written against (§9). |
| `engines` | no | semver range against the **engine** version. Absent = any. |
| `capabilities` | yes | Declared contribution kinds: `"frameworks"`, `"synthPasses"`. Returning a contribution that was not declared is a load error. |

**The manifest lives in `package.json`, not in the module's exports**, for one
reason: it is the only version of the check that happens *before* the plugin's code
executes. `require()` runs module top-level code; a manifest read from an export
can only gate the factory call, which is already too late. Reading
`package.json` lets the loader reject an `apiVersion: 2` plugin on a v1 engine
without ever evaluating it.

*Exception, stated honestly:* a plugin loaded by **path specifier** (a single file
committed in a non-Node repo, §5.2) may have no `package.json`. Those may export a
named `manifest` object instead, and the compat check then happens after module
evaluation. The doc says so out loud rather than pretending the guarantee is
uniform; the real protection for that case is the trust model (§6), not the check.

**On mismatch — `apiVersion` unsupported, `engines` unsatisfied, manifest missing
or malformed, `id` colliding — the plugin is skipped with a diagnostic and the run
continues.** Never a crash, never a partial registration. (§9 covers what a
mismatch *says*.)

### 4.3 What contributions must guarantee

Promoted from in-tree convention to public contract:

1. **`postExtract` idempotency and id preservation.** The contract already
   documented at `src/resolution/types.ts:246-255` becomes public verbatim: the
   node `id` MUST be preserved so existing edges survive; `qualifiedName` SHOULD be
   preserved so a second run can recover the original in-file form. `postExtract`
   runs again on **every incremental sync**, so a non-idempotent pass corrupts the
   graph slowly rather than loudly.
2. **Node ids must be namespaced.** Built-ins use scheme-prefixed ids
   (`route:<file>:<line>:<METHOD>:<path>` — `frameworks/express.ts:171`;
   `expo-module:` for cross-platform pairs). A plugin's synthetic node ids must be
   prefixed `plugin:<id>:` so two plugins can never collide and so a node can be
   traced back to what made it.
3. **Synthesized edges carry provenance.** `provenance: 'heuristic'` plus
   `metadata.synthesizedBy = '<plugin id>'` and, where the wiring site is known,
   `metadata.registeredAt = 'file:line'` — the same shape the built-in
   synthesizers use.
4. **A plugin edge must say what it means — derived in ONE place.** The label
   of a synthesized hop is derived in **five** renderers today, across three
   packages: `ContextBuilder`'s closed `synthesizedBy` switch
   (`src/context/index.ts:405-421`, fallback the string `event …` — an unknown
   plugin value renders as a fabricated "event" hop, the exact overclaiming
   CLAUDE.md forbids), the steps fold (`src/ui-server/api/steps.ts:1605-1618`,
   fallback `via <synthesizedBy>`), the flow endpoint
   (`src/ui-server/api/flow.ts:315-316`, dash-stripped mechanism words), and
   the viewer inventing its own (`ui/src/lib/symbol-model.ts:98-101`, fallback
   `'synthesized'`) from the raw `synthesizedBy` the wire payload passes
   through (`src/ui-server/api/wire.ts:200`). Per this repo's own rule — a
   derivation more than one surface renders lives in `src/graph/`, because two
   derivations eventually disagree — CG-68 must not patch each switch. It adds
   one helper in `src/graph/` (`synthEdgeLabel(edge)`): prefer
   `metadata.label` — required on every plugin-synthesized edge, a short human
   phrase like `"Acme route → handler"` — else the built-in mechanism words,
   else `via <plugin id>`, **never** `event`. Every engine-side renderer calls
   it, and the wire payload carries the resolved label so the viewer renders it
   verbatim instead of coining words of its own.
5. **Purity.** No wall clock, no randomness, no network, no dependence on file
   visit order or on state carried between files. See §7.3.
6. **No direct DB writes.** Contributions return data; the engine persists it.
   `ResolutionContext` is a read interface and stays one.
7. **Contributions are validated before persistence.** The types package
   constrains TypeScript authors at compile time; the engine trusts nothing at
   run time. Every contributed node and edge is checked at the persistence
   boundary: `kind` must be an existing `NodeKind`/`EdgeKind` (the unions stay
   closed — a plugin invents no kinds in v1), `filePath` must resolve inside
   the project root, spans must be sane, `id`/`qualifiedName` non-empty with
   the id namespaced per rule 2. An invalid item is dropped with a warning and
   counted in the plugin's diagnostics (§9.2) — the config parser's
   warn-and-skip posture, applied to data. This is the failure class §9.1
   cannot see: a plugin that throws gets disabled, but a plugin that returns
   plausible garbage would otherwise corrupt the graph silently.

### 4.4 One resolved plugin set per run

At the start of a write run the main thread produces a **resolved plugin set**:
for each config entry, `{ id, version, resolvedPath, options }`, in config order.
That object — not the config file path — is what parse workers and resolver
workers receive in their init message.

Consequence: every context loads the *same* modules with the *same* options even
if `codegraph.json` is edited mid-run, and a worker never re-reads or re-resolves
config. This is the direct analogue of the main thread resolving the language and
shipping it to the parse worker (`parse-worker.ts:82-86`) rather than letting each
worker detect independently.

Workers load only what they need: `"frameworks"` → parse workers and resolver
workers; `"synthPasses"` → resolver workers only. A plugin declaring neither is
never loaded in a worker at all.

---

## 5. Configuration

### 5.1 The file is `codegraph.json` — **not** `.codegraph/config.json`

The issue proposed `.codegraph/config.json` "since the dir already exists".
Rejected, on evidence:

- **`.codegraph/` is entirely gitignored.** `init` writes `.codegraph/.gitignore`
  containing `*` + `!.gitignore` (`src/directory.ts:645-657`) so transient files —
  the DB, `daemon.pid`, sockets — are never committed. A plugin list is the
  opposite kind of state: it must be committed, reviewed, and shared, or the whole
  premise ("a teammate clones and gets the same graph") fails. It is also the file
  a security reviewer must be able to see in a diff (§6).
- **A committed project config already exists.** `codegraph.json` at the project
  root (`PROJECT_CONFIG_FILENAME`, `src/project-config.ts:32`) is documented as
  "committed … that a team shares through version control" and already carries
  `extensions`, `include`, `exclude`, `includeIgnored`, `deprioritize`. A second
  config file would be a second answer to "where do I configure codegraph".
- The `.codegraph/` dir does get one job here, and it is the right one: the
  machine-local trust stamp (§6.3), which must *not* be committed.

### 5.2 Schema

```jsonc
{
  "plugins": [
    "@acme/codegraph-plugin-internal-routes",
    {
      "name": "@acme/codegraph-plugin-rpc",
      "options": { "protoDir": "api/proto" }
    },
    { "name": "./tools/codegraph/legacy-routes.js" }
  ]
}
```

- Entries are objects `{ name, options?, replaces? }`. A bare string is sugar for
  `{ name }`, normalized at parse time.
- `name` is a **module specifier**: a bare package name (resolved from the project
  root, §7.1) or a project-relative path beginning `./` or `../` that stays inside
  the root.
- `options` is passed to the factory verbatim. The engine does not validate it;
  the plugin does (and reports through `ctx.log`).
- `replaces?: string[]` — built-in resolver names this entry displaces. See §7.2.

Validation follows `project-config.ts`'s existing posture exactly: **an invalid
entry is warned-and-skipped, never fatal; a malformed file degrades to the
zero-config default.** A non-array `plugins`, an entry without a string `name`, an
absolute path, a path escaping the root — each is one `logWarn` and a skip.

Unknown keys are already ignored by `parseConfig`, so adding `plugins` is
backward-compatible with older engines — with one honest caveat: an older engine
silently produces a graph *without* the plugin's edges. The index stamp (§5.4)
makes that visible on the machine that has the newer engine, not on the old one.

### 5.3 One load path — the existing one

`loadPluginEntries(rootDir): PluginEntry[]` joins `loadExtensionOverrides`,
`loadExcludePatterns`, … in `src/project-config.ts`, sharing the same
mtime-cached, root-keyed `loadParsedConfig`.

The issue proposed that "ALL entry points read it through one load path in
`CodeGraph.open()`". The *intent* is right — one load path — but `open()` is the
wrong place:

- `open()` is deliberately lazy-required off the MCP startup path
  (`src/mcp/engine.ts:22-27`) and is not called at all until the first tool call
  touches a project. Hanging plugin resolution off it puts plugin `require()` cost
  on the first tool call, which is the latency that matters most (§8).
- The daemon hosts several roots in one process; root-keyed module-level caching is
  precisely why `project-config.ts` is built the way it is.

So: **config parsing** goes through the one existing loader, from any entry point,
at any time. **Plugin loading** happens once per write run, on the write path, from
the resolved set (§4.4). Both are single paths; they are just not the same path.

### 5.4 When the plugin list changes

Two mechanisms, no hot reload (explicitly out of scope in the issue):

- **Index stamp.** A write run records `indexed_with_plugins` in
  `project_metadata` — the sorted `id@version` list actually loaded. `codegraph
  status` compares it to the currently resolved set and, on a difference, prints
  the same kind of hint `isIndexStale()` already drives: *the plugin set changed
  since this index was built — run `codegraph index`.*
- **Live daemon.** Editing `codegraph.json` already triggers
  `FileWatcher.refreshScope()` and a full rescan (`src/sync/watcher.ts:581,614`).
  That rescan runs with the plugin set the **process** loaded at start, so a newly
  listed plugin will not take effect until restart. This is a real, narrow drift
  (the same class of bug #1590 fixed for scope fields): the rescan's graph and a
  restarted process's graph differ. v1 handles it by *saying so* — the stamp
  mismatch above is written by that rescan too, so `status` and the index summary
  both report "plugin set changed; restart the MCP server / re-index" — rather than
  by pretending a `require()` cache can be invalidated. Recorded as a known
  limitation in the authoring guide (CG-70).

---

## 6. Trust and security

### 6.1 What is actually true

A plugin is `require()`d into the engine process. It has the full authority of that
process: filesystem, network, `child_process`. **CodeGraph does not sandbox
plugins, and v1 does not claim to.** The security property on offer is *consent*,
not containment: code runs because a human put its name in a version-controlled
file that shows up in review.

Stating this plainly is the point. Node's `--permission` model could bound a
plugin's fs/net access, but it applies process-wide and the engine itself needs
broad fs access; a per-plugin sandbox means a separate process with an IPC-shaped
contribution API, which is a much larger project than #1376. Out of scope for v1,
noted in [Open questions](#open-questions) as the natural v2 lever.

### 6.2 The two rules

1. **Explicit listing only.** Only entries present in the project's committed
   `codegraph.json` are ever loaded. **No auto-discovery** — not by
   `codegraph-plugin-*` name prefix, not by scanning `node_modules`, not by a
   `codegraph` key found in an arbitrary installed package. Confirming the issue's
   proposal, and the reason is worth keeping in the doc: with prefix discovery, any
   transitive dependency that renames itself becomes an execution vector inside a
   tool that runs over the user's entire source tree.
2. **Specifier confinement.** A bare name resolves only through the *project's own*
   resolution paths (§7.1) — i.e. something the user installed. A path specifier
   must stay inside the project root; absolute paths and `../` escapes are rejected
   at parse time, consistent with the engine's existing path-refusal posture
   (`validatePathWithinRoot`). The check normalizes separators **before**
   judging: `..\` must be caught on Windows exactly as `../` is on POSIX, and
   drive-absolute (`C:\…`) is rejected with the absolute paths — enforced by
   Windows-gated tests (`it.runIf(process.platform === 'win32')`), not assumed.

### 6.3 The hostile-repo case, and the trust stamp

The uncomfortable corollary of "the config is committed": cloning a hostile
repository and running `codegraph init` would execute whatever `./tools/evil.js`
its `codegraph.json` lists. This is the same exposure class as VS Code workspace
tasks or an ESLint config's plugins, and it deserves an explicit answer rather than
a footnote.

Proposal — **workspace-trust, machine-local**:

- The first time a project's plugin set is loaded, the engine records a stamp in
  `.codegraph/plugins-trust.json` (gitignored by construction, per-machine): the
  hash of the normalized `plugins` array plus the resolved ids/versions.
- When the stamp is absent or does not match:
  - **interactive CLI** (`codegraph init` / `index` / `sync` on a TTY) → prompt
    once, listing exactly what will be loaded, and record the answer;
  - **non-interactive** (MCP serve, the daemon, CI, `--yes`) → **skip all plugins**
    with a diagnostic telling the user to run `codegraph plugins trust` (or index
    once interactively). Never execute unreviewed plugin code from a context that
    cannot ask.
- `CODEGRAPH_PLUGINS=0` disables plugin loading entirely, mirroring
  `CODEGRAPH_KERNEL=0`. A `--no-plugins` flag on `init`/`index`/`sync` does the
  same for one run.

Note the split: a **bare package** specifier can only load if the user already ran
`npm install`, which already executes that package's install scripts — the marginal
risk is small. A **path specifier** ships inside the repo, so it is the case the
prompt exists for. A second argument for that split: the stamp hashes resolved
ids **and versions**, so stamping bare packages means every routine
`npm update` invalidates it — and a non-interactive daemon then silently drops
all plugins until someone re-trusts. That is recurring churn with no security
payoff for code `npm install` already executed. If the prompt is judged too
much UX for v1, the fallback is "path specifiers require the stamp, bare
specifiers do not" — listed in [Open questions](#open-questions).

**Decision (2026-09-02): that split IS the v1 behavior.** The stamp-and-prompt
flow above applies to **path-specifier entries only**; bare package entries load
without a stamp. Consequently a non-interactive context (daemon, MCP serve, CI)
skips only *unstamped path-specifier* plugins — bare packages still load there.

### 6.4 Interaction with the ui-server loopback boundary

None, by construction (§3): `codegraph ui` is a read surface, it never loads plugin
code, and no plugin hook runs per HTTP request. The boundary in
`src/ui-server/security.ts` — loopback `Host` check, no CORS headers,
`resolveProjectFile` as the single read chokepoint — is unchanged and unextended.
v1 grants plugins **no network capability of any kind**: no listener, no route, no
outbound helper in `PluginContext`. A plugin that dials out is doing it with raw
Node APIs, which is exactly what §6.1 says the trust model is for.

### 6.5 Plugin identity never enters telemetry

Telemetry today reports language names on an `index` event (TELEMETRY.md). The
audience for this feature is teams with **proprietary** frameworks — the plugin's
name can itself be confidential. So: a plugin's id, package name, options, error
text, and timings are never transmitted. At most an aggregate count ("2 plugins
loaded"), and only if a real product question ever needs it. Pinned here so a
future "which plugins are popular" dashboard idea meets a written rule instead of
a review comment.

---

## 7. Module resolution, registry order, determinism

### 7.1 Resolving a specifier inside the bundled runtime

CodeGraph ships its own Node (`scripts/build-bundle.sh`, currently v24.16.0), so
the engine's own `require` resolves against the *bundle*, not the user's project.
Plugins must resolve against the **project**:

```ts
const req = createRequire(path.join(projectRoot, 'package.json'));
const resolved = req.resolve(specifier);   // bare name → project node_modules; './x' → in-repo file
```

`createRequire` from the project root is the same mechanism the kernel loader
already uses for our own native binary (`src/extraction/kernel/loader.ts:151`).

- **CJS and ESM both supported.** `require()` first; on `ERR_REQUIRE_ESM` fall back
  to `await import(pathToFileURL(resolved))`. On the bundled Node 24, `require()`
  of an ESM graph without top-level await already works, so the fallback is mostly
  for TLA modules. The default export is unwrapped from `.default` in either case.
- **Native addons are banned in v1.** A `.node` binding in a resolved specifier is
  a load error with a specific message. The bundled runtime is Node 24.x; addons in
  a user's `node_modules` are built against whatever Node they installed with
  (commonly 20 or 22), and the module ABIs differ — the failure without the ban is
  an opaque `NODE_MODULE_VERSION` error attributed to codegraph. We control our own
  kernel binary's build; we cannot control a plugin's.
- **wasm is allowed** and is the recommended escape hatch for native-speed work —
  the engine already loads wasm grammars, and a wasm module is ABI-portable across
  the bundled runtime.
- Resolution failure (`MODULE_NOT_FOUND`) is a skip-with-diagnostic naming the
  package and suggesting `npm install`, not a crash.

**Non-Node projects** (a Go or Rails repo with no `node_modules`) get the path
specifier: commit the plugin — a small built JS file or a vendored package
directory — anywhere in the repo and list it as `./tools/codegraph/plugin.js`.
Recommended over the alternatives: `.codegraph/plugins/` with its own
`package.json` would be gitignored (§5.1) and so invisible to teammates and to
review; a global `~/.codegraph/plugins` dir is neither per-project nor
version-controlled. A team that wants dependency management in a non-Node repo can
put a real `package.json` in `tools/codegraph/` and list
`./tools/codegraph/node_modules/@acme/plugin` — no new mechanism needed. (Open
question 2 if the maintainer wants a first-class install dir anyway.)

Everything in this section is path arithmetic and therefore Windows-sensitive:
resolution anchors, specifier confinement (§6.2), and the trust-stamp path all
get Windows-gated tests, and CG-67/CG-71 include a real run on the Parallels
Windows VM per CLAUDE.md's cross-platform rule — validated, not guessed.

### 7.2 Registry order and duplicates

- **Built-ins first, in their current array order; then plugins, in config order.**
  Never interleaved, never sorted. `FRAMEWORK_RESOLVERS` order is semantic (the
  comments in `frameworks/index.ts` explain which resolver must see a reference
  first), and `SYNTH_PASSES` order decides which duplicate `(source, target)` edge
  wins — the cross-tier pass sits before the emitter pass *on purpose*
  (`callback-synthesizer.ts:3550-3554`).
- **Duplicate ids are a load error**, not a silent replace. Today
  `registerFrameworkResolver` splices out a same-named resolver and pushes the new
  one — fine as a dead export, wrong as a public API: a plugin could shadow
  `express` by accident and no one would know. CG-64 changes it to reject a
  duplicate (skip + diagnostic).
- **Displacing a built-in is explicit and belongs to the user, not the plugin
  author**: `{ "name": "@acme/drupal", "replaces": ["drupal"] }` in config. The
  named built-ins are removed from the registry for that project, and `status`
  reports the displacement. This is what makes CG-71's acceptance test possible —
  porting `drupalResolver` out-of-tree and diffing the graph requires turning the
  in-tree one off.
- **Synth pass names** are namespaced on registration as `<plugin id>:<name>` so
  the name-keyed dispatch into resolver workers (`resolver-worker.ts:101`) can
  never collide with a built-in pass.
- `SYNTH_PROGRESS_STEPS` is pinned by a test to the pass count; with plugin passes
  the count becomes per-run, so CG-64 must make it a function of the *effective*
  registry rather than a module constant.

### 7.3 Determinism

**Requirement: same repo + same plugin set → same graph, byte-for-byte in node and
edge sets.** Two runs that differ mean a plugin is impure, and a non-deterministic
graph is unreviewable — it breaks incremental-sync convergence (the invariant in
`.kommandr/memory/sync-rebuild-convergence-invariant.md`) and every A/B measurement
the project relies on.

What the engine guarantees: fixed registry order; synth-pass results merged in
registry order regardless of execution order (already true — passes persist
nothing until the ordered merge, `callback-synthesizer.ts:3730-3738`); the same
resolved plugin set in every worker (§4.4).

What the plugin must guarantee: no clock, no randomness, no network, no
cross-file mutable state, no dependence on visit order. The plugin test harness
(CG-69) enforces it the only way that is honest — index twice and diff — and
CG-71's validation gate includes a double-index diff on a real repo.

**Graph equivalence for the CG-71 port.** §4.3 rule 2 makes a byte-identical
diff impossible *on purpose*: the ported plugin's node ids carry the
`plugin:<id>:` prefix; the in-tree resolver's do not. CG-71 therefore compares
graphs **modulo id scheme**: node sets keyed on `(kind, qualifiedName,
filePath, span)` — `qualifiedName` carries no plugin prefix and is what saved
trails and the read surfaces key on — and edge sets keyed on the endpoints'
qualified names plus edge `kind`. Counts, provenance metadata, and labels must
match exactly; only the id text may differ. (Double-index determinism, same
plugin set, stays byte-for-byte — this relaxation applies only to the
in-tree-vs-ported comparison.)

---

## 8. Performance budget

The constraint that dominates: **MCP attach is already borderline at ~2–3s**
(CLAUDE.md, retrieval performance), and an agent that starts its first turn before
codegraph attaches runs the whole task without codegraph.

Commitments:

1. **No plugin work on the MCP startup path, ever.** Plugins load on the write path
   only (§3), not in `CodeGraph.open()`, not in `MCPEngine.ensureInitialized`, not
   on a tool call. Attach latency is structurally unchanged — there is no code to
   run, so there is nothing to measure or regress.
2. **Plugins load at the start of an index/sync run**, after config resolution and
   before extraction; the cost is `require()` + one factory call per plugin per
   context.
3. **Per-plugin timing is surfaced**: load ms and factory ms per plugin, per
   context, behind `CODEGRAPH_PLUGIN_TIMINGS=1` (mirroring
   `CODEGRAPH_SYNTH_TIMINGS`), and a one-line total in the index summary. A plugin
   whose load exceeds **1s** gets a warning naming it — a slow plugin should be
   attributable without a profiler.
4. **The multiplier is explicit.** Load cost is paid once per process/thread that
   needs the plugin: main thread + N parse workers (frameworks) + M resolver
   workers. Capability-gated loading (§4.4) keeps a synth-pass-only plugin out of
   parse workers entirely.
5. **Gate (CG-71):** with the ported plugin installed, (a) fresh-index wall clock on
   a control repo within run-to-run noise of the no-plugin build, (b) the explore
   call budget and Read/Grep counts unchanged on the standard flow questions, (c)
   MCP attach unchanged. Measured with the harness and model policy CLAUDE.md
   mandates (Sonnet, ≥2 runs per arm, CLI shim blocked).

Budgeting the *plugin's own* work is the plugin author's problem, with one engine
guardrail: a plugin's synth pass runs under the same cooperative-yield discipline
as a built-in (`yieldToLoop` is passed into `run`), because a pass that blocks the
main thread trips the liveness watchdog and gets the process SIGKILLed — the #1091
/ #1122 failure class. The authoring guide states this as a rule with the failure
it prevents.

---

## 9. Error isolation, diagnostics, and compatibility

### 9.1 Failure policy

| Failure | Behavior |
|---|---|
| Manifest missing / malformed / `apiVersion` unsupported / `engines` unsatisfied | Skip the plugin. Diagnostic. Run continues. |
| Module not found / resolution refused (absolute path, escape, `.node`) | Skip. Diagnostic naming the fix. Run continues. |
| Throw at module scope or in the factory | Skip. Diagnostic with the message and the plugin id. Run continues. |
| Throw inside `detect` / `resolve` / `claimsReference` / `extract` / `postExtract` / a synth pass | **Disable that contribution for the session** on the first throw, log once with plugin id + hook + message, continue indexing. |
| Anything above, in an MCP context | **Never `isError`.** |

Disabling on first throw rather than swallowing every throw is deliberate: a hook
that throws once per file would produce megabytes of log and a silently
half-populated graph. Disabling is bounded and honest — the graph is missing that
plugin's contribution, and `status` says which and why. It matches the existing
posture around synthesis (a pass that fails on a worker is retried once, then
skipped with a printed reason, `callback-synthesizer.ts:3778-3788`) and around
`detect` (already try/caught, `frameworks/index.ts:116-127`).

`isError: true` is reserved for security refusals and genuine malfunctions
(`src/mcp/tools.ts:78-89`); one or two of them early in a session make an agent
stop calling codegraph entirely. A plugin problem is a *user configuration*
problem: it belongs in `status` and in the index summary, never in a tool response.

### 9.2 Where diagnostics surface

- **Index summary** — one line per plugin: `id@version — frameworks: 1, passes: 0
  (loaded in 34ms)`, and a warning line per skipped/disabled plugin.
- **`codegraph status`** — a `Plugins:` block after `Backend:`/`Journal:` listing
  each configured entry with its state (`loaded` / `skipped: <reason>` /
  `disabled: <hook> threw <message>`) and any built-ins it `replaces`. Because
  `status` is a *different process* from the index run, the last run's plugin
  diagnostics are persisted in `project_metadata` under `plugins_last_run` (JSON)
  alongside `indexed_with_plugins` (§5.4).
- **Never** in MCP tool output, and never on stdout from a plugin (§4.1).

### 9.3 Versioning and compatibility policy

- **The types package** — `@colbymchenry/codegraph-plugin-api` (CG-66) — is
  versioned **independently of the engine** and is the only public surface. It
  exports `CodeGraphPlugin`, `PluginContext`, `PluginContributions`,
  `FrameworkResolver`, `SynthPass`, `ResolutionContext`, and the graph types
  (`Node`, `Edge`, `UnresolvedRef`, `NodeKind`, `EdgeKind`, `Language`).
  (`SynthPass` is the public name of the in-tree `SynthPassDef`,
  `callback-synthesizer.ts:3528` — the package renames it; core keeps its name.)
- **`apiVersion` is an integer major.** The engine declares which majors it
  accepts. v1 accepts `1` only. When a breaking change ships as major 2, the engine
  accepts `{1, 2}` for **at least two engine minor releases**, warning in `status`
  that major 1 is deprecated, then drops it in a major engine release with a
  CHANGELOG `### Breaking Changes` entry.
- **In the contract:** the interfaces above, the required members of
  `ResolutionContext`, the `postExtract` id/idempotency rules, node-id namespacing,
  edge provenance/label requirements, registry ordering.
  **Not in the contract:** the *optional* members of `ResolutionContext` (they may
  come and go; plugins already have to feature-detect them, which is why they are
  optional in-tree), additive `NodeKind`/`EdgeKind` values, built-in resolver
  internals, and anything a plugin reaches by importing from
  `@colbymchenry/codegraph` directly rather than from the types package.
- **Publishing:** mirror `@colbymchenry/codegraph-ui` — built and asserted in CI,
  `"private": true`, packed only behind an env flag (`scripts/pack-npm.sh`) — and
  keep it unpublished until CG-71 proves the API by re-implementing a built-in
  out-of-tree with an identical graph. Publishing an API we have not used
  externally is how it gets frozen wrong.
- **Adding a built-in framework resolver in-tree is not a plugin-API breaking
  change**, but it does change extraction output, so it keeps bumping
  `EXTRACTION_VERSION` as today.

---

## 10. Why language providers are deferred

Deferred to spike **CG-72**, for reasons that are architectural rather than
schedule-driven:

- **The TS extractor is the fallback path, not the hot path.** Extraction routes
  through the Rust kernel when `isRouted(language) && kernelSupports(language)`
  (`src/extraction/kernel/index.ts:155`), with the WASM/TS extractor as the
  deferral path. Freezing a public plugin API around `LanguageExtractor` would
  publish the legacy architecture as the contract — ytfh44's point on #1376, and
  the right one.
- **The language axis is a closed union, not a registry.** `Language` is
  `(typeof LANGUAGES)[number]` (`src/types.ts:124`) and `EXTRACTORS` is
  `Partial<Record<Language, LanguageExtractor>>`
  (`src/extraction/languages/index.ts:40`). A runtime-registered language means
  opening that union everywhere it is used — grammars, detection, kernel routing,
  branch guards, framework `languages` filters. That is ytfh44's phase 1 and 2, and
  it is a bigger job than everything in this doc combined.
- **Language knowledge is not only in extraction.** Import rules, member-call
  syntax, chained-call behavior and type inference live in `src/resolution/`. A
  language plugin that only supplies extraction still needs core edits, so shipping
  one would be a promise the seam cannot keep.
- **The right boundary already exists.** The kernel's ABI-versioned, file/batch-
  grained buffer contract is a better long-term extension point than a per-AST-node
  callback API, and it is backend-neutral by construction.

The cost of *not* deciding is visible: #1563 asks, in as many words, "which layer
should a new language target now?" CG-72 answers it. Until then the honest position
— stated in the authoring guide (CG-70) — is: **framework and semantic behavior is
pluggable today; a new language is still a core contribution**, and here is the
issue tracking the change.

The capability-levels idea from that comment (parser / symbols / imports / local
calls / cross-file calls / type resolution / framework semantics, each ✓ / partial
/ —) is worth adopting when the language surface lands. v1's `capabilities` field
is deliberately the coarse contribution-kind list; it is forward-compatible with a
richer per-language matrix.

---

## Open questions

**All six resolved by the maintainer on 2026-09-02 — each as recommended.** Kept
in question form for the reasoning; the *Decision* line on each item is the
binding part.

1. **Trust prompt in v1?** §6.3 proposes a machine-local trust stamp plus an
   interactive prompt, with non-interactive contexts skipping plugins. It is the
   right security posture and it is real UX work. Alternative: require the stamp
   only for **path** specifiers (code shipped inside the repo) and let bare
   installed packages load unprompted, on the grounds that installing them already
   executed their install scripts. *Decision (2026-09-02): prompt for path
   specifiers only; bare installed packages load unprompted.*
2. **A first-class install dir for non-Node repos?** §7.1 recommends committed path
   specifiers and no new mechanism. If the maintainer wants `codegraph plugins
   install` with its own dir, it must live somewhere committed (`tools/codegraph/`,
   not `.codegraph/`), and it is a new sub-project's worth of npm plumbing.
   *Decision (2026-09-02): no first-class install dir; committed path specifiers.*
3. **Do plugin synth passes run in resolver workers in v1?** §4.4 says yes, since
   parse workers already need plugin loading for `extract()` and the fallback path
   (a pass that fails on a worker retries on the main thread) already exists.
   Main-thread-only would be simpler but serializes plugin passes on exactly the
   repos where synthesis is expensive. *Decision (2026-09-02): worker-side.*
4. **`replaces` on the config entry vs the manifest.** Config (§7.2) puts the
   decision with the person who owns the repo; a manifest field would let a plugin
   author displace a built-in for every user who installs it. *Decision (2026-09-02): config only.*
5. **Publish the types package in v1?** §9.3 recommends prepared-not-published
   until CG-71 passes, mirroring `codegraph-ui`. The counter-argument is that an
   unpublished package makes external authorship awkward (plugin authors would
   vendor the types). *Decision (2026-09-02): unpublished through CG-71;
   publish with the release that ships plugin support.*
6. **Per-plugin sandboxing** (§6.1) is out of scope for v1. If it ever becomes a
   requirement, the shape is a separate process with an IPC contribution protocol —
   which the file/batch-grained boundary in CG-72 would also want. Worth keeping
   the two in the same conversation. *Decision (2026-09-02): confirmed out of
   scope for v1; revisit alongside CG-72.*

---

## What each downstream task takes from here

| Task | Consumes |
|---|---|
| **CG-64** internal registry | §2 (the three contexts), §7.2 (order, duplicate rejection, `replaces`, namespaced pass names, `SYNTH_PROGRESS_STEPS` becomes per-run) |
| **CG-65** config | §5 (file choice + schema + `loadPluginEntries` + warn-and-skip posture + `indexed_with_plugins`) |
| **CG-66** types package | §4 (module shape, manifest, contribution guarantees), §9.3 (what is and is not in the contract, publishing model) |
| **CG-67** loader + lifecycle | §4.4 (resolved set), §6 (trust), §7.1 (resolution, ESM/CJS, native ban, Windows path rules — VM-validated), §9.1–9.2 (failure policy, diagnostics) |
| **CG-68** end-to-end | §3 (write-path only), §4.3 rule 4 (ONE `synthEdgeLabel` helper in `src/graph/`, label carried through the wire payload), §4.3 rule 7 (contribution validation), §5.4 |
| **CG-69** example + harness | §7.3 (double-index determinism check), §4.1 (`ctx.log`, no stdout) |
| **CG-70** docs | §6.1 (say plainly that plugins are unsandboxed), §5.4 (no hot reload), §8 (cooperative yield), §10 (a new *language* is still a core contribution) |
| **CG-71** validation | §7.2 (`replaces` makes the built-in port possible), §7.3 (graph equivalence modulo id scheme), §8 item 5 (the perf gate), Windows VM run |
| **CG-72** language spike | §10 |

## References

- GH [#1376](https://github.com/colbymchenry/codegraph/issues/1376) — the issue,
  plus marcelovani's three-layer comment and ytfh44's two-surface / kernel-boundary
  comment.
- GH [#300](https://github.com/colbymchenry/codegraph/pull/300) — the blocked Drupal
  contribution that motivates the epic; CG-71 ports it out-of-tree.
- GH [#1563](https://github.com/colbymchenry/codegraph/issues/1563) — "which layer
  should a new language target now?"; the cost of leaving §10 unanswered.
- `docs/design/framework-coverage.md` — what a framework resolver has to produce
  for each of the three pictures (routes, navigation, guards).
- `docs/design/callback-edge-synthesis.md`,
  `docs/design/dynamic-dispatch-coverage-playbook.md` — what a synthesis pass is
  for and the validation bar it is held to.
- `docs/design/native-extraction-kernel.md`, `docs/design/rust-kernel-migration-plan.md`
  — the seam §10 defers to.
