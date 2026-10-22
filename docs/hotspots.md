# Risk Hotspots

`codegraph hotspots --json` and `CodeGraph.getRiskHotspots(options)` rank indexed callables using `(1 + decisions) * (1 + distinct callers)`, a 1.5 multiplier for explicitly supplied changed files, and a 0.75 discount for direct test-file dependency evidence. This ranking is a navigation aid, not defect probability or measured test coverage.

`--changed src/example.ts` supplies changed paths; no implicit Git diff is taken. `--strict --threshold 50` exits 1 if any scored symbol reaches the threshold, even with `--limit 0`. A clean gate covers only the scored subset; inspect skipped and truncated coverage before treating it as a repository-wide check.

The default report considers up to 2,000 non-test supported files, 256 KiB per source, and returns 20 symbols. Eight grammar fixtures pin the decision rules. Missing, unsupported, oversized, malformed or source-drifted files do not receive zero complexity. Drifted files must be synced first because caller edges and callable ranges are indexed evidence. Reports expose eligible/scanned/skipped files, scored-symbol totals and truncation. Related tests are direct file-dependency evidence, not proof that a particular branch executes.

The existing branch-guard cache and parse budget are reused. No metrics are persisted and no schema or kernel changes are made. Performance on large repositories and real-repo agent A/B validation remain pending.
