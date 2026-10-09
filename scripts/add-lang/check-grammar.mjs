#!/usr/bin/env node
// Verify a tree-sitter grammar wasm is HEALTHY under the project's web-tree-sitter
// runtime BEFORE writing an extractor. Prints the ABI version and parses a valid
// sample many times in a multi-grammar context, to catch heap-corruption bugs
// that silently drop nodes on every parse after the first.
//
// Why this exists: the tree-sitter-wasms Lua grammar is ABI 13 and corrupts the
// shared WASM heap under web-tree-sitter 0.25 — Lua extraction degraded on every
// file after the first (nested calls/imports vanished). The fix was to vendor the
// upstream ABI-15 wasm. Run this on any new grammar first; if it FAILs, vendor a
// newer build instead of using the tree-sitter-wasms one.
//
// Usage: node scripts/add-lang/check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]
// Exit: 0 healthy, 1 corruption / parse errors / crashed, 2 could not run.
// NOTE: the sample must be SYNTACTICALLY VALID — a broken sample fails for the
//       wrong reason.

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const fail = (code, msg) => { console.error(`[check-grammar] ${msg}`); process.exit(code); };

// The parse loop runs in a child process and the parent owns the verdict: a
// grammar can finish every parse and then take the process down (e.g. a V8
// "Fatal process out of memory: Zone" while compiling the wasm), so PASS is only
// printed once the child has actually exited cleanly.
if (!process.env.CHECK_GRAMMAR_CHILD) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, CHECK_GRAMMAR_CHILD: '1' },
  });
  if (r.error) fail(2, `could not start the check: ${r.error.message}`);
  if (r.status === 0) {
    console.log('RESULT: PASS — grammar parses cleanly, reuses safely, and the process exited cleanly.');
    process.exit(0);
  }
  if (r.status === 1 || r.status === 2) process.exit(r.status); // child already explained
  console.log(
    `RESULT: FAIL — the check process died (${r.signal ? `signal ${r.signal}` : `exit code ${r.status}`}) ` +
    `after or during the parse loop. Completing the parses is not the same as being safe to use; ` +
    `do not vendor this grammar.`
  );
  process.exit(1);
}

const [token, sample, iterArg] = process.argv.slice(2);
if (!token || !sample) fail(2, 'usage: check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]');
if (!existsSync(sample)) fail(2, `sample not found: ${sample}`);
const iters = iterArg ? parseInt(iterArg, 10) : 20;

const SPECIAL = { csharp: 'c_sharp', 'c#': 'c_sharp' };
function resolveWasm(t) {
  if (t.endsWith('.wasm')) return existsSync(t) ? t : fail(2, `wasm not found: ${t}`);
  const base = SPECIAL[t.toLowerCase()] ?? t.toLowerCase();
  try { return require.resolve(`tree-sitter-wasms/out/tree-sitter-${base}.wasm`); } catch { /* try vendored */ }
  const vendored = `src/extraction/wasm/tree-sitter-${base}.wasm`;
  if (existsSync(vendored)) return vendored;
  return fail(2, `no grammar for "${t}" — not in tree-sitter-wasms and not vendored`);
}

const wasmPath = resolveWasm(token);
const source = readFileSync(sample, 'utf8');

try { await Parser.init(); }
catch { await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') }); }

// Load a second, known-good grammar — the corruption surfaces under the
// multi-grammar runtime that real indexing uses, not a single grammar in isolation.
try { await Language.load(require.resolve('tree-sitter-wasms/out/tree-sitter-python.wasm')); } catch { /* ok */ }

let language;
try { language = await Language.load(wasmPath); }
catch (e) { fail(2, `failed to load ${wasmPath}: ${e.message}`); }

const parser = new Parser();
parser.setLanguage(language);

let ok = 0, err = 0;
for (let i = 0; i < iters; i++) {
  const tree = parser.parse(source);
  if (tree.rootNode.hasError) err++; else ok++;
  tree.delete();
}

console.log(`grammar: ${wasmPath.split('/').pop()}`);
console.log(`  ABI version: ${language.abiVersion}`);
console.log(`  parses: ${ok} clean / ${err} with errors (of ${iters})`);
if (err > 0) {
  console.log(
    `RESULT: FAIL — ${err}/${iters} parses produced ERROR trees on a valid sample. ` +
    `This grammar corrupts under web-tree-sitter; vendor a newer (ABI 14/15) wasm ` +
    `(see SKILL.md "Find a grammar"). Confirm your sample is syntactically valid first.`
  );
  process.exit(1);
}
process.exit(0); // the parent prints PASS only after this process exits cleanly
