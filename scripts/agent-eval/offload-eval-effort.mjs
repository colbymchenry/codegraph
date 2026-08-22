#!/usr/bin/env node
// Effort A/B — does CODEGRAPH_OFFLOAD_EFFORT=high improve offload SYNTHESIS FIDELITY vs low?
// Probe-based (no agent): for each repo × effort × rep, run codegraph_explore with the offload
// ON on the canonical question, capture the synthesized answer + AI tokens/cost/latency, then
// Sonnet-judge that answer's fidelity vs source-verified ground truth. Isolates the synthesis
// from agent/adoption noise. Requires `codegraph login` (managed offload) + indexed repos.
//
// Env: REPS (default 3) · CG_ENGINE (engine repo) · AGENT_EVAL_OUT (repos under /repos) · CONC (judge concurrency)
import { pathToFileURL, fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = process.env.CG_ENGINE || resolve(HERE, '..', '..');
const OUT = process.env.AGENT_EVAL_OUT || '/tmp/cg-offload-eval';
const REPOS = join(OUT, 'repos');
const GT = JSON.parse(readFileSync(resolve(HERE, 'offload-eval-ground-truth.json'), 'utf8'));
const REPS = Number(process.env.REPS || 3);
const CONC = Number(process.env.CONC || 4);
const EFFORTS = (process.env.EFFORTS_FILTER || 'low,high').split(',');
const ONLY = process.env.REPOS_FILTER ? new Set(process.env.REPOS_FILTER.split(',')) : null;
const TIER = { mtkruto: 'small', postybirb: 'medium', shapeshift: 'complex', trezor: 'large' };

const load = async (rel) => import(pathToFileURL(resolve(ENGINE, rel)).href);
const idx = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
const ToolHandler = toolsMod.ToolHandler ?? toolsMod.default?.ToolHandler;
if (typeof CodeGraph?.openSync !== 'function' || typeof ToolHandler !== 'function') {
  console.error('could not load engine from', ENGINE); process.exit(2);
}

const fidPrompt = (gt, ans) => `You are scoring the FIDELITY of a machine-synthesized code-exploration answer against verified ground truth. Do NOT use any tools.

QUESTION: ${gt.question}

VERIFIED GROUND TRUTH (the actual call path + files):
${gt.truth}

SYNTHESIZED ANSWER (to score):
${ans || '(empty)'}

Judge: (1) is the traced call path correct vs ground truth? (2) are the cited files/symbols correct (not fabricated)? (3) if it gave a "Coverage:" verdict, was it honest? A confident WRONG trace is the worst outcome — penalize it harder than an honest partial.
Output ONLY minified JSON: {"verdict":"pass|partial|fail","score":<0-100>,"fabrication":<true|false>,"coverageHonest":<true|false>,"note":"<=20 words"}`;

const askJudge = (prompt) => new Promise((res) => {
  execFile('claude', ['-p', prompt, '--model', 'sonnet', '--effort', 'high', '--max-budget-usd', '0.5',
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
    { cwd: OUT, maxBuffer: 1 << 24, timeout: 120000 }, (err, stdout) => {
      const m = (stdout || '').match(/\{[\s\S]*\}/);
      if (!m) return res({ verdict: 'error', score: null, note: (err ? err.message : 'no json').slice(0, 60) });
      try { res(JSON.parse(m[0])); } catch { res({ verdict: 'error', score: null }); }
    });
});

// ---- 1. Probe: collect synthesized answers at each effort -------------------
const records = [];
for (const repo of Object.keys(GT)) {
  if (ONLY && !ONLY.has(repo)) continue;
  const dir = join(REPOS, repo);
  if (!existsSync(join(dir, '.codegraph'))) { console.error('skip (not indexed):', repo); continue; }
  const cg = CodeGraph.openSync(dir);
  const h = new ToolHandler(cg);
  for (const effort of EFFORTS) {
    for (let rep = 1; rep <= REPS; rep++) {
      process.env.CODEGRAPH_OFFLOAD_EFFORT = effort;
      const usageLog = join(tmpdir(), `effort-${repo}-${effort}-${rep}.jsonl`);
      try { rmSync(usageLog); } catch { /* none */ }
      process.env.CODEGRAPH_OFFLOAD_USAGE_LOG = usageLog;
      let answer = '';
      try { answer = (await h.execute('codegraph_explore', { query: GT[repo].question }))?.content?.[0]?.text ?? ''; }
      catch (e) { console.error(`  ${repo}/${effort}#${rep} explore failed: ${e?.message}`); }
      const fired = /Synthesized by CodeGraph/.test(answer);
      const ai = { tokens: 0, cost: 0, ms: 0 };
      if (existsSync(usageLog)) for (const e of readFileSync(usageLog, 'utf8').split('\n').filter(Boolean).map(JSON.parse)) {
        ai.tokens += e.totalTokens || 0; ai.cost += e.costUsd || 0; ai.ms += e.ms || 0;
      }
      records.push({ repo, tier: TIER[repo], effort, rep, fired, ai, answer });
      console.error(`  ${repo}/${effort}#${rep}: fired=${fired} ${ai.tokens}tok $${ai.cost.toFixed(4)} ${ai.ms}ms`);
    }
  }
  try { cg.close?.(); } catch { /* none */ }
}

// ---- 2. Judge fidelity (concurrency) ---------------------------------------
console.error(`\njudging ${records.length} answers (concurrency ${CONC})...`);
let done = 0;
const q = [...records];
async function worker() { while (q.length) { const r = q.shift(); r.fid = await askJudge(fidPrompt(GT[r.repo], r.answer)); console.error(`  [${++done}/${records.length}] ${r.repo}/${r.effort}#${r.rep}: ${r.fid.verdict} ${r.fid.score ?? ''}`); } }
await Promise.all(Array.from({ length: CONC }, worker));
writeFileSync(join(OUT, 'effort-results.jsonl'), records.map((r) => JSON.stringify(r)).join('\n') + '\n');

// ---- 3. Aggregate: low vs high per repo ------------------------------------
const med = (a) => { a = a.filter((x) => x != null).sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
console.log(`\n${'='.repeat(80)}\nEFFORT A/B — offload synthesis fidelity (probe, n=${REPS}/cell)\n${'='.repeat(80)}`);
console.log(`${'repo'.padEnd(11)} ${'tier'.padEnd(8)} ${'effort'.padEnd(6)} fired  ${'fid(med)'.padStart(8)} ${'fab%'.padStart(5)} ${'AItok'.padStart(7)} ${'AIcost'.padStart(8)} ${'ms(med)'.padStart(8)}`);
for (const repo of Object.keys(GT)) {
  for (const effort of EFFORTS) {
    const rs = records.filter((r) => r.repo === repo && r.effort === effort);
    if (!rs.length) continue;
    const fids = rs.map((r) => r.fid?.score).filter((x) => x != null);
    const fab = rs.filter((r) => r.fid?.fabrication === true).length;
    console.log(`${repo.padEnd(11)} ${TIER[repo].padEnd(8)} ${effort.padEnd(6)} ${rs.filter((r) => r.fired).length}/${rs.length}   ${String(med(fids) ?? '—').padStart(8)} ${String(Math.round(100 * fab / rs.length) + '%').padStart(5)} ${String(Math.round(med(rs.map((r) => r.ai.tokens)) / 1000) + 'k').padStart(7)} ${('$' + (med(rs.map((r) => r.ai.cost)) ?? 0).toFixed(4)).padStart(8)} ${String(med(rs.map((r) => r.ai.ms)) ?? '—').padStart(8)}`);
  }
}
console.log('');
