# Anonymous usage telemetry

Status: implemented — ingest Worker (`telemetry-worker/`), client (`src/telemetry/`),
`codegraph telemetry` CLI, MCP + installer wiring, `TELEMETRY.md`. Pending: Worker deploy
+ DNS, release.
Scope: public `codegraph` engine (CLI + MCP server + installer)

CodeGraph is a local-first tool whose whole pitch is "your code never leaves your machine."
Telemetry has to be designed so that sentence stays true and provable: a short, auditable list
of anonymous counters, documented field-by-field, easy to turn off, and impossible to grow
quietly. This doc is the contract; `TELEMETRY.md` (repo root, user-facing) restates it and the
implementation must never collect anything not listed there.

## Goals

Answer, in aggregate and anonymously:

- How many machines actively use codegraph (daily/weekly), and how does that change?
- Which agents drive usage (Claude Code, Cursor, Codex, opencode, …) — via MCP `clientInfo`.
- Which install targets people pick, local vs global, fresh vs upgrade.
- Which MCP tools and CLI commands get used, how often, and how often they error.
- Which languages people index (prioritize extractor/framework work by real usage).
- Version adoption speed, OS/arch/Node mix, native-vs-wasm SQLite backend share.

## Non-goals / never collected

- **No source code, ever.** No file paths, file names, repo names, symbol names, query
  strings, search terms, or anything derived from the contents of an indexed project.
- No IP addresses (stripped at the edge; storage disabled at the backend too).
- No hardware fingerprinting — the machine ID is a random UUID, not derived from anything.
- No per-keystroke / per-call event stream — usage is aggregated locally into daily rollups
  before anything is sent.
- No telemetry from the `codegraph-pro` fork (see "codegraph-pro rule" below).

## Principles

1. **The schema is the allowlist.** Client sends only the events below; the ingest Worker
   validates against the same allowlist and drops anything else. Adding a field = PR that
   edits this doc + `TELEMETRY.md` + the Worker allowlist together.
