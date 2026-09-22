# Internal dependency shadow recorder

This implements the bounded follow-on to the [contract review](semantic-dependency-contract.md)
as an **explicitly enabled validation host**, not a shipping engine option. The three
modules live under [docs/validation/dependency-shadow](../validation/dependency-shadow/).
No production source, schema, worker, public SDK or Drupal package is changed.

## Observation point and admission

The harness packs a small `shadow-binding` package whose entry points to the audited
host adapter. The real `ExtensionManager` installs/trusts its bytes; the normal loader
registers its pass and the existing candidate/synthesis pipeline runs it. The pass
receives the real `ResolutionContext`, reads the real candidate nodes and returns
ordinary validated edges through the real registry merge into SQLite. No pipeline or
context monkey patch is used. The validation package's absolute host-module path is
test-owned, local and nonportable; it is never a registry artifact or public opt-in.

`recorder.enable(projectRoot, { expectedPackageDigest, owners })` explicitly creates
one process-local validation session. The session is not inferred from a plugin option
or manifest. The loader's actual resolved package digest must match the host's approval.
The host adapter/recorder/compiled engine digests are bound at module load and a later
disk change disables recording. This is an audited allowlist, **not arbitrary-plugin
containment**. Existing v1 code can access Node; a proxy cannot stop that. Without a
session, the adapter executes normally with no shadow callback. Other v1 hooks are
never double-invoked by the observer and normally make the generation ineligible.

Two additional exact-digest fixture producers are admitted only in isolated tests:
a source-only node producer for stable-ID query-order changes, and a colliding edge
producer for ownership order. They always evaluate normally, once; their output is
never cached or shadow-executed. They are not a second reusable adapter or an API for
arbitrary upstream declarations. The legacy filesystem hook remains ineligible.

The adapter is grounded in the generic binding pass in
[`__tests__/extension-sync.test.ts`](../../__tests__/extension-sync.test.ts): resolve
`dispatch` to the unique named Python function, with option override and a real failure
sentinel. `binding.txt` deliberately moves metadata outside the indexed source set;
`.events.yaml` registration membership supplies a fallback. Fixed optional probes
exercise an unsupported derived query and a caught missing operation. No option can
select an arbitrary function or arbitrary context operation.

## Exact views, reads and invocation identity

The audited evaluator has no filesystem, network, clock, environment or module reads.
Only the surrounding host observer performs bookkeeping. Its four captured operations
delegate to the actual context: `getAllFiles`, `fileExists`, `readFile`, `getNodesByName`.
Unknown operations are forwarded with sticky taint set **before** execution or an
exception, including when the audited callback catches that exception. The observer
does not reinterpret errors as an empty successful capture.

Node results use a declared internal JSON projection: remove `updatedAt` and undefined
properties, preserve all remaining values and array order. This is a new internal view,
not transparent interception of arbitrary v1 callbacks. The evaluator cannot read the
omitted fields. Returned arrays/objects are detached copies. All empty, false and null
results are recorded, not just successful symbols. Each observation stores operation,
arguments, complete result value and SHA256, serialized value byte count and empty-result marker.
Diagnostic rows retain invocation identity, premerge owned output and the certified
SQLite edge set so the receipt hashes and comparisons can be independently recomputed.
No previous returned member list substitutes for reexecuting a query predicate.

Identity binds canonical project path, loaded adapter/observer/engine bytes, engine
version, view contract, post-resolution stage, options, full project config, ignore
rules, CODEGRAPH environment settings, all loaded package digests/options/replacements,
and the actual ordered synthesis registry (including builtins). The config includes
scan policies, enabled state and replacements. Read-set replay uses the new candidate's
context. A trace from another committed graph marker or identity is cold/ineligible.

The first implementation is deliberately conservative and expensive: it replays complete
queries and hashes their results, reads identity files and inspects SQLite. No efficient
bucket index, missing-path watcher or general derived-query implementation is claimed.

## Authoritative execution and commit discipline

1. Always run the full audited callback on the real context. Its result is authoritative.
   An actual callback error follows the existing loader/candidate failure path.
