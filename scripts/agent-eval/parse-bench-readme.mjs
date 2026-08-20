#!/usr/bin/env node
// Aggregate the README A/B (bench-readme.sh output): per repo, median of N runs
// per arm → time, tool calls, tokens, cost, % saved, and RESIDUAL CONTEXT
// OCCUPANCY. Plus an average row.
//
// Tokens = SUM of per-turn assistant `usage` (input + output + cache read +
// cache creation) — the cumulative "total tokens processed". NOTE: `result.usage`
// is last-turn-only in some Claude Code versions, so reading it alone can
// under-count badly; parseSession() sums per-segment and dedupes assistant
// events by message.id (Claude Code emits one event per content block, each
// carrying the same usage — summing per EVENT double-counts).
//
// The occupancy table answers the question "tokens processed" cannot: how much
// of the window each arm's tool output STILL OCCUPIES when the run ends. Under
// multi-turn rows that residual is charged against every following turn.
//
// Usage: node parse-bench-readme.mjs [/tmp/ab-readme]
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseSession, SUFFICIENCY } from './parse-run.mjs';

const ROOT = process.argv[2] || '/tmp/ab-readme';
const REPOS = ['vscode', 'excalidraw', 'django', 'tokio', 'okhttp', 'gin', 'alamofire'];

/** All segment files of one arm's session, in turn order (t1, t2, t3, …). */
function segments(dir, label) {
  const first = join(dir, `run-${label}.jsonl`);
  if (!existsSync(first)) return null;
  const rest = readdirSync(dir)
    .map((f) => [f, new RegExp(`^run-${label}\\.t(\\d+)\\.jsonl$`).exec(f)])
    .filter(([, m]) => m)
    .sort((a, b) => Number(a[1][1]) - Number(b[1][1]))
    .map(([f]) => join(dir, f));
  return [first, ...rest];
}

function parse(dir, label) {
  const files = segments(dir, label);
  if (!files) return null;
  const s = parseSession(files);
  if (!s.ok) return null;
  const o = s.occupancy;
  return {
    dur: s.dur, tools: s.tools, reads: s.reads, grep: s.grep, cg: s.cg,
    bash: s.counts.Bash || 0, cliCalls: s.cliCalls, cliContaminated: s.cliContaminated,
    tokens: s.processed, cost: s.cost, raced: s.raced, turns: s.turns,
    segments: files.length,
    ctx: o.ctxFinal,
    ctxBase: o.ctxBase,
    occCg: o.residual.codegraph,
    occFile: o.residualFileAccess,
    // The arm's own retrieval residual: codegraph in the with-arm, Read/Grep/Bash
    // in the without-arm. Comparing these is the apples-to-apples pair.
    occSelf: o.residual.codegraph + o.residualFileAccess,
    occShareCtx: o.ctxFinal > 0 ? ((o.residual.codegraph + o.residualFileAccess) / o.ctxFinal) * 100 : 0,
    occShareWin: ((o.residual.codegraph + o.residualFileAccess) / o.windowTokens) * 100,
    window: o.windowTokens,
    // The other two feedback metrics, carried per run so the campaign can pool
    // them. Both are with-arm-only in practice — a without-arm makes no explore
    // calls, so it has nothing to be sufficient about and no bytes to allocate.
    suffAnswered: s.sufficiency.answered,
    suffCounts: s.sufficiency.counts,
    // Byte-weighted, so a run with no explore contributes NOTHING rather than a
    // zero; a zero would drag a repo toward "wasteful" for never spending a byte.
    allocUsed: s.allocation.envelope ? s.allocation.used : 0,
    allocEnvelope: s.allocation.envelope,
    allocCalls: s.allocation.calls.length,
  };
}

