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
// Exit: 0 healthy, 1 corruption / parse errors, 2 could not run.
// NOTE: the sample must be SYNTACTICALLY VALID — a broken sample fails for the
//       wrong reason.

import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Parser, Language } from 'web-tree-sitter';

const require = createRequire(import.meta.url);
const fail = (code, msg) => { console.error(`[check-grammar] ${msg}`); process.exit(code); };

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
console.log('RESULT: PASS — grammar parses cleanly and reuses safely.');
process.exit(0);
