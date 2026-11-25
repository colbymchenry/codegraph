#!/usr/bin/env node
// Accuracy judge. For each run in results.jsonl:
//   - end-to-end: agent finalAnswer vs verified ground truth (all arms)
//   - fidelity:   offload synthesized answer vs ground truth (offload arm only)
// Judge = claude -p sonnet --effort high, no tools, run from a neutral cwd,
// JSON-only verdicts. Writes judged.jsonl (one line per run, verdicts merged).
//
// Usage: judge.mjs --results <f> --truth <f> --out <f> [--concurrency 4]
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execFile } from 'child_process';

const A = {};
for (let i = 2; i < process.argv.length; i += 2) A[process.argv[i].replace(/^--/, '')] = process.argv[i + 1];
const results = readFileSync(A.results, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const truth = JSON.parse(readFileSync(A.truth, 'utf8'));
const OUT = A.out || '/tmp/cg-offload-eval/judged.jsonl';
const CONC = Number(A.concurrency || 4);

function askJudge(prompt) {
  return new Promise((resolve) => {
    execFile('claude', ['-p', prompt, '--model', 'sonnet', '--effort', 'high',
      '--max-budget-usd', '0.5', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}'],
      // Run from a neutral dir with no repo files so the judge can't "cheat" by reading source.
      { cwd: process.env.AGENT_EVAL_OUT || '/tmp', maxBuffer: 1 << 24, timeout: 120000 },
      (err, stdout) => {
        const raw = (stdout || '').trim();
        const m = raw.match(/\{[\s\S]*\}/);
        if (!m) return resolve({ verdict: 'error', score: null, note: (err ? 'exec ' + err.message : 'no json').slice(0, 80) });
        try { resolve(JSON.parse(m[0])); } catch { resolve({ verdict: 'error', score: null, note: 'parse fail' }); }
      });
  });
}

const e2ePrompt = (gt, ans) => `You are scoring whether an AI coding agent correctly answered a code-flow question about a repository. Judge ONLY against the verified ground truth. Do NOT use any tools.

QUESTION: ${gt.question}

VERIFIED GROUND TRUTH (the actual call path + files):
${gt.truth}

AGENT'S ANSWER:
${ans || '(empty)'}

Score how correct the agent's answer is vs the ground truth. A "pass" means it identifies the core mechanism and the major hops with the right files/symbols and makes no materially wrong claim. "partial" = right area but misses major hops or has notable errors. "fail" = wrong layer, fabricated, or misses the mechanism.
Output ONLY minified JSON, no prose, no code fences:
{"verdict":"pass|partial|fail","score":<0-100>,"missedHops":["..."],"wrongClaims":["..."],"note":"<=20 words"}`;

const fidPrompt = (gt, ans) => `You are scoring the FIDELITY of a machine-synthesized code-exploration answer against verified ground truth. The synthesized answer claims to trace a flow and cite file:line locations. Do NOT use any tools.

QUESTION: ${gt.question}

VERIFIED GROUND TRUTH (the actual call path + files):
${gt.truth}

SYNTHESIZED ANSWER (to score):
${ans || '(empty)'}

Judge: (1) is the traced call path correct vs ground truth? (2) are the cited files/symbols correct (not fabricated)? (3) if it gave a "Coverage:" verdict, was that verdict honest about what it actually covered? A confident WRONG trace is the worst outcome — penalize it harder than an honest "partial/not found".
Output ONLY minified JSON, no prose, no code fences:
{"verdict":"pass|partial|fail","score":<0-100>,"fabrication":<true|false>,"coverageHonest":<true|false>,"missedHops":["..."],"note":"<=20 words"}`;

// Build the job list
const jobs = [];
for (const r of results) {
  const gt = truth[r.repo];
  if (!gt) { r._nojudge = true; continue; }
  jobs.push({ r, kind: 'e2e', prompt: e2ePrompt(gt, r.finalAnswer) });
  if (r.arm === 'offload' && Array.isArray(r.offloadAnswers))
    r.offloadAnswers.forEach((ans, i) => { if (ans && ans.trim()) jobs.push({ r, kind: 'fid', idx: i, prompt: fidPrompt(gt, ans) }); });
}
console.error(`judging ${jobs.length} verdicts across ${results.length} runs (concurrency ${CONC})...`);

let done = 0;
async function worker(queue) {
  while (queue.length) {
    const job = queue.shift();
    const v = await askJudge(job.prompt);
    if (job.kind === 'e2e') job.r.e2e = v; else (job.r._fid ??= []).push(v);
    console.error(`  [${++done}/${jobs.length}] ${job.r.repo}/${job.r.arm}#${job.r.rep} ${job.kind}: ${v.verdict}${v.score != null ? ' ' + v.score : ''}`);
  }
}
const q = [...jobs];
await Promise.all(Array.from({ length: CONC }, () => worker(q)));

// Aggregate per-answer fidelity verdicts into one fidelity object per offload run.
const medOf = (a) => { a = [...a].sort((x, y) => x - y); return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null; };
for (const r of results) {
  if (r._fid?.length) {
    const scores = r._fid.map(v => v.score).filter(x => x != null);
    r.fidelity = {
      n: r._fid.length, scores,
      max: scores.length ? Math.max(...scores) : null,
      min: scores.length ? Math.min(...scores) : null,
      median: medOf(scores),
      anyFabrication: r._fid.some(v => v.fabrication === true),
      allCoverageHonest: r._fid.every(v => v.coverageHonest !== false),
      verdicts: r._fid.map(v => v.verdict),
    };
  }
  delete r._fid;
}
writeFileSync(OUT, results.map(r => JSON.stringify(r)).join('\n') + '\n');
console.error(`wrote ${OUT}`);
