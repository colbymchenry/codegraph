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
// The grammar runs the way indexing runs it, in a child process:
//   - with indexing's V8 flags (WASM_RUNTIME_FLAGS in
//     src/extraction/wasm-runtime-flags.ts), so V8 compiles it as it would there;
//   - next to every grammar codegraph vendors, like a polyglot index;
//   - parsing the sample with one reused parser, walking every node of each tree
//     and freeing it, as extraction does; every parse must give the same tree;
//   - then once more at the largest file indexing reads (the sample repeated to
//     1 MiB, MAX_SOURCE_FILE_SIZE_BYTES in src/file-limits.ts), with the time
//     indexing gives one file.
// This process prints the verdict only after that child has exited. A grammar
// can finish every parse and still take the process down, as when V8 aborts it
// from a background compile job ("Fatal process out of memory: Zone"), or hang;
// either one is a FAIL (#2464).
//
// Usage: node scripts/add-lang/check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]
// Exit: 0 healthy; 1 parse errors, corruption, or the check process crashed or
//       hung; 2 could not run.
// CODEGRAPH_CHECK_GRAMMAR_TIMEOUT_MS: how long the child may run (default 120000).
// NOTE: the sample must be SYNTACTICALLY VALID — a broken sample fails for the
//       wrong reason.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SCRIPT = fileURLToPath(import.meta.url);
const VENDORED_DIR = path.resolve(path.dirname(SCRIPT), '../../src/extraction/wasm');
// Indexing's V8 flags. Keep in step with WASM_RUNTIME_FLAGS:
// __tests__/add-lang-check-grammar.test.ts fails when the child lacks one.
const INDEXING_WASM_FLAGS = ['--liftoff-only'];
// The most indexing reads from one file (MAX_SOURCE_FILE_SIZE_BYTES), and how
// long it gives one file to parse (DEFAULT_PARSE_TIMEOUT_MS in parse-pool.ts).
const MAX_FILE_BYTES = 1024 * 1024;
const FILE_BUDGET_MS = 10_000;
const CHILD_ENV = 'CODEGRAPH_CHECK_GRAMMAR_CHILD';
const RESULT_TAG = 'CHECK_GRAMMAR_RESULT ';
const DEFAULT_TIMEOUT_MS = 120_000;
const SPECIAL = { csharp: 'c_sharp', 'c#': 'c_sharp' };

const fail = (code, msg) => { console.error(`[check-grammar] ${msg}`); process.exit(code); };
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

function resolveWasm(t) {
  if (t.endsWith('.wasm')) return existsSync(t) ? path.resolve(t) : fail(2, `wasm not found: ${t}`);
  const base = SPECIAL[t.toLowerCase()] ?? t.toLowerCase();
  try { return require.resolve(`tree-sitter-wasms/out/tree-sitter-${base}.wasm`); } catch { /* try vendored */ }
  const vendored = path.join(VENDORED_DIR, `tree-sitter-${base}.wasm`);
  if (existsSync(vendored)) return vendored;
  return fail(2, `no grammar for "${t}" — not in tree-sitter-wasms and not vendored`);
}