const median = (arr) => { const v = [...arr].sort((a, b) => a - b); const n = v.length; return n === 0 ? 0 : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const fmtTok = (t) => t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1000)}k`;
const pct = (w, wo) => wo > 0 ? Math.round((1 - w / wo) * 100) : 0;

// Exclude MCP-cold-start-raced WITH runs by default — they measure a startup
// race, not steady-state value. `CG_INCLUDE_RACED=1` keeps them (to see the raw
// distribution). The WITHOUT arm has no MCP, so it's never raced.
const includeRaced = process.env.CG_INCLUDE_RACED === '1';
// A without-arm run that shelled out to the codegraph CLI measured
// codegraph-over-CLI, not codegraph-absent. Drop it unless asked otherwise.
const includeContaminated = process.env.CG_INCLUDE_CONTAMINATED === '1';
const rows = [];
let contaminated = 0;
for (const repo of REPOS) {
  const dir = join(ROOT, repo);
  const runDirs = existsSync(dir) ? readdirSync(dir).filter(d => /^run\d+$/.test(d)).sort() : [];
  const W = [], WO = []; let racedExcluded = 0;
  for (const rd of runDirs) {
    const w = parse(join(dir, rd), 'headless-with');
    if (w) { if (w.raced && !includeRaced) racedExcluded++; else W.push(w); }
    const wo = parse(join(dir, rd), 'headless-without');
    if (wo) {
      if (wo.cliContaminated && !includeContaminated) { contaminated++; console.error(`[excluded] ${repo}/${rd} without-arm got codegraph CLI output ${wo.cliContaminated}x`); }
      else WO.push(wo);
    }
  }
  rows.push({ repo, W, WO, racedExcluded });
}
if (contaminated) console.error(`[excluded] ${contaminated} contaminated without-arm run(s); CG_INCLUDE_CONTAMINATED=1 keeps them\n`);

// ---- Table 1: the existing throughput view. --------------------------------
console.log('repo        n(w/wo)  time WITH→WITHOUT      tools W→WO   tokens W→WO (saved)     cost W→WO (saved)');
const savings = { cost: [], tokens: [], time: [], tools: [] };
for (const { repo, W, WO, racedExcluded } of rows) {
  if (!W.length || !WO.length) { console.log(`${repo.padEnd(11)} (incomplete: w=${W.length} wo=${WO.length})`); continue; }
  const m = (arr, k) => median(arr.map(x => x[k]));
  const wT = m(W, 'dur'), woT = m(WO, 'dur'), wTok = m(W, 'tokens'), woTok = m(WO, 'tokens');
  const wC = m(W, 'cost'), woC = m(WO, 'cost'), wTl = m(W, 'tools'), woTl = m(WO, 'tools');
  savings.time.push(pct(wT, woT)); savings.tokens.push(pct(wTok, woTok)); savings.cost.push(pct(wC, woC)); savings.tools.push(pct(wTl, woTl));
  console.log(
    `${repo.padEnd(11)} ${W.length}/${WO.length}      ` +
    `${(fmtTime(wT) + '→' + fmtTime(woT)).padEnd(22)}` +
    `${(Math.round(wTl) + '→' + Math.round(woTl)).padEnd(12)}` +
    `${(fmtTok(wTok) + '→' + fmtTok(woTok) + ' (' + pct(wTok, woTok) + '%)').padEnd(24)}` +
    `$${wC.toFixed(2)}→$${woC.toFixed(2)} (${pct(wC, woC)}%)` +
    (racedExcluded ? `  [${racedExcluded} raced run${racedExcluded === 1 ? '' : 's'} excluded]` : '')
  );
}
const avg = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;
console.log(`\nAVERAGE saved:  cost ${avg(savings.cost)}%  ·  tokens ${avg(savings.tokens)}%  ·  time ${avg(savings.time)}%  ·  tool calls ${avg(savings.tools)}%`);

// ---- Table 2: residual context occupancy. ----------------------------------
// WITH's retrieval residual is codegraph's tool output; WITHOUT's is Read +
// Grep/Glob + Bash. Same question, same window — so the pair is comparable.
const anyMulti = rows.some(({ W, WO }) => [...W, ...WO].some(r => r.segments > 1));
console.log(`\n\nRESIDUAL CONTEXT OCCUPANCY — retrieval tokens still in the window at end of run`);
console.log(`(WITH = codegraph responses · WITHOUT = Read + Grep/Glob + Bash responses)`);
console.log(`${anyMulti ? 'multi-turn sessions' : 'SINGLE-TURN sessions — see the caveat below'}\n`);
console.log('repo        turns   final ctx W→WO        residual W→WO         % of ctx W→WO     % of window W→WO');
const occ = { resid: [], shareCtx: [], fixed: [] };
for (const { repo, W, WO } of rows) {
  if (!W.length || !WO.length) { console.log(`${repo.padEnd(11)} (incomplete)`); continue; }
  const m = (arr, k) => median(arr.map(x => x[k]));
  occ.fixed.push(m(W, 'ctxBase') - m(WO, 'ctxBase'));
  const wR = m(W, 'occSelf'), woR = m(WO, 'occSelf');
  const wCtx = m(W, 'ctx'), woCtx = m(WO, 'ctx');
  const wSc = m(W, 'occShareCtx'), woSc = m(WO, 'occShareCtx');
  const wSw = m(W, 'occShareWin'), woSw = m(WO, 'occShareWin');
  occ.resid.push(pct(wR, woR)); occ.shareCtx.push(pct(wSc, woSc));
  console.log(
    `${repo.padEnd(11)} ${String(median(W.map(x => x.turns)) + '/' + median(WO.map(x => x.turns))).padEnd(7)} ` +
    `${(fmtTok(wCtx) + '→' + fmtTok(woCtx)).padEnd(21)}` +
    `${(fmtTok(wR) + '→' + fmtTok(woR) + ' (' + pct(wR, woR) + '%)').padEnd(22)}` +
    `${(wSc.toFixed(1) + '%→' + woSc.toFixed(1) + '%').padEnd(18)}` +
    `${wSw.toFixed(1)}%→${woSw.toFixed(1)}%`
  );
}
// Direction must follow the SIGN, not the hope. `pct(w, wo)` is the reduction
// going with→without, so a NEGATIVE value means the with-arm's residual is
// LARGER. Hardcoding "lower" printed "-82% lower with codegraph" for the case
// where codegraph in fact occupies 82% MORE — a double negative that reads as a
// win and inverts the headline. Say which way it went, in words.
const dir = (v) => (v < 0 ? 'HIGHER' : 'lower');
const magn = (v) => Math.abs(v);
console.log(
  `\nAVERAGE: retrieval residual ${magn(avg(occ.resid))}% ${dir(avg(occ.resid))} with codegraph` +
  `  ·  share-of-context ${magn(avg(occ.shareCtx))}% ${dir(avg(occ.shareCtx))}`
);
if (avg(occ.resid) < 0) {
  console.log(
    `  ^ codegraph front-loads one large verbatim payload that STAYS resident, where Read/Grep\n` +
    `    churn many small results that evict. Read alongside the cost/token table above: fewer\n` +
    `    total tokens processed can coexist with a larger persistent footprint. This is the axis\n` +
    `    issue #1500 reported.`
  );
}

