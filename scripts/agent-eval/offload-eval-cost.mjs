#!/usr/bin/env node
// Cost/token analysis for the 3-arm offload eval, with a MAIN-vs-SUBAGENT split.
//
// The explore-subagent question. With delegation ALLOWED, the nocg arm spawns a
// Claude Code Explore subagent; the codegraph arms do all work in the main agent.
// Two facts make naive accounting wrong:
//   1. The Explore subagent runs on HAIKU 4.5; the main agent on SONNET 4.6.
//      So per-token cost differs ~3x between them — you cannot price both the same.
//   2. The subagent's consumption is ~95% cache-reads. At Haiku's $0.10/MTok
//      cache-read rate, a huge TOKEN volume is a small DOLLAR cost.
//
// Rather than re-derive cost from raw token counts (and guess the cache TTL —
// Claude Code uses 1-hour ephemeral cache here, 2x write, not 5-min), we read
// Claude Code's OWN authoritative accounting from the `result` event:
//   result.modelUsage[model].costUSD  — per-model cost CC itself billed
//   result.total_cost_usd             — their sum (INCLUDES the Haiku subagent;
//                                       the handoff's "excludes subagent" was wrong)
// The model split IS the agent split here: sonnet => main, haiku => Explore subagent
// (only nocg spawns one, and only nocg shows haiku usage). Token volume is still
// summed per-model from modelUsage for the separate "tokens" story.
//
// Usage: offload-eval-cost.mjs <runs-dir> <repo> [reps]
//   e.g. offload-eval-cost.mjs /tmp/cg-offload-eval/runs trezor 3
import { readFileSync, existsSync } from 'fs';

const MAIN_TIER = /sonnet/;   // main agent
const SUB_TIER  = /haiku/;    // Claude Code Explore subagent

const [,, runsDir, repo, repsArg] = process.argv;
if (!runsDir || !repo) { console.error('usage: offload-eval-cost.mjs <runs-dir> <repo> [reps]   (env ARMS=nocg,raw,offload)'); process.exit(1); }
const REPS = Number(repsArg || 3);
// Arms to analyze (file stems `<repo>-<arm>-<rep>.jsonl`). Override for the style A/B:
// ARMS=raw,refs,map,src. nocg's Haiku subagent is the only sub-tier; the rest are main-only.
const ARMS = (process.env.ARMS || 'nocg,raw,offload').split(',').map((s) => s.trim()).filter(Boolean);

const toks = (u) => (u.inputTokens||0)+(u.outputTokens||0)+(u.cacheReadInputTokens||0)+(u.cacheCreationInputTokens||0);

function analyzeRun(file) {
  let result = null, agentCalls = 0;
  const tools = {}, subPids = new Set();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.parent_tool_use_id && e.message?.usage) subPids.add(e.parent_tool_use_id);
    if (e.type === 'assistant' && Array.isArray(e.message?.content))
      for (const b of e.message.content)
        if (b.type === 'tool_use') { tools[b.name] = (tools[b.name]||0)+1; if (b.name === 'Agent') agentCalls++; }
    if (e.type === 'result') result = e;
  }
  // Authoritative cost + tokens from Claude Code's per-model accounting.
  const mu = result?.modelUsage || {};
  const main = { cost: 0, tok: 0 }, sub = { cost: 0, tok: 0 };
  for (const [model, u] of Object.entries(mu)) {
    const bucket = SUB_TIER.test(model) ? sub : main; // sonnet/anything-else => main
    bucket.cost += u.costUSD || 0;
    bucket.tok  += toks(u);
  }
  return {
    main, sub, subagents: subPids.size, agentCalls,
    ccTotal: result?.total_cost_usd ?? null,
    ok: result?.subtype === 'success',
    durationSec: result?.duration_ms ? +(result.duration_ms/1000).toFixed(1) : null,
    models: Object.keys(mu), tools,
  };
}

const k = (n) => (n/1000).toFixed(0).padStart(5) + 'K';
const d = (n) => '$' + n.toFixed(3);
const cost = (b) => b.cost;
const tot  = (b) => b.tok;

const byArm = {};
for (const arm of ARMS) {
  const runs = [];
  for (let r = 1; r <= REPS; r++) {
    const f = `${runsDir}/${repo}-${arm}-${r}.jsonl`;
    if (existsSync(f)) runs.push({ rep: r, ...analyzeRun(f) });
  }
  byArm[arm] = runs;
}