/** The parent: run the grammar in a child process, then judge how it ended. */
function judge([token, sample, iterArg]) {
  if (!token || !sample) fail(2, 'usage: check-grammar.mjs <lang|wasm-path> <valid-sample> [iterations]');
  if (!existsSync(sample)) fail(2, `sample not found: ${sample}`);
  const iters = iterArg === undefined ? 20 : Number(iterArg);
  if (!Number.isInteger(iters) || iters < 1) fail(2, `iterations must be a whole number above 0, not "${iterArg}"`);
  const wasmPath = resolveWasm(token);
  const timeoutMs = Number(process.env.CODEGRAPH_CHECK_GRAMMAR_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  const run = spawnSync(process.execPath, [...INDEXING_WASM_FLAGS, SCRIPT, wasmPath, path.resolve(sample), String(iters)], {
    env: { ...process.env, [CHILD_ENV]: '1' },
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  const timedOut = run.error?.code === 'ETIMEDOUT';
  if (run.error && !timedOut) fail(2, `could not run the check: ${run.error.message}`);

  const lines = (run.stdout ?? '').split(/\r?\n/);
  const tagged = lines.find((line) => line.startsWith(RESULT_TAG));
  const result = tagged ? JSON.parse(tagged.slice(RESULT_TAG.length)) : null;
  const passthrough = lines.filter((line) => !line.startsWith(RESULT_TAG)).join('\n').trim();
  if (passthrough) console.log(passthrough);
  if (run.stderr) process.stderr.write(run.stderr.endsWith('\n') ? run.stderr : `${run.stderr}\n`);
  if (run.status === 2 && !result) { process.exitCode = 2; return; } // the child said why it could not run

  console.log(`grammar: ${path.basename(wasmPath)}`);
  if (result) {
    console.log(`  ABI version: ${result.abi}`);
    console.log(`  runtime: node ${[result.node, ...result.execArgv].join(' ')}, with ${result.companions} other grammars loaded`);
    console.log(`  parses: ${result.clean} clean / ${result.errors} with errors (of ${result.iters})`);
    if (result.large) {
      const { copies, bytes, nodes, ms } = result.large;
      console.log(nodes === null
        ? `  largest file: the sample ${copies}x (${bytes} bytes) was still parsing after ${FILE_BUDGET_MS / 1000} s, ` +
          'as long as indexing gives one file, and was stopped (not judged)'
        : `  largest file: the sample ${copies}x (${bytes} bytes, ${nodes} nodes) in ${ms} ms`);
    }
  }

  const [code, verdict] = verdictFor(run, result, timedOut, timeoutMs);
  console.log(verdict);
  process.exitCode = code;
}

function verdictFor(run, result, timedOut, timeoutMs) {
  const seconds = Math.round(timeoutMs / 1000);
  const finishedAnyway = 'Finishing the parses is not the same as being safe to use: indexing would ' +
    'go down the same way. Do not vendor this wasm.';
  if (timedOut) {
    return [1, result
      ? `RESULT: FAIL — the parses finished, but the process running them had not exited after ${seconds} s ` +
        `and was stopped. ${finishedAnyway}`
      : `RESULT: FAIL — the parses had not finished after ${seconds} s, so the process running them was stopped: ` +
        'the grammar hangs, or is far too slow, on this sample. Do not vendor this wasm.'];
  }
  if (run.status !== 0 || !result) {
    return [1, result
      ? `RESULT: FAIL — the parses finished, but the process running them then died (${describeEnd(run)}). ${finishedAnyway}`
      : `RESULT: FAIL — the process running the parses died (${describeEnd(run)}) before they finished. ` +
        'Indexing would go down the same way. Do not vendor this wasm.'];
  }
  if (result.errors > 0) {
    return [1, `RESULT: FAIL — ${result.errors}/${result.iters} parses produced ERROR trees on a valid sample. ` +
      'This grammar corrupts under web-tree-sitter; vendor a newer (ABI 14/15) wasm ' +
      '(see SKILL.md "Find a grammar"). Confirm your sample is syntactically valid first.'];
  }
  if (result.diverged > 0) {
    return [1, `RESULT: FAIL — ${result.diverged}/${result.iters - 1} later parses of the same sample gave a ` +
      'different tree than the first. This grammar corrupts under web-tree-sitter; vendor a newer ' +
      '(ABI 14/15) wasm (see SKILL.md "Find a grammar").'];
  }
  return [0, 'RESULT: PASS — grammar parses cleanly and reuses safely, and the process running it exited cleanly.'];
}

function describeEnd(run) {
  if (run.signal) return `signal ${run.signal}`;
  const code = run.status;
  return code > 255 ? `exit code ${code}, 0x${(code >>> 0).toString(16).toUpperCase()}` : `exit code ${code}`;
}

/** The child: load and exercise the grammar the way indexing does, then report. */
async function runGrammar(wasmPath, samplePath, itersArg) {
  const iters = Number(itersArg);
  const { Parser, Language } = await import('web-tree-sitter');
  try { await Parser.init(); }
  catch { await Parser.init({ locateFile: () => require.resolve('web-tree-sitter/tree-sitter.wasm') }); }

  // The other grammars an index loads beside this one: the corruption surfaces
  // under the multi-grammar runtime that real indexing uses, not a single
  // grammar in isolation.
  let companions = 0;
  for (const file of readdirSync(VENDORED_DIR).filter((f) => f.endsWith('.wasm')).sort()) {
    const companion = path.join(VENDORED_DIR, file);
    if (samePath(companion, wasmPath)) continue;
    try { await Language.load(companion); companions++; } catch { /* not the grammar under test */ }
  }

  let language;
  try { language = await Language.load(wasmPath); }
  catch (e) {
    // No process.exit: on Windows a pipe write can still be pending.
    console.error(`[check-grammar] failed to load ${wasmPath}: ${e.message}`);
    process.exitCode = 2;
    return;
  }

  const parser = new Parser();
  parser.setLanguage(language);
  const source = readFileSync(samplePath, 'utf8');

  let clean = 0, errors = 0, diverged = 0, first = null;
  for (let i = 0; i < iters; i++) {
    const tree = parser.parse(source);
    if (!tree) throw new Error('the parser returned no tree');
    const shape = walk(tree);
    if (tree.rootNode.hasError) errors++; else clean++;
    if (!first) first = shape;
    else if (shape.nodes !== first.nodes || shape.hash !== first.hash) diverged++;
    tree.delete();
  }

  // The largest file indexing reads, with the time indexing gives one file,
  // unless the grammar has already failed. Repeating a sample can make code the
  // language rejects, and recovering from that can be slow, so here only a
  // crash or a hang counts.
  let large = null;
  if (errors === 0 && diverged === 0) {
    const copies = Math.max(1, Math.floor(MAX_FILE_BYTES / (Buffer.byteLength(source) + 1)));
    const big = Array(copies).fill(source).join('\n');
    const started = performance.now();
    const bigTree = parser.parse(big, null, { progressCallback: () => performance.now() - started > FILE_BUDGET_MS });
    large = { copies, bytes: Buffer.byteLength(big), nodes: bigTree ? walk(bigTree).nodes : null, ms: Math.round(performance.now() - started) };
    bigTree?.delete();
  }
  parser.delete();

  console.log(RESULT_TAG + JSON.stringify({
    abi: language.abiVersion, iters, clean, errors, diverged, companions, large,
    node: process.version, execArgv: process.execArgv,
  }));
}

/** Visit every node, as extraction does; returns the tree's size and a hash of its shape. */
function walk(tree) {
  const cursor = tree.walk();
  let nodes = 0, hash = 2166136261;
  const mix = (value) => { hash = Math.imul(hash ^ value, 16777619) >>> 0; };
  for (;;) {
    nodes++;
    mix(cursor.nodeTypeId); mix(cursor.currentFieldId); mix(cursor.startIndex); mix(cursor.endIndex);
    if (cursor.gotoFirstChild()) continue;
    while (!cursor.gotoNextSibling()) {
      if (!cursor.gotoParent()) { cursor.delete(); return { nodes, hash }; }
    }
  }
}

if (process.env[CHILD_ENV] === '1') await runGrammar(...process.argv.slice(2));
else judge(process.argv.slice(2));
