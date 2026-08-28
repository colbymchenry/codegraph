# Anonymous usage telemetry

Status: implemented — client (`src/telemetry/`), `codegraph telemetry` CLI, MCP + installer
wiring, `TELEMETRY.md`, ingest Worker (`telemetry-worker/`) storing to its own Cloudflare D1
database, nightly rollup + retention cron, and the admin dashboard Worker
(`telemetry-dashboard/`).
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
- Version adoption speed, OS/arch/Node mix. (The SQLite backend is always the built-in `node:sqlite` now — there is no native-vs-wasm split left to measure.)

## Non-goals / never collected

- **No source code, ever.** No file paths, file names, repo names, symbol names, query
  strings, search terms, or anything derived from the contents of an indexed project.
- No IP addresses — never read at the edge, and there is no downstream backend that could
  see one.
- No third-party analytics vendor. Events are stored only in our own database; the ingest
  Worker makes no outbound requests at all.
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
| `schema_version` | `2` | bump when the schema changes (v2 dropped `index.sqlite_backend`) |

Event types:

- **`install`** — one per installer run. Props: `targets` (e.g. `["claude","cursor"]`),
  `scope` (`local`/`global`), `kind` (`fresh`/`upgrade`/`reinstall`).
- **`index`** — one per full index (`init`/`index`, not per `sync`). Props: `languages`
  (names only, e.g. `["typescript","go"]`), `file_count_bucket` (`<100`, `100-1k`, `1k-10k`,
  `10k+`), `duration_bucket` (`<10s`, `10-60s`, `1-5m`, `5m+`).
