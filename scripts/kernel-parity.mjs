#!/usr/bin/env node
/**
 * Kernel↔wasm extraction parity harness (R2/R3 of the kernel migration).
 *
 * Runs BOTH extraction paths over the given files/directories and diffs the
 * per-file ExtractionResults as sets (nodes/edges/refs, canonicalized), so a
 * behavioral gap in the native kernel shows up as a categorized diff instead
 * of a graph-dump surprise later. This is the fast inner loop; the §5 gate's
 * full-repo dump-diff still runs before any default-on.
 *
 * Usage:
 *   node scripts/kernel-parity.mjs <file-or-dir>... [--lang typescript,tsx]
 *        [--max-samples N] [--list-files] [--max-deferral 0.1]
 *
 * --max-deferral: the broken-kernel backstop (default 0.1). For C/C++ pass
 * 0.5: macro-heavy C/C++ trees genuinely parse with errors at 10–40% file
 * rates even after the preParse blanking family (git 19%, protobuf 26%, fmt
 * 42% — measured 2026-07-17), and every erroring file defers BY POLICY, so
 * the 10% bar calibrated on the 0–0.4% incidence of ts/java/py/go would fail
 * healthy sweeps. A broken walker still trips 0.5 (it defers ~everything).
 *
 * Requires: npm run build (dist/) and a staged kernel (npm run build:kernel).
 * Exit code: 0 = parity, 1 = diffs found, 2 = setup error.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = (p) => path.join(ROOT, 'dist', p);

const args = process.argv.slice(2);
const paths = [];
let langFilter = null;
let maxSamples = 5;
let listFiles = false;
let maxDeferral = 0.1;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--lang') langFilter = new Set(args[++i].split(','));
  else if (args[i] === '--max-samples') maxSamples = Number(args[++i]);
  else if (args[i] === '--list-files') listFiles = true;
  else if (args[i] === '--max-deferral') maxDeferral = Number(args[++i]);
  else paths.push(args[i]);
}
if (paths.length === 0) {
  console.error('usage: kernel-parity.mjs <file-or-dir>... [--lang ts,tsx] [--max-samples N]');
  process.exit(2);
}

const KERNEL_LANGS = new Set(['typescript', 'tsx', 'javascript', 'jsx', 'java', 'python', 'go', 'c', 'cpp', 'rust']);
const EXTS = new Map([
  ['.ts', 'typescript'], ['.mts', 'typescript'], ['.cts', 'typescript'],
  ['.tsx', 'tsx'], ['.js', 'javascript'], ['.mjs', 'javascript'],
  ['.cjs', 'javascript'], ['.jsx', 'jsx'], ['.java', 'java'], ['.py', 'python'], ['.pyw', 'python'], ['.go', 'go'],
  // C/C++ (R7a). `.h` needs CONTENT sniffing (C vs C++) — resolved per file
  // in the run loop via detectLanguage, matching the real indexer's routing.
  ['.c', 'c'], ['.h', 'detect'],
  ['.cpp', 'cpp'], ['.cc', 'cpp'], ['.cxx', 'cpp'], ['.hpp', 'cpp'], ['.hxx', 'cpp'],
  ['.metal', 'cpp'], ['.cu', 'cpp'], ['.cuh', 'cpp'],
  ['.rs', 'rust'], // R7b
]);

/** Collect candidate files. */
function collect(p, out) {
  let st;
  try {
    st = fs.statSync(p); // dangling symlinks (Linux-tree dtc fixtures) throw
  } catch {
    return;
  }
  if (st.isDirectory()) {
    const base = path.basename(p);
    if (base === 'node_modules' || base === '.git' || base === 'dist' || base === '.codegraph') return;
    for (const e of fs.readdirSync(p)) collect(path.join(p, e), out);
  } else if (EXTS.has(path.extname(p))) {
    const lang = EXTS.get(path.extname(p));
    // 'detect' (.h) resolves per file in the run loop; under --lang it rides
    // along whenever either C-family language is requested.
    const passes =
      !langFilter ||
      (lang === 'detect' ? langFilter.has('c') || langFilter.has('cpp') : langFilter.has(lang));
    if (passes) out.push({ file: p, lang });
  }
}

