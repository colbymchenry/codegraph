# Internal dependency shadow validation — September 22, 2026

**Pass for the bounded shadow experiment; no-go for production callback skipping.**
The explicitly enabled host recorder observes one audited binding adapter in the real
managed candidate/synthesis path. Full callback evaluation and the engine's committed
SQLite graph remain authoritative. It predicts reuse and compares output; it skips
nothing. Observation costs more than this representative callback, and snapshot,
commit-path and lifecycle gaps remain.

Tested review source: **`58b04f685a9b7487ac60e1b0754c9db40a2b8480`**.
Application remains **`7575dcc71e4524c660aff06486ebc007cca290b9`**. Changes since the
accepted `415291a` review are confined to documentation and executable validation.
No production source, public API, schema, worker, workflow or Drupal artifact changed.
[Design/admission and limitations](../design/semantic-dependency-shadow.md) ·
[Exact source, compiled, raw and command ledger](extensions-dependency-shadow-20260922.json).

## Reproduction and integration scope

Run from the built checkout, with its existing dependencies:

```sh
node docs/validation/dependency-shadow/run.cjs .qa/dependency-shadow/review
```

The accepted command used output directory `.qa/dependency-shadow/auditable-final`.
The durable wrapper command was:

```sh
python3 ../run-check.py dependency-shadow-auditable-final \
  node docs/validation/dependency-shadow/run.cjs .qa/dependency-shadow/auditable-final
```

It exited **0** in **30.472 seconds**, starting 17:11:21 UTC and ending 17:11:52 UTC,
with a clean tested checkout, Node 22.23.2 on Linux x64. The wrapper belongs to this
workspace's recovery tooling; the Node command is the independently executable check.
It writes source copies, incremental progress, a result and a child-process log, uses
only disposable owned projects and removes those projects on exit.

The fixture package points to a local audited host module through the ordinary managed
loader. The package is trusted/installed by `ExtensionManager`; synthesis receives the
actual candidate `ResolutionContext`, returns validated edges, and goes through the
real registry pair merge and SQLite transaction. The binding is grounded in
`__tests__/extension-sync.test.ts`. There is no model context or mocked SQLite in this
matrix. The older review's canonical hash helper is reused, not its evaluation model.
The internal absolute-module bridge is test-owned and nonportable, never a published
package or arbitrary API-v1 opt-in. Production has no import of the recorder.

Capture is limited to the audited adapter. Other callbacks still run normally, once.
Only two exact-digest fixture producers are specially admitted upstream to exercise
same-ID ordering and collisions; their outputs are not cached or shadow-executed.
The session requires explicit project and package admission. It captures file values,
missing results, full query membership/fields/order, config/scan/options, loaded code
and package digests, stage and ordered registry. The view deliberately excludes node
`updatedAt` and undefined fields. This is not transparent interception of v1, filesystem
containment or proof of arbitrary-plugin determinism.

## Results

**63 grouped checks pass**, including reset/reference cases and ten repeat timing
samples. There are **47 certified operation rows**, 14 observed but uncertified rows,
and two recorder-disabled/reference checks. They are not 63 different feature classes.
No callback is skipped. Every successful operation asserts actual target names in
SQLite; certified rows also compare exact premerge owned output, authoritative callback
output and the known fixture-owner merge with SQLite. The final recorder-disabled
full reference asserts the complete normalized edge graph equals the prior graph.

| Actual managed-engine coverage | Result |
|---|---|
| Missing metadata and missing symbol, appearance, ambiguity, deletion and rename | Correct invalidation and edge presence/absence |
| Metadata retarget between untouched endpoints; non-indexed `binding.txt` | Correct on explicit full candidate refresh |
| `.events.yaml` enumeration membership and deletion | Correct binding appearance/removal |
| Same-ID signature field; stable-ID query order from a pinned source producer | Correct new output; prior trace not reusable |
| Options, scan/ignore policy, project, adapter package bytes/version and registry order | Identity invalidates prior trace |
| Overlapping edge owners, order reversal and winner removal | Full premerge ownership retained; correct surviving edge |
| Irrelevant indexed-file content change | Predicts reuse while fully evaluating and committing |
| Wrong digest admission; real unrestricted filesystem hook | No recording admission/global fallback; legacy callback count unchanged |
| Unsupported derived query and caught unknown operation | Sticky taint, uncertified trace, normal graph correct |
| Actual callback failure and retry | Old SQLite preserved; failed trace discarded; retry cold |
| Capture exception, shadow mismatch and corrupted predicted output | Observer disabled; authoritative graph unchanged |
| Indexed-source/config/non-indexed-source mutation | Actual engine behavior and certification limits below asserted |
| Budget refusal, session close and real fresh child process | No trace reuse; graph remains correct |

The final receipt includes **195 full query values with independently recomputed hashes**
and **47 certified SQLite edge sets with independently recomputed hashes**. Invocation
identity, owned output, phase list, marker and metrics accompany each observed row.
The default cap is 128 reads and 64 KiB of serialized `{identity, trace, owned}` per
retained trace. History is capped at 256 rows per session; this is not a V8 heap bound.

## Observation costs, not a speedup

Five consecutive samples per row, on the small fixture. “Unchanged” deliberately calls
explicit full refresh, not no-change polling. “Irrelevant” changes the contents of an
existing **indexed** unrelated Python file, then explicitly refreshes. Both retain the
same observed binding queries. Every sample predicts reuse and still does all actual
work; the nominal callback work avoided is hypothetical.