console.log(
  `FIXED overhead: codegraph's tool schema + MCP instructions cost ${avg(occ.fixed) >= 0 ? '+' : ''}${avg(occ.fixed)} tok\n` +
  `  of context before any tool is called (median WITH ctxBase - median WITHOUT ctxBase, averaged\n` +
  `  over repos). It is paid whether or not the agent ever calls codegraph.`
);

// Per-run detail. Medians over 2-3 runs hide swings big enough to flip a repo's
// sign — the agent's tool mix is the variable, and a with-arm run that reads
// files ON TOP of calling explore pays for both. Show every run.
console.log('\nper run (retrieval residual · tool mix — cg=explore rd=Read gr=Grep bs=Bash):');
for (const { repo, W, WO } of rows) {
  if (!W.length && !WO.length) continue;
  const one = (r) => `${fmtTok(r.occSelf)}${r.cg ? ` cg${r.cg}` : ''}${r.reads ? ` rd${r.reads}` : ''}${r.grep ? ` gr${r.grep}` : ''}${r.bash ? ` bs${r.bash}` : ''}`;
  console.log(`  ${repo.padEnd(11)} W: ${W.map(one).join(' | ').padEnd(46)} WO: ${WO.map(one).join(' | ')}`);
}
if (!anyMulti) {
  console.log(
    `\nCAVEAT: every row is a SINGLE-turn session, so the residual is measured at the\n` +
    `moment the one question is answered. Occupancy is a cost that compounds over the turns\n` +
    `that FOLLOW; a single-turn number does not settle it. Re-run with "||"-separated\n` +
    `follow-ups (see run-all.sh) to measure the regime this metric is actually about.`
  );
}

