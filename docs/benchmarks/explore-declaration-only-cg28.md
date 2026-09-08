# Deterministic measurement — declaration-only files in the explore envelope (task CG-28)

**Date:** 2026-08-06 · **Baseline:** `feature/CG-24` @ `463f6e7` ·
**Harness:** `scripts/agent-eval/probe-decl-only.mjs` against a hermetic fixture
(`__tests__/fixtures/ambient-decls-ts/`, copied to a temp dir and indexed per run, so two runs on
one build give identical numbers), plus `probe-suite-envelope.mjs` and a corpus-wide flag-rate
survey for the regression side. No agent A/B: the claim under test is which FILES get selected and
in what order, and the agent runs are far too noisy to see that.

**Verdict, both halves:**

- **The motivating file is already handled — CG-25 credited.** The Wrangler `worker-configuration.d.ts`
  that opened this issue is demoted by the generated penalty alone, worth 15–46 points of envelope
  share on the four flow queries measured. No new mechanism needed for it.
- **The narrower gap is real and was fixed.** A declaration file with NO banner carried `pen 1.00`,
  took **rank #1 and 51% of delivered source** on a prose flow query, and displaced the flow's own
  entry file out of the response entirely. It is now damped — but only when nothing in the index
  depends on it, which is the condition that makes the rule safe.

---

## The fixture

`__tests__/fixtures/ambient-decls-ts/` — an upload path (route → stream → metadata → queue) with
four declaration-shaped files competing against it for one envelope. All four declare nothing but
`interface`/`type_alias` and have no bodies; they differ only in the two properties under test.

| file | banner | depended on | lines |
|---|---|---|---|
| `types/worker-configuration.d.ts` | Wrangler | no | 271 |
| `types/platform-shims.d.ts` | none | no | 212 |
| `src/storage/types.ts` | none | **yes** (2 imports, 3 references) | 18 |
| implementation (`routes/`, `storage/`, `lib/`) | — | — | 37–71 each |

The declaration files carry the same generic identifiers the prose queries use — `Body`, `Message`,
`ImageMetadata`, `ReadableStream`, `Upload*` — which is the whole mechanism of the original report.

## Result 1 — what CG-25 is worth (the obsolescence leg)

Same fixture, same queries, one variable: `--variant strip-banner` deletes the two banner COMMENT
lines from `worker-configuration.d.ts` and changes nothing else, so the two declaration files become
indistinguishable to the ranker. Delivered share of the envelope for that file:

| query | with banner | banner stripped |
|---|---|---|
| flow-upload | not a candidate | 15.1% (2,271 chars) |
| flow-pipe | not a candidate | 38.5% (4,398 chars) |
| flow-generic | cliffed to a pointer, 0 chars | 35.1% (3,076 chars) |
| flow-queue | 9.4% via clusters (1,264 chars) | **46.1%, rank #1, whole file** (7,390 chars) |

The generated penalty alone is the difference between "rank #1 and nearly half the answer" and
"named in the not-shown list". **The file this issue was filed about needs nothing further.**

## Result 2 — the gap that survived

`platform-shims.d.ts` — hand-written, no banner — on the `feature/CG-24` tip:

| query | rank | score | pen | delivered |
|---|---|---|---|---|
| flow-upload | **#1** | 53.0 | 1.00 | 6,044 chars (**50.7%**) |
| flow-queue | **#1** | 21.0 | 1.00 | 6,044 chars (44.9%) |

On `flow-upload` the response carried three files and `src/routes/upload.ts` — the handler the
question is *about* — was not one of them. That is the CG-24 epic symptom, reproduced with no
generated banner anywhere in it.

Note also: `.pyi` is **not an indexed extension**, so Python stubs never enter the graph and cannot
take an envelope. That third of the issue's premise does not occur today.

## The mechanism, and why it is drawn this tight

`AMBIENT_DECLARATION_RANK_PENALTY` (0.5) multiplies score and graph mass in `rankPenalty`, for files
`QueryBuilder.getAmbientDeclarationPathsAmong` flags. Four conditions, all required — the first
three were the obvious rule, the fourth is the one that makes it safe:

1. declares ≥1 symbol;
2. **every** declared symbol is type-level (`interface`, `type_alias`, `enum`, `enum_member`,
   `namespace`);
3. originates no `calls`/`instantiates` edge;
4. **nothing outside the file points at it.**

