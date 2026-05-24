#!/usr/bin/env node
// Aggregate the README A/B (bench-readme.sh output): per repo, median of N runs
// per arm → time, tool calls, tokens, cost, and % saved. Plus an average row.
//
// Tokens = SUM of per-turn assistant `usage` (input + output + cache read +
// cache creation) — the cumulative "total tokens processed". NOTE: `result.usage`
// is last-turn-only in current Claude Code, so it under-counts badly; don't use it.
// `total_cost_usd` and `duration_ms` are already cumulative.
//
// Usage: node parse-bench-readme.mjs [/tmp/ab-readme]
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
const ROOT = process.argv[2] || '/tmp/ab-readme';
const REPOS = ['vscode', 'excalidraw', 'django', 'tokio', 'okhttp', 'gin', 'alamofire'];

function parse(file) {
  if (!existsSync(file)) return null;
  const L = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  let tools = 0, reads = 0, grep = 0, cg = 0, tokens = 0, r = null;
  for (const l of L) { let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type === 'assistant') {
      const u = e.message?.usage;
      if (u) tokens += (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      for (const b of (e.message?.content || [])) if (b.type === 'tool_use') {
        const n = b.name;
        if (n === 'ToolSearch') continue;
        tools++;
        if (n === 'Read') reads++;
        else if (n === 'Grep' || n === 'Glob') grep++;
        else if (/codegraph/.test(n)) cg++;
      }
    }
    if (e.type === 'result') r = e;
  }
  if (!r || r.subtype !== 'success') return null;
  return { dur: r.duration_ms / 1000, tools, reads, grep, cg, tokens, cost: r.total_cost_usd || 0 };
}
const median = (arr) => { const v = [...arr].sort((a, b) => a - b); const n = v.length; return n === 0 ? 0 : n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2; };
const fmtTime = (s) => s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`;
const fmtTok = (t) => t >= 1e6 ? `${(t / 1e6).toFixed(1)}M` : `${Math.round(t / 1000)}k`;
const pct = (w, wo) => wo > 0 ? Math.round((1 - w / wo) * 100) : 0;

console.log('repo        n(w/wo)  time WITH→WITHOUT      tools W→WO   tokens W→WO (saved)     cost W→WO (saved)');
const savings = { cost: [], tokens: [], time: [], tools: [] };
for (const repo of REPOS) {
  const dir = join(ROOT, repo);
  const runDirs = existsSync(dir) ? readdirSync(dir).filter(d => /^run\d+$/.test(d)) : [];
  const W = [], WO = [];
  for (const rd of runDirs) {
    const w = parse(join(dir, rd, 'run-headless-with.jsonl')); if (w) W.push(w);
    const wo = parse(join(dir, rd, 'run-headless-without.jsonl')); if (wo) WO.push(wo);
  }
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
    `$${wC.toFixed(2)}→$${woC.toFixed(2)} (${pct(wC, woC)}%)`
  );
}
const avg = (a) => a.length ? Math.round(a.reduce((s, x) => s + x, 0) / a.length) : 0;
console.log(`\nAVERAGE saved:  cost ${avg(savings.cost)}%  ·  tokens ${avg(savings.tokens)}%  ·  time ${avg(savings.time)}%  ·  tool calls ${avg(savings.tools)}%`);
