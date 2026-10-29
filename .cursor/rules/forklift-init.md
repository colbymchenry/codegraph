---
name: forklift-init
description: Bootstrap forklift in a target repository - classify the repo as fork or host, discover the agent tools in use, scaffold .forklift/registry.yaml (fork role) or document the adapter layout (host role).
---
<!-- forklift v1 -->

# forklift-init

Run from the **target** repository root (`cd` there first). `FORKLIFT` is the absolute path of the forklift checkout containing this skill:

```bash
cd "$(git rev-parse --show-toplevel)"
export FORKLIFT=<absolute path to the forklift checkout>
bun --version || echo "WARN: bun missing - forklift tooling requires it"
```

## 1. Classify the target

```bash
cd "$(git rev-parse --show-toplevel)"
echo "--- remotes:"; git remote -v
echo "--- forklift dir:"; ls -d .forklift 2>/dev/null || echo "none"
```

- **fork** - the repo rebase-syncs against an upstream project: `.forklift/` exists, or `git remote -v` shows an `upstream` (or `origin` pointing at a sibling clone) remote it tracks and rewrites history against.
- **host** - the repo IS the upstream other repos fork: no upstream-remote relationship, no `.forklift/`.

State the classification and the evidence (remote URLs) before proceeding.

## 2. Discovery

**Fork role - probe which fork tooling targets this repo:**

```bash
bun "$FORKLIFT/bin/forklift" render --help >/dev/null 2>&1 && echo "forklift render: runnable" || echo "forklift render: NOT runnable (bun missing?)"
npx --no-install create-opencode --help >/dev/null 2>&1 && echo "create-opencode: available (opencode scaffold)" || echo "create-opencode: not available"
```

**Both roles - scan agent-tool directories** using root-relative paths from `$FORKLIFT/adapters/tools.yaml`:

```bash
cd "$(git rev-parse --show-toplevel)" && FORKLIFT="$FORKLIFT" bun -e '
const tools = Bun.YAML.parse(await Bun.file(`${process.env.FORKLIFT}/adapters/tools.yaml`).text());
for (const t of tools.tools) {
  const ip = t.install_paths ?? {};
  for (const [key, dir] of Object.entries(ip)) {
    if (!dir) continue;
    let count = 0;
    try {
      for await (const f of new Bun.Glob("**/*").scan(dir)) {
        if (/\.(md|txt)$/.test(f)) count++;
      }
    } catch {}
    console.log(`${t.id} ${key}: ${dir} - ${count} file(s)`);
  }
}
'
```

Interpretation: `role: fork`/`both` entries are candidate **install** targets for this fork; `role: host` entries document the host project's layout (their counts are the `examples` a fork may record in `adapters/tools.yaml`).

## 3. Fork role - scaffold the registry

```bash
cd "$(git rev-parse --show-toplevel)"
mkdir -p .forklift
cp "$FORKLIFT/templates/registry.template.yaml" .forklift/registry.yaml
```

Then fill `.forklift/registry.yaml` - every field is documented in `$FORKLIFT/schema/registry.schema.yaml`:

1. `harness.fork` / `harness.upstream` - from `git remote -v` (remote names and branches), plus `sync_command` (how to start a sync: for a manual fork, `git rebase <upstream>/<branch>`), `fork_doc` (the doc that records sync points; `.forklift/README.md` when the repo keeps no other), and `sync_runner` **only** when the fork runs a forklift-style runner script with `--verify`/`--revert`/`--tag` flags - omit it otherwise, and the runner-flag sections are dropped from the rendered skill instead of rendering nonsense flags onto a plain `git rebase`.
2. `harness.project` - inspect the tree: `source_roots` (globs of fork source dirs), `test_globs` (test dir layouts), `conflict_marker_globs` (the file classes where conflict markers must be inspected), `package_aliases` (package name -> source dir for bare-specifier import resolution; from `package.json` workspaces if present).
3. `harness.checks` - `behavioral_source_regex` (paths whose features need protecting tests), `footprint_baseline` path once one exists, `excludes` for harness-generated paths, `semantic_drift: {tool: difftastic}` - enable it whenever difftastic can be installed for this fork: add `"github:Wilfred/difftastic" = "latest"` to the fork's mise.toml [tools], run `mise install`, confirm with `mise exec -- difft --version`, then set the key so the rendered skill's Conflict Walk reads conflicts structurally instead of by line diff. Omit it only when the tool cannot be installed here; the walk stays git-only and doctor check 8 says so.
4. `features` - enumerate fork-owned work from `git log --name-only <upstream>/<branch>..<fork>/<branch>` grouped by file overlap; each entry: `name`, `owned_paths`, and either `protecting_tests` or `coverage_exempt`. Put `status: draft` on every generated feature: the fresh registry is a migration worklist, and doctor checks 3 and 4 report draft findings without failing (protecting tests, import liveness) until you promote each feature to `active` once its worklist items are cleared.
5. `divergences` - upstream-owned files the fork deliberately does not override (always take upstream).
6. `expected_fork_commit_count` - `git rev-list --count <upstream>/<branch>..<fork>/<branch>`.

Then generate the skill and audit:

```bash
bun "$FORKLIFT/bin/forklift" render --registry .forklift/registry.yaml
bun "$FORKLIFT/bin/forklift" install
```

`forklift render` (default template `templates/SKILL.md.tmpl`) writes `sync-upstream/SKILL.md` into every adapter skills directory that already exists from step 2's scan; if none exists yet, create the directory this fork's agents use (e.g. `.omp/skills`) and re-render - until then the output is staged at `.forklift/SKILL.md`. `forklift install` then stamps the static skills into the same adapter directories, installs the sync command, and writes `.forklift/harness.lock`, which doctor check 7 requires.

Run `forklift doctor` checks 1-8 (skill in `$FORKLIFT/skills/forklift-doctor/SKILL.md`) and fix every finding before the first sync.

## 4. Host role - document the layout

Do **not** create `.forklift/`. From step 2's scan, record which adapter directories exist and their counts; if the counts differ from the `examples` block in `$FORKLIFT/adapters/tools.yaml`, report the corrected numbers so the table can be refreshed. Host repos consume forklift only through fork-side installs (`forklift install` run against them) - mention which `role: fork`/`both` tools could target this repo.