Conditions 2 and 4 were both forced by measurement, not taste:

**Why not just "no callables" (condition 2).** Surveyed across the corpus, a rule of "declares no
callable and calls nothing" flags **1.1%–18.0%** of files, and what it catches is real source:
okhttp's `SocketPolicy.kt` (19 declarations, a Kotlin sealed hierarchy), `BrotliInterceptor.kt`,
`tokio/src/runtime/mod.rs`, Alamofire's umbrella `Alamofire.swift`, and all 500+ of django's
`conf/locale/*/formats.py` constant tables. Requiring every symbol to be type-level drops that to
**0%–4%**.

**Why "nothing depends on it" (condition 4).** Without it the rule also flags
`__tests__/fixtures/displacement-ts/src/pipeline/types.ts` — pure interfaces, no bodies, structurally
identical to an ambient shim — and demoting it **broke the CG-31 displacement gate**, which is a
different invariant entirely. That file carries 13 inbound imports and 21 references: the pipeline
stages that answer a query about the pipeline are typed *by* it, so it is part of that answer's
structure. The ambient shims carry **zero** inbound edges — reachable by name, attached to nothing.
That is the real distinction, and the graph already holds it.

**The counter-case guard.** A query that NAMES a declared type is a question about the declaration,
so its file is exempt and ranks at full weight. Only shape-precise tokens count (the same
NL-stopword reasoning as named-seed selection) — "…the file **body**…" must not exempt a `Body`
interface it never meant to name. This needed its own set: `namedSeedIds` is callable-only by
construction, so a type can never become a named seed.

**No double-charging.** Generated and ambient-declaration are combined with `Math.min`, not
multiplied. A generated `.d.ts` has one property that two signals happen to see; charging it twice
(0.3 × 0.5 = 0.15) is how a file gets cliffed out of answers where it is genuinely relevant. The
low-value multiplier is orthogonal and still compounds.

## Result 3 — after the fix

| query | before | after |
|---|---|---|
| flow-upload | rank **#1**, 50.7% | rank **#2**, 38.6% — and `src/routes/upload.ts` now delivered (2,417 chars) |
| flow-queue | rank **#1**, 44.9% | rank **#3**, 41.3% |
| flow-pipe / flow-generic | not a candidate | unchanged |
| type-shim (`UploadStorage StoredUploadObject ImageMetadataShim`) | rank #1, `pen 1.00` | **unchanged** — exempt |
| type-prose (*what does the UploadStorage interface declare…*) | rank #1, `pen 1.00` | **unchanged** — exempt |

The byte share falls less than the rank does, and that is the correct outcome rather than a weak
fix: on this fixture every implementation file already delivers its entire contents, so the
declaration file is filling envelope nobody else needs. What it was actually taking was a **file
slot** — which is why the entry file came back. The issue explicitly forbids suppression, and a
damped file is still a candidate, still named in the response, and one follow-up explore away.

## Regression evidence

- **`probe-suite-envelope.mjs`, 6 repos, new build vs a clean `feature/CG-24` baseline build:
  byte-identical.** django 20,878 · excalidraw 19,652 · okhttp 18,870 · tokio 21,607 · gin 10,776 ·
  alamofire 11,662 source chars, same file counts, on both builds.
- **VS Code** — the repo the issue names for `.d.ts` surface — across five flow and type queries:
  **zero** ambient-declaration files reach the ranked candidate set, so the output cannot differ.
- **Corpus-wide flag rate:** django 0.00% · okhttp 0.00% · gin 0.00% · alamofire 0.00% ·
  tokio 0.12% · vscode 0.53% · excalidraw 0.74%. What it catches is `global.d.ts`, `vite-env.d.ts`,
  `css.d.ts`, unreferenced vendored headers and test fixtures — exactly the intended shape.
- `probe-allocation.mjs`: `payroll-go` PASS, `self-query` PASS.
- Full suite: **178 files, 2,978 passed**, 6 skipped.

The change is inert everywhere the shape does not occur, which is most places. That is the point:
the defect is real but rare, and the mechanism costs nothing where it does not apply.

## Reproducing

```bash
npm run build
node scripts/agent-eval/probe-decl-only.mjs                        # as committed
node scripts/agent-eval/probe-decl-only.mjs --variant strip-banner # what CG-25 is worth
npx vitest run __tests__/explore-declaration-only.test.ts          # the standing gate
```
