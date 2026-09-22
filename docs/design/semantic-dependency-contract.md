# Opt-in semantic read-set contract: decision review

Status: **proposal with validation-only evidence; no public API or production behavior change**.
Reviewed against application `7575dcc71e4524c660aff06486ebc007cca290b9` on draft PR #1911.
The executable [model](../validation/dependency-review/model.cjs) and
[driver](../validation/dependency-review/run.cjs) are not imported by the engine.

## Recommendation and decision

Proceed with a **bounded, opt-in, initially memory-only capture experiment for edge-only
synthesis over an immutable host snapshot**. Start with the generic cross-file binding
example and a trusted host-owned adapter. First implement shadow evaluation: capture
reads, predict reuse, still run the full callback, and compare outputs. Do not yet skip
community callbacks, cache extraction/post-extraction outputs, or replace the current
candidate/SQLite transaction. A production reuse gate requires enforceable capabilities
or a deliberately narrow audited host implementation; a package's declaration of
determinism is insufficient. Do not describe a Node worker or `vm` wrapper as a sandbox.

An additive *future* capability interface is necessary for general author opt-in. It
must not reinterpret existing `SynthPass.run` or `FrameworkResolver.extract` as pure.
Existing API-v1 packages, including immutable Drupal 0.1.0 and 0.1.1, continue through
global evaluation. No migration, new package release or engine rollout occurs here.

The contract can avoid repeated callback work when a narrow pass's observed inputs
are unchanged. It cannot avoid input-change discovery, base parsing/resolution,
whole-candidate construction or database replacement by itself. Current Drupal wiring
reads nearly all PHP/YAML inputs; whole-pass capture will therefore invalidate on most
Drupal edits. Useful finer reuse would require separately owned discovery/route/service/
hook/event units with tracked derived-index queries. That is a later design and a new
reviewed package version, not an automatic rewrite of either immutable release.

## Current reads and stage boundaries

Locations below refer to unchanged source. A read returning nothing is still an input.
The source ledger in the [validation report](../validation/extensions-dependency-review-20260922.md)
pins these files and representative corpus bytes.