// ---- Table 3: sufficiency + allocation, WITH arm only. ---------------------
// Occupancy says what a response COST; these two say whether it was enough and
// whether it spent its bytes on the right files. A campaign that reports only
// occupancy cannot tell a tighter response from a worse one.
//
// Pooled per repo, not median-of-runs: both are per-CALL quantities (sufficiency
// counts explores, allocation weights by bytes), and a repo contributes 2-15
// calls across its runs. Median-of-run-percentages would weight a 1-call run the
// same as a 5-call one.
console.log(`\n\nEXPLORE SUFFICIENCY + ALLOCATION EFFICIENCY — with-arm only, pooled over runs`);
console.log(`(sufficiency = what the agent did NEXT · allocation = share of returned bytes the answer cited)\n`);
console.log('repo        calls   again  read-ret  read-miss  grep   MOVED ON     alloc eff   envelope');
const totals = { answered: 0, counts: Object.fromEntries(SUFFICIENCY.map(([k]) => [k, 0])), used: 0, env: 0, calls: 0 };
for (const { repo, W } of rows) {
  if (!W.length) { console.log(`${repo.padEnd(11)} (no with-arm runs)`); continue; }
  const answered = W.reduce((s, r) => s + r.suffAnswered, 0);
  const cnt = (k) => W.reduce((s, r) => s + r.suffCounts[k], 0);
  const env = W.reduce((s, r) => s + r.allocEnvelope, 0);
  const used = W.reduce((s, r) => s + r.allocUsed, 0);
  totals.answered += answered; totals.used += used; totals.env += env;
  totals.calls += W.reduce((s, r) => s + r.allocCalls, 0);
  for (const [k] of SUFFICIENCY) totals.counts[k] += cnt(k);
  const cell = (k) => (answered ? `${cnt(k)} ${Math.round((cnt(k) / answered) * 100)}%` : '—').padEnd(9);
  console.log(
    `${repo.padEnd(11)} ${String(answered).padEnd(7)} ` +
    `${cell('explore_again')}${cell('read_returned')}${cell('read_missed')}${cell('search')}` +
    `${(answered ? `${cnt('sufficient')} ${Math.round((cnt('sufficient') / answered) * 100)}%` : '—').padEnd(13)}` +
    `${(env ? `${((used / env) * 100).toFixed(1)}%` : '—').padEnd(12)}${fmtTok(env)}`
  );
}
const tp = (k) => totals.answered ? `${totals.counts[k]} (${Math.round((totals.counts[k] / totals.answered) * 100)}%)` : '—';
console.log(
  `\nPOOLED (${totals.answered} answered explore calls): ` +
  SUFFICIENCY.map(([k, label]) => `${label} ${tp(k)}`).join(' · ')
);
console.log(
  `POOLED allocation efficiency: ${totals.env ? ((totals.used / totals.env) * 100).toFixed(1) + '%' : '—'} ` +
  `over ${totals.calls} calls / ${fmtTok(totals.env)} chars`
);
console.log(
  `\nHOW TO READ: "read-ret" (Read a file we RETURNED) is an allocation miss — right file,\n` +
  `wrong bytes; "read-miss" and "grep" are recall misses. "again" is ambiguous by construction.\n` +
  `Allocation efficiency is RELATIVE — attribution is by citation, so it compares BUILDS on the\n` +
  `same questions and is not a claim that codegraph wasted the remainder. Full guidance:\n` +
  `docs/benchmarks/agent-eval-feedback-metrics.md`
);