const files = [];
for (const p of paths) collect(path.resolve(p), files);
if (files.length === 0) {
  console.error('no matching files');
  process.exit(2);
}

// --- load the built engine ---------------------------------------------------
const { extractFromSource } = await import(dist('extraction/tree-sitter.js'));
const { initGrammars, loadGrammarsForLanguages, detectLanguage } = await import(dist('extraction/grammars.js'));
const kernel = await import(dist('extraction/kernel/index.js'));

await initGrammars();
await loadGrammarsForLanguages([...KERNEL_LANGS]);

if (!kernel.getKernel()) {
  console.error('kernel .node not found — run: npm run build:kernel');
  process.exit(2);
}

// --- canonicalization ---------------------------------------------------------
/**
 * Node identity for cross-referencing edges/refs: the node id itself (both
 * paths compute the same deterministic ids, and id embeds kind+name+line).
 */
function canonNode(n) {
  const out = {
    id: n.id, kind: n.kind, name: n.name, qualifiedName: n.qualifiedName,
    filePath: n.filePath, language: n.language,
    startLine: n.startLine, endLine: n.endLine,
    startColumn: n.startColumn, endColumn: n.endColumn,
  };
  for (const k of ['docstring', 'signature', 'visibility', 'isExported', 'isAsync', 'isStatic', 'isAbstract', 'returnType']) {
    if (n[k] !== undefined) out[k] = n[k];
  }
  if (n.decorators !== undefined) out.decorators = n.decorators;
  if (n.typeParameters !== undefined) out.typeParameters = n.typeParameters;
  return JSON.stringify(out);
}

function canonEdge(e) {
  const out = { source: e.source, target: e.target, kind: e.kind };
  if (e.line !== undefined) out.line = e.line;
  if (e.column !== undefined) out.column = e.column;
  if (e.provenance !== undefined) out.provenance = e.provenance;
  if (e.metadata !== undefined) out.metadata = e.metadata;
  return JSON.stringify(out);
}

function canonRef(r) {
  // FULL object — a field only one path sets is a parity bug (the vitest
  // parity suite caught decode.ts pre-filling filePath/language this way).
  const out = {
    from: r.fromNodeId, name: r.referenceName, kind: r.referenceKind,
    line: r.line, column: r.column,
  };
  for (const k of ['filePath', 'language', 'candidates', 'rowId']) {
    if (r[k] !== undefined) out[k] = r[k];
  }
  return JSON.stringify(out);
}

function diffSets(aList, bList) {
  const a = new Map(); // canon -> count (multiset — duplicates matter)
  const b = new Map();
  for (const x of aList) a.set(x, (a.get(x) ?? 0) + 1);
  for (const x of bList) b.set(x, (b.get(x) ?? 0) + 1);
  const onlyA = [];
  const onlyB = [];
  for (const [k, c] of a) {
    const d = c - (b.get(k) ?? 0);
    for (let i = 0; i < d; i++) onlyA.push(k);
  }
  for (const [k, c] of b) {
    const d = c - (a.get(k) ?? 0);
    for (let i = 0; i < d; i++) onlyB.push(k);
  }
  return { onlyA, onlyB };
}

// --- run ----------------------------------------------------------------------
const buckets = new Map(); // category -> {count, samples[]}
function report(category, sample) {
  let b = buckets.get(category);
  if (!b) buckets.set(category, (b = { count: 0, samples: [] }));
  b.count++;
  if (b.samples.length < maxSamples) b.samples.push(sample);
}

let filesWithDiffs = 0;
let filesOk = 0;
let deferred = 0;
let processed = 0; // collected files minus content-detect skips
let totals = { nodes: 0, edges: 0, refs: 0 };

process.env.CODEGRAPH_KERNEL_LANGS = 'all';

