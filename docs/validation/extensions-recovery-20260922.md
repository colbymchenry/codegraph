# Extension preview: recovery and validation

This is a development checkpoint, not a product release. Runtime/graph source checkpoint:
`c33354c930e1853f618223734186bc2d2aaf9bec`, based on
`ba3c21e50d9129d2f5f3843ec3728868ae6d47a1`. The follow-up `2ca1385` changes marketplace source/documentation links only.
Final regression tested clean revision `07b0a10455989cf33ce134a7557b20168c7c287d`,
which adds only the report/changelog/coverage checkpoint to that source.
The subsequent regression evidence commit changes documentation only.

## Scope and fixes

The preview adds project-scoped framework/synthesis factories, compiled-worker
loading, managed `.cgext` packages and transactional graph refresh. The Drupal
package replaces the built-in Drupal contribution only when explicitly selected.
A browser marketplace talks to an approved loopback companion, with project
selection and signed, immutable publisher releases backed by SQLite.

Validation exposed and fixed these problems:

- Literal route paths were dropped or interpreted as fuzzy symbol queries.
  Exact paths, including placeholders and method suffixes, now resolve to route
  nodes. Synthesized links retain the extension's label and wiring location.
- PHP comments and quoted code examples could produce false invocation edges.
  A position-preserving code mask excludes comments, strings and heredoc/nowdoc
  content when identifying executable calls.
- Disable/remove operations reported activation. Their completion messages now
  describe the operation, and the browser replaces stale progress notifications.
- Mobile details hid version, compatibility and source metadata. Those details
  remain visible at 390 px without horizontal overflow.

## Validation environment and commands

Linux x86-64, Node 22.23.2, npm 10.9.8, Chrome 153.0.8010.36, Playwright 1.63.0.
The host has approximately 3.8 GiB RAM. Heavy commands run sequentially.
No additional model sessions or paid resources were used.

```sh
npm ci
npm run build
node scripts/build-extensions.mjs
npm test -- --maxWorkers=2 --minWorkers=1
node --test scripts/validation/extensions-runtime.test.cjs
node --test scripts/validation/drupal-negative.test.cjs
PLAYWRIGHT_MODULE=/absolute/path/to/playwright node scripts/validation/marketplace-browser.cjs
CORPUS_OUTPUT=.qa/recovery/corpus-verified node scripts/validation/drupal-corpus.cjs /absolute/path/to/fresh-corpus
node scripts/validation/control-benchmark.cjs /path/to/engine /path/to/fresh-express /path/to/result.json
```

Playwright is a validation dependency installed outside this repository. The
browser harness accepts `CHROME_PATH` when Chrome is not at its Linux default.
Corpus tools operate on caller-owned disposable clones. Do not point them at
a working repository. Corpus roots must be named `pathauto`, `commerce`, and
`drupal`; Drupal's `codegraph.json` excludes `**/tests/**`. Pathauto retains its
tests because the selected hook implementation lives in a test module.

Each captured command has a `.qa/recovery/<name>.log` and JSON record with its
arguments, working directory, start time, exit code and duration. These local
artifacts are ignored by Git. The first historical full-suite log had no final
summary, so its outcome is unknown. Later interrupted attempts are recorded in
`executor-interruptions.json` and are not counted as passes.

## Regression checkpoint

The earlier recovered-source full suite completed with 259 passing files / 4,539
passing tests and 16 skipped files / 192 skipped tests. That run predates the
final fixes and is separate from the final-source results below. The subsequent
unsharded final suite and first shard-1 attempt were interrupted without a
completion receipt or summary; neither is counted as passing.

The final source passed all four sequential Vitest shards on September 22,
2026, from 02:10:11 to 02:18:25 UTC. Every shard tested clean revision
`07b0a10455989cf33ce134a7557b20168c7c287d` with this exact command, substituting
the shard number for `N`:

```sh
npx vitest run --shard=N/4 --maxWorkers=2 --minWorkers=1
```

| Shard | Exit | Files passed / skipped | Tests passed / skipped | Command seconds |
|---|---:|---:|---:|---:|
| 1/4 | 0 | 64 / 6 | 1,693 / 63 | 136.478 |
| 2/4 | 0 | 65 / 5 | 1,125 / 56 | 102.268 |
| 3/4 | 0 | 68 / 2 | 860 / 23 | 147.704 |
| 4/4 | 0 | 64 / 3 | 867 / 50 | 89.888 |
| Total | 0 | 261 / 16 | 4,545 / 192 | 476.338 |

