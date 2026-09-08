#!/usr/bin/env node
/**
 * Per-file reservation-vs-delivered sweep for `codegraph_explore` (CG-36).
 *
 * `probe-suite-envelope.mjs` answers "how much source did the response deliver";
 * this answers the question one level down — "did the bytes go to the files that
 * earned them". The CG-36 defect was invisible to the envelope probe because the
 * envelope stayed full: a rank-#3 file spent 24% of its reservation, the slack
 * carried forward exactly as designed, and a far weaker file spent 3.5x its own.
 * The response looked healthy; the ANSWER-bearing file had been starved.
 *
 * So the flag here is a PAIR, not a per-file threshold: a file that leaves a
 * large share of its reservation unspent WHILE a materially lower-scoring file
 * spends well over its own. Either alone is legitimate — a small file simply has
 * less to say, and carry-forward is the mechanism that hands its slack down.
 *
 * Numbers come from the CG-4 diagnostic (`CODEGRAPH_EXPLORE_DEBUG`), so this
 * measures the shipping allocator rather than re-deriving shares from markdown.
 *
 * Usage (needs a current `npm run build`, and full-REBUILT indexes — CG-33):
 *   node scripts/agent-eval/probe-file-spend.mjs
 *   node scripts/agent-eval/probe-file-spend.mjs --json > /tmp/new.json
 *   node scripts/agent-eval/probe-file-spend.mjs --baseline /tmp/base.json
 *   node scripts/agent-eval/probe-file-spend.mjs django --all   # every file, not just flags
 *   CORPUS=/tmp/codegraph-corpus node scripts/agent-eval/probe-file-spend.mjs
 *
 * Exit code is 1 when any repo carries a starvation flag, so this can gate.
 */
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const CORPUS = process.env.CORPUS ?? '/tmp/codegraph-corpus';

/** Same six repos and queries the CG-30/CG-31/CG-26 envelope tables use. */
const SUITE = [
  { id: 'django', q: 'How does a QuerySet turn into SQL and fetch rows from the database?' },
  { id: 'excalidraw', q: 'How does updating an element re-render the canvas on screen?' },
  { id: 'okhttp', q: 'How does a call go through the interceptor chain to the network?' },
  { id: 'tokio', q: 'How does a spawned task get scheduled and run by a worker?' },
  { id: 'gin', q: 'How does a registered route handler get invoked for an incoming HTTP request?' },
  { id: 'alamofire', q: 'How does a request get built and sent through the session?' },
];

/**
 * Starvation thresholds. A flag needs BOTH sides — the starved file and the
 * overspending one it lost the bytes to.
 *
 * `MIN_RESERVED` keeps the noise out: under it, "80% unspent" is a few hundred
 * chars and means nothing. `SCORE_RATIO` is what makes the pair meaningful —
 * a higher-scoring file underspending while a *comparable* one overspends is
 * ordinary; the defect is a materially weaker file taking the bytes.
 */
const STARVED_SHARE = 0.5;   // spent < half its reservation
const OVERSPEND_RATIO = 1.5; // spent > 1.5x its own reservation
const SCORE_RATIO = 2;       // ...while scoring less than half the starved file
const MIN_RESERVED = 2000;   // ignore files whose reservation is too small to matter

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const showAll = argv.includes('--all');
const baselineAt = argv.includes('--baseline') ? argv[argv.indexOf('--baseline') + 1] : null;
const only = argv.filter((a) => !a.startsWith('--') && a !== baselineAt);

const say = (s = '') => { if (!asJson) console.log(s); };
const num = (n) => Math.round(n).toLocaleString('en-US');
const pct = (f) => `${(f * 100).toFixed(1)}%`;

