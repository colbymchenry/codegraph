# Extension author tooling acceptance — September 22, 2026

Author implementation: `8b30afb328fc8fe0c4d2d0b348d53bdbcb009acc` on
`feature/extensions-author-kit-20260922`. This continues the recovered implementation,
not a second implementation. [Draft PR #1911](https://github.com/colbymchenry/codegraph/pull/1911)
contains the work. No merge, npm publication or production deployment was performed.

The complete prior checkpoint `1466021e1855a87f95bec6a7885935e4c412c02e` was pushed
first. Git fetch verified both SHA and tree
`5a341950db6cfaa21395100d6f2c709074f85c6a` matched locally, with an empty diff.
The original partial remote branch at `99cdef0c7d1845abbeb9b349f4877f36e0b341f8`
was preserved. Main was `ba3c21e50d9129d2f5f3843ec3728868ae6d47a1` immediately
before publishing. Later author/evidence commits extend the new topic branch.

## Delivered author path

- Public package-root exports for `CodeGraphPlugin`, context, framework/synthesis
  types, `defineExtension`, API version, starter, packer and test harness. These
  work through the existing npm SDK entry and generated declaration tree.
- `codegraph extensions create <directory> --id <id>` emits a standalone CJS
  Python event-map example, manifest, test fixtures and README. It refuses to
  overwrite an existing directory. No private imports or runtime SDK dependency.
- `codegraph extensions test <directory>` uses the real managed installer and
  graph API in disposable non-Node projects. It checks explicit positive/negative
  graph expectations, deterministic rebuild and cleanup after removal.
- Compatibility is checked before evaluating author code. Unsupported API,
  incompatible engine, malformed extraction arrays/node IDs and missing edge
  labels have actionable failures. Empty assertions and unsafe fixture paths fail.
- [External author guide](../extensions/authoring.md), CLI usage, public contracts,
  local publisher walkthrough and compatibility limits. The guide ships in the
  development npm package and is included by the release shim packaging script.

Reproducible author commands, using the built preview CLI on PATH:

```sh
codegraph extensions create ./python-events --id python-events
codegraph extensions test ./python-events
codegraph extensions pack ./python-events --out ./python-events-0.1.0.cgext
codegraph extensions install ./python-events-0.1.0.cgext --path ./python-app
codegraph extensions remove python-events --path ./python-app
```

The guide supplies the Python application fixture. No public npm release contains
these commands yet; use the branch build or locally packed development archive.

## Evidence

Linux x86-64 / Node 22.23.2. Exact commands, exits, source hashes and generated
graph data are in [the committed receipt](extensions-author-20260922.json).

| Check | Result | Receipt |
|---|---|---|
| Engine/viewer/grammar build | Exit 0, 121.099 s | `.qa/recovery/author-build-fixed.json` |
| Author, runtime, marketplace, route, npm SDK and CLI regression | 6 files / 26 tests passed, exit 0 | `.qa/recovery/author-focused.json` |
| Fresh external author/package/browser/install exercise | 9 checks, exit 0, 35.338 s at clean `8b30afb` | `.qa/recovery/author-e2e-verified.json` |
| Compiled worker lifecycle/isolation/rollback | 2 tests passed, exit 0, 8.019 s at clean `8b30afb` | `.qa/recovery/author-compiled-workers.json` |
| Packaging shell syntax and diff whitespace | Passed | `bash -n scripts/pack-npm.sh`; `git diff --check` |

Build and focused tests ran before the author commit. Their receipts correctly
record parent HEAD and dirty source; runtime/author source did not change after
those passes. Only documentation and the external acceptance runner were finalized
before commit. The two clean-commit exercises above validate the compiled build.
The prior 4,545-pass/192-skipped full regression remains evidence for `07b0a10`,
not a claim that the entire suite was rerun on the author-kit commit.

The fresh author exercise (`scripts/validation/extension-author.cjs`) creates an
author project under a new temporary directory outside core, packages the built
engine locally with `npm pack`, installs that archive as an author development
dependency, and type-checks the generated JSDoc against public declarations.
It then runs the generated CLI test/pack commands through that installed engine.
There is no manual copy of private core source into the extension.

The generated fixture harness passes eight assertions across two cases: literal
event-to-handler wiring, absent computed/commented events, unresolved unknown
handlers and unresolved ambiguous handlers. Each case also proves deterministic
rebuild and removal cleanup. The runtime is configured to exercise compiled
parse/resolver workers during the external test.

An actual Chrome browser submitted the generated `.cgext` through the existing
signed local publisher form. The release was community-owned and its integrity
matched the packed bytes. The CLI downloaded that local release URL and installed
it into a separate Python application with no `package.json`. The public graph
API confirmed `event:order.created` → `send_receipt`, labelled `Python event
dispatch`, with extension provenance. Managed removal cleared the route and edge.
There were no browser page errors. Screenshot and command logs are retained under
`.qa/recovery/author-e2e/`; the temporary application/registry were cleaned up.

Generated artifact SHA-256:
`d87fe94c5016372984c579b31989c036e863b6102bbf027704c7ff8afe21e5c8`.
It includes the generated author's local development manifest/lock file, so a
fresh directory/dependency resolution can change package bytes. Deterministic
graph output, rather than identical npm lock-file paths, is the asserted property.

Failed preparation attempts remain visible: the first compiler run found a
test-harness type error; the first external exercise needed a writable isolated
npm cache; the next used a synchronous child process that blocked its own local
HTTP registry. The type and runner issues were fixed before the successful run.
Those failures are not counted as passes or presented as production failures.

## Gates and remaining work

The EXT-01 external author-kit acceptance described above is complete for this
Linux preview. The original Drupal corpora and broader browser security artifacts
are reused because valid extension behavior and those sources did not change.
This increment does not establish compatibility with every framework or engine.

Repository main requires one approving PR review, prohibits deletion/non-fast-forward
updates, and has no required status-check rule in the inspected ruleset. Existing
workflows are manual release and main-branch site deployment; there is no PR test
workflow and no hosted CI pass is claimed.

Still pending: compatible-version fallback; process-kill/stale-lock recovery;
actual Windows/macOS; hosted HTTPS companion acceptance; durable SQLite/artifact
registry hosting and Vercel setup; broader Drupal accuracy and performance review.
The earlier measured Drupal rebuild overhead remains about **22–30%** versus the
built-in resolver, with limited samples and selected boundary-flow coverage.
Agent A/B remained excluded; no extra model sessions were launched.

Product code-complete: **no**. Validation: **local author milestone passed; broader
acceptance partial**. Hosted preview-ready: **unverified**. Released: **no**.
The next bounded product step is compatible-version resolution, with explicit
fallback/rejection tests against multiple immutable releases, after Klaus review.