2. If explicitly admitted, replay the previous committed trace to predict `wouldReuse`.
   Always run the separate capture execution of **only this audited callback**, and
   compare its exact premerge output with the authoritative output. For a predicted hit,
   also compare the previous owned output exactly with the newly evaluated result.
3. Return the original authoritative result regardless of observer error, mismatch,
   budget or taint. Observer failure/mismatch disables the session's trace; unsupported
   reads/legacy input discard that generation. No observed result controls the graph.
4. The validation owner wraps a real engine/manager operation in `session.operation`.
   A pending trace is not retained as a valid generation unless the operation returns
   successfully, the existing `codegraph.semantic.update` **committed** event occurred,
   the actual SQLite `semantic_update` marker changed, observed metadata/config still
   matches, and exact fixture-owner SQLite output matches the expected ordered merge.
5. Store the full owned output **before pair merge**, including an output shadowed by
   another owner. The ownership test reverses registry order and removes the winner;
   the previously shadowed contribution must appear. The private fixture oracle supplies
   the known competing owner's output. This is not a general replacement for observing
   all builtin/extension merge outputs in a production recorder.

Failure, partial work, unknown commit path or missing observation drops the trace. The
existing transaction and recovery code is untouched; no new process-death mechanism
exists to validate. A fresh child process proves that observation state is absent while
the real graph remains correct. The validation owner closes the recorder with its graph.
Normal `CodeGraph.close()` has no new observer hook; lifecycle association is private
to this owner and would need an explicit internal hook before product integration.

One trace is retained per explicitly registered project, bounded to 128 observations
and a 64 KiB serialized `{identity, trace, owned}` payload by default. Oversized captures
are declined without affecting the callback. Reporting history is capped at 256 rows
per session; it is diagnostic overhead, not an engine cache. The limits are serialized
payload bounds, not promises about V8 heap allocation. Closing removes the session,
trace and listener. No trace is written to the project or restored from disk.

## Integrated boundaries discovered

**Normal config-triggered sync can bypass candidate events.** It still runs the normal
engine and applies the changed options, but this observer cannot certify that path.
It discards observations. The options/scan identity cases therefore use the real explicit
candidate refresh, and a separate normal-sync case asserts this conservative refusal.
This is a finding about observation coverage, not a change to sync behavior.

**Non-indexed metadata is not a certified filesystem snapshot.** The existing engine
source stamp does not cover arbitrary `binding.txt` reads. A deliberately timed edit
after candidate evaluation can leave the old observed binding committed. The observer
detects the changed direct-file observation and refuses to certify a trace; it cannot
retroactively undo or repair the authoritative graph. Explicit refresh converges. Even
auth/shadow equality can compare the same cached old file content, so equality alone is
not a freshness guarantee. Indexed-source mutation rejects the actual candidate; config
mutation during copy remains pending for the next sync and cannot certify the old trace.

Only the main-thread resolver is instrumented in this validation. Worker dispatch lacks
the private session and must remain ineligible; no shared-process state or worker-channel
integration was added. Native worker and transaction evidence remains the unchanged
accepted evidence, not a new native shadow claim.

## Decision

**Pass for this bounded shadow experiment; no-go for production skipping yet.** It
predicts repeat/irrelevant-input reuse while preserving actual full evaluation and
detects the specified changes and failures. This cheap binding callback does not establish
an economic case: small-fixture observation overhead must be compared with the much
smaller callback time, not with the whole indexing operation. Predicted work avoided
is hypothetical; actual callback skips are zero.

Before a selective-reuse implementation: provide real candidate generation and close/
worker lifecycle hooks; close the non-indexed/negative-input observation and revalidation
gap; cover every eligible commit path; generalize premerge ownership comparison without
assuming the fixture schedule; measure a useful audited callback where replay costs less
than reevaluation. Retain legacy/global fallback and the current atomic graph transaction.
Do not roll this into public API-v1 admission, persistent cache, Drupal partitioning,
cyclic stage evaluation or graph storage deltas. Global extraction/resolution/candidate/
database costs persist. See the [exact evidence report](../validation/extensions-dependency-shadow-20260922.md).