| Metric, median milliseconds | Unchanged | Irrelevant indexed content |
|---|---:|---:|
| Full authoritative callback / predicted callback work avoided | 0.405 | 0.334 |
| Invocation identity | 1.471 | 1.222 |
| Trace replay | 1.218 | 1.114 |
| Capture bookkeeping (included in shadow execution) | 0.177 | 0.158 |
| Audited shadow execution, including capture | 0.342 | 0.278 |
| Output comparison | 0.052 | 0.050 |
| Post-operation commit/SQLite/file verification | 1.091 | 1.151 |
| Observer total | **4.052** | **4.197** |
| Entire actual engine operation, including observer | **464.675** | **417.709** |

Observer ranges: **3.701–6.236 ms** and **3.513–5.988 ms**. Authoritative callback
ranges: **0.310–0.528 ms** and **0.292–0.431 ms**. Entire operation ranges:
**398.602–478.744 ms** and **406.608–447.213 ms**. One comparison outlier of 2.180 ms
is retained. Each repeat sample records three reads and **3,123 serialized trace bytes**.
The ledger preserves every unrounded sample and earlier attempts.

The observer sum includes identity, replay, shadow execution, output comparison and
final verification. Capture is a subset of shadow execution, not added twice. Per-stage
medians need not sum to the median total. It is instrumentation timing, not paired
observer-on/off engine benchmarking or CPU isolation. No performance claim is derived
from the difference between the two small sample groups.

This cheap adapter fails the economic gate: even replay alone exceeds reevaluation.
Removing the shadow comparison alone would not make this implementation profitable.
Base extraction, global resolution, full candidate construction and database replacement
still run. No large-corpus matrix was rerun or extrapolated from these values.

## Findings that block selective production reuse

1. **Non-indexed metadata can change outside the engine's source stamp.** A mutation
   after candidate evaluation commits the old observed binding. The observer's direct
   read revalidation rejects certification, but cannot undo the successful graph commit.
   Explicit refresh converges. Authoritative/shadow equality can agree on cached old
   content; it does not prove freshness. Missing/directory/query inputs need a coherent
   observation/revalidation contract before selective output reuse.
2. **Normal config-triggered sync can lack the candidate commit event/marker.** It
   applies the option change through the existing engine path but remains uncertified.
   The options/scan identity tests use explicit candidate refresh; the normal path's
   conservative refusal is a separate assertion. No partial trace is promoted.
3. **Lifecycle and ownership coverage are private to the fixture host.** The owner must
   close its session with the graph; only the main-thread resolver is observed. Known
   competing output is supplied by a fixture oracle. Production would need candidate
   generation/close/worker integration and general premerge ownership observation.
4. **A context proxy is not a sandbox.** Exact reviewed code admission is essential;
   arbitrary API-v1 filesystem hooks remain globally evaluated and ineligible. Public
   package flags cannot provide the required guarantee.

Indexed-source mutation rejects the real candidate and preserves the prior graph.
Config mutation during copy leaves the later option pending and rejects certification;
normal sync applies it afterward. Actual callback failure follows existing atomic
candidate rollback. Observer mismatch/error never changes the returned authoritative
edges. No transaction/recovery code was changed, so no new process-kill matrix is claimed.
The fresh process case demonstrates cold recorder state, not a new kill-recovery test.

**Smallest justified follow-on:** design and prove the non-indexed/negative-input
snapshot and internal lifecycle hooks for this same shadow host, while retaining full
evaluation. First establish a callback whose measured cost exceeds capture/replay and
cover every eligible commit path. Do not enable production skipping, introduce a public
API opt-in, persist traces, partition Drupal broadly or change storage in this milestone.

## Retained attempts and unchanged evidence

| Command suffix | Exit | Scope |
|---|---:|---|
| `first` | 1 | Missing brace caused module-load failure |
| `second` | 1 | Harness queried `metadata`; actual table is `project_metadata` |
| `third` | 1 | Incorrect expectation of certification on normal config-sync path |
| `fourth` | 0 | 63 checks; preliminary observer/budget/source identity |
| `final` | 0 | 63 checks at `fa2c839`; loaded-code identity, exact payload budget, indexed repeat input |
| `auditable-final` | 0 | 63 checks at `58b04f6`; full observation values/identity/SQLite preserved |

All six receipts, logs and available source copies are retained. The first load failure
preserved its original recorder; run/adapter were unchanged from the second saved
copies but were not separately copied at the moment of that failure. The third failure
was an observation-coverage discovery, not a graph failure or an engine fix. Later
passes use conservative refusal plus an explicit separate assertion, not a weaker
claim of successful tracing. Earlier successful runs are superseded for final metrics.

The accepted **26 source and 13 compiled hashes** from semantic-update validation still
match. This ledger additionally inventories **18 source, 21 compiled and 47 raw files**,
with all six receipt bodies/log hashes. Drupal 0.1.0 and 0.1.1 bytes remain immutable.
No full/native suite was rerun for validation-only changes:

- Full Linux evidence remains **4,577 passed / 192 skipped**, 284 files once at `e0885ee`.
- Native run [35744283425](https://github.com/colbymchenry/codegraph/actions/runs/35744283425)
  remains successful at application `7575dcc`: Windows 2022 x64 162 focused/four skips,
  macOS 15 ARM64 165/one, with accepted worker and 76 recovery cases per OS.
- Prior measured warm Pathauto/Commerce improvements, core cold regression
  **103.49 → 112.45 s** with higher RSS, global candidate cost, historical **22–30%**
  rebuild overhead and unfavorable diagnostics retain their original scope. Stable
  failed references did not reproduce the no-change rebuild concern.

No current-head native/full-suite or hosted CI claim. Cloudflare account/resources,
stable Worker HTTPS, provider persistence/backup/retention and deployed Free-plan CPU
fit remain unverified. No remote import, hosting, DNS, paid/account/runtime action,
merge, release or package publication occurred. Product delivery remains incomplete.
