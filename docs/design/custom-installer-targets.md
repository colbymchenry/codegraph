# Custom installer targets — spec-driven agent targets without registry PRs

**Status:** prototype (this branch). Motivated by #1272 (CoDev Code, an opencode
fork) and #1324 (Grok Build, a Codex-shaped TOML config) — two open PRs in four
days that each add a built-in target for an agent whose config format CodeGraph
already knows how to write. Every fork/clone of an existing agent currently
costs a permanent registry entry, a bespoke target file, and a maintainer
support surface. This feature caps that: users declare the target; CodeGraph
supplies the write mechanics.

## Goals

- `codegraph install --target <custom-id>` (and `auto` / `all` / the
  interactive multiselect) work for agents CodeGraph has never heard of, as
  long as their config follows a known **family** shape.
- Custom targets get the full contract built-ins have: detect, surgical
  install, byte-identical idempotent re-runs (`unchanged`), uninstall that
  reverses install and preserves siblings, `--print-config`, `describePaths`.
- Registration is one command: `codegraph targets add <spec.json>`.

## Non-goals

- Arbitrary file writes. A spec never says *what* to write — only *where* and
  under which family's rules. This is what keeps the installer's contract
  (sibling preservation, reversible uninstall) provable per family instead of
  per spec, and keeps a malicious/typo'd spec from scribbling outside an agent
  config dir.
- Claude-style targets (permissions surface, prompt hook) — deliberately out of
  scope; anything needing `settings.json` permissions or hooks should be a
  built-in.
- Per-project spec files. Specs are user-level (`~/.codegraph/targets.json`);
  a project-local spec source can be added later if demand shows up.

## Families

A family is a factory that turns a small spec into a complete `AgentTarget`.
Three cover every agent shape in the current registry except Claude:

| family | config shape | extracted from | example targets |
|---|---|---|---|
| `opencode` | jsonc `mcp.<name>` wrapper, `command` as array, XDG dirs, `<app>.jsonc`-over-`.json` preference | `targets/opencode.ts` (now a 6-line spec instantiation) | opencode, CoDev Code (#1272) |
| `toml` | `[mcp_servers.codegraph]` table via `targets/toml.ts`, `~/.<app>/config.toml` | `targets/codex.ts` (now a spec instantiation) | Codex CLI, Grok Build (#1324) |
| `mcp-json` | standard `mcpServers.codegraph` JSON object | modeled on `targets/gemini.ts` | Gemini-/Cursor-shaped clients |

The built-in opencode and codex targets are themselves instantiated through
their family factories, so the families are exercised by the existing ~47-test
installer contract suite on every run — custom targets ride battle-tested code,
not a parallel implementation.

## Spec schema

`~/.codegraph/targets.json` (override with `CODEGRAPH_TARGETS_FILE`, used by
tests):

```jsonc
{
  "targets": [
    { // opencode family: appName drives every path —
      // ~/.config/<appName>/<appName>.jsonc (+ AGENTS.md), ./<appName>.jsonc local
      "id": "codev",
      "displayName": "CoDev Code",
      "family": "opencode",
      "appName": "codev",
      "schemaUrl": "https://opencode.ai/config.json",
      "docsUrl": "https://github.com/quickbeard/codev-code"
    },
    { // toml family: Codex-shaped
      "id": "grok",
      "displayName": "Grok Build",
      "family": "toml",
      "configDir": "~/.grok",
      "homeEnvVar": "GROK_HOME",     // env override for configDir, wins when set
      "localConfigDir": ".grok"      // enables --location=local; omit = global-only
    },
    { // mcp-json family: standard mcpServers shape
      "id": "myagent",
      "family": "mcp-json",
      "configDir": "~/.myagent",
      "configFileName": "settings.json", // default
      "localConfigDir": ".myagent",
      "serversKey": "mcpServers",        // default
      "instructionsFileName": null,      // default "AGENTS.md"; null disables
      "notes": [                         // any family: surfaced verbatim after install
        "MyAgent only reloads its MCP config from the settings panel — hit Refresh there."
      ]
    }
  ]
}
```

`notes` (any family) exists for agent quirks the user must act on after a
successful install — e.g. Windsurf not reloading `mcp_config.json` until the
MCP panel's Refresh is pressed (#952, reported by the target's author). They
ride the existing `WriteResult.notes` channel (the same one Cursor's
"Restart Cursor to apply" uses), are free text shown only to the user, and are
never written into any agent file.

### Validation (enforced on `targets add` and on load)

- `id`: `^[a-z][a-z0-9-]{0,31}$`; must not collide with a built-in id or the
  reserved words `auto` / `all` / `none` / `custom`.
- `family`: one of `opencode` / `toml` / `mcp-json`.
- `appName` (opencode): single path segment (`^[A-Za-z0-9._-]+$`), required.
- `configDir` (toml / mcp-json): required; must be absolute or `~/`-prefixed —
  never relative, so a spec can't write into whatever cwd install runs from.
- `localConfigDir`: relative single segment or nested relative path, no `..`,
  not absolute.
- `notes`: at most 5 non-empty single-line strings, ≤200 chars each.
- Load is tolerant: an invalid spec is skipped with a one-line warning (the
  installer must never crash because of a bad spec); `targets add` is strict
  and refuses invalid specs up front. Duplicate ids: first wins, rest warned.

## Registry integration

`targets/registry.ts` gains `getAllTargets()` = built-ins + loaded customs.
`getTarget`, `listTargetIds`, `detectAll`, and `resolveTargetFlag` all resolve
against the merged list, so everything downstream — interactive multiselect,
`--target` CSV / `all` / `auto` detection, uninstall's all-targets sweep,
`--print-config`, `--check` — picks up custom targets with no further changes.
`ALL_TARGETS` stays the frozen built-in list (test fixtures parameterize over
it). `TargetId` widens to `string`; the old union survives as
`BuiltinTargetId` documentation.

## CLI

```
codegraph targets add <spec.json | '{...inline json}'>   # validate + upsert into targets.json
codegraph targets list                                   # ids, families, resolved paths
codegraph targets remove <id>
```

`targets add` prints the follow-up (`codegraph install --target <id>`); it
never triggers an install itself.

## Instructions files

Families write the short marker-fenced CodeGraph block (#704) the same way
their built-in counterparts do — `AGENTS.md` next to the global config
(opencode family also writes it for local installs at the project root;
toml family is global-only, matching Codex). `mcp-json` specs can rename or
disable it. Uninstall strips the block via the existing #529 markers.

## Mapping the open PRs

- **#1272 (codev)** → the `codev` spec above, byte-for-byte the same writes as
  the PR's `OpencodeFamilyTarget` (this design independently arrives at the
  same factory extraction the PR proposed; the factory here additionally backs
  the custom-target loader). The pre-#535 `%APPDATA%` sweep stays an
  opencode-only flag (`sweepLegacyWindowsAppData`, not spec-exposed) — forks
  never had a legacy Windows install base.
- **#1324 (grok)** → the `grok` spec above. Differences from the PR: no
  `AGENTS.md` for local installs (family follows Codex), and empty-dir cleanup
  on local uninstall is family behavior.

## Test plan

- `__tests__/custom-targets.test.ts`: spec validation matrix; loader tolerance
  (malformed file, duplicate ids); per-family contract runs driven by synthetic
  specs (install / detect / idempotent re-run / uninstall-reverses /
  sibling + comment preservation); registry merge (`--target <id>`, `all`,
  unknown-id error message lists customs); `targets add/list/remove`
  round-trip.
- Existing `installer-targets.test.ts` is the regression net proving the
  opencode/codex factory refactors are behavior-preserving.

## Future work

- A `claude-json` family if demand appears (needs a story for permissions).
- Project-local spec files (`.codegraph/targets.json`) for teams.
- `codegraph install --target-spec <file>` one-shot mode (no persistence) for
  CI images.
