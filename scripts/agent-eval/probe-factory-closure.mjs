#!/usr/bin/env node
/**
 * CG-27 measurement probe — what a factory-closure file actually delivers.
 *
 * `probe-allocation.mjs` measures how the envelope is split BETWEEN files. This
 * one measures what comes back from WITHIN one file whose top-level symbol spans
 * almost all of it: a `createFoo()` factory returning an object of closures
 * (Svelte 5 rune stores, React hook modules, Zustand `create((set,get)=>({…}))`,
 * IIFE module-pattern JS). The claim under test is a ranking one, not a byte one
 * — CG-30 already bounds the bytes — so the number that matters is WHICH inner
 * symbols reach the agent, not how many chars did.
 *
 * Prints, for the factory file: every line range the response delivered, and for
 * each inner function whether its DEFINITION LINE is inside one of them.
 *
 * Usage (needs a current `npm run build`):
 *   node scripts/agent-eval/probe-factory-closure.mjs
 *   node scripts/agent-eval/probe-factory-closure.mjs --json
 *   node scripts/agent-eval/probe-factory-closure.mjs --query "..."
 */
import { cpSync, mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE = join(REPO_ROOT, '__tests__/fixtures/factory-closure-ts');
const targetAt = process.argv.indexOf('--target');
const TARGET = targetAt >= 0 ? process.argv[targetAt + 1] : 'src/stores/dashboard-store.ts';
const factoryAt = process.argv.indexOf('--factory');
const FACTORY = factoryAt >= 0 ? process.argv[factoryAt + 1] : 'createDashboardStore';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const queryAt = argv.indexOf('--query');
const QUERY = queryAt >= 0
  ? argv[queryAt + 1]
  : 'how does the dashboard store refresh its metrics and apply a filter';

const say = (s = '') => { if (!asJson) console.log(s); };
const num = (n) => Math.round(n).toLocaleString('en-US');

const load = (rel) => import(pathToFileURL(resolve(REPO_ROOT, rel)).href);
if (!existsSync(join(REPO_ROOT, 'dist/index.js'))) {
  console.error('dist/ not built — run `npm run build` first.');
  process.exit(2);
}
const idxMod = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idxMod.default?.default ?? idxMod.default ?? idxMod.CodeGraph;
const ToolHandler = toolsMod.ToolHandler ?? toolsMod.default?.ToolHandler;

const dir = mkdtempSync(join(tmpdir(), 'cg-factory-'));
cpSync(FIXTURE, dir, { recursive: true });
rmSync(join(dir, '.codegraph'), { recursive: true, force: true });

let out;
try {
  let cg = CodeGraph.initSync(dir);
  await cg.indexAll();

  // Inner function definitions, straight from the index — the symbols the file's
  // enclosing factory range would otherwise swallow.
  const nodes = cg.getNodesInFile(TARGET);
  const factory = nodes.find((n) => n.name === FACTORY);
  const inner = nodes
    .filter((n) => (n.kind === 'function' || n.kind === 'method')
      && n.name !== FACTORY
      && factory && n.startLine > factory.startLine && n.endLine <= factory.endLine)
    .sort((a, b) => a.startLine - b.startLine);
  cg.close?.();

  const sidecar = join(dir, 'diag.jsonl');
  process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
  cg = CodeGraph.openSync(dir);
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query: QUERY });
  const text = res.content?.[0]?.text ?? '';
  cg.close?.();
  delete process.env.CODEGRAPH_EXPLORE_DEBUG;
  const report = JSON.parse(readFileSync(sidecar, 'utf8').trim().split('\n').pop());

  // Which source lines of the target file the response actually carries. The
  // response numbers every delivered line `<n>\t<text>`; match them back against
  // the file so a line number that merely appears in prose can't count.
  const source = readFileSync(join(dir, TARGET), 'utf8').split('\n');
  const delivered = new Set();
  for (const line of text.split('\n')) {
    const m = /^(\d+)\t(.*)$/.exec(line);
    if (!m) continue;
    const n = Number(m[1]);
    if (n >= 1 && n <= source.length && source[n - 1] === m[2]) delivered.add(n);
  }
  // Collapse to ranges for display.
  const ranges = [];
  for (const n of [...delivered].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && n === last.end + 1) last.end = n;
    else ranges.push({ start: n, end: n });
  }

  const covered = (n) => delivered.has(n.startLine);
  const rec = report.files.find((f) => f.path === TARGET) ?? null;

  out = {
    query: QUERY,
    target: TARGET,
    fileLines: source.length,
    factory: factory ? { name: factory.name, start: factory.startLine, end: factory.endLine } : null,
    file: rec && {
      rank: rec.rank, render: rec.render, clipped: rec.clipped,
      emittedChars: rec.emittedChars, finalChars: rec.finalChars,
      allowance: rec.allowance, spendable: rec.spendable, skipped: rec.skipped,
    },
    deliveredRanges: ranges,
    deliveredLines: delivered.size,
    inner: inner.map((n) => ({ name: n.name, start: n.startLine, end: n.endLine, delivered: covered(n) })),
    innerDelivered: inner.filter(covered).length,
    innerTotal: inner.length,
    envelope: report.envelope,
    allFiles: report.files
      .filter((f) => f.emittedChars > 0 || f.finalChars > 0)
      .map((f) => ({ rank: f.rank, path: f.path, render: f.render, emitted: f.emittedChars, final: f.finalChars })),
  };
} finally {
  rmSync(dir, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
} else {
  say(`query   "${out.query}"`);
  say(`target  ${out.target} — ${out.fileLines} lines, factory ${out.factory?.name} spans ${out.factory?.start}–${out.factory?.end}`);
  say('');
  say('  #  render      emitted    final  file');
  for (const f of out.allFiles) {
    say(`  ${String(f.rank).padStart(2)}  ${(f.render ?? '-').padEnd(10)}  ${num(f.emitted).padStart(7)}  ${num(f.final).padStart(7)}  ${f.path}`);
  }
  say('');
  say(`delivered lines of ${out.target}: ${out.deliveredLines}`);
  say(`  ranges: ${out.deliveredRanges.map((r) => `${r.start}-${r.end}`).join(', ') || '(none)'}`);
  say('');
  say(`inner symbols whose definition reached the agent: ${out.innerDelivered}/${out.innerTotal}`);
  for (const n of out.inner) {
    say(`  ${n.delivered ? '✓' : '·'}  ${n.name} (${n.start}–${n.end})`);
  }
}
