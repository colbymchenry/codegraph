# User defined installer targets

**Status:** implemented on `feat/user-defined-targets`, the successor of #1459.
Motivated by #1272 and #1274 (CoDev Code, an opencode fork), #1324 (Grok Build,
a Codex shaped TOML config, since shipped as a builtin target), #1535 (ZCode),
#1860 (Devin) and #1193 / #1464 (the Qoder IDE). Each agent whose config
shape CodeGraph already writes used to cost a registry entry, a target file,
tests, a changelog entry and a release. A spec lets the user supply the paths;
CodeGraph supplies the write mechanics.

## Goals

- `codegraph install --target <id>`, `auto`, `all`, the interactive picker,
  `install --refresh`, `install --print-config` and `codegraph uninstall` work
  for an agent CodeGraph has never heard of, as long as its config follows a
  known **family** shape.
- A target built from a spec keeps every promise a builtin target makes:
  detection that never writes, edits that keep comments and formatting, an
  entry the user changed left as it is, byte identical reruns reported as
  `unchanged`, an uninstall that reverses install and keeps siblings, a
  symbolic link written through rather than replaced.
- Registration is one command: `codegraph targets add <spec.json>`.

## Non goals

- Arbitrary file writes. A spec says *where* to write and under which
  family's rules, never *what*. That keeps the installer's promises provable
  per family rather than per spec, and keeps a typo in a spec from writing
  outside an agent's config dir.
- Permissions, prompt hooks and other surfaces only one agent has. Claude
  Code and Qwen Code keep theirs in code.
- A project local spec file. Specs are user level, in `~/.codegraph/targets.json`.

## Families

A family is a factory that turns a spec into a complete `AgentTarget`, built on
the shared module the builtin targets of that shape already use.

| family | shape | built on | builtin targets of that shape |
|---|---|---|---|
| `mcp-json` | a map of `<name>: { command, args }` objects in a JSON file, under `mcpServers` or any other path | `targets/json-config.ts` | Bob, Droid, Windsurf, Qwen, Kimi, Qoder, Pi |
| `toml` | an `[mcp_servers.codegraph]` table in a `config.toml` | `targets/toml.ts` | Codex, Grok |
| `opencode` | OpenCode 2's `mcp.servers` wrapper in `<app>.jsonc`, XDG dirs, `AGENTS.md` | `targets/opencode-family.ts`, which `opencode.ts` is now one call to | opencode |

The builtin targets are untouched. The one exception is `opencode.ts`, whose
mechanics moved into the family factory unchanged, pinned by the opencode tests
that were already there. `json-config.ts` gained the servers path as an
optional last argument, and `resolveCodegraphCommand` moved from the
Antigravity target to `shared.ts`, both with no change for the targets that
call them.

## Spec schema

`~/.codegraph/targets.json` (override with `CODEGRAPH_TARGETS_FILE`, used by
tests). Comments and trailing commas are read.

```jsonc
{
  "targets": [
    { // ZCode (#1535): servers under mcp.servers
      "id": "zcode",
      "displayName": "ZCode",
      "family": "mcp-json",
      "docsUrl": "https://zcode.z.ai",
      "configDir": "~/.zcode/cli",
      "configFileName": "config.json",
      "localConfigDir": ".zcode",
      "serversKey": "mcp.servers",
      "instructionsFile": null
    },
    { // Zed: context_servers in settings.json, one dir for each platform, no type key
      "id": "zed",
      "displayName": "Zed",
      "family": "mcp-json",
      "configDir": { "darwin": "~/.config/zed", "linux": "~/.config/zed", "win32": "${APPDATA}/Zed" },
      "configFileName": "settings.json",
      "serversKey": "context_servers",
      "omitTypeField": true,
      "instructionsFile": null
    },
    { // Devin (#1860): a schema that refuses extra keys, so no type; AGENTS.md block
      "id": "devin",
      "displayName": "Devin",
      "family": "mcp-json",
      "configDir": { "darwin": "~/.config/devin", "linux": "~/.config/devin", "win32": "${APPDATA}/devin" },
      "configFileName": "mcp_config.json",
      "localConfigDir": ".devin",
      "omitTypeField": true
    },
    { // Claude Desktop: launched from the Dock, so the command is the binary's absolute path on macOS
      "id": "claude-desktop",
      "displayName": "Claude Desktop",
      "family": "mcp-json",
      "configDir": { "darwin": "~/Library/Application Support/Claude", "win32": "${APPDATA}/Claude" },
      "configFileName": "claude_desktop_config.json",
      "absoluteCommand": true,
      "omitTypeField": true,
      "instructionsFile": null,
      "notes": ["Quit and reopen Claude Desktop to load CodeGraph."]
    },
    { // CoDev Code (#1274): an opencode fork, renamed on disk
      "id": "codev",
      "displayName": "CoDev Code",
      "family": "opencode",
      "appName": "codev",
      "schemaUrl": "https://opencode.ai/config.json",
      "docsUrl": "https://github.com/quickbeard/codev-code"
    },
    { // a Codex shaped agent with a rules folder, as Grok Build has
      "id": "myagent",
      "family": "toml",
      "configDir": "~/.myagent",
      "homeEnvVar": "MYAGENT_HOME",
      "localConfigDir": ".myagent",
      "instructionsFile": "rules/codegraph.md",
      "instructionsLocal": "config"
    }
  ]
}
```

Keys by family:

| key | families | meaning | default |
|---|---|---|---|
| `id` | all | the `--target` id: 1 to 32 lowercase letters, digits or dashes, starting with a letter | required |
| `displayName` | all | shown in prompts and log lines | the id |
| `docsUrl` | all | an http or https URL | none |
| `notes` | all | up to 5 lines shown after every successful install, never written to a file | none |
| `appName` | opencode | the app's name on disk: `~/.config/<appName>/<appName>.jsonc`, `./<appName>.jsonc` | required |
| `schemaUrl` | opencode | the `$schema` stamped into a config the install creates | none |
| `configDir` | toml, mcp-json | the global config dir: absolute, `~`, or one leading `${ENV}` token; or a `{darwin, win32, linux}` map | required |
| `homeEnvVar` | toml, mcp-json | an environment variable that names the global config dir when set, like `GROK_HOME` | none |
| `configFileName` | toml, mcp-json | the config file's name, with the family's extension | `config.toml` / `settings.json` |
| `localConfigDir` | toml, mcp-json | the project local config dir, relative to the project; `.` is the project itself; absent means global only | none |
| `localConfigFileName` | mcp-json | the project local file's name when it differs, as the Qoder CLI's does | `configFileName` |
| `serversKey` | mcp-json | the keys that lead to the servers map, 1 to 3 identifiers joined by dots | `mcpServers` |
| `instructionsFile` | toml, mcp-json | the file that gets the CodeGraph block, relative to the config dir; `null` writes none | `AGENTS.md` |
| `instructionsLocal` | toml, mcp-json | for a local install, `project` puts the file at the project root, `config` under the local config dir | `project` |
| `omitTypeField` | mcp-json | write `{ command, args }` with no `type` key | `false` |
| `absoluteCommand` | mcp-json | write the binary's resolved absolute path as `command` on macOS, as the Antigravity target does | `false` |

`configDir` as a map must have an entry for the machine the spec is loaded on;
other platforms' entries ride along. A dir that cannot be resolved on this
machine, because the variable is unset, degrades to not installed, with a
"cannot locate its config dir" note, never a throw.

### Validation, on `targets add` and on load

- The id's shape, the reserved words `auto`, `all`, `none` and `custom`, and the
  builtin ids.
- Only the keys the family reads. A key another family reads is a problem,
  not ignored, since it is most likely a typo.
- `configDir`: absolute for its platform, `~` alone or followed by a
  separator, or one leading `${ENV}` token followed by a separator or the end.
  `~user`, a relative path and `..` are refused, so a spec can never be written
  relative to the working directory.
- `homeEnvVar` is an environment variable name. `docsUrl` and `schemaUrl` parse
  as http or https URLs. `displayName` and each note are one line of printable
  characters, within their length limits.
- File names are one segment with the family's extension: `.toml`, or `.json`
  and `.jsonc`. `localConfigDir` and `instructionsFile` are relative paths with
  no `..`.
- `serversKey` is 1 to 3 identifiers joined by dots; `$schema` is not one.
- A spec whose resolved files include one a builtin target owns is refused,
  naming the target, so two targets never edit one file.
- Loading is tolerant: a spec that fails a check is skipped with one warning,
  printed once for each version of the file; the first of two specs with one
  id wins; at most 50 are loaded. `targets add` is strict and refuses the spec
  with every problem listed, and never rewrites a file it cannot read.

## Registry integration

`targets/registry.ts` gains `getAllTargets()`: the builtin targets, then the
loaded specs, in that order. `getTarget`, `listTargetIds`, `detectAll` and
`resolveTargetFlag` resolve against it, so the picker, `--target`, `auto`,
`all`, `--refresh`, `--print-config` and uninstall's sweep pick up a custom
target with no further wiring. `ALL_TARGETS` stays the frozen builtin list
the contract suite iterates. `TargetId` widens to `string`; the compiled ids
remain as `BuiltinTargetId`.

Telemetry records a custom target as `custom-<family>`, never the name the
user gave it, through `telemetryTargetId`.

## CLI

```
codegraph targets add <spec.json | '{...inline json}'>   # check, then write to targets.json
codegraph targets list                                   # ids, families, the files each writes
codegraph targets remove <id>                            # forget it; uninstall first to remove its files
```

`targets add` prints the follow up, `codegraph install --target <id>`, and
never installs by itself.

## Parity with the builtin targets

`__tests__/custom-targets.test.ts` builds a spec for each JSON and TOML
builtin target and installs it beside the builtin into a fresh home and
project: the same files, bytes, detection, snippet and uninstall.

| builtin | result |
|---|---|
| Droid, Kimi Code, Windsurf, IBM Bob, Qoder CLI, Qwen Code, Grok Build, Codex | identical |
| Pi | identical except `exposure: "direct"`, which only the builtin adds to the entry |
| Qwen Code with auto allow | identical except the `permissions.allow` rule, which only the builtin writes |

Two builtin behaviors are not part of a fresh install and are not expressed by
a spec: Bob's fallback to an existing `mcp_settings.json`, and Codex rewriting
a table the user changed, which the toml family does not do.

## Limits

- The mcp-json family has no "this variable, or else this default" form, so a
  Zed spec covers `~/.config/zed` and `%APPDATA%\Zed`, not `$XDG_CONFIG_HOME`.
- Zed's project level `.zed/settings.json` is not verified against Zed's docs
  here, so the example spec is global only.
- Devin's cleanup of a legacy `mcpServers` key in `config.json`, from #1860, is
  code, not data.
- `absoluteCommand` resolves on macOS only, as the Antigravity target does.

## Future work

- Bundled specs: the eight builtin targets the parity test covers could be
  spec rows shipped in the package, which is a separate decision.
- A project local spec file, `.codegraph/targets.json`, for teams.
- `codegraph install --target-spec <file>` for a one shot install with no
  persistence, for CI images.
