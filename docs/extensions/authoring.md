# Write a CodeGraph extension (API v1 preview)

Use an extension to add framework extraction, reference resolution or semantic
edges for a language CodeGraph already understands. The API does not add parsers,
query-time tools, PHP branch guards or browser screen navigation automatically.
Extension code runs with the user's permissions in the main process and workers;
it is trusted executable code, not a sandbox. Installation never runs npm scripts.

These commands are in this development branch, **not a published npm release**.
Use a build from the draft PR. From a source checkout, run `npm ci`, `npm run build`,
then put `dist/bin` on PATH (or invoke `node /absolute/path/dist/bin/codegraph.js`
where this guide says `codegraph`). Embedded SDK consumers need Node 22.5–24.

## Start outside the core repository

Run these commands from a separate working directory with an existing parent:

```sh
codegraph extensions create ./python-events --id python-events
codegraph extensions test ./python-events
codegraph extensions pack ./python-events --out ./python-events-0.1.0.cgext
```

`create` refuses an existing directory. It produces `package.json`, `index.cjs`,
`extension.test.json`, and a standalone README. There is no runtime dependency,
private core import, source-copying step or bundler requirement for this starter.
Keep the `.cgext` output outside the source directory. Packages contain UTF-8
JavaScript/JSON/documentation; bundle third-party dependencies before packing.
Native addons, symlinks, arbitrary file extensions and packages over 8 MiB are
rejected. This template keeps its Python/YAML test sources inside fixture JSON.

The starter describes a small Python event-map framework. A `*.events.yaml` file
has one unquoted `event.name: python_function_name` per line. The extension adds
event route nodes and labelled links to unique indexed Python function nodes.
Computed, unknown and ambiguous handlers remain unresolved. It is an example
contract for authors to adapt, not support for every Python event library.

## Install into a non-Node application

Create a separate directory `python-app` with these two files:

`checkout.events.yaml`:

```yaml
order.created: send_receipt
```

`handlers.py`:

```python
def send_receipt():
    return "sent"
```

```sh
codegraph extensions install ./python-events-0.1.0.cgext --path ./python-app
codegraph extensions list --path ./python-app
codegraph extensions remove python-events --path ./python-app
```

The managed installer initializes/indexes the target and pins the package bytes.
The target needs no `package.json`, npm install, Python execution or Python library.
While installed, inspect the `event:order.created` route and its `Python event
dispatch` edge to `send_receipt` in the graph. The author test command below checks
these actual nodes/edges through the public graph API and verifies removal.

## Public types and factory

All author types and helpers are exported from **`@colbymchenry/codegraph`**.
Do not import `src/`, `dist/plugins/`, database classes, or private registries.
For local editor/type checking before release, make a development package with
`npm pack --ignore-scripts --pack-destination /absolute/path/to/artifacts` in the
built core checkout, then in the author project run
`npm install --save-dev /absolute/path/to/artifacts/colbymchenry-codegraph-1.6.0.tgz`.
This is local packaging, not npm publication. The installed editor dependency is
excluded when packing the extension.

The CommonJS starter uses a JSDoc `CodeGraphPlugin` type and `module.exports`.
A TypeScript author can use `import type { CodeGraphPlugin } from
'@colbymchenry/codegraph'`, compile to CommonJS JavaScript, and set `main` to that
compiled file. ESM factories are also supported. Bundle runtime imports; a managed
package does not inherit the target project's npm dependencies.

| Public contract | Purpose |
|---|---|
| `CodeGraphPlugin` / `defineExtension(factory)` | Factory returning `PluginContributions`, optionally asynchronously |
| `PluginContext` | Absolute project root, cloned options, engine version, warning/debug logger |
| `PluginManifest` / `EXTENSION_API_VERSION` | Package ID, API version, engine range and declared capabilities; current API is 1 |
| `FrameworkResolver` | Synchronous detection, extraction, reference resolution and optional finalization |
| `ResolutionContext` | Read-only indexed node/file lookups; optional helpers must be checked before use |
| `SynthPass` | Async whole-graph pass returning semantic edges; optional language gate |
| `Node`, `Edge`, `NodeKind`, `EdgeKind`, `Language` | Graph output shapes and supported kinds/languages |
| `createExtensionProject`, `packExtension`, `testExtension` | The same starter, packer and test harness exposed by the CLI |
| `AuthorFixtureCase`, `AuthorTestReport` | Typed fixture assertions and test receipts |

Factories must create independent per-project state. They can be called in the
main process and separate parse/resolver workers; do not rely on shared globals,
one call per index, worker order, network results, or mutable external state.
Use deterministic IDs and output. Keep synchronous hooks synchronous.