for (const { file, lang: extLang } of files) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  // `.h` resolves C vs C++ by content — the same call the indexer makes.
  const lang = extLang === 'detect' ? detectLanguage(rel, source) : extLang;
  if (!KERNEL_LANGS.has(lang)) continue;
  if (langFilter && !langFilter.has(lang)) continue;
  processed++;

  delete process.env.CODEGRAPH_KERNEL; // kernel path on
  const kres = kernel.tryKernelExtract(rel, source, lang);
  if (!kres) {
    // Expected: files with parse errors defer to wasm (parity by
    // construction — both arms run the same extractor). Counted, and
    // guarded below so a broken kernel can't silently defer everything.
    deferred++;
    report('kernel-deferred', rel);
    continue;
  }
  process.env.CODEGRAPH_KERNEL = '0'; // wasm path
  const wres = extractFromSource(rel, source, lang);
  delete process.env.CODEGRAPH_KERNEL;

  totals.nodes += wres.nodes.length;
  totals.edges += wres.edges.length;
  totals.refs += wres.unresolvedReferences.length;

  let fileHasDiff = false;
  const tables = [
    ['node', wres.nodes.map(canonNode), kres.nodes.map(canonNode)],
    ['edge', wres.edges.map(canonEdge), kres.edges.map(canonEdge)],
    ['ref', wres.unresolvedReferences.map(canonRef), kres.unresolvedReferences.map(canonRef)],
  ];
  for (const [table, wasm, kern] of tables) {
    const { onlyA, onlyB } = diffSets(wasm, kern);
    for (const x of onlyA) {
      fileHasDiff = true;
      const o = JSON.parse(x);
      report(`${table}:missing-in-kernel:${o.kind ?? ''}`, `${rel}: ${x}`);
    }
    for (const x of onlyB) {
      fileHasDiff = true;
      const o = JSON.parse(x);
      report(`${table}:extra-in-kernel:${o.kind ?? ''}`, `${rel}: ${x}`);
    }
    // ORDER matters too: identical multisets in a different emission order
    // change DB rowids, and resolution iterates refs in rowid order — the
    // full-index dump-diff would surface it as a downstream mystery. Catch it
    // here instead.
    if (onlyA.length === 0 && onlyB.length === 0) {
      for (let i = 0; i < wasm.length; i++) {
        if (wasm[i] !== kern[i]) {
          fileHasDiff = true;
          report(`${table}:order-mismatch`, `${rel}: index ${i}: wasm=${wasm[i]} kernel=${kern[i]}`);
          break;
        }
      }
    }
  }
  if (fileHasDiff) {
    filesWithDiffs++;
    if (listFiles) console.log(`DIFF ${rel}`);
  } else {
    filesOk++;
  }
}

console.log(`\n=== kernel parity: ${filesOk}/${processed} files byte-parity` +
  ` (${filesWithDiffs} with diffs, ${deferred} deferred-to-wasm)` +
  ` | wasm totals: ${totals.nodes} nodes / ${totals.edges} edges / ${totals.refs} refs ===\n`);

const sorted = [...buckets.entries()].sort((a, b) => b[1].count - a[1].count);
for (const [cat, { count, samples }] of sorted) {
  console.log(`--- ${cat}: ${count}`);
  for (const s of samples) console.log(`    ${s.length > 400 ? s.slice(0, 400) + '…' : s}`);
}

// Deferrals are per-file parse-error routing (expected; rare for most
// languages, routine for macro-heavy C/C++ — see --max-deferral above). A
// rate past the threshold means the kernel is broken and hiding behind the
// fallback — fail loudly.
const deferralRate = deferred / Math.max(processed, 1);
if (deferralRate > maxDeferral) {
  console.error(
    `deferral rate ${(deferralRate * 100).toFixed(1)}% exceeds ${(maxDeferral * 100).toFixed(0)}% — kernel likely broken`
  );
  process.exit(1);
}
process.exit(filesWithDiffs > 0 ? 1 : 0);
