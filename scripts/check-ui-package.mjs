#!/usr/bin/env node
/**
 * Finish and verify the `@colbymchenry/codegraph-ui` build (task CG-61).
 *
 * `svelte-package` compiles the whole of `ui/src`, which is the right input —
 * the components a host imports and the ones `codegraph ui` renders are the
 * same files, and splitting them into two trees is how the two screens start
 * to drift. But it means the emitted `dist/` also carries the standalone app's
 * shell, and one of those files is a hazard rather than dead weight:
 * `lib/router.svelte.js` attaches `hashchange`/`popstate` listeners at module
 * scope. A host must never inherit a hash router just by rendering a Symbol
 * view. So this script does three jobs, in order:
 *
 *   1. PRUNE the app-only files from the package.
 *   2. RESOLVE the extensionless relative specifiers `svelte-package` leaves
 *      behind, so the package works under Node's own ESM resolution and under
 *      a consumer on `moduleResolution: node16`, not only inside a bundler.
 *   3. ASSERT the result: the entry, the theme, every path in `exports`, the
 *      five named components, and — the one that matters most — that nothing
 *      outside `lib/adapter.js` talks to the network. The whole point of the
 *      package is that a host's own adapter is the only way data arrives; a
 *      stray `fetch` anywhere else is a screen that ignores it.
 *
 * Run by `npm run build:lib -w ui`. Exits non-zero on any failure.
 */

import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const UI = fileURLToPath(new URL('../ui', import.meta.url));
const DIST = join(UI, 'dist');

/**
 * The standalone viewer's shell — everything that is only reachable from
 * `main.ts`. Listed by hand rather than derived, because getting it wrong in
 * the derived direction (pruning something a component needs) is silent until
 * a host imports it.
 */
const APP_ONLY = [
  'main.js',
  'main.d.ts',
  'App.svelte',
  'App.svelte.d.ts',
  'app.css',
  'components/TopBar.svelte',
  'components/TopBar.svelte.d.ts',
  'lib/router.svelte.js',
  'lib/router.svelte.d.ts',
];

/** Extensions that already resolve; anything else is rewritten to `<spec>.js`. */
const RESOLVES = ['.js', '.mjs', '.cjs', '.json', '.css', '.svg', '.png'];

const fail = (message) => {
  console.error(`[check-ui-package] ${message}`);
  process.exitCode = 1;
};

if (!existsSync(DIST)) {
  fail(`no ${relative(UI, DIST)} — run \`npm run build:lib -w ui\``);
  process.exit(1);
}

/* ------------------------------------------------------------------ 1. prune */

for (const entry of APP_ONLY) {
  const path = join(DIST, entry);
  if (existsSync(path)) rmSync(path, { recursive: true });
}

/* ------------------------------------------------------------------ walk it */

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* files(path);
    else yield path;
  }
}

const all = [...files(DIST)];

/* ---------------------------------------------------------------- 2. resolve */

/**
 * `from './lib/adapter'` -> `from './lib/adapter.js'`, and
 * `from './lib/trail.svelte'` -> `from './lib/trail.svelte.js'` (the emitted
 * file for a `.svelte.ts` rune module).
 *
 * Driven by the filesystem rather than by the extension alone: `.svelte` is a
 * real file for a component and a compiled `.js` for a rune module, and only
 * looking is right for both.
 */
function resolveSpecifiers(source, fromFile) {
  return source.replace(
    /(\bfrom\s*|\bimport\s*\(\s*)(['"])(\.[^'"]*)\2/g,
    (match, head, quote, spec) => {
      if (RESOLVES.some((ext) => spec.endsWith(ext))) return match;
      const target = resolve(dirname(fromFile), spec);
      if (existsSync(target) && statSync(target).isFile()) return match;
      if (!existsSync(`${target}.js`)) return match;
      return `${head}${quote}${spec}.js${quote}`;
    }
  );
}

let rewritten = 0;
for (const path of all) {
  if (!/\.(js|d\.ts|svelte)$/.test(path)) continue;
  const before = readFileSync(path, 'utf8');
  const after = resolveSpecifiers(before, path);
  if (after !== before) {
    writeFileSync(path, after);
    rewritten += 1;
  }
}

/* ----------------------------------------------------------------- 3. assert */

const manifest = JSON.parse(readFileSync(join(UI, 'package.json'), 'utf8'));

// Every path the exports map promises has to be there. A missing one is a
// package that installs cleanly and then fails at the consumer's first import.
for (const [name, entry] of Object.entries(manifest.exports ?? {})) {
  const targets = typeof entry === 'string' ? [entry] : Object.values(entry);
  for (const target of targets) {
    if (!target.startsWith('./')) continue;
    if (!existsSync(join(UI, target))) fail(`exports["${name}"] -> ${target} is missing`);
  }
}

// The exported screens, plus the two seams they are useless
// without. Checked in the emitted JS, so a rename in index.ts that misses a
// component fails here rather than in the Pro app.
const entry = existsSync(join(DIST, 'index.js'))
  ? readFileSync(join(DIST, 'index.js'), 'utf8')
  : '';
for (const name of [
  'SymbolView',
  'TypeHierarchy',
  'FlowStrip',
  'ArchitectureMap',
  'DeadCodeView',
  'TrailBar',
  'SavedTrails',
  'SearchPalette',
  'CodegraphUi',
  'setGraphAdapter',
  'createHttpAdapter',
  'setNavigationDriver',
]) {
  if (!new RegExp(`\\b${name}\\b`).test(entry)) fail(`dist/index.js does not export ${name}`);
}

// Nothing the app dragged in survives. A component still importing one of the
// pruned modules would resolve to nothing in a host.
for (const path of all) {
  if (!existsSync(path)) continue;
  const text = readFileSync(path, 'utf8');
  for (const pruned of ['router.svelte', 'TopBar.svelte', 'app.css']) {
    const importing = new RegExp(`(from|import\\()\\s*['"][^'"]*${pruned}`);
    if (importing.test(text)) {
      fail(`${relative(DIST, path)} still imports ${pruned}, which is app-only`);
    }
  }
}

// The data seam. `lib/adapter.js` is the ONE place that may reach the network;
// anywhere else means a screen that ignores the host's adapter.
for (const path of all) {
  if (!existsSync(path) || !path.endsWith('.js')) continue;
  if (path.endsWith(join('lib', 'adapter.js'))) continue;
  const text = readFileSync(path, 'utf8')
    // Comments talk about `fetch` and `EventSource` on purpose; only code counts.
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '');
  if (/\bnew EventSource\b|\bfetch\s*\(/.test(text)) {
    fail(`${relative(DIST, path)} reaches the network directly — it must go through the adapter`);
  }
}

if (process.exitCode) {
  console.error('[check-ui-package] FAILED');
  process.exit(1);
}

const count = [...files(DIST)].length;
console.log(
  `[check-ui-package] ok — ${count} files, ${rewritten} rewritten, ` +
    `${APP_ONLY.length} app-only pruned (v${manifest.version})`
);