- **`usage_rollup`** — the workhorse. One event per `(day, kind, name)` per machine,
  aggregated locally. Props: `kind` (`mcp_tool`/`cli_command`), `name`
  (e.g. `codegraph_explore`, `affected`), `count`, `error_count`, and for MCP:
  `client_name`/`client_version` captured from the `initialize` handshake
  (`src/mcp/session.ts`) and passed through on every `recordUsage` call.
  The prompt hook additionally rolls up its gate DECISION as `cli_command`
  counters named `prompt-hook-gate-<outcome>`, outcome ∈ `high-keyword` /
  `high-token` / `medium-segment` / `nudge-projects` / `noop-shape` /
  `noop-no-index` / `noop-unverified` / `noop-explore-keyword` /
  `noop-explore-token` / `noop-vocab-empty` — decision names only, never
  prompt content. This is the gate's measured recall/precision funnel: a
  rising `noop-*` share against the `high`/`medium` tiers is the signal that
  the gate (keyword table or segment matching) is missing real questions.
  A `high-*` outcome means context was actually injected — a gate decision
  whose `codegraph_explore` errored or returned nothing records
  `noop-explore-<trigger>` instead (#1143), and a MEDIUM-eligible prompt
  hitting a not-yet-backfilled segment vocabulary records `noop-vocab-empty`
  rather than polluting `noop-unverified` (#1142).
- **`uninstall`** — one per `uninstall`/`uninit` run (churn signal). Props: `targets`.

One legacy field is still *accepted* and belongs in the mirror even though nothing sends
it: `sqlite_backend` (`native`/`wasm`) on `install` and `index`. Pre-schema-v2 clients
(≤ June 2026) sent it; `node:sqlite` is the only backend now, so current clients omit it.
It is never `required`, and it is safe to drop from the Worker once those clients'
share is negligible.

Volume math: rollups mean monthly events ≈ active machines × active days × distinct tools
used (single digits) — there is no per-call event by design. At ~97k accepted POSTs/day
that is ≈30M D1 row writes/month against the 50M included on **Workers Paid**, roughly
doubling to ≈48M once the retention purge reaches steady state (a delete bills like an
insert). Storage is the binding constraint, not writes: raw events grow ≈74 MB/day, so the
90-day window lands at ≈6.7 GB against D1's 10 GB per-database cap — which is what sets the
window. Full arithmetic and the remaining levers are in the migration's footer comment.

There are no person profiles to opt out of: `machine_id` is the only identifier that exists
anywhere in the system, it is a client-minted random UUID, and unique-machine counts are
computed from it directly in SQL.

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
  strip unknown props), enforce sane sizes, **never read or log the client IP**, light
  per-`machine_id` rate limit so abuse can't burn the ingest cap, then write the survivors
  to D1. Responds `204` on accept (including events dropped by the allowlist) and honest
  `4xx` for malformed/oversized/rate-limited requests — the client treats every response
  as final and never retries.
- **Storage: our own Cloudflare D1 database** (`codegraph-telemetry`, bound as `env.DB`).
  The Worker makes **no outbound requests** — nothing is forwarded to a third-party
  analytics vendor, so there is no vendor-side privacy setting to get wrong and no second
  copy of the data anywhere. The complete stored schema is
  [`telemetry-worker/migrations/0001_init.sql`](../../telemetry-worker/migrations/0001_init.sql),
  checked in for the same reason the Worker's source is public.
- The write is off the response path (`ctx.waitUntil`, one `batch()` = one transaction) and
  deliberately **fail-silent**: a D1 error is logged as counts only, never the payload, and
  the client still gets its `204`. Clients never retry, so losing a datapoint beats losing
  availability.
- **Nightly cron (00:30 UTC, `src/rollup.ts`)** rolls each finished day into anonymous daily
  counts (`daily_machines`, `daily_event_counts`, `daily_dim_counts`) and re-runs the two
  days before it, since offline clients ship completed-day rollups late. Aggregation is
  `INSERT … SELECT … ON CONFLICT DO UPDATE` inside D1 — no event row crosses the wire, and
  re-running a day is a no-op rather than a double count. The same job **purges raw
  `events` older than `RETENTION_DAYS`** (90; a var in `wrangler.jsonc`). Rollups and
  `machine_days`/`machine_first_seen` are kept forever, so shortening the window costs
  ad-hoc drill-back, never a chart.
- The Worker remains the seam: changing storage later is a Worker change, not a client
  release. The client only ever knows the domain.

Operational detail — deploy, migrations, the cron, the `POST /admin/rollup` backfill hatch,
and the D1 quota arithmetic — lives in
[`telemetry-worker/README.md`](../../telemetry-worker/README.md).

## Admin dashboard (Cloudflare Worker)

`stats.getcodegraph.com` → a second Worker at
[`telemetry-dashboard/`](../../telemetry-dashboard/) — the read side, and the reason
self-hosting the data costs us no analysis capability. Also public source, for the same
reason: the code that touches telemetry should be readable by the people it collects from.
Full documentation is [`telemetry-dashboard/README.md`](../../telemetry-dashboard/README.md).

- **Same D1 database, read-only.** It never migrates and never writes; schema changes belong
  to the ingest Worker. The two Workers are separate deployments that agree on a list of
  dimension names by convention alone, which is exactly the seam
  `telemetry-worker/scripts/smoke-cutover.sh` exists to cover — a mismatch there is silent,
  showing up as a panel that reads zero forever rather than as an error.
- **Reads rollups, not raw events**, so a chart stays correct for days whose raw rows have
  been purged. `/api/activation` is the one exception — "did this machine ever run an index"
  is not a daily aggregate — so it reads raw `events` and is bounded by the retention window,
  which it reports as `raw_events_from`.
- **Auth is a shared password and a signed cookie**, sized for exactly two people:
  `ADMIN_PASSWORD` + `SESSION_SECRET` as Worker secrets, constant-time compare, HMAC-signed
  cookie with no session store, everything except `/login` and `robots.txt` gated. Rotating
  the password signs everyone out; that is the revocation story.
- This Worker *does* read the client IP, solely as a login rate-limit key, never stored or
  logged — the one deliberate difference from the ingest Worker, which never reads it at all.

## codegraph-pro rule (do not lose this in upstream merges)

The private `codegraph-pro` fork ships inside customer containers whose guarantee is
"nothing leaves the box" — including telemetry. In the fork, telemetry must be **default-off
and not enableable by the installer** (compile-time constant or stripped module), and the
container sets `CODEGRAPH_TELEMETRY=0` as belt-and-braces. This rule lives in the fork's
CLAUDE.md and must survive every upstream merge.

## Rollout

1. This doc + repo-root `TELEMETRY.md` (user-facing field-by-field list) + README section.
2. Worker + DNS live first (so the first shipping client never 404s), then the dashboard
   Worker over the same D1: weekly active machines, installs by target, usage by
   tool × client, version adoption, languages indexed.
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