There were zero reported failures. Skipped tests are not validated coverage.
The combined file inventory matches all 277 tracked test files exactly once,
with no missing, unexpected or duplicate files. Source and configuration stayed
unchanged throughout; no test fixes were needed in this continuation.

The committed [regression receipts](extensions-regression-20260922.json) contain
each exact command, revision, start/finish time, exit, summary, file inventory
and raw-log SHA-256. Local originals are
`.qa/recovery/final-shard-{1,2,3,4}.{started.json,json,log}`. The interrupted
01:58:11 shard attempt is retained separately as
`.qa/recovery/final-shard-1-interrupted-015811.*`, including an explicit
incomplete record with unknown exit status. Each successful shard wrote its
receipt and appended the external recovery checkpoint before the next began.

Stable execution was possible during this continuation: all four commands
completed normally without another task interruption. This does not diagnose
the earlier interruptions. Klaus's readback reported continuous kernel uptime
of about six days and zero visible OOM events; the earlier SIGTERM exits do not
establish a host reboot or CodeGraph crash. Host/control logs were unavailable,
and the shared-service cause remains unknown. No infrastructure changes were made.

Completed final-source preparation: engine build (exit 0, 35.389 s), Drupal
package build (exit 0, 0.329 s), Drupal negative fixture (exit 0, 1.413 s), and
marketplace frontend build (exit 0, 0.245 s). The rebuilt Drupal package hash
matches the artifact used for the completed corpus checks.

This milestone reused the successful corpus, browser, worker and control
artifacts because there were no invalidating source changes. PR preparation
is the next milestone; this pass did not push, create a PR, deploy or release.

| Product gate | Status after this milestone |
|---|---|
| Code-complete | Incomplete: acceptance gaps below remain |
| Validated | Final Linux regression passed; broader acceptance remains partial |
| Preview-ready | Local evidence exists; hosted HTTPS preview unverified |
| Released | No |

## Worker, package and browser checks

The compiled-worker harness asserts positive worker thread IDs for both parse
and resolver contributions, changed options, separate roots, lifecycle cleanup,
and failed parse/resolver updates preserving the entire prior graph and config.

The package/marketplace contract suite covers unsafe paths, unsupported API
versions, changed trusted bytes, integrity failures, persisted immutable
releases, ownership, replay, expired submissions, invalid signatures, malformed
packages, and unauthorized/cross-origin/forged-host bridge requests.

The real browser run covers signed upload, a second publisher's rejected claim,
invalid-signature and malformed-package failure messages, installation into the
selected project, update failure rollback, successful update cleanup,
disable/enable/remove, wrong-window and wrong-origin messages, and mobile layout.
SQLite queries verify graph state rather than relying only on button text.
Screenshots: `.qa/recovery/browser/desktop-installed.png` and `mobile-detail.png`.
This is local HTTP browser evidence, not hosted HTTPS or Windows/macOS evidence.

The Drupal negative fixture checks unknown controllers, cyclic service aliases,
computed identifiers, ambiguous plugin IDs, and fake calls in comments/strings,
alongside positive route, service, hook, plugin and event examples.

## Real repositories and performance

The corpus run exited 0 in 576.769 seconds. All three repositories passed
explicit edge assertions, built-in replacement, three explore probes each,
whole-graph deterministic rebuild, and incremental add/remove convergence.
Canonical hashes exclude only node `updated_at` and auto-generated edge IDs;
node identities, edge metadata, locations and provenance are compared.
The inserted route's unknown controller stays unresolved, and removing the
route restores the original whole-graph hash.

| Corpus | Revision | Indexed files | Nodes | Edges | Extension edges |
|---|---|---:|---:|---:|---:|
| Pathauto | `b97aadf47a37cff25f7d6105c3dade6778fccb47` | 89 | 1,103 | 1,867 | 66 |
| Commerce | `643bb39620c083f6d52acd41c8170d7f34b40e1c` | 1,230 | 12,190 | 26,962 | 411 |
| Drupal | `eaba66f418831210acc6bc5b49c61d171853455b` | 6,728 | 64,427 | 156,865 | 4,251 |

The three selected boundary flows in each corpus are:

- Pathauto settings route → settings form, bulk-update route → bulk form,
  and `AliasCleaner.getPunctuationCharacters` → the declared punctuation hook.
- Commerce cart route → cart controller, checkout route → checkout controller,
  and add-order route → order form. Extra assertions cover service injection
  and the cart block's plugin implementation.
