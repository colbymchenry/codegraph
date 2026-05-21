# Smoke test: `codegraph completions`

End-to-end verification that `codegraph completions <shell>` produces a
script that actually works when installed into a real shell. Runs in a
pinned Docker image so the result doesn't depend on the developer's
local zsh/bash/fish versions.

## Run

```bash
npm run smoke:completions
```

Expected final line on success: `smoke: zsh bash fish OK`.

## What this proves

- `npm pack` artifact installs cleanly via `npm install -g`.
- `codegraph completions <shell> --install` writes to the correct path
  for zsh, bash, and fish, and the resulting file is non-empty.
- **bash**: the installed completion, sourced via `bash-completion`,
  produces the expected COMPREPLY for top-level commands, subcommand
  flags, options with `<path>` values, and the global `--help` / `--version`.
- **fish**: `complete -C "codegraph …"` returns the expected suggestions
  for top-level commands, subcommand flags, and file-hint options.
- **zsh**: the script parses (`zsh -n`), is registered as an
  autoloadable completion by `compinit`, and a representative
  cross-section of per-subcommand helper functions is defined after
  autoload (proves the file body ran to completion — if any helper is
  missing, the script crashed mid-way).

## What this does NOT prove

zsh completion output is **not** content-verified. The actual
suggestions zsh produces require `_main_complete` running under a real
ZLE widget context, which scripts cannot manufacture — `_values` and
`_arguments` short-circuit on missing `$compstate`/`$state` setup, so
even a `compadd` shim captures nothing. The only way to drive the full
path is PTY + `expect`, which is too flaky across zsh 5.7/5.8/5.9 and
across `TERM`/locale/`zle` configurations to belong in CI.

Concretely, a subtle bug inside an `_arguments` spec (e.g., malformed
quoting that breaks one specific state) would pass our structural
checks and still misbehave for users. Industry consensus on this
exact tradeoff: clap_complete, oclif, click, and Commander.js itself
all ship structural-only zsh tests. We match that bar.

If you want stronger zsh coverage in the future, the realistic path
is `zpty`-based testing (what Fig uses) — that runs a real interactive
zsh under a pseudo-terminal and pipes keystrokes. It's a separate
engineering effort from this smoke harness.

## What's tested

| Shell | Mechanism                                          | Strength |
|-------|----------------------------------------------------|----------|
| bash  | Source script, set `COMP_*`, call `_codegraph`, assert `COMPREPLY` | Full content |
| fish  | `complete -C "codegraph …"` stdout assertions       | Full content |
| zsh   | Syntax + `compinit` load + cross-section of helpers defined | Structural |

## Architecture

```
host:                                          container:
                                               ┌────────────────────────────────┐
npm run build                                  │ node:22 + zsh + bash + fish    │
npm pack            ───── /pkg.tgz ──────────▶ │ npm install -g /pkg.tgz        │
docker run                                     │ codegraph completions … --install │
                                               │ /smoke/test-{bash,fish,zsh}.sh │
                                               └────────────────────────────────┘
```

The image is bind-mounted **only** with the tarball — test scripts
are baked in at build time so the image is self-contained. The host
wrapper at `run-host.sh` does build, pack, image-build, and run.

## Why Docker (not just a local script)

- Pins shell versions (Debian Bookworm: zsh 5.9, bash 5.2, fish 3.6) so
  results are deterministic across developer machines and CI.
- Avoids polluting the developer's shell config with test completions.
- Sidesteps macOS-specific bash 3.2 quirks (the bundled bash on macOS
  is too old for the `_init_completion` helper).

## Isolation from the main test suite

The smoke test is **not** wired into `npm test` or vitest. It has its
own opt-in npm script (`smoke:completions`) and lives entirely under
`docker/`, which is excluded from `npm pack` by the `files:` allowlist
in `package.json`. The existing vitest suite is untouched.
