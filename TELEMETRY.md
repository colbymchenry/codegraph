# Telemetry

CodeGraph collects a small set of **anonymous usage statistics** — which commands and
tools get used, which languages get indexed, which agents drive usage — so we can tell
which of the 20+ languages and 8 agent integrations deserve the most work. This page is
the complete list of what is collected. If a field isn't on this page, it isn't collected;
the ingest endpoint enforces this list as an allowlist and is itself
[public, auditable code](telemetry-worker/) in this repository.

## Turning it off

Any of these works, permanently:

```bash
codegraph telemetry off        # stores your choice (and deletes any unsent data)
```

```bash
export CODEGRAPH_TELEMETRY=0   # per-shell / per-CI override
export DO_NOT_TRACK=1          # the cross-tool standard — always honored
```

`codegraph telemetry status` shows the current state, what decided it, and your machine ID.
The interactive installer (`codegraph install`) asks up front with a visible default-on
toggle and never re-asks. If you never saw the installer (e.g. `npx` straight into `init`),
a one-line notice is printed to stderr before the first time anything is sent.

Off means off: when disabled, CodeGraph records nothing, opens no connection to the
telemetry endpoint, and sends no "opted out" ping.

## What is collected

Every payload carries this envelope:

| field | example | notes |
|---|---|---|
| `machine_id` | `b3a8c1…` | random UUID minted on first send — derived from nothing |
| `codegraph_version` | `0.9.9` | |
| `os` / `arch` | `darwin` / `arm64` | platform identifiers only |
| `node_major` | `22` | major version only |
| `ci` | `false` | whether the `CI` env var was set |
| `schema_version` | `2` | bumped when this page changes (v2 dropped the `index` event's `sqlite_backend` field) |

And one of four events:

- **`install`** — when `codegraph install` configures agents: which agents
  (`["claude","cursor",…]`), global vs project-local, and whether it was a fresh install,
  an upgrade, or a re-run.
- **`index`** — when a full index completes: the **language names** present (e.g.
  `["typescript","go"]`), the file count as a **coarse bucket** (`<100`, `100-1k`,
  `1k-10k`, `10k+`), and the duration as a bucket (`<10s`, `10-60s`, `1-5m`, `5m+`).
- **`usage_rollup`** — one line per day per tool: the tool or CLI command **name** (e.g.
  `codegraph_explore`, `init`), how many times it ran, how many errored, and — for MCP
  tools — the connecting agent's name and version from the MCP handshake (e.g.
  `Claude Code 2.1`).
- **`uninstall`** — when `codegraph uninstall`/`uninit` runs: which agents were removed.

Usage is **aggregated locally into daily totals** before anything is sent — there is no
per-call event stream, and nothing is sent in real time.

## What is never collected

- **No source code.** No file paths, file names, directory names, repository names or
  URLs, symbol names, search queries, or anything else derived from the contents of an
  indexed project.
- **No IP addresses.** The ingest endpoint never reads, logs, or forwards the client IP,
  and IP discarding is enabled at the analytics backend on top of that. No geolocation.
- **No fingerprinting.** The machine ID is a random UUID stored in
  `~/.codegraph/telemetry.json` — delete that file (or run `codegraph telemetry off`,
  then `on`) and the old ID is gone forever, with no way to reconnect it.
- **No personal data.** No usernames, hostnames, emails, or environment variables.

## How it travels

Events POST to `telemetry.getcodegraph.com` — a first-party endpoint whose complete
source lives in [`telemetry-worker/`](telemetry-worker/) in this repository. It validates
every event and property against the allowlist above (anything else is dropped), strips
IPs, rate-limits, and forwards to a managed analytics store (PostHog, US region) as
anonymous events. Sends are fire-and-forget with a short timeout: offline or air-gapped
machines buffer a bounded local file (256 KB cap) and never retry-loop, log errors, or
slow a command down. Telemetry never adds latency to MCP tool calls — recording is an
in-memory counter.

The engineering contract behind all of this — including the rule that schema changes must
update this page, the client, and the public endpoint in one PR — is in
[`docs/design/telemetry.md`](docs/design/telemetry.md).
