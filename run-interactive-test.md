# Running the agent-behavior test (how agents actually use codegraph)

This explains how to measure **how a Claude Code agent uses the codegraph MCP
tools** on a real repo — which tools it calls (does it lead with
`codegraph_explore`?), how many follow-up `Read`/`Grep`s it does, and the token
cost. Use it when changing tool guidance (`server-instructions.ts`,
`instructions-template.ts`, tool descriptions) or retrieval, to verify the
change actually shifts agent behavior.

Scripts live in `scripts/agent-eval/`.

## Why two harnesses (read this first)

| | Interactive (`itrun.sh`) | Headless (`run-agent.sh`) |
|---|---|---|
| Drives | the real TUI via tmux | `claude -p` print mode |
| Subagent it picks | **Explore** (matches real UX) | general-purpose (diverges) |
| Metrics | tool breakdown (from session logs) + `Done(…)` token summary | exact per-tool calls + tokens/cost (stream-json) |
| Cost | Claude Max subscription | API $ (`total_cost_usd`) |

**Headless `claude -p` does NOT reproduce what users see** — it silently picks
the general-purpose subagent, while interactive sessions delegate to the
read-first **Explore** subagent. So for "what does my session actually do," use
the interactive harness. For a clean per-tool/token breakdown in one shot, use
headless (and ask for the Explore subagent in the prompt if you want that path).

## Prerequisites

- **tmux 3.0+**
- A logged-in `claude` CLI (Claude Max or API).
- codegraph configured as an MCP server (`claude mcp list` shows `codegraph`).
  The interactive harness uses your global config, so it runs whatever
  `codegraph` resolves to — point that at your dev build (`npm link` / the
  symlinked global) to test local changes.
- A target repo, cloned and indexed:
  ```bash
  git clone --depth 1 https://github.com/square/okhttp /tmp/corpus/okhttp
  cd /tmp/corpus/okhttp && codegraph init -i
  ```
  Good scale spread for a sweep: Alamofire (~100 files), Excalidraw (~600),
  OkHttp (~640), VS Code (~10k).

## Interactive test (the faithful one)

```bash
scripts/agent-eval/itrun.sh <repo-path> <label> "<question>"
```

Example:
```bash
scripts/agent-eval/itrun.sh /tmp/corpus/vscode vscode \
  "How does the extension host communicate with the main process?"
```

It opens `claude` in a tmux session, types the question, waits for the agent to
finish, then prints:
- the `Done (N tool uses · Xk tokens · Ym)` subagent summary (from the pane),
- the `Context Xk/1.0M` main-session size,
- a **tool breakdown** parsed from the session logs (main + subagents), ending
  in a `VERDICT: codegraph_explore used Nx | Read N | Grep/Bash N` line.

### Startup robustness (so unattended runs don't silently no-op)

Two things bite an unattended driver before the prompt even runs:
- **The `❯` glyph is drawn ~6s before the input accepts keystrokes.** Waiting
  for `❯` is necessary but not sufficient. The harness sends the prompt, then
  **verifies a chunk of it actually landed in the input box**, retrying until it
  does — so it can't type into a not-yet-live input and submit nothing.
- **First time claude opens a repo it shows "Is this a project you trust?"**
  (which also contains `❯`). The harness detects that dialog and presses Enter
  to accept it before typing.

If the prompt never lands or work never starts, the harness now **fails loudly**
(non-zero exit) instead of capturing an empty pane and reporting a bogus run.

### How completion is detected (the tricky part)

Claude's TUI redraws in place, so you can't just wait for output to stop. The
harness polls `tmux capture-pane` and treats the pane as **busy** when it shows
the spinner's elapsed-time-in-parens — `(8s · …)` / `(1m 3s · …)`, matched by
`\(([0-9]+m )?[0-9]+s ·`. That's the *universal* working signal: it shows during
the pre-stream **thinking** phase (`(8s · thinking with max effort)`, which has
no token arrow yet) *and* during streaming. The `↓ N`/`↑ N` token arrow,
`esc to interrupt`, and `Initializing…` are OR'd in as belt-and-braces (some TUI
versions show one but not the others). It declares **idle** when the `❯` prompt
is present and not busy for 10 consecutive polls (~5s, long enough to ride out
mid-conversation thinking gaps that briefly drop the spinner). (Technique
adapted from devpit's `WaitForIdle`.)

### Where the breakdown comes from

`parse-session.mjs` reads the newest session log under
`~/.claude/projects/<escaped-cwd>/<session>.jsonl` and its subagent transcripts
under `<session>/subagents/*.jsonl`. The **subagent** file is where the real
tool calls are — the main log only shows the `Agent` delegation. You can run it
standalone:
```bash
node scripts/agent-eval/parse-session.mjs /tmp/corpus/vscode
```

## Headless test (clean tokens, forceable Explore path)

```bash
scripts/agent-eval/run-agent.sh <repo-path> <label> "<question>"
```
Writes stream-json and prints the tool sequence + exact tokens/cost. To
reproduce the Explore-subagent path headlessly, ask for it:
`"Use an Explore subagent to investigate, then answer: …"`.

## Running a sweep

Single runs vary a lot (the VS Code question has ranged 26–37 tool uses /
88–105k tokens across runs). For a real signal, run N≥3 and take the median:
```bash
for i in 1 2 3; do
  scripts/agent-eval/itrun.sh /tmp/corpus/vscode "vscode-$i" "<question>"
done
```

## What "good" looks like

After the explore-first guidance (PR #191), an understanding question should
show the agent **leading with `codegraph_explore`** and using `search`/`node`
to fill gaps — not a wall of `Read`/`Grep`. Example faithful run:
`VERDICT: codegraph_explore used 3x | Read 8 | Grep/Bash 1`. If `explore` is 0
and `Read`/`Grep` dominate, the guidance regressed.

## Output artifacts

Transcripts and logs go to `$AGENT_EVAL_OUT` (default `/tmp/agent-eval/`):
`itrun-<label>.txt` (pane capture), `run-<label>.jsonl` (headless stream-json).
