#!/usr/bin/env node
// Aggregate judged.jsonl (or results.jsonl) into a per-repo, per-arm report:
// time, main tokens/cost, AI tokens/cost, total cost, tool mix, accuracy.
// Usage: summarize.mjs <judged-or-results.jsonl>
import { readFileSync } from 'fs';
const rows = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

const med = (xs) => { const a = xs.filter(x => x != null).sort((p, q) => p - q); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const rng = (xs) => { const a = xs.filter(x => x != null); return a.length ? `${Math.min(...a)}–${Math.max(...a)}` : '—'; };
const d2 = (x) => x == null ? '—' : (+x).toFixed(2);
const d3 = (x) => x == null ? '—' : (+x).toFixed(3);
const d4 = (x) => x == null ? '—' : (+x).toFixed(4);

const ARM_ORDER = ['frontload', 'offload', 'raw', 'nocg'];
const byRepo = {};
for (const r of rows) (byRepo[r.repo] ??= {});
for (const r of rows) ((byRepo[r.repo][r.arm] ??= []).push(r));

const verdictTally = (rs, field) => {
  const t = { pass: 0, partial: 0, fail: 0, error: 0 };
  for (const r of rs) { const v = r[field]?.verdict; if (v in t) t[v]++; }
  return t;
};

for (const repo of Object.keys(byRepo)) {
  const tier = byRepo[repo][Object.keys(byRepo[repo])[0]][0].tier;
  console.log(`\n${'='.repeat(78)}\n${repo}  [${tier}]\n${'='.repeat(78)}`);
  console.log(`${'arm'.padEnd(9)} n  ${'time(s)'.padStart(9)} ${'mainCost'.padStart(9)} ${'aiCost'.padStart(8)} ${'totCost'.padStart(8)} ${'mainTok'.padStart(8)} ${'aiTok'.padStart(7)} ${'rd'.padStart(3)} ${'gr'.padStart(3)} ${'exp'.padStart(3)} ${'off'.padStart(3)}  e2e(P/p/F)  fidScore`);
  for (const arm of ARM_ORDER) {
    const rs = byRepo[repo][arm]; if (!rs) continue;
    const n = rs.length;
    const mainCost = med(rs.map(r => r.costUsdMain));
    const aiCost = med(rs.map(r => r.ai?.costUsd ?? 0));
    const totCost = (mainCost ?? 0) + (aiCost ?? 0);
    const e2e = verdictTally(rs, 'e2e');
    const fidScores = arm === 'offload' ? rs.flatMap(r => r.fidelity?.scores ?? []) : [];
    const fid = fidScores.length ? med(fidScores) : null;
    const fab = arm === 'offload' && rs.some(r => r.fidelity?.anyFabrication);
    const e2eScore = med(rs.map(r => r.e2e?.score).filter(x => x != null));
    console.log(
      `${arm.padEnd(9)} ${String(n).padStart(1)}  ${String(med(rs.map(r => r.durationSec))).padStart(9)} ` +
      `${('$' + d3(mainCost)).padStart(9)} ${('$' + d3(aiCost)).padStart(8)} ${('$' + d3(totCost)).padStart(8)} ` +
      `${String(Math.round(med(rs.map(r => r.tokBillable)) / 1000) + 'k').padStart(8)} ${String(Math.round(med(rs.map(r => r.ai?.totalTokens ?? 0)) / 1000) + 'k').padStart(7)} ` +
      `${String(med(rs.map(r => r.read))).padStart(3)} ${String(med(rs.map(r => r.grep))).padStart(3)} ${String(med(rs.map(r => r.explore))).padStart(3)} ${String(med(rs.map(r => r.offloadFired))).padStart(3)}  ` +
      `${(e2e.pass + '/' + e2e.partial + '/' + e2e.fail).padStart(9)}  ${e2eScore != null ? 'e2e=' + e2eScore : ''} ${fid != null ? 'fid=' + fid + (fab ? ' FAB!' : '') : ''}`
    );
  }
  // ranges line for the two key metrics (variance matters)
  for (const arm of ARM_ORDER) {
    const rs = byRepo[repo][arm]; if (!rs) continue;
    console.log(`   ${arm} ranges: time ${rng(rs.map(r => r.durationSec))}s · mainCost $${rng(rs.map(r => r.costUsdMain))} · read ${rng(rs.map(r => r.read))} · explore ${rng(rs.map(r => r.explore))} · offloadFired ${rng(rs.map(r => r.offloadFired))}`);
  }
}

// Cross-repo roll-up: offload vs raw vs nocg deltas
console.log(`\n${'='.repeat(78)}\nCROSS-REPO SUMMARY (medians per repo, then averaged)\n${'='.repeat(78)}`);
console.log(`${'repo'.padEnd(12)} ${'arm'.padEnd(8)} ${'time'.padStart(7)} ${'totCost'.padStart(8)} ${'read'.padStart(5)} ${'e2e pass%'.padStart(9)} ${'fid'.padStart(5)}`);
for (const repo of Object.keys(byRepo)) {
  for (const arm of ARM_ORDER) {
    const rs = byRepo[repo][arm]; if (!rs) continue;
    const e2e = verdictTally(rs, 'e2e');
    const passPct = Math.round(100 * e2e.pass / rs.length);
    const totCost = (med(rs.map(r => r.costUsdMain)) ?? 0) + (med(rs.map(r => r.ai?.costUsd ?? 0)) ?? 0);
    const fid = arm === 'offload' ? med(rs.flatMap(r => r.fidelity?.scores ?? [])) : null;
    console.log(`${repo.padEnd(12)} ${arm.padEnd(8)} ${(med(rs.map(r => r.durationSec)) + 's').padStart(7)} ${('$' + d3(totCost)).padStart(8)} ${String(med(rs.map(r => r.read))).padStart(5)} ${(passPct + '%').padStart(9)} ${String(fid ?? '—').padStart(5)}`);
  }
}
console.log('');
