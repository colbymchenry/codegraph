#!/usr/bin/env node
/**
 * "Did the symbol the agent NAMED actually render?" (CG-38).
 *
 * This is the measurement the whole CG-24 epic was missing. Every other probe
 * here scores the response in AGGREGATE — `probe-suite-envelope.mjs` measures how
 * much source came back, `probe-file-spend.mjs` measures whether the bytes went
 * to the files that earned them, `probe-allocation.mjs` measures group shares.
 * All three are green on a response that returns 25K of source from the right
 * file and still omits the one function the agent asked for by name. That is
 * exactly what CG-38 was: `queueMessage` at L1087 of a 1,414-line file, whose
 * file won rank #1 with 67% of the envelope, never rendered — the agent got a
 * same-stem `QueuedMessage` INTERFACE at L70 instead and had to Read the file.
 *
 * So the assertion here is per-SYMBOL and binary: for each named symbol, does its
 * definition line appear in the rendered source? Nothing else can substitute —
 * not the file being present, not its share, not its byte count.
 *
 * Usage (needs a current `npm run build`):
 *   node scripts/agent-eval/probe-named-symbol.mjs
 *   node scripts/agent-eval/probe-named-symbol.mjs --verbose
 *   # any indexed repo, ad hoc:
 *   node scripts/agent-eval/probe-named-symbol.mjs <repo> "<query>" sym1 sym2
 *
 * Exit code is 1 when any expected symbol is missing, so this can gate.
 */
import { cpSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');

const load = async (rel) => import(pathToFileURL(resolve(REPO, rel)).href);
const idxMod = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idxMod.default?.default ?? idxMod.default ?? idxMod.CodeGraph;
const { ToolHandler } = toolsMod;

/**
 * The fixture cases. `symbols` are what the agent names; each must come back with
 * its DEFINITION rendered. The queries deliberately cover both shapes the bug was
 * reported on — a bare symbol bag and a prose question — because the failure had
 * a different cause on each and a fix for one does not imply the other.
 */
const FIXTURE = '__tests__/fixtures/tail-render-ts';
const CASES = [
  {
    id: 'tail-symbol-bag',
    why: 'two sibling closures past L1000, named directly; neither calls the other',
    query: 'queueMessage flushQueuedMessages',
    symbols: ['queueMessage', 'flushQueuedMessages'],
  },
  {
    id: 'tail-prose',
    why: 'same two symbols named inside a prose question',
    query: 'how does queueMessage hand its entries to flushQueuedMessages',
    symbols: ['queueMessage', 'flushQueuedMessages'],
  },
  {
    id: 'tail-with-decoy',
    why: 'the same-stem QueuedMessage interface at L70 must not stand in for the functions',
    query: 'explain queueMessage, removeQueuedMessage and flushQueuedMessages',
    symbols: ['queueMessage', 'removeQueuedMessage', 'flushQueuedMessages'],
  },
];

/** Every `<n>\t<text>` line number present in the response's source blocks. */
function renderedLines(response) {
  const out = new Set();
  for (const m of response.matchAll(/^(\d+)\t/gm)) out.add(Number(m[1]));
  return out;
}

/**
 * A symbol counts as rendered only when its DECLARATION line is among the lines
 * the response actually sent — not when its name merely appears somewhere (it
 * shows up in the section header symbol list and in call sites regardless, which
 * is precisely how this defect hid for a whole epic).
 */
function check(cg, response, names) {
  const lines = renderedLines(response);
  return names.map((name) => {
    const node = (cg.getNodesByName?.(name) ?? []).find((n) => n.startLine > 0);
    return {
      name,
      file: node?.filePath ?? '(not indexed)',
      line: node?.startLine ?? 0,
      rendered: !!node && lines.has(node.startLine),
    };
  });
}

async function runCase(root, { query, symbols }) {
  const cg = CodeGraph.openSync(root);
  try {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
    const response = res.content?.[0]?.text ?? '';
    return { response, results: check(cg, response, symbols) };
  } finally {
    try { cg.close?.(); } catch { /* already closed */ }
  }
}

const argv = process.argv.slice(2);
const verbose = argv.includes('--verbose');
const positional = argv.filter((a) => !a.startsWith('--'));

let failures = 0;
let checked = 0;

if (positional.length >= 3) {
  // Ad-hoc mode: <repo> "<query>" sym...
  const [repo, query, ...symbols] = positional;
  const { response, results } = await runCase(resolve(repo), { query, symbols });
  console.log(`\n${repo}\n  query "${query}"  ·  ${response.length} chars\n`);
  for (const r of results) {
    checked += 1;
    if (!r.rendered) failures += 1;
    console.log(`   ${r.rendered ? 'PASS' : 'FAIL'}  ${r.name}  ${r.file}:${r.line}`);
  }
} else {
  const src = join(REPO, FIXTURE);
  if (!existsSync(src)) {
    console.error(`fixture missing: ${src}`);
    process.exit(2);
  }
  const dir = mkdtempSync(join(tmpdir(), 'cg-named-'));
  try {
    cpSync(src, dir, { recursive: true });
    rmSync(join(dir, '.codegraph'), { recursive: true, force: true });
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    cg.close?.();

    console.log(`\ntail-render-ts  ·  agent-named symbols must render\n`);
    for (const c of CASES) {
      const { response, results } = await runCase(dir, c);
      console.log(`── ${c.id} — ${c.why}`);
      console.log(`   query   "${c.query}"`);
      console.log(`   response ${response.length.toLocaleString()} chars`);
      for (const r of results) {
        checked += 1;
        if (!r.rendered) failures += 1;
        console.log(`   ${r.rendered ? 'PASS' : 'FAIL'}  ${r.name} defined at ${r.file}:${r.line}`
          + (r.rendered ? '' : '  — DEFINITION NOT IN RESPONSE'));
      }
      if (verbose && failures) {
        const spans = [...renderedLines(response)].sort((a, b) => a - b);
        console.log(`   rendered lines: ${spans[0]}..${spans[spans.length - 1]} (${spans.length} lines)`);
      }
      console.log();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(failures === 0
  ? `Every agent-named symbol rendered (${checked} checked).`
  : `${failures} of ${checked} agent-named symbols did NOT render.`);
process.exit(failures === 0 ? 0 : 1);