| Surface | Actual behavior | Required dependency / consequence |
|---|---|---|
| [`PluginContext`](../../src/plugins/api.ts#L24), [factory loading](../../src/plugins/loader.ts#L76) | Factory receives real project root, cloned options, engine version; executes arbitrary CommonJS/ESM, independently in worker contexts | Project identity, **package content digest**, options, engine/adapter epoch; factory closure state, direct `fs`, network, process environment, time/random and module state remain outside capture |
| [`FrameworkResolver`](../../src/resolution/types.ts#L225) | `detect(ctx)`, `claimsReference(name)`, `extract(file,content)`, `resolve(ref,ctx)`, `postExtract(ctx)` | Detection/language gates, full input reference/source and invocation identity; capture a negative detect/resolve result. `extract` lacks a context argument and may close over arbitrary reads. `postExtract` mutates existing node fields; it is not an edge-only unit |
| [node lookups](../../src/resolution/index.ts#L440) | Name, qualified/lower name, file, kind, ID, method-match queries, optional iterator | Predicate plus complete observable result (all fields, order and missing/null). New matching nodes, second matches, changed fields, removals and renames invalidate. Node IDs alone cannot establish uniqueness |
| [files](../../src/resolution/index.ts#L539) | `fileExists` checks indexed set then filesystem; `readFile`/`getFileLines` can read metadata; `getAllFiles` enumerates **indexed paths**, `listDirectories` uses filesystem | Do not conflate indexed set with disk tree. Track absent paths, bytes, failures, directory membership and scan/ignore policy. A non-indexed `composer.json` can control output |
| [derived queries](../../src/resolution/index.ts#L615) | Supertypes read nodes and `extends`/`implements`; imports, reexports, aliases, Go module, workspace members and include dirs read additional state | Track complete derived response and upstream input epoch/closure; revalidate before reuse. Paths/globs and misses must be observable. Unsupported derived query must taint the capture, not return an untracked “empty” |
| [plugin fingerprint](../../src/plugins/loader.ts#L56) / registry | Enabled state, order, options and replacement choices affect graph; package digest checked at load | Same version is not a cache identity. Capture replacement/builtin selection, scan/language gates and ordered schedule, even if callback makes no queries |
| [independent synth passes](../../src/resolution/callback-synthesizer.ts#L3583) | Same post-resolution snapshot; results withheld until merge; parallel execution allowed; first `source > target` pair in **registry order** wins | Preserve that exact collision rule, including shadowed outputs; do not use source/target/kind/line as a replacement key. Ordinary synthesis does **not** see an earlier sibling's newly returned edges |
| [staged pre-passes](../../src/resolution/callback-synthesizer.ts#L3765) | Go method containment and implements are persisted before independent synthesis; postExtract also precedes resolution | Later stages must read current upstream outputs. Per-stage immutable epochs, not one unordered pass bag. No proposed fixed point or cycle evaluation in first scope |
| [candidate update](../../src/index.ts#L549) | Source observations before/after full candidate; loaded config fingerprint frozen; graph/index transaction controls visibility | Reuse must stay inside the candidate boundary. Existing observations are not a filesystem snapshot or a guarantee for arbitrary external I/O |

### Official Drupal read closure

[`extensions/drupal/index.cjs`](../../extensions/drupal/index.cjs) is a real broad pass:

* `detect` (line 125) reads `composer.json` even if unindexed, then searches indexed
  `.info.yml` membership when that does not establish Drupal. A missing/invalid composer
  and an empty info-file set must both be recorded. Short circuiting is safe only if the
  observed condition is revalidated; newly taken branches acquire new traces.
* `extract` (line 137) derives route/service/plugin nodes from exact filename and bytes.
  The builtin public signature has no tracked cross-file facility. The reference
  implementation is source-only here, but that does not prove arbitrary authors are.
* `wiring` (line 146) sorts all indexed files, reads PHP, `.services.yml` and
  `.routing.yml`, queries nodes per file and builds class, service, hook, subscriber and
  plugin maps. Empty class/member/service/alias lookups are negative dependencies of
  those complete maps; recording only successful final edges loses them.
* Service aliases/injection and class ambiguity (lines 183–243), route `_form` and
  `_controller` resolution (245–256), API hook existence (277), event constants,
  subscribers and plugin uniqueness all depend on set membership. A second class or
  plugin with the same name can **remove** a formerly valid edge. Retargeting YAML can
  change a link between PHP endpoints whose files never changed.
* The installed package itself has no tracked partition interface. Wrapping its entire
  pass records broad reads; an unrelated PHP comment still changes one observed input.
  Snapshot files not queried, or an irrelevant non-PHP/YAML content change with unchanged
  membership, may leave the pass reusable, but no useful latency claim follows here.

### Generic author and hook examples

The shipped [Python event starter](../../src/plugins/author-template.ts#L6) detects
`.events.yaml` membership, extracts literal registrations and uses `getNodesByName`
with Python/function filtering. It deliberately rejects zero or multiple handlers.
An absent target appearing and a second target appearing must both invalidate.

The exact [cross-file fixture](../../__tests__/extension-sync.test.ts#L51) has a
framework extractor that directly reads `binding.py` through `require('fs')`, while
its semantic callback reads that file through `ctx.readFile` or selects an option.
The former can alter a `handlers.py` node while that file's source stays identical.
Our driver obtains these callback bytes from the TypeScript AST, not a rewritten
approximation. A capture flag falsely applied to this real hook produces stale output.
Reevaluating the whole legacy schedule produces the current result. This demonstrates
the admission problem; it does not solve arbitrary JavaScript I/O containment.

## Proposed additive contract (not shipped types)

An illustrative host capability could be called `capturedSemanticV1`. The name is
provisional. Old engines must be prevented from silently accepting a package that
requires it: capability negotiation plus an engine range is required; a parallel
ordinary v1 callback can remain the explicit fallback. An optional field old engines
ignore is not sufficient negotiation for a correctness-critical contract.

```ts
// Design sketch, not an export in @colbymchenry/codegraph.
capturedSemanticV1({ unit: 'bindings', stage: 'post-resolution', run(view, options) {
  const target = options.target || view.readFile('binding.py').text?.trim();
  if (!target) return [];
  const from = view.nodes({ name: 'dispatch', kind: 'function', language: 'python' });
  const to = view.nodes({ name: target, kind: 'function', language: 'python' });
  return from.length === 1 && to.length === 1 ? [call(from[0], to[0])] : [];
}});
```

For a later Drupal adapter, an individual route unit could read one routing document,
query a **host-captured** class/service index by FQN/service ID and method membership,
then return owned handler edges. Recording `classIndex.lookup(fqn) === []` is mandatory.
That index first needs its own complete discovery/read closure (including new PHP
files, service aliases and duplicates). A hand-built map closed over by the callback
is not a tracked index. Do not split route work while retaining an untracked global map.

### Capture and invalidation rules

1. **Admission:** a fresh, stateless callable with no ambient filesystem/network/env/
   clock/random/module access. Frozen JSON options and read-only host views are its only
   inputs. This is a host enforcement/admission obligation, not a manifest assertion.
   First implementation should limit admission to an audited host adapter; arbitrary
   v1 packages always use global fallback. An eventual isolated runtime needs its own
   security/compatibility review, including transitive imports and constructors.
2. **Snapshot:** invocation identity includes project identity, engine/parser/query
   contract version, package/content digest, unit/stage, exact options, replacements,
   enabled state, ordered registry and relevant scan/language policy. Do not reuse
   across projects or upgrades. Read views supply detached/frozen values and never
   expose mutable SQLite handles, root paths or `require`.
3. **Reads:** record typed operation, normalized arguments and complete result fingerprint.
   `readFile` distinguishes present bytes, absent path and access/parse error. An error
   is not “missing”; abort or explicit fallback. Directory/glob reads capture predicate
   and complete membership, including empty. Query response fingerprints include every
   field visible through the new contract and observable order; arrays remain ordered.
   Explicitly define stable projections if omitting volatile `updatedAt`; never silently
   drop a field existing callbacks can read. Early-stopped iterators capture their full
   predicate/bucket revision, not only visited nodes. Unbounded/paged queries may use a
   broad graph generation token until a correct finer index exists.
4. **Revalidation:** replay each prior query against the current immutable stage snapshot
   (initial simplest mechanism), compare exact result fingerprints, then either reuse
   its entire owned output or reevaluate with an entirely new trace. Deletions/renames
   are old-path removal plus new-path membership; do not preserve identity by guessing.
   A dependency to an empty predicate is real. Later scalable bucket generations must
   include membership, field and order changes with the same observable semantics.
5. **Branching:** validate previously observed predicates before reuse. If any changes,
   rerun; the new branch captures new reads. No need to guess untaken branches for a
   truly deterministic, closed callable. An option branch is covered by the invocation
   identity, even when it avoids reading a file this time.
6. **Fallback:** legacy hook/pass, unknown context operation, tainted capture, unsupported
   I/O, changed/unverifiable package, malformed cache, memory bound, unknown stage or
   incomplete snapshot => discard tentative selective results and reevaluate the affected
   pipeline globally. The first implementation should use the **whole candidate**, since
   unknown hook outputs may influence every downstream stage. Unsupported-operation
   taint is sticky even if plugin code catches the exception. Direct ambient reads cannot
   be discovered by a context proxy; they must never be admitted by that mechanism alone.

### Output ownership, order, failures and restart

Store outputs **before merging** per `(project, package digest, unit, stage, invocation)`.
Replacement removes the entire former owned set, including an empty new set; never
delete another producer's edge just because both contributed the same pair. Retain
shadowed contenders so disabling/removing the winning owner reveals the next one.
Remerge the complete candidate in existing registry order, regardless of which units
ran or finished first. Validate endpoint identities and output shapes before commit.
No query may read its own previously committed derived output as new base evidence.

First scope is edge-only ordinary synthesis over a fixed post-resolution snapshot.
PostExtract node patches, per-reference resolution, framework detection/extraction and
Go stages remain global. A future stage-DAG extension would invalidate downstream
readers using the changed upstream snapshot; cyclic dependencies are unsupported and
fall back globally. Do not introduce fixed-point iteration silently or allow ordinary
independent passes to start seeing each other's outputs.

Prepare traces, ownership and graph in one candidate generation. A callback throw,
missing endpoint, source/config observation change, cancellation or worker death must
publish **none** of them and retain the prior graph. Failed empty output is not success.
Fallback must not partially commit earlier “good” units. Only after the existing atomic
graph transaction commits may the process-local trace generation be installed; tag it
with that graph generation. Readers continue to observe the old or new graph using the
existing commit marker. Unstable source while materializing a snapshot requires retry;
the accepted stat/hash observation is not a cross-filesystem lock. Unindexed metadata
and negative paths must join the observation closure before production reuse is safe.

Start with process-local bounded caches: close/restart/unknown generation => cold global
evaluation. Discard traces on plugin/config/engine/scan contract changes. Persistent
read sets are deferred; they would need transactionally bound schema, package provenance,
input generation, output ownership, and orphan/corruption recovery. No change to the
accepted candidate record/lock/index transaction is proposed in this milestone.

## Executable proof boundary

The model records complete results, replays predicates, keeps per-unit outputs and
matches the current pair-merge rule. It does **not** enforce runtime capabilities,
implement all ResolutionContext methods, stream large results, integrate cache
generations into SQLite, or track production watchers. It materializes/hashes full
snapshots, which is intentionally unsuitable as a large-project optimization.

The driver invokes the actual generic fixture and generated author callback. It also
loads the immutable Drupal 0.1.1 artifact, installs it into a disposable project made
from four pinned Pathauto files, and compares modeled pass output with both uncached
callback output and the **actual full managed-engine SQLite contribution** for each
state. The engine always evaluates fully; it does not consume the modeled cache. This
is stronger than a pure invented graph example, but is not production incremental,
whole-corpus, arbitrary-plugin, native or hosted proof. Model failures/“restart” are
in-memory exercises, not new process-kill evidence. Existing transaction-kill evidence
is reused with its original source and scope.

## Smallest follow-on and acceptance gate

Approve only an internal shadow recorder for one host-owned edge-only adapter, with
explicit captured-view semantics and no public package opt-in yet. Run callback plus
uncached oracle on small generic fixtures, recording negative/ambiguous membership,
trace size, replay cost and invalidation causes. Preserve all current fallbacks. A
useful shadow result is less callback work predicted **and** exact output parity; no
time target or speed claim is established by this review.

Before actual skipping: test adversarial admission/bypass/caught-error cases, generation
and endpoint validation, scan/option/plugin/order changes, disabling overlapping owners,
source races, true worker failure and kill boundaries using the real candidate path.
Before public API: old engine/new package refusal or deliberate v1 fallback, new engine/
old packages unchanged, author types and framework/parsing worker parity on supported
native platforms. A later fine-grained Drupal adapter requires its own reviewed version
and corpus accuracy probes. A later storage-delta design requires separate atomicity
proof; read tracking does not remove global resolution or graph-copy costs.

The accepted mixed performance remains unchanged: limited warm comment-edit/retarget
medians improved about 22% Pathauto and 26% Commerce; core cold update worsened from
103.494 to 112.452 s with higher RSS, while some warm updates improved. Historical
22–30% rebuild overhead and unfavorable diagnostics remain in the prior report. Stable
failed references did not reproduce a no-change rebuild loop. No new performance
matrix or tuning was run for this contract review.
