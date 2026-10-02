# Requested-source contribution validation

Measured 2026-09-11 UTC. These measurements validate the upstream-based contribution, not the consolidated fork.

The literal-seeding foundation `248493bf` is based on upstream `3ed73bc1`. The requested-source implementation `0bf5b98d` adds bounded source selection and allocation on top of that foundation. A later follow-up on this branch ports the consolidated broad-receiver/source reservations (`245d00d4`) without fork-only Markdown/session or deployment configuration.

## Validation

- Foundation: application and native-kernel builds passed; 100 tests across six focused native suites passed, including deferred-buffer literal persistence and the rebuild recommendation for pre-literal indexes. The four relevant WASM suites passed all 42 tests.
- Requested source: application build passed; 345 tests across 28 retrieval suites passed with the native kernel, and the same 345 passed with `CODEGRAPH_KERNEL=0`. The unchanged upstream Rust sources use the kernel built for the foundation.
- Builds and tests ran on WSL with Node 24 at low priority, at most three test/compiler workers, sequentially. This is not a full-suite or cross-platform validation claim.

## Fixed-index comparison

### Review follow-up

Foundation revision `3b95088b` fixes three subsequently reproduced gaps: compiled native store-worker decoding omitted literal capture, unchanged-file re-indexing erased literal entries, and same-line functions received incorrect ownership. Its TypeScript compilation, 101 focused native tests, 43 WASM tests, and three compiled-index regressions passed. The compiled regressions cover fresh/repeated indexing, migration backfill, deleted files, and UTF-16 ownership after non-ASCII text across native-worker, native-main-thread, and WASM-worker modes.

The dependent branch incorporates that foundation update. All 346 retrieval tests passed on each backend, and the three compiled-index regressions passed. The fixed-index measurements below remain measurements of the original revisions; they were not repeated after the extraction/lifecycle fixes and do not establish fresh-index behavior of the updated branch.

The [16-query fixture](https://github.com/bompus/chrome-ext-bompus-espn-draft/blob/74fcd4e147020d834a3110ac161cb1f6d10cf4b2/docs/agents/codegraph-retrieval-repro.json) pins source from ESPN commit `c570e32b`. Each referenced source file was verified against its recorded SHA-256 before its query. Both engines used the same existing checkout-local index, a fresh process and ToolHandler per query, and an explicit projectPath, with no maxFiles override. This isolates retrieval against fixed extracted data; it does not compare separately rebuilt real-project indexes. Foundation extraction and persistence were tested independently above.

Cells count returned / expected nonblank source lines in the fixture's expected ranges. A plus separates ranges, not calls. Each row required one call per engine.

| Case | Foundation | Requested source |
| --- | --- | --- |
| 1 | 29/29 + 4/23 | 29/29 + 23/23 |
| 2 | 9/9 | 9/9 |
| 3 | 0/2 + 0/22 | 2/2 + 22/22 |
| 4 | 2/50 + 50/73 | 50/50 + 73/73 |
| 5 | 0/31 | 30/31 |
| 6 | 0/132 | 132/132 |
| 7 | 0/33 | 33/33 |
| 8 | 36/36 + 61/61 + 0/20 | 36/36 + 61/61 + 0/20 |
| 9 | 0/78 | 0/78 |
| 10 | 0/78 | 0/78 |
| 11 | 0/50 | 50/50 |
| 12 | 0/1 + 0/6 + 0/2 + 0/1 + 0/12 | 0/1 + 6/6 + 0/2 + 0/1 + 12/12 |
| 13 | 0/31 | 23/31 |
| 14 | 33/33 | 33/33 |
| 15 | 0/1 + 0/3 | 1/1 + 3/3 |
| 16 | 35/50 + 78/78 | 50/50 + 78/78 |

The combined contribution restores the full snapshot assertion, Vue selectors, cache-key body, named interface, and specific shared-key sender/receiver evidence. No measured range loses coverage relative to the foundation. Maximum response length was 24,989 JavaScript characters.

A later follow-up on this branch retains compound-concept readers/writers, whole matching tests, and additional Vue regions. Synthetic regressions cover those paths. The optional mapper test (8) remains a documented non-goal. Returning sender and receiver source in case 16 does not create a publisher/listener graph edge.

These are deterministic source-completeness checks, not agent A/B runs, productivity measurements, or evidence of a latency improvement.