- Drupal account switching → time-zone subscriber, BigPipe response dispatch →
  active-link response subscriber, and configuration import completion →
  configuration snapshot subscriber.

Each query used one `codegraph_explore` call and returned the expected labeled
link and wiring site. Responses ranged from 9,675 to 24,986 characters.
Observed per-query times were 136–423 ms, 372–588 ms, and 949–1,108 ms for the
three corpus sizes respectively. These are boundary-flow probes and selected
precision checks, not an exhaustive end-to-end application accuracy score.

All corpus runs use two parse workers and in-process resolution to fit the
host's memory; compiled resolver workers are tested separately. Milliseconds:

| Corpus | Built-in fresh | Built-in rebuild | Extension install | Extension rebuild | Second extension rebuild | Incremental add / remove |
|---|---:|---:|---:|---:|---:|---:|
| Pathauto | 1,913 | 1,711 | 1,970 | 1,904 | 1,740 | 423 / 353 |
| Commerce | 12,228 | 12,924 | 14,173 | 13,474 | 13,561 | 737 / 548 |
| Drupal | 78,291 | 82,764 | 87,781 | 107,461 | 100,635 | 2,695 / 2,340 |

The first extension rebuild is about 11%, 4%, and 30% slower than the built-in
rebuild at these sizes. The second Drupal rebuild is about 22% slower. Different
graph coverage and a memory-constrained shared host limit this comparison;
these observations do not establish a performance SLA or a general speedup.
Earlier contended/interrupted runs are retained but excluded from this table.

Express control revision `9a34acf03cb818ff3f8bc40e44176e277a25cbb9` was indexed in
four fresh clones, alternating baseline and candidate twice. Baseline times:
3,928 / 3,198 ms; candidate: 2,865 / 3,104 ms. Medians: 3,563 / 2,984.5 ms.
All four have 148 files, 1,124 nodes, 3,156 edges and identical canonical hash
`282cc97105416e6033719e953505803ed507320accfa24d64dfbe06b81dc9264`.
No control graph change or slowdown was observed; two runs per arm are too few
for a general performance claim. Candidate timing records predate its commit
and report the base HEAD; the candidate checkout contained the runtime source
subsequently preserved in `c33354c`.

The Drupal package SHA-256 for these results is
`e5015747d02fe50d6af607b6c44f1db9cf7969a0070866ed03c7643377a459c8`.
Per-repository records, hashes and all nine raw responses are under
`.qa/recovery/corpus-verified/`; control records are under `.qa/recovery/control/`.

## Acceptance gaps

- The author-kit gap at this regression checkpoint was subsequently closed for
  the Linux preview by `8b30afb`: public SDK exports, starter generation, dedicated
  author tests and a fresh generated-extension publish/install/removal exercise.
  See [author acceptance](extensions-author-20260922.md) for its separate evidence
  and limits; the original recovery scripts alone did not satisfy this gate.
- The compatible-version gap was subsequently closed for Linux/local in
  `79f2d9f`: browser and headless registry installs select the highest compatible
  stable semver; exact pins and automatic no-downgrade updates are verified.
  See [compatible release acceptance](extensions-compatibility-20260922.md).
- Exception rollback is tested. Process termination between config/database
  writes and stale `operation.lock` recovery are not completed crash guarantees.
- Only Linux was exercised. Native Windows/macOS installation, worker loading,
  filesystem replacement and browser-companion behavior remain unverified.
- Drupal spot checks do not establish exhaustive precision/recall. Computed IDs,
  external dependencies outside the index and ambiguous declarations remain
  unresolved. This does not add language providers, PHP branch guards, or
  Drupal screen navigation.
- Repository guidance's agent A/B, tool-call/Read/Grep and occupancy/sufficiency
  metrics were not run: this assignment explicitly excludes extra agent sessions.
  Deterministic probes and indexing timings cannot substitute for those metrics.
- Vercel readback found no project linked to this repository. No hosted preview
  or release was made. The gateway requires `MARKETPLACE_API_ORIGIN` pointing to
  an HTTPS registry service with persistent SQLite/artifact storage, backups and
  a restart/persistence check. The registry binds loopback and needs an appropriate
  reverse proxy on its durable host. Vercel's ephemeral filesystem is unsuitable.
- Hosted HTTPS-to-loopback connection, publishing, installation and failure
  handling still need integrated browser acceptance. There is no release claim.