Framework hook contract:

- `detect(graph)` returns whether the framework applies. `languages` gates
  per-file extraction. The starter detects `*.events.yaml` files.
- `extract(relativeFile, source)` returns `{ nodes: [], references: [] }`.
  Every contributed ID starts with `plugin:<manifest-id>:`. Use a relative file
  path, supported kind/language, 1-based lines and 0-based columns. References
  must originate at a node returned by that extraction call.
- `claimsReference(name)` admits framework-specific reference names through the
  core prefilter. `resolve(ref, graph)` returns a labelled `ResolvedRef` or null.
  Targets must exist; confidence is between 0 and 1. Never fabricate an endpoint
  when a name is missing or ambiguous.
- `postExtract(graph)` can update previously emitted nodes, preserving both ID
  and qualified name. It cannot introduce new nodes.

For `synthPasses`, declare that capability in the manifest and return objects with
`name`, optional `languages`, and `async run(graph, yieldToLoop)`. Return `Edge[]`
whose endpoints exist, kind is supported and `metadata.label` is meaningful
(1–160 characters). Include `metadata.registeredAt` as `relative/file:line` when
known. For long loops call the supplied yield function. Core stamps
`provenance: 'heuristic'` and `metadata.synthesizedBy`; core owns persistence and
deterministic merging. Do not open SQLite or write graph files from a plugin.

## Author harness and compatibility

`codegraph extensions test ./python-events` packs and validates the real artifact,
checks the current engine against `codegraph.engines`, then installs it into fresh
disposable projects through the managed installer. It checks the declared graph
expectations, clean rebuild determinism and removal cleanup. It closes graph
handles and removes its temporary directories on success and ordinary failures.
It executes your code with your permissions. It is not a security sandbox or a
substitute for testing large real applications, process kills and each platform.

Fixtures use `format: "codegraph-extension-tests-1"` and a nonempty `cases` array.
Each case has `name`, `files` (relative paths to UTF-8 source strings) and `expect`:

```json
{
  "nodes": [{"name": "event:order.created", "kind": "route"}],
  "edges": [{"source": "event:order.created", "target": "send_receipt", "label": "Python event dispatch"}],
  "absentNodes": [{"name": "event:computed.event"}],
  "absentEdges": [{"source": "event:order.missing"}]
}
```

Node assertions apply only to this extension's contributions; optional `kind`
and `filePath` narrow matches. Edge assertions apply only to edges attributed to
this extension. Positive edges require source name, target name and label.
Negative edges can omit target/label to reject any outgoing contribution from
that source. At least one assertion is required per case. Traversal, hidden files,
`codegraph.json` and a root `package.json` are refused. Use `--fixtures other.json`
to select another fixture file inside the extension directory.

Add both successful flows and examples that must remain unresolved. Change an
expected handler or label to verify that the harness fails; it must not pass just
because an extension loads. Nonzero exit messages name the failing case and
assertion or output contract. API versions other than 1 fail before evaluation;
incompatible engine ranges report both the required and running versions.
Malformed extraction outputs, node IDs and missing edge labels report the field
requirements. Correct the extension rather than widening compatibility blindly.

For a compatibility matrix, run the same fixture command using each intended
CodeGraph build and actual operating system, preserving JSON output, engine
version and exit. `engines` is an assertion about those builds, not proof by itself.
The starter's range defaults to the current preview version through `<2`; narrow
it if you have not validated that range. Native Windows/macOS validation is still
pending for this preview.

## Publish through the local marketplace

In the core preview checkout, run `node scripts/build-extensions.mjs`, then
`node marketplace/server/dev.cjs`. Open the printed loopback URL, select **Publish
an extension**, upload the `.cgext`, and fill in the listing and your HTTPS source
repository URL. The browser signs the submission with its local publisher identity;
retain that browser profile to publish later versions of the same ID. Releases
are immutable. This is publication into your local development registry only.

Use `codegraph extensions connect /absolute/path/python-app --marketplace <local-url>`
to connect the selected target. Open the printed connection link, allow the local
connection, select the project, and install your extension. Alternatively install
the local registry's `/api/download/<id>/<version>` URL using the CLI. Remove it
with the managed removal command above. Existing signed publishing and browser
origin/window checks are shared with ordinary extensions.

The hosted HTTPS marketplace and durable production registry are unfinished.
Do not deploy or publish to npm as part of this author exercise. Other preview
gaps remain: compatible-version fallback, crash/stale-lock recovery and broader
Drupal accuracy/performance review. The prior Drupal sample measured about
22–30% rebuild overhead versus the built-in resolver; it is not a general SLA.
