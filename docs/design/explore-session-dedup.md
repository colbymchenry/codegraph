# Cross-call explore session state

`codegraph_explore` answers every call as if it were the first one. It has no idea what it
already sent this session, so a 4th call happily re-serves the spine the 1st call already
delivered (the #1500 report: 4 calls on a 2-call tier budget), and the tier's call budget
can only be *asked* for in prose the agent ignores.

This document covers the state layer that fixes the "no idea" part — `src/mcp/explore-session-state.ts`
(CG-17) — and the first thing built on it, cross-call source dedup
(`src/mcp/explore-dedup.ts`, CG-18). Budget decay past the tier budget (CG-19) is the
other consumer.

## What is recorded

One `ExploreSessionState` per MCP session. Inside it, per **resolved project root**:

- `callCount` / `responseBytes` — every explore call served this session for that project;
- `calls[]` — the recent ones in detail: query, per-file emitted **line ranges**, a content
  **fingerprint** for the bytes those ranges were sliced from, source bytes, response bytes,
  and the call's 1-based session index.

Ranges come from the render loop itself — `buildSection` returns the spans it slices
alongside the text, and the whole-file / focused / skeleton paths report theirs at the
point they push source into the response. A separate function mirroring the window and
padding rules would drift, and drift here is not symmetric: see *Which way to be wrong*.

Only files that **survive the final hard-ceiling truncation** are recorded. A section the
ceiling dropped was never delivered. A back-referenced file records its spans at **zero
bytes**: the record means "source the agent HOLDS for this file", not "bytes this call
spent", so re-recording keeps a long session from ageing a pointed-at span out of the
retained window and re-serving it for nothing.

## Four constraints, and what each one rules out

| Constraint | Why | What it rules out |
|---|---|---|
| Per session, never persisted | A new agent has seen nothing | A disk cache keyed by project |
| Per **resolved** project root | One session can query several projects by `projectPath` | Keying on the path the agent typed — `/repo` and `/repo/internal` are one project |
| Bounded memory | Sessions can run for hours | Unbounded `calls[]` growth |
| Daemon-safe | One daemon shares ONE `ToolHandler` and a pool of worker threads across every connected client | State on the handler, in a worker, or in a module-level singleton |

The daemon constraint is the sharp one. State kept on the shared `ToolHandler` would blend
two agents' histories, and a dedup built on that would withhold source from an agent that
never saw it — which costs a Read, the exact failure this area exists to prevent. So the
state lives on `MCPSession`, and the plumbing is:

```
MCPSession (owns the state)
  └─ ToolHandler.execute(tool, args, sessionState)
       ├─ down: session view attached to args    (survives structured clone → worker)
       └─ up:   emission attached to the result  (survives structured clone ← worker)
            └─ recorded on the MAIN thread, then DELETED from the result
```

Both legs travel as plain properties (`_cgExploreSession`, `_cgExploreEmission`) because
either may cross a worker boundary, where a closure or a handler field could not follow.
The emission is stripped in `execute` **unconditionally** — including for callers that
track nothing, like the CLI — so the agent-facing response is byte-identical. A view a
client spells itself is discarded, not trusted: it decides what a later call may withhold.

## The bounds

`EXPLORE_SESSION_LIMITS`: 4 projects (LRU), 8 retained calls per project, 24 files per
call, 24 ranges per file, 4 calls in the view handed to a call.

Every bound caps **detail**. `callCount` and `responseBytes` keep counting past eviction —
decay (CG-19) reads the count, and a bound that reset it would make decay reset itself
every 8 calls.

## Which way to be wrong

Where a bound forces a choice, the record keeps **fewer** ranges than were emitted, never
more:

- under-report → a later call re-serves something the agent already has. Wasteful.
- over-report → a later call withholds source the agent never saw. The agent Reads the
  file, and one Read costs more than every byte the dedup saved.

So `coalesceRanges` drops the smallest spans when it hits the cap (and flags
`rangesTruncated`), invalid spans are discarded rather than clamped, and truncated file
sections are never recorded.

## Inspecting it

The CG-4 diagnostic (`CODEGRAPH_EXPLORE_DEBUG`, see
[explore-budget-allocation.md](./explore-budget-allocation.md)) carries a `session` block
on every report:

```
  session call #2 for this project · 1 prior call · 18,204 chars already served
    already served internal/usecase/payroll_cycle.go · 4,928 chars · L1-159
```

`callIndex` is this call's position in the session; `priorFiles` unions the ranges already
served per file, most-recent call first. The block is **absent** — not zeroed — when the
caller tracks no state, which is how "untracked" and "first call of a tracked session" stay
distinguishable.

---

# Cross-call dedup (CG-18)

A call that would re-send source an earlier call already delivered sends a **pointer**
instead. Never a bare omission: an insufficient-feeling response is precisely what sends an
agent to Read, and one or two of those early in a session teach it to abandon codegraph
entirely. So the replacement carries the file, the symbols, the line spans, and the two
facts that make the copy usable — that it came from THIS conversation, and that the file has
not changed since:

```
**`internal/usecase/payroll/cycle.go`** — Cycle, PayslipsForCycle, Service, …

> **Already sent earlier in this conversation:** `internal/usecase/payroll/cycle.go`
> L42-76, L78-215 (Cycle, PayslipsForCycle, Service, +6 more) — unchanged on disk since,
> so that copy is still exact. Only the NEW lines are shown below; scroll back for the
> rest. Do NOT Read this file.
```

The convention is also stated once, inline, as an exception appended to the "verbatim
source" guarantee (the same shape #1474 uses for drift), and once in
`server-instructions.ts`.

## What gates it

| Gate | Rule |
|---|---|
| Session | Off on a session's first call for a project — nothing to point at |
| Content | A span is withheld only if the file still hashes to the bytes that span was sliced from |
| Size | Only a covered run of ≥ `MIN_COVERED_LINES` (8) is replaced |
| Remainder | New source under `MIN_DELTA_CHARS` (160) folds into the pointer instead of getting its own fence |
| Kill switch | `CODEGRAPH_EXPLORE_DEDUP=0` renders as if the session had no history |

The **content** gate is a fingerprint (`length:sha1-prefix`) recorded per file per call, NOT
the index's drift flag. They answer different questions: two calls inside one drift window
served the same current bytes (dedup is correct); a file edited *and re-synced* between two
calls is never "stale" and yet the agent's copy is now wrong (dedup would be actively
harmful). #1474's drift handling is upstream of this and unchanged — a drifted file still
ships whole or not at all.