2. **Telemetry may never cost the user anything**: zero added latency on the MCP tool-call
   hot path (the repo's core invariant), zero new npm dependencies (global `fetch`, Node ≥18),
   zero bytes on stdout (stdio is the MCP protocol channel), zero retries, zero error noise.
   Every failure mode is silence.
3. **Off is off.** When disabled, no process opens a socket to the telemetry endpoint — not
   even an "opted out" ping.
4. **First-party endpoint.** Clients only ever talk to `telemetry.getcodegraph.com`. The URL
   baked into a published npm version POSTs there forever, so the domain must be ours; the
   backend behind it can change without a client release.

## Events

Common envelope on every batch (computed once per process):

| field | example | notes |
|---|---|---|
| `machine_id` | `b3a8…` (UUIDv4) | random, minted at first run, stored in global config |
| `codegraph_version` | `0.9.12` | from package.json |
| `os` / `arch` | `darwin` / `arm64` | `process.platform` / `process.arch` |
| `node_major` | `22` | major only |
| `ci` | `false` | `CI` env var present |
| `schema_version` | `1` | bump when the schema changes |

Event types:

- **`install`** — one per installer run. Props: `targets` (e.g. `["claude","cursor"]`),
  `scope` (`local`/`global`), `kind` (`fresh`/`upgrade`/`reinstall`), `sqlite_backend`
  (`native`/`wasm`).
- **`index`** — one per full index (`init`/`index`, not per `sync`). Props: `languages`
  (names only, e.g. `["typescript","go"]`), `file_count_bucket` (`<100`, `100-1k`, `1k-10k`,
  `10k+`), `duration_bucket` (`<10s`, `10-60s`, `1-5m`, `5m+`), `sqlite_backend`.
- **`usage_rollup`** — the workhorse. One event per `(day, kind, name)` per machine,
  aggregated locally. Props: `kind` (`mcp_tool`/`cli_command`), `name`
  (e.g. `codegraph_explore`, `affected`), `count`, `error_count`, and for MCP:
  `client_name`/`client_version` from the `initialize` handshake (`src/mcp/session.ts`
  `case 'initialize'` — plumbing to add; currently unread).
- **`uninstall`** — one per `uninstall`/`uninit` run (churn signal). Props: `targets`.

Volume math: rollups mean monthly events ≈ active machines × active days × distinct
tools used (single digits) — the PostHog free tier (1M events/mo) covers tens of
thousands of MAU. There is no per-call event by design.

Events are sent as PostHog **anonymous events** (`$process_person_profile: false`):
cheaper, no person profiles, unique-machine counts still work on `distinct_id` =
`machine_id`. Revisit only if retention tooling demands profiles.

## Consent & controls

Resolution order (first match wins):

1. `DO_NOT_TRACK=1` (community standard — always honored) → off
2. `CODEGRAPH_TELEMETRY=0|1` → forced off/on for that process
3. Global config `~/.codegraph/telemetry.json` → stored user choice
4. Default: **on**, gated by the first-run notice below

Surfaces:

- **Installer (interactive):** a visible clack toggle in the existing prompt flow —
  "Share anonymous usage data? (no code, paths, or names — see TELEMETRY.md)" — default
  yes. Choice persisted with `consent_source: "installer"`. Re-runs/upgrades respect the
  stored choice and don't re-ask.
- **Headless paths** (`npx codegraph init`, MCP server — no TTY, never prompt): right
  before the **first actual send** (recording only buffers locally and stays silent — so
  the installer's explicit toggle always precedes any notice), print one line to
  **stderr** and record `first_run_notice_shown`:
  `codegraph collects anonymous usage stats (no code or paths) — "codegraph telemetry off" or CODEGRAPH_TELEMETRY=0 disables. Details: TELEMETRY.md`
- **CLI:** `codegraph telemetry status|on|off` (status prints the machine ID, current
  state, and what decided it). Deleting `~/.codegraph/telemetry.json` resets everything,
  including the machine ID.

`~/.codegraph/telemetry.json`:

```json
{
  "enabled": true,
  "machine_id": "uuid-v4",
  "consent_source": "installer | default-notice | cli",
  "first_run_notice_shown": true,
  "updated_at": "2026-06-12T00:00:00Z"
}
```

(`~/.codegraph/` is new — today nothing global exists. Coexists by filename if a user ever
indexes `$HOME` itself, since per-project data lives in `<project>/.codegraph/` with fixed
other filenames.)

## Client architecture

New module `src/telemetry/` (single small module, no deps):

- **Counters in memory** — recording a tool call/CLI command is an in-memory increment.
  Nothing on the hot path touches disk or network. MCP tool handlers call
  `telemetry.count('mcp_tool', name, ok)` and move on.
- **Buffer** — counters persist (debounced, async) to `~/.codegraph/telemetry-queue.jsonl`.
  Hard cap ~256 KB; on overflow drop oldest lines. Corrupt buffer → truncate, never throw.
- **Flush** — many CLI actions end via `process.exit()`, where `beforeExit` never fires
  and async sends die, so the design is: a tiny **synchronous append** on `process.on('exit')`
  persists in-memory deltas (survives `process.exit`), and actual network sends happen
  opportunistically — at the start of long-running commands (`init`/`index`/`sync`/
  `uninit`/`upgrade`), on an unref'd interval in the long-lived MCP server/daemon, and
  awaited-with-cap at the end of `install`/`init`/`index`/`uninit` where a second is
  invisible. Sends POST completed-day rollups + lifecycle events to
  `https://telemetry.getcodegraph.com/v1/events` with `AbortSignal.timeout(1500)`,
  fire-and-forget: any response (or none) is final — no retry, no error surfaced. The
  queue is claimed by atomic rename so concurrent processes can't double-send (a crashed
  sender's claim merges back after an hour). `CODEGRAPH_TELEMETRY_DEBUG=1` echoes
  payloads to stderr for development.
- **Offline / air-gapped:** flush fails silently, buffer stays within cap, steady state is
  a bounded file and zero noise.

## Ingest endpoint (Cloudflare Worker)

`telemetry.getcodegraph.com` → small Worker living at `telemetry-worker/` in this repo —
public on purpose, so anyone can audit exactly what the endpoint stores. It ships nowhere
with the npm package (excluded by the `files` allowlist):

- `POST /v1/events`: validate against the event/property allowlist (drop unknown events,
  strip unknown props), enforce sane sizes, **never forward or log the client IP**
  (drop `CF-Connecting-IP`), light per-`machine_id` rate limit so abuse can't burn the
  ingest cap, forward to `https://us.i.posthog.com/batch/` with the project key from a
  Worker secret. Responds `204` on accept (including events dropped by the allowlist)
  and honest `4xx` for malformed/oversized/rate-limited requests — the client treats
  every response as final and never retries.
- Backend today: PostHog Cloud US, free plan, "discard client IP" enabled, GeoIP disabled,
  autocapture/replay/heatmaps/web-vitals all off. The Worker is the seam: swapping the
  backend later is a Worker change, not a client release.

## codegraph-pro rule (do not lose this in upstream merges)

The private `codegraph-pro` fork ships inside customer containers whose guarantee is
"nothing leaves the box" — including telemetry. In the fork, telemetry must be **default-off
and not enableable by the installer** (compile-time constant or stripped module), and the
container sets `CODEGRAPH_TELEMETRY=0` as belt-and-braces. This rule lives in the fork's
CLAUDE.md and must survive every upstream merge.

## Rollout

1. This doc + repo-root `TELEMETRY.md` (user-facing field-by-field list) + README section.
2. Worker + DNS live first (so the first shipping client never 404s), PostHog dashboards:
   weekly active machines, installs by target, usage by tool × client, version adoption,
   languages indexed.
3. Client module + config + `codegraph telemetry` subcommand + MCP `clientInfo` plumbing.
4. Installer toggle + first-run notice. CHANGELOG entry under `[Unreleased]` announcing
   telemetry, the default, and every off-switch. Release.

Tests (no DB mocking, per repo convention; fetch mocked at `globalThis.fetch`):
consent precedence (env > config > default), off ⇒ zero fetch calls, rollup aggregation
across days, buffer cap + corrupt-buffer recovery, no-stdout invariant under MCP transport,
flush abort honors timeout, installer toggle persists + re-run doesn't re-ask
(`__tests__/installer-targets.test.ts` per house rules).

## Open questions

- Exact installer copy / notice wording — maintainer call before release.
- `uninstall` event: keep or drop? (Honest churn signal vs. "pinging on the way out" optics.)
- CI events are kept (tagged `ci: true`) because engine-in-CI is a real usage mode — revisit
  if it ever dominates volume.
