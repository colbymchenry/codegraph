#!/usr/bin/env node
/**
 * Deterministic 6-repo envelope sweep for `codegraph_explore` (CG-26).
 *
 * The allocation issues (CG-30 / CG-31 / CG-26) are all decided by how the
 * render loop divides a fixed byte ceiling, and the agent A/B is far too noisy
 * to see a 2K byte shift. This runs the SAME six queries the CG-30 and CG-31
 * benchmark tables use, against the same clean-rebuilt corpus indexes, and
 * prints the numbers those tables are made of: source chars delivered, files in
 * the final output, whether the hard ceiling cut anything, and whether the
 * epilogue survived.
 *
 * Numbers come from the CG-4 diagnostic (`CODEGRAPH_EXPLORE_DEBUG`), so this
 * measures the shipping allocator rather than re-deriving shares from markdown.
 *
 * Usage (needs a current `npm run build`, and full-REBUILT indexes — CG-33):
 *   node scripts/agent-eval/probe-suite-envelope.mjs
 *   node scripts/agent-eval/probe-suite-envelope.mjs --json > /tmp/new.json
 *   node scripts/agent-eval/probe-suite-envelope.mjs --baseline /tmp/base.json
 *   CORPUS=/tmp/codegraph-corpus node scripts/agent-eval/probe-suite-envelope.mjs
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORPUS = process.env.CORPUS ?? '/tmp/codegraph-corpus';

/** The six suite repos + the exact queries the CG-30/CG-31 tables were measured on. */
const SUITE = [
  { id: 'django', q: 'How does a QuerySet turn into SQL and fetch rows from the database?' },
  { id: 'excalidraw', q: 'How does updating an element re-render the canvas on screen?' },
  { id: 'okhttp', q: 'How does a call go through the interceptor chain to the network?' },
  { id: 'tokio', q: 'How does a spawned task get scheduled and run by a worker?' },
  { id: 'gin', q: 'How does a registered route handler get invoked for an incoming HTTP request?' },
  { id: 'alamofire', q: 'How does a request get built and sent through the session?' },
];

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const baselineAt = argv.includes('--baseline') ? argv[argv.indexOf('--baseline') + 1] : null;
const only = argv.filter((a) => !a.startsWith('--') && a !== baselineAt);

const say = (s = '') => { if (!asJson) console.log(s); };
const num = (n) => Math.round(n).toLocaleString('en-US');

const load = (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
const ToolHandler = toolsMod.ToolHandler ?? toolsMod.default?.ToolHandler;
if (typeof CodeGraph?.openSync !== 'function' || typeof ToolHandler !== 'function') {
  console.error('could not resolve CodeGraph/ToolHandler from dist/ — run `npm run build`');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'cg-suite-'));
const results = [];
try {
  for (const { id, q } of SUITE) {
    if (only.length > 0 && !only.includes(id)) continue;
    const repo = join(CORPUS, id);
    if (!existsSync(join(repo, '.codegraph', 'codegraph.db'))) {
      say(`${id}: no index at ${repo} — skipped`);
      continue;
    }
    const sidecar = join(tmp, `${id}.jsonl`);
    process.env.CODEGRAPH_EXPLORE_DEBUG = sidecar;
    const cg = CodeGraph.openSync(repo);
    const h = new ToolHandler(cg);
    const res = await h.execute('codegraph_explore', { query: q });
    const text = res.content?.[0]?.text ?? '';
    try { cg.close?.(); } catch { /* best effort */ }
    const report = JSON.parse(readFileSync(sidecar, 'utf8').trim().split('\n').pop());
    results.push({
      repo: id,
      sourceChars: report.envelope.sourceChars,
      envelopeChars: report.envelope.chars,
      allocatedChars: report.envelope.allocatedChars,
      hardCeiling: report.budget.hardCeiling,
      truncated: report.envelope.truncated,
      files: report.selection.filesInFinalOutput,
      // Did the response keep its trailing pointer list / notes, or did the
      // hard ceiling spend them? This is CG-26's residual 1.
      epilogueCut: text.includes('omitted for size'),
      sectionCut: text.includes('output truncated to budget'),
      notShown: text.includes('Not shown above'),
      budgetNote: text.includes('**Explore budget:'),
    });
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const base = baselineAt ? JSON.parse(readFileSync(baselineAt, 'utf8')) : null;
  const byRepo = new Map((base ?? []).map((r) => [r.repo, r]));
  say('repo         source     Δ        env      files  cut          epilogue');
  say('-'.repeat(74));
  for (const r of results) {
    const b = byRepo.get(r.repo);
    const delta = b ? (r.sourceChars - b.sourceChars) : null;
    const dStr = delta === null ? '' : (delta > 0 ? `+${num(delta)}` : num(delta));
    const cut = r.sectionCut ? 'section' : r.epilogueCut ? 'epilogue' : '—';
    const epi = [r.notShown ? 'not-shown' : null, r.budgetNote ? 'budget-note' : null]
      .filter(Boolean).join('+') || 'none';
    say(
      `${r.repo.padEnd(12)} ${num(r.sourceChars).padStart(7)} ${dStr.padStart(8)} `
      + `${num(r.envelopeChars).padStart(7)} ${String(r.files).padStart(5)}  ${cut.padEnd(12)} ${epi}`,
    );
  }
  if (base) {
    const lost = results.filter((r) => {
      const b = byRepo.get(r.repo);
      return b && (r.sourceChars < b.sourceChars || r.files < b.files);
    });
    say('');
    say(lost.length === 0
      ? 'No repo delivers less source or fewer files than the baseline.'
      : `REGRESSION: ${lost.map((r) => r.repo).join(', ')} deliver less than baseline.`);
  }
}