The **size** gates exist because the pointer sentence is itself ~140 chars. Replacing a
signature line or the ±3 lines of cluster padding would make the response bigger *and* read
as full of holes. `MIN_DELTA_CHARS` is the one place the design withholds something the
agent has not seen — bounded to ~two lines sitting directly against source it does hold —
and it is there because the alternative is a code fence containing `228\t`, which reads as
a broken response. The file is still named with its symbols, so one follow-up explore
fetches it whole.

## Where the reclaimed bytes go

Two channels, both of which move bytes toward files the agent has NOT seen:

- **`sourceSpent`** — a deduped file spends less, so CG-21's carry-forward pool hands the
  difference down the rank order, and `headroom` grows for every file after it.
- **the `maxFiles` slot** — a fully back-referenced file does not consume one (the same
  treatment a cliffed file gets), so a file that would not have fit now renders.

Within a file, the shrink decision reads the **deduped** length: shrinking a cluster on its
raw size would drop new symbols to make room for source that is not being sent.

Spending rather than banking is what keeps the response the same *size* while raising the
share of it the agent has never seen — and it is also why CG-20 found residual context
occupancy **flat**. A design that spends every reclaimed byte cannot lower the byte count;
what it lowers is the duplicate fraction of those bytes (−87% across CG-20's agent runs).
Measured on two matched 3-call replays: client-go 44,740 → 46,957 unique source chars for a
3.2% larger response, excalidraw 39,575 → 43,973 unique for a 5.4% **smaller** one. If the
goal is ever restated as "fewer bytes," this is the one rule to reverse — and it needs its own
abandonment gate, because banking makes a repeat call return strictly less.

**`dedup.savedChars` is a pre-clip figure.** It counts what dedup suppressed from the
*unclipped candidate* render, not what stayed out of the window — most of a suppressed range
would have been trimmed by the budget anyway. Measured on client-go: 11,450 reported against
1,042 chars the baseline actually re-served. Read it as "how much duplication the ranking
wanted to emit," never as a saving; over-reading it inflates the win ~7×.

## The all-pointer guard

If dedup suppresses everything and nothing new takes its place, the response would be
pointers only — the shape that reads as "codegraph found nothing". The render loop keeps the
first fully-suppressed file's real section in hand and splices it back when the loop ends
with zero new source. It costs a re-serve of one file on the one call shape where dedup
would otherwise have saved everything. That is the safe direction, and it is why "no
duplicate ranges across calls" holds for every call that had anything new to say, rather
than universally.

CG-20 ran that gate on a real agent — client-go and excalidraw, both arms codegraph-on,
n=3 and n=6 per arm. **Read = 0 in all 24 runs**, no `isError`, codegraph last in every run,
and the "Read a file we returned" / "Read a file we did not return" buckets empty on both
arms, with back-references demonstrably reaching the agent in 8 of the 9 multi-call runs. The
guard never fired on a real query — the thinnest of those 21 calls still carried 12,011 chars
of new source, so `newSourceChars === 0` was never reached and that threshold remains untested
in the field; the numbers and the one bar that did not pass are in
[`../benchmarks/explore-dedup-ab-cg20.md`](../benchmarks/explore-dedup-ab-cg20.md).

## Coverage

`__tests__/explore-session-state.test.ts`, in three layers: the container (keying, monotonic
index past eviction, every bound), the handler seam (a real explore against a real index
records real ranges; a session's FIRST call is byte-identical to an untracked one; two
states on one handler stay separate), and the session seam (two `MCPSession`s on one engine
get their own state, and each call carries its own session's).

`__tests__/explore-cross-call-dedup.test.ts` covers the dedup itself: the range algebra and
its thresholds, the fingerprint gate (an edited file re-emits; an unprovable record is
ignored), the pointer's wording (names the file/spans/symbols, never says "omitted", never
steers to Read), and then the seam — a real second call re-sends **no** line the first one
sent, comes back with >20 lines the first call never sent (reclaimed budget, not a shrunken
response), always contains real source however much the session holds, and reports its
savings through the CG-4 diagnostic (`dedup.savedChars`, per-file `dedupSavedChars` /
`dedupCovered`, `render: 'backref'`).

Two things vitest cannot cover, verified by hand against `dist/`:

- **the worker path** — with a `QueryPool` attached, the emission survives the structured
  clone back from the worker, records on the main thread, and is absent from the result;
- **two genuinely different projects in one session** — opening a second index inside vitest
  fails on the lazy `require('../index')`. The in-suite substitute reaches one project two
  ways (bare, and by a `projectPath` pointing at a subdirectory) and asserts both land in one
  bucket; multi-project keying itself is covered at the container level.
