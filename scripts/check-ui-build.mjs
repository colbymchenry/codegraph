#!/usr/bin/env node
/**
 * Assert that the browser viewer actually built.
 *
 * `codegraph ui` serves dist/viewer/ as static files. If that tree is missing
 * or half-written, the CLI still starts and the browser gets a 404 — a failure
 * that would otherwise surface after the release is published. So the build
 * fails here instead: index.html must exist, be non-trivial, and every local
 * asset it references must be on disk next to it.
 *
 * It also re-asserts that the compiled engine is still there. The viewer build
 * empties its own output directory, and `dist/ui/` — the obvious name — is
 * where tsc puts the TERMINAL ui, so a mis-pointed outDir silently deletes
 * modules the CLI requires at startup.
 *
 * The tree-sitter grammars and their required third-party license notices in
 * dist/extraction/wasm/ are checked the same way
 * and for the same reason. They are copied by `npm run copy-assets`, they are
 * what both indexing and the viewer's syntax classification parse with, and
 * their absence is survivable at runtime — source is served unhighlighted —
 * which is exactly why it has to fail here: nothing downstream would complain.
 *
 * Usage: node scripts/check-ui-build.mjs [--root <dir>]
 *   --root  directory holding dist/ (default: the repo root). The release
 *           bundler points this at its staging dir to verify the copy.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const rootFlag = argv.indexOf('--root');
const staged = rootFlag >= 0 && Boolean(argv[rootFlag + 1]);
const root = staged
  ? resolve(argv[rootFlag + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');

const viewerDir = join(root, 'dist', 'viewer');
const indexHtml = join(viewerDir, 'index.html');

function fail(message, hint) {
  console.error(`[check-ui-build] ${message}`);
  if (hint) console.error(`[check-ui-build] ${hint}`);
  process.exit(1);
}

if (!existsSync(indexHtml)) {
  fail(
    `missing ${indexHtml}`,
    staged
      ? 'this bundle predates the UI or was assembled from a stale archive — rebuild it with scripts/build-bundle.sh'
      : 'the UI workspace did not build — run `npm run build:ui` (or `npm ci` if ui/ has no node_modules)'
  );
}

const html = readFileSync(indexHtml, 'utf8');
if (html.length < 200 || !/<div id="app">/.test(html)) {
  fail(`${indexHtml} does not look like the built viewer (${html.length} bytes)`);
}

// Every local src=/href= in the document must resolve inside dist/ui. This is
// what catches a partial write: index.html naming a hashed bundle that the
// build never emitted.
const referenced = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const local = referenced.filter(
  (url) => !/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url) && !url.startsWith('#')
);

const missing = [];
let assets = 0;
for (const url of local) {
  const rel = url.replace(/^\.\//, '').replace(/[?#].*$/, '');
  if (!rel) continue;
  const onDisk = join(viewerDir, ...rel.split('/'));
  if (!existsSync(onDisk) || !statSync(onDisk).isFile()) missing.push(rel);
  else assets += 1;
}

if (missing.length > 0) {
  fail(
    `index.html references ${missing.length} file(s) that are not in dist/viewer: ${missing.join(', ')}`,
    'the UI build was interrupted or dist/viewer was copied incompletely'
  );
}

if (assets === 0) {
  fail('index.html references no bundled assets — the UI build produced no JS/CSS');
}

// The viewer build must never have eaten the tsc output next door.
for (const compiled of [join('bin', 'codegraph.js'), 'index.js', join('ui', 'shimmer-progress.js')]) {
  if (!existsSync(join(root, 'dist', compiled))) {
    fail(
      `dist/${compiled.split(sep).join('/')} is missing — the compiled engine is incomplete`,
      "if this appeared with a UI change, check ui/vite.config.ts: build.outDir must stay dist/viewer, and emptyOutDir must never point at a directory tsc writes (dist/ui is the TERMINAL ui)"
    );
  }
}

// The vendored tree-sitter grammars (`npm run copy-assets`). The viewer reads
// every file with the same grammar the engine indexed it with, so a missing
// wasm is both an extraction gap and a silently unhighlighted screen.
const wasmDir = join(root, 'dist', 'extraction', 'wasm');

/**
 * The core syntax-classification gate (the CG-57 languages plus the TS family)
 * and Haskell, which has no fallback in the installed grammar dependency.
 * Every one is vendored (see VENDORED_WASM_LANGS), so all of them must be in
 * this directory rather than resolved out of node_modules.
 */
const GATE_GRAMMARS = [
  'tree-sitter-typescript.wasm',
  'tree-sitter-tsx.wasm',
  'tree-sitter-javascript.wasm',
  'tree-sitter-go.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-rust.wasm',
  'tree-sitter-swift.wasm',
  'tree-sitter-c_sharp.wasm',
  'tree-sitter-ruby.wasm',
  'tree-sitter-php.wasm',
  // Haskell is WASM-only, so a staged bundle without this artifact cannot
  // index any .hs file even when the source build was complete.
  'tree-sitter-haskell.wasm',
];

// Haskell's grammar is built directly from upstream rather than copied from
// tree-sitter-wasms. Keep its MIT notice beside the shipped artifact.
const REQUIRED_WASM_LICENSES = ['tree-sitter-haskell.LICENSE'];

if (!existsSync(wasmDir)) {
  fail(
    `missing ${wasmDir}`,
    staged
      ? 'dist/extraction/wasm was not copied into the bundle — re-run scripts/build-bundle.sh'
      : 'run `npm run copy-assets` (it copies src/extraction/wasm/*.wasm into dist/)'
  );
}

// Against the source tree, the source directory IS the list — nothing to drift.
// Inside a staged bundle there is no src/, so the gate list carries it.
const expectedGrammars = new Set(GATE_GRAMMARS);
const srcWasmDir = join(root, 'src', 'extraction', 'wasm');
if (!staged && existsSync(srcWasmDir)) {
  for (const name of readdirSync(srcWasmDir)) {
    if (name.endsWith('.wasm')) expectedGrammars.add(name);
  }
}

const invalidGrammars = [...expectedGrammars].filter((name) => {
  const file = join(wasmDir, name);
  if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size < 10_000) return true;
  const bytes = readFileSync(file);
  return bytes[0] !== 0x00 || bytes[1] !== 0x61 || bytes[2] !== 0x73 || bytes[3] !== 0x6d;
});
if (invalidGrammars.length > 0) {
  fail(
    `dist/extraction/wasm has ${invalidGrammars.length} missing or invalid grammar(s): ${invalidGrammars.join(', ')}`,
    'the copy-assets step was interrupted or dist/extraction/wasm was copied incompletely'
  );
}

const missingLicenses = REQUIRED_WASM_LICENSES.filter(
  (name) => {
    const file = join(wasmDir, name);
    return !existsSync(file) || !statSync(file).isFile() || statSync(file).size === 0;
  }
);
if (missingLicenses.length > 0) {
  fail(
    `dist/extraction/wasm is missing ${missingLicenses.length} required license notice(s): ${missingLicenses.join(', ')}`,
    'the copy-assets step was interrupted or the staged bundle omitted a third-party license'
  );
}

const grammarCount = readdirSync(wasmDir).filter((n) => n.endsWith('.wasm')).length;

console.log(
  `[check-ui-build] dist/viewer ok (index.html + ${assets} referenced asset(s)); ` +
    `dist/extraction/wasm ok (${grammarCount} grammars + ${REQUIRED_WASM_LICENSES.length} required license notice(s)); dist/ engine intact`
);
