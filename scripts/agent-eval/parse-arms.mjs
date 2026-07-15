#!/usr/bin/env node
// Analyze the tool-surface ablation (/tmp/arms/<repo>/<arm>-r<n>.jsonl).
// Compares arms A–E on trace adoption, Read/Grep fallback, codegraph payload,
// round-trips, and duration — averaged across runs per arm.
//
// The decisive signal is READS: if removing a tool raises Reads on a question
// class, that tool was load-bearing for it (not redundant). If removing it
// changes nothing, it was redundant.
//
//   A control       all tools            no steering   (baseline)
//   B steer         all tools            trace-first   (adoption)
//   C no-explore    hide explore         trace-first   (is explore redundant?)
//   D trace-centric hide explore+context trace-first   (is the survey pair redundant?)
//   E control-probe hide explore+context trace-first   (NON-flow Q — should degrade)
//
// Usage: node scripts/agent-eval/parse-arms.mjs [/tmp/arms]
import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = process.argv[2] || '/tmp/arms';
const cgShort = (n) => n.replace('mcp__codegraph__codegraph_', '').replace('mcp__codegraph__', '');

function parse(file) {
  if (!existsSync(file)) return null;
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const calls = []; let result = null, initCg = 0;
  for (const l of lines) {
    let ev; try { ev = JSON.parse(l); } catch { continue; }
    if (ev.type === 'system' && ev.subtype === 'init') initCg = (ev.tools || []).filter(t => /codegraph/.test(t)).length;
    if (ev.type === 'assistant') for (const b of (ev.message?.content || [])) if (b.type === 'tool_use')
      calls.push({ id: b.id, name: b.name, out: 0 });
    if (ev.type === 'user') for (const b of (ev.message?.content || [])) if (b.type === 'tool_result') {
      const c = b.content;
      const txt = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.text || '').join('') : '';
      const call = calls.find(k => k.id === b.tool_use_id); if (call) call.out = txt.length;
    }
    if (ev.type === 'result') result = ev;
  }
  const cg = calls.filter(c => c.name.includes('codegraph'));
  return {
    initCg,
    reads: calls.filter(c => c.name === 'Read').length,
    greps: calls.filter(c => c.name === 'Grep').length + calls.filter(c => c.name === 'Glob').length,
    cgCalls: cg.length,
    cgSeq: cg.map(c => cgShort(c.name)),
    cgOut: cg.reduce((s, c) => s + c.out, 0),
    traceUsed: cg.some(c => c.name.includes('trace')),
    turns: result?.num_turns ?? null,
    dur: result?.duration_ms ? Math.round(result.duration_ms / 1000) : null,
    cost: result?.total_cost_usd || 0,
    ok: result?.subtype === 'success',
  };
}

// repo -> arm -> [runs]
const data = {};
if (!existsSync(ROOT)) { console.error(`no ${ROOT}`); process.exit(1); }
for (const repo of readdirSync(ROOT)) {
  const rdir = join(ROOT, repo);
  if (!statSync(rdir).isDirectory()) continue;
  for (const f of readdirSync(rdir)) {
    const m = f.match(/^([A-I])-r(\d+)\.jsonl$/); if (!m) continue;
    const p = parse(join(rdir, f)); if (!p || !p.ok) continue;
    (((data[repo] ??= {})[m[1]]) ??= []).push(p);
  }
}

const avg = (a, f) => a.length ? a.reduce((s, x) => s + (f(x) || 0), 0) / a.length : 0;
const k = (n) => (n / 1000).toFixed(1);
const pad = (s, n) => String(s).padEnd(n);
const ARMS = ['A', 'H', 'I', 'B', 'F', 'G', 'C', 'D', 'E'];
const LABEL = { A: 'A all/none(old)', H: 'H body-trace/none', I: 'I bodytrace+dest', B: 'B all/steer(thin)', F: 'F all/steer(body)', G: 'G ported(noprompt)', C: 'C no-explore', D: 'D trace-centric', E: 'E nonflow-probe' };

// ---- per repo × arm ----
console.log('\n=== PER REPO × ARM (avg over runs) ===');
console.log(pad('repo', 22), pad('arm', 16), 'tools', 'trace', pad('reads', 6), pad('cgOutK', 7), pad('turns', 6), 'dur');
for (const repo of Object.keys(data).sort()) {
  for (const arm of ARMS) {
    const runs = data[repo][arm]; if (!runs?.length) continue;
    console.log(
      pad(repo, 22), pad(LABEL[arm], 16),
      pad(runs[0].initCg, 5),
      pad(runs.filter(r => r.traceUsed).length + '/' + runs.length, 5),
      pad(avg(runs, r => r.reads).toFixed(1), 6),
      pad(k(avg(runs, r => r.cgOut)), 7),
      pad(avg(runs, r => r.turns).toFixed(1), 6),
      avg(runs, r => r.dur).toFixed(0) + 's',
    );
  }
}

// ---- aggregate per arm (flow arms A–D over the flow repos; E shown apart) ----
console.log('\n=== AGGREGATE PER ARM (mean across repos) ===');
console.log(pad('arm', 16), pad('adoption', 9), pad('reads', 7), pad('greps', 7), pad('cgOutK', 8), pad('turns', 7), pad('dur', 6), 'cost');
for (const arm of ARMS) {
  const all = [];
  for (const repo of Object.keys(data)) for (const r of (data[repo][arm] || [])) all.push({ ...r, repo });
  if (!all.length) continue;
  const repos = new Set(all.map(r => r.repo)).size;
  const adopt = all.filter(r => r.traceUsed).length;
  console.log(
    pad(LABEL[arm], 16),
    pad(`${adopt}/${all.length}`, 9),
    pad(avg(all, r => r.reads).toFixed(2), 7),
    pad(avg(all, r => r.greps).toFixed(2), 7),
    pad(k(avg(all, r => r.cgOut)), 8),
    pad(avg(all, r => r.turns).toFixed(1), 7),
    pad(avg(all, r => r.dur).toFixed(0) + 's', 6),
    '$' + avg(all, r => r.cost).toFixed(3),
    `  (${repos} repos)`,
  );
}

console.log('\nRead the signal: B vs A = does steering alone fix adoption + cut payload.');
console.log('C vs B = is explore redundant (reads should NOT jump). D vs C = is context redundant.');
console.log('E = non-flow under trace-centric; reads SHOULD jump (proves survey tools are load-bearing).');
