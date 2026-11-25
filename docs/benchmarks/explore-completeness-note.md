# The completeness note claims only what was sent

**Date:** 2026-09-28 · **New:** `claude/nostalgic-mccarthy-31c89d` (measured at `024d88b9`, then
rebased onto #2071) · **Baseline:** `main` @ `724b5dee` (#2068) · **Harness:** `scripts/agent-eval/ab-new-vs-baseline.sh`, `--model
sonnet --effort high`, both arms codegraph-on, CLI blocked, `CODEGRAPH_NO_PROMPT_HOOK=1`, every
index rebuilt per arm.

## The defect

On the tiers with `includeCompletenessSignal` (>= 500 indexed files), every `codegraph_explore`
response ended with the same line:

> **Complete source for N files is included above — do NOT re-read them.** … Reserve Read for a
> single specific line range explore can't surface.

It was printed whatever the render had cut. The small tiers switch to a "trimmed for size" note on
`anyFileTrimmed`, but that flag is set at individual trim sites, and before #2068 one of them, the
oversize-spine window, set nothing. That is how a 62-line slice of vscode's 968-line
`rpcProtocol.ts` went out as complete. Even with every site flagged, the large tiers never read the
flag. The last sentence also offered Read, which explore output must never do.

## The change

- **Completeness is measured, not flagged.** Each file section passes the symbols it set out to
  deliver (the cluster members, or the per-symbol view's symbols) to `emitFileSection`.
  `elidedWantedSpans` checks them against the ranges actually sent, plus back-referenced ones. A
  span not fully covered marks the file trimmed. Any path that elides source is caught this way,
  including paths added later.
- **The note says what is true.** When no section was trimmed it is the old line, without the
  Read sentence. Otherwise it keeps the guarantee that still holds and names what was cut:

  > **Verbatim source for 2 files is included above — treat it as already Read.** Trimmed for
  > size: `rpcProtocol.ts`; gap markers and file headers name what was elided (e.g.
  > `RPCProtocol._receiveOneMessage`, `MessageIO.serializeReplyOK`, …). For those, or anything
  > under "Not shown above", make ANOTHER codegraph_explore with those exact names instead of
  > reading the files — it returns their source with line numbers.

  Elided methods are offered as `Owner.member` (django has 110 `as_sql`s). Containers are never
  offered, because a class too big for one section comes back trimmed on a follow-up too.
- **Fitted like the rest of the epilogue (CG-26), in `fitExploreEpilogue`.** The note comes in
  three sizes: with names, with files, and generic. The generic one (≈340 chars) is shorter than
  the line it replaced (401). A complete-source note keeps its old precedence. A trimmed note
  yields to the pointer list, which names files the response does not show at all, while a
  trimmed section already names its elisions in its own gap markers. It leaves the list's header
  and first entry, and its optional detail never costs an entry the generic note would have left.
- **The fallback notes follow.** The lost-pointer note, the epilogue-cut note and the truncation
  note drop "complete" when a section they vouch for was trimmed. Each trimmed variant is no longer
  than the original, so the epilogue floor is unchanged.

## Deterministic replay

39 agent-shaped queries (the vscode and django queries from the named-concentration A/B, the
README questions, and pinned / stress queries), replayed through both builds on one index with a
fresh `ToolHandler` per query.

| | `main` @ `724b5dee` | new |
|---|---|---|
| source sections byte-identical | — | **39 / 39** (only the epilogue changed) |
| responses claiming "Complete source" | 24 | 1 |
| … of which a section was actually trimmed | **23** | 0 |
| responses with the trimmed note | 0 | 16 (1 naming elided symbols) |
| responses with a pointer list | 23 | 33 |
| pointer entries, total | 71 | 102 (no list shorter than baseline) |
| responses offering Read | 24 | 0 |
| responses over the 25K inline cap | 0 | 0 |

The named variant is rare because the fit spends leftover room on pointer entries first. In
saturated responses the names cost an entry, and the gap markers already carry them.

Re-run after rebasing onto `290e03f7` (#2071, same-named file pinning), against that build: source
identical 39 / 39, "Complete source" 23 → 1, trimmed note 16, pointer entries 67 → 93 (none
shorter), Read offered 23 → 0, nothing over the cap.

## Agent A/B

Four questions, three runs per arm, against `724b5dee`.

| question | Read runs (new / base) | Grep/Glob | explore calls (new / base) | duration median (s) |
|---|---|---|---|---|
| vscode: rpcProtocol serialize + dispatch | 0 / 0 | 0 / 0 | 7 / 6 | 45 / 36 |
| vscode: extension host ↔ main process | 0 / 0 | 0 / 0 | 12 / 12 | 61 / 58 |
| django: `SQLCompiler.as_sql` / `pre_sql_setup` / `get_select` | 0 / 0 | 0 / 0 | 6 / 6 | 31 / 32 |
| django: QuerySet → SQL | 0 / 0 | 0 / 0 | 4 / 5 | 22 / 23 |
| **pooled, 12 runs** | **0 / 0** | **0 / 0** | **29 / 29** | 36 / 36 |

The change was exercised. Of the 29 explore responses the new arm's agents received, 20 carried
the trimmed note (4 naming elided methods). The baseline agents received "Complete source … Reserve
Read" on 26 of 29, and on this build all but one of those are false. One pre-explore Bash call in
the new arm happens before any codegraph output and is noise. Load average was 30–95 from other
work on the machine, so durations are indicative only.

### Earlier round, against `e63fe2ec`

Before #2062 / #2063 / #2068 landed, the same four questions (the django pair run twice, 18 runs
per arm) showed Read in 8 new runs vs 7 baseline runs, Grep/Glob 0 / 0, explore 42 / 49. Every
django Read targeted `SQLCompiler.as_sql`, which no build returned for the query shape the agents
wrote (`SQLCompiler.as_sql … compiler.py:776`). Naming the file pinned it and dropped the method:
175 of 228 lines for the bare name, 0 with the path. #2063 fixed that, and on current `main` no run
in either arm reads.

## Coverage

`__tests__/explore-completeness-note.test.ts`:

- `elidedWantedSpans`: partial and absent spans, back-referenced and adjacent ranges joining,
  ordering, and invalid spans.
- `shortestUniqueSuffixes`.
- `exploreCompletenessNotes`: the complete case never offers Read; the trimmed case keeps the
  already-Read guarantee, names files and `Owner.member` names, and skips containers; candidates
  shrink in order, and the last is shorter than the old line; "1 file", never "0 files"; a trimmed
  file's label stays distinct from a same-named file in the pointer list.
- `EXPLORE_FALLBACK_NOTES`: each trimmed wording drops "complete", keeps the already-Read
  guarantee, and is no longer than the wording the floor and the cut test were sized on.
- `fitExploreEpilogue`:
  - a complete note keeps precedence;
  - a trimmed note leaves the first pointer entry;
  - detail never costs an entry;
  - with no pointer list, the most specific note that fits wins.
- End to end on a three-hop flow whose spine method the render windows: the large tier reports it
  trimmed, the small tier agrees, and complete flows are still called complete.
- End to end with dedup on: a second call whose new lines are too few to fence, and are folded
  into the "Already sent" pointer, is reported trimmed rather than complete.

Mutation-checked:

| Mutation | Red |
|---|---|
| Derived detection removed | the large-tier windowed-spine test |
| Old Read sentence restored | both Read checks |
| The entry rule dropped from the fit | "detail never costs a pointer entry" |
| The first-entry reservation dropped | "a trimmed note leaves the pointer list its first entry" |
| Completeness judged before the dedup fold | the folded-remainder test |