const load = (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const toolsMod = await load('dist/mcp/tools.js');
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
const ToolHandler = toolsMod.ToolHandler ?? toolsMod.default?.ToolHandler;
if (typeof CodeGraph?.openSync !== 'function' || typeof ToolHandler !== 'function') {
  console.error('could not resolve CodeGraph/ToolHandler from dist/ — run `npm run build`');
  process.exit(2);
}

/**
 * Pair up the starved with the overspenders they lost bytes to. Only files the
 * render loop actually reached (a reservation and a render mode) take part —
 * a cliffed or max-files file never had bytes to spend.
 */
function findStarvation(files) {
  const spenders = files.filter(
    (f) => f.allowance !== null && f.allowance > 0 && f.render && f.render !== 'backref',
  );
  const flags = [];
  for (const s of spenders) {
    if (s.allowance < MIN_RESERVED) continue;
    if (s.finalChars >= s.allowance * STARVED_SHARE) continue;
    for (const o of spenders) {
      if (o.path === s.path) continue;
      if (o.finalChars <= o.allowance * OVERSPEND_RATIO) continue;
      if (o.score * SCORE_RATIO > s.score) continue;
      flags.push({
        starved: s.path,
        starvedScore: s.score,
        starvedReserved: s.allowance,
        starvedSpent: s.finalChars,
        overspent: o.path,
        overspentScore: o.score,
        overspentReserved: o.allowance,
        overspentSpent: o.finalChars,
      });
    }
  }
  return flags;
}

const tmp = mkdtempSync(join(tmpdir(), 'cg-spend-'));
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
    await h.execute('codegraph_explore', { query: q });
    try { cg.close?.(); } catch { /* best effort */ }
    const report = JSON.parse(readFileSync(sidecar, 'utf8').trim().split('\n').pop());
    const files = report.files.map((f) => ({
      path: f.path,
      rank: f.rank,
      score: f.score,
      allowance: f.allowance,
      spendable: f.spendable,
      finalChars: f.finalChars,
      render: f.render,
      skipped: f.skipped,
      spent: f.allowance ? f.finalChars / f.allowance : null,
    }));
    results.push({
      repo: id,
      sourceChars: report.envelope.sourceChars,
      files,
      flags: findStarvation(files),
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
  for (const r of results) {
    const b = byRepo.get(r.repo);
    say(`\n${r.repo}  —  ${num(r.sourceChars)} source chars`
      + (b ? `  (baseline ${num(b.sourceChars)})` : ''));
    say(' #   score  reserved   spent   spent%   render        file');
    say('-'.repeat(96));
    const flagged = new Set(r.flags.flatMap((f) => [f.starved, f.overspent]));
    for (const f of r.files) {
      if (f.allowance === null || f.allowance === 0) continue;
      if (!showAll && !flagged.has(f.path) && f.spent > STARVED_SHARE && f.spent < OVERSPEND_RATIO) continue;
      const mark = flagged.has(f.path) ? '*' : ' ';
      say(
        `${String(f.rank).padStart(2)}${mark} ${String(Math.round(f.score)).padStart(6)} `
        + `${num(f.allowance).padStart(9)} ${num(f.finalChars).padStart(7)} `
        + `${pct(f.spent).padStart(7)}   ${(f.render ?? f.skipped ?? '—').padEnd(13)} ${f.path}`,
      );
    }
    for (const f of r.flags) {
      say(`  FLAG: ${f.starved} (score ${Math.round(f.starvedScore)}) spent `
        + `${num(f.starvedSpent)}/${num(f.starvedReserved)} while ${f.overspent} `
        + `(score ${Math.round(f.overspentScore)}) spent ${num(f.overspentSpent)}/${num(f.overspentReserved)}`);
    }
  }
  const total = results.reduce((n, r) => n + r.flags.length, 0);
  say('');
  say(total === 0
    ? 'No file leaves a large share of its reservation unspent while a weaker file overspends.'
    : `STARVATION: ${total} flag(s) across `
      + `${results.filter((r) => r.flags.length > 0).map((r) => r.repo).join(', ')}.`);
  if (base) {
    const worse = results.filter((r) => {
      const b = byRepo.get(r.repo);
      return b && (r.flags.length > b.flags.length || r.sourceChars < b.sourceChars);
    });
    say(worse.length === 0
      ? 'No repo flags more or delivers less than the baseline.'
      : `REGRESSION vs baseline: ${worse.map((r) => r.repo).join(', ')}.`);
  }
  if (total > 0) process.exitCode = 1;
}
