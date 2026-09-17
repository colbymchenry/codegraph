---
name: codegraph-lift
description: Benchmark CodeGraph retrieval quality on a real codebase by comparing agent behavior with vs without CodeGraph. Use when the user runs /codegraph-lift or asks to test, benchmark, audit, or validate a codegraph version (the local dev build or a published npm version) against a language's repo.
---

# CodeGraph Quality Audit

Measures how much CodeGraph helps an agent versus plain grep/read, for a chosen
codegraph version on a chosen real-world repo. Drives the harness in
`scripts/agent-eval/`.

## Prerequisites
- `node`, `git`, a logged-in agent CLI (Claude Code today — see Runners).
- `tmux` 3+ for the interactive harness only.
- Run from the codegraph repo root.

## Runners

Headless is the portable arm; the tmux arm drives the Claude TUI specifically.

- Claude Code: `claude -p` with stream-json — native; `parse-run.mjs` / `parse-session.mjs` are built for its formats.
- opencode: `opencode run --format json` — proven in other panels; needs its own stream parser (follow-up).
- Cursor: `cursor-agent -p` — proven; avoid `--mode plan` (swallows print output), pass `--trust` headless.
- Devin: `devin -p` is help-asserted but unverified here.
- `AskUserQuestion` below means the host's question tool (name varies by host).

## Workflow

Copy this checklist:
```
- [ ] 1. Pick version (local or npm)
- [ ] 2. Pick language
- [ ] 3. Pick repo by size
- [ ] 4. Pick harness (headless / tmux / both)
- [ ] 5. Run audit.sh in the background
- [ ] 6. Report results
```

**Step 1 — version.** Ask with `AskUserQuestion`: which codegraph version to test.
Offer "Local dev build" and "Latest published"; the free-text "Other" lets the
user type a specific version. Map the answer to a VERSION token:
- "Local dev build" → `local`
- "Latest published" → `latest`
- a typed version → that string

**Step 2 — language.** Read `.claude/skills/codegraph-lift/corpus.json`. Ask with
`AskUserQuestion` which language to test, listing the languages that have entries.

**Step 3 — repo.** From the chosen language's entries, ask which repo. Label each
option with its size and file count, e.g. `excalidraw — Medium (~600 files)`.
Each entry carries the `repo` URL and a representative `question`.

**Step 4 — harness.** Ask with `AskUserQuestion` which harness to run, and map
the answer to a MODE token:
- "Headless" → `headless` — `claude -p` with stream-json: exact tokens/cost and a
  clean tool sequence (2 runs, fast, no TTY).
- "Interactive (tmux)" → `tmux` — drives the real Claude TUI in tmux: faithful
  Explore-subagent behavior, metrics from session logs (2 runs, slower).
- "Both" → `all` — headless + interactive (4 runs).

**Step 5 — run.** Launch in the background (sets the version, clones if missing,
wipes + re-indexes, runs the chosen arms — several minutes, paid runs):
```bash
scripts/agent-eval/audit.sh <VERSION> <repo-name> <repo-url> "<question>" <MODE>
```

**Step 6 — report.** When the job finishes, read the log and report per arm:
- Headless (`parse-run.mjs`): total tool calls, file `Read`s, Grep/Bash,
  codegraph-tool calls, duration, **total cost**.
- Interactive (`parse-session.mjs`): the `VERDICT: codegraph_explore used Nx |
  Read N | Grep/Bash N` and `TOKENS:` lines.
- Both paths also print the three feedback metrics — residual context occupancy,
  explore sufficiency, allocation efficiency — and a headless A/B ends with a
  side-by-side `ARM COMPARISON` table. Report that table, and check its
  contamination row first: `CLI calls that RETURNED output` > 0 means the arm
  reached codegraph through Bash and its numbers are void. How to read the rest:
  `docs/benchmarks/agent-eval-feedback-metrics.md`.

Lead with cost + tool/Read counts — they are the reliable signals; raw token
in/out are confounded by subagent delegation and prompt caching. State whether
codegraph reduced effort and whether both arms reached a correct answer.

## Notes
- The index is rebuilt every run (`audit.sh` wipes `.codegraph`) — different
  versions extract differently, so an index must be served by the same binary
  that built it.
- `audit.sh` temporarily mutates the global `codegraph` install for the test,
  then restores your dev link via `local-install.sh`.
- Corpus repos are cloned to `/tmp/codegraph-corpus` (reused if already present).
- Add or edit repos in `corpus.json` (fields: `name`, `repo`, `size`, `files`,
  `question`).