// Per-run detail. Cost is Claude Code's own modelUsage.costUSD (authoritative,
// per-model pricing + correct cache TTL). MAIN=Sonnet, SUB=Haiku Explore subagent.
// cc-check: main$+sub$ must equal result.total_cost_usd (delta should be ~0).
console.log(`\n=== ${repo}: per-run main(Sonnet)/sub(Haiku) split — Claude Code's own cost accounting ===`);
console.log('arm      rep | subAg | MAIN(sonnet) tok / $ | SUB(haiku) tok / $   | TOTAL tok / $   | cc_total Δ | dur  reads');
for (const arm of ARMS) for (const r of byArm[arm]) {
  const mC = cost(r.main), sC = cost(r.sub), mT = tot(r.main), sT = tot(r.sub);
  const reads = r.tools['Read'] || 0, grep = (r.tools['Grep']||0)+(r.tools['Bash']||0)+(r.tools['Glob']||0);
  const explore = r.tools['mcp__codegraph__codegraph_explore'] || 0;
  const delta = (mC + sC) - (r.ccTotal || 0); // should be ~0
  console.log(
    `${arm.padEnd(8)} #${r.rep} | ${String(r.subagents).padStart(2)}    | ${k(mT)} ${d(mC).padStart(7)}     | ${k(sT)} ${d(sC).padStart(7)}     | ${k(mT+sT)} ${d(mC+sC).padStart(7)} | ${d(r.ccTotal||0).padStart(7)} ${(delta>=0?'+':'')+delta.toFixed(4)} | ${String(r.durationSec).padStart(5)} r=${reads} g=${grep} x=${explore}`
  );
}

// Per-arm means
const mean = (arr, f) => arr.length ? arr.reduce((s,x)=>s+f(x),0)/arr.length : 0;
console.log(`\n=== ${repo}: per-arm MEANS (n per arm) ===`);
console.log('arm      n | main $   sub $    TOTAL $  | main tok   sub tok    TOTAL tok | %$ in sub | %tok in sub');
for (const arm of ARMS) {
  const runs = byArm[arm]; if (!runs.length) continue;
  const mC = mean(runs, r=>cost(r.main)), sC = mean(runs, r=>cost(r.sub));
  const mT = mean(runs, r=>tot(r.main)),  sT = mean(runs, r=>tot(r.sub));
  const pctSubC = (mC+sC) ? (100*sC/(mC+sC)) : 0;
  const pctSubT = (mT+sT) ? (100*sT/(mT+sT)) : 0;
  console.log(
    `${arm.padEnd(8)} ${runs.length} | ${d(mC).padStart(7)} ${d(sC).padStart(7)} ${d(mC+sC).padStart(7)} | ${k(mT)} ${k(sT)} ${k(mT+sT)} | ${pctSubC.toFixed(0).padStart(3)}%      | ${pctSubT.toFixed(0).padStart(3)}%`
  );
}

// Headline ladders — cost, tokens, duration, all vs a baseline (nocg if present, else first arm).
console.log(`\n=== Ladders (mean, incl. subagent) ===`);
const totals = ARMS.map(a => ({ a, c: mean(byArm[a], r=>cost(r.main)+cost(r.sub)), t: mean(byArm[a], r=>tot(r.main)+tot(r.sub)) })).filter(x=>byArm[x.a].length);
const base = totals.find(x=>x.a==='nocg') ?? totals[0];
const bn = base?.a ?? '?';
console.log(`  COST (vs ${bn}):`);
for (const x of totals) {
  const vs = base && base.c ? ` (${((x.c/base.c-1)*100>=0?'+':'')}${((x.c/base.c-1)*100).toFixed(0)}%)` : '';
  console.log(`    ${x.a.padEnd(8)} ${d(x.c)}${vs}`);
}
console.log(`  TOKENS (vs ${bn}):`);
for (const x of totals) {
  const vs = base && base.t ? ` (${((x.t/base.t-1)*100>=0?'+':'')}${((x.t/base.t-1)*100).toFixed(0)}%)` : '';
  console.log(`    ${x.a.padEnd(8)} ${k(x.t)}${vs}`);
}
console.log(`  DURATION (wall-clock, vs ${bn}):`);
const durs = ARMS.map(a => ({ a, s: mean(byArm[a].filter(r=>r.durationSec!=null), r=>r.durationSec) })).filter(x=>byArm[x.a].length);
const dbase = durs.find(x=>x.a==='nocg') ?? durs[0];
for (const x of durs) {
  const vs = dbase && dbase.s ? ` (${((x.s/dbase.s-1)*100>=0?'+':'')}${((x.s/dbase.s-1)*100).toFixed(0)}%)` : '';
  console.log(`    ${x.a.padEnd(8)} ${x.s.toFixed(0)}s${vs}`);
}
