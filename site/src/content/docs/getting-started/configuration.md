---
title: Configuration
description: CodeGraph is zero-config by default, with one optional codegraph.json for custom extensions, excluding tracked directories, indexing gitignored source, indexing nested git repositories, and naming a PHP site's web root.
---

Next to none — CodeGraph is **zero-config by default**, with nothing to write or keep in sync to get started. Language support is automatic from the file extension; there's nothing to wire up per language. The one optional file, `codegraph.json`, covers [custom file extensions](#custom-file-extensions), [excluding tracked directories](#excluding-a-tracked-directory), [indexing gitignored source](#indexing-gitignored-source-a-second-vcs), [indexing nested git repositories](#indexing-nested-git-repositories), and [naming a PHP site's web root](#php-includes-from-the-web-root) when CodeGraph can't work it out.

## What it skips out of the box

- **Dependency, build, and cache directories** — `node_modules`, `vendor`, `dist`, `build`, `target`, `.venv`, `Pods`, `.next`, and the like across every [supported stack](/codegraph/reference/languages/) — so the graph is your code, not third-party noise. This holds even with no `.gitignore`. A `build` folder inside `src/` is the exception: no build step writes TypeScript, JSX, Vue, Svelte, Astro, Go, C# or Rust files into one, so those are indexed from it, and a Java, Kotlin or Scala package named `build` is indexed whole.
- **Anything in your `.gitignore`** — honored in git repos via git, and in non-git projects by reading `.gitignore` directly (root and nested).
- **Files larger than 1 MB** — generated bundles, minified JS, vendored blobs.

## Excluding or including more

To keep something else out, add it to `.gitignore`. To pull a default-excluded directory back **in** (e.g. you really want a vendored dependency indexed), add a negation — `!vendor/`.

The defaults apply uniformly, so committing a dependency or build directory doesn't force it into the graph — the `.gitignore` negation is the explicit opt-in.

## Excluding a tracked directory

`.gitignore` only affects files git **doesn't already track** — it can't drop a directory you've committed. So a vendored theme, SDK, or asset bundle that's checked into the repo (say a Metronic admin theme under `static/`, with hundreds of `.js` files) can't be excluded that way. For those, list them under `exclude` in `codegraph.json`:

```json
{
  "exclude": ["static/", "**/vendor/**"]
}
```

Each entry is a gitignore-style pattern, matched against project-root-relative paths, and honored everywhere CodeGraph looks at files — the full index, incremental `sync`, and file-watching. It applies even to tracked files (that's the whole point) and takes precedence over everything else, so it's the right tool for a large committed dependency that bloats the graph but isn't really your code. (This is the opposite of [`includeIgnored`](#indexing-nested-git-repositories), which pulls gitignored directories back *in*.)

Re-index (`codegraph index`) after adding or changing `exclude`.

## Indexing gitignored source (a second VCS)

`.gitignore` keeps files out of the index — which is usually what you want, but not when the gitignored files are real first-party source. The case this exists for: a project tracked by **SVN, Perforce, or another VCS alongside Git**, where some source is committed to that VCS and deliberately listed in `.gitignore` so it never lands in Git. That source is still yours and you want it in the graph, but git never lists it, so CodeGraph never sees it. (`includeIgnored` doesn't help — it only revives *embedded git repositories* inside a gitignored directory, not plain source.)

List those paths under `include` in `codegraph.json` to force them in:

```json
{
  "include": ["Tools/", "Local/typescript/"]
}
```

Each entry is a gitignore-style pattern, matched against project-root-relative paths (a directory like `"Tools/"`, a recursive `"Tools/**"` glob, or a single file all work). CodeGraph discovers the matching files directly off disk — overriding `.gitignore` — and indexes them everywhere it looks at files: the full index, incremental `sync`, and file-watching.

A few things to know:

- An explicit [`exclude`](#excluding-a-tracked-directory) still wins — listing the same path in both keeps it out.
- Built-in skips like `node_modules`, `dist`, and `.git` are never re-included, even when an `include` pattern would match inside them.
- This is the opposite of `exclude` (which keeps tracked files *out*); it's for source git itself never tracks.

Re-index (`codegraph index`) after adding or changing `include`.

## Custom file extensions

If your project uses a non-standard extension for a [supported language](/codegraph/reference/languages/) — say `.dota_lua` for Lua, or `.tpl` for PHP — those files are skipped by default, because the extension isn't one CodeGraph recognizes. Map them with an optional `codegraph.json` at your project root:

```json
{
  "extensions": {
    ".dota_lua": "lua",
    ".tpl": "php"
  }
}
```

Each value is a supported language id. The mappings merge on top of the built-in defaults and win on conflict, so you can also re-point a built-in (e.g. `".h": "cpp"`). Commit the file to share the mapping with your team.

A typo'd language or a malformed file is warned about and skipped — it never breaks indexing — and a project with no `codegraph.json` behaves exactly as before. Re-index (`codegraph index`) after adding or changing mappings.

## PHP includes from the web root

PHP code often loads files from the folder the web server serves, as in `require $_SERVER['DOCUMENT_ROOT'] . '/inc/header.php'`. That folder is set in the server's configuration (Apache's `DocumentRoot`, nginx's `root`), not in your code, so CodeGraph works it out from your includes: it's the folder under which their paths name files your project has. With `public/` as the web root, that include links to `public/inc/header.php`.

There's nothing to set when your includes settle it. CodeGraph picks a folder only when they clearly point to it: at least three different paths name files under it, and at least twice as many as under any other folder above the including file. When they don't settle it, or you'd rather say, name the folder as `webRoot` in `codegraph.json`:

```json
{
  "webRoot": "public"
}
```

The folder is relative to the project root, like `"public"`, `"web"` or `"htdocs"`, or `"."` when the project root is the web root, and a `webRoot` you set always wins. With neither, these includes link to nothing rather than to a guess: assuming the project root would link `public/index.php` to a root-level `config.php` instead of the `public/config.php` PHP loads.

A few things to know:

- Includes built from the including file's own folder, like `__DIR__ . '/inc/a.php'` or `dirname(__FILE__) . '/inc/a.php'`, link to their file with no setting, the way a plain `require_once 'lib.php'` does.
- When CodeGraph works the web root out, a project holding two sites gets one for each, and a file outside the folder the server serves (an `includes/` folder beside `public_html/`) gets none. A `webRoot` you set applies to every file.
- An absolute path (the server's own, like `/var/www/html`) or a folder outside the project is warned about and ignored, as if `webRoot` weren't set.
- The next `sync`, or the file watcher, applies a change to `webRoot` or to what your includes show; there's no need to re-index.

## Indexing nested git repositories

CodeGraph respects your `.gitignore`, so a directory you've gitignored stays out of the graph — **including any git repositories nested inside it.** If you keep cloned reference projects, vendored copies, or a folder of unrelated repos in a gitignored directory (a `resource/`, `.repos/`, or `examples/` dir), CodeGraph leaves it untouched: it won't walk in, discover the embedded repos, or index them.

If instead you run a **"super-repo" of independent clones** — a workspace whose own `.gitignore` lists its child repos to keep `git status` quiet, where you genuinely want every child indexed into one graph — opt those directories back in with `includeIgnored`:

```json
{
  "includeIgnored": ["packages/", "services/"]
}
```

Each entry is a gitignore-style pattern naming a gitignored directory whose nested git repositories should be indexed anyway. CodeGraph descends into the directories you list and indexes each embedded repo by its own `git ls-files`, so every child repo's own `.gitignore` is still honored. Directories you don't list stay excluded.

A few things to know:

- **Untracked** nested repositories (ones you haven't gitignored) are indexed automatically — `includeIgnored` is only for the ones your `.gitignore` excludes.
- Built-in skips like `node_modules` are never re-included, even inside an opted-in directory.
- A project without this layout needs no `codegraph.json` at all.

Re-index (`codegraph index`) after adding or changing `includeIgnored`.

## Where data lives

Per-project data lives in a `.codegraph/` directory at your project root, containing the SQLite database (`codegraph.db`). Nothing leaves your machine.
