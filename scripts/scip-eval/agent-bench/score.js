// score.js <task> [arm ...]: score each arm's runs of <task> (bench.sh) against tasks/<task>/truth.txt, with their cost;
// with several runs, an average line per arm. BENCH_MODEL picks the model's logs, as bench.sh writes them.
//
// Call-site tasks: the answer's `CALL SITES` section of `path:line`; a reported site matches a truth site in the same
// file within ±2 lines (a chain's call may be cited at either end), each truth site at most once.
// Two-level tasks (truth lines `<level> <path> <name>`): the answer's last `LEVEL 1` / `LEVEL 2` heading lines — prose may
// say "level 2 callers" earlier — of `path name`, matched on file and the name's last `::` segment.
// Cost: turns, tool calls by name, tokens summed once per assistant message, cost and wall time from the result event.
// Adoption (roadmap 8.1/8.2): whether the run called codegraph, and how many tool calls came after its first answer.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNS = process.env.BENCH_RUNS || path.join(os.homedir(), '.cache/codegraph-scip-eval/bench');
const [task, ...arms] = process.argv.slice(2);
if (!task) {
  console.error('usage: score.js <task> [arm ...]');
  process.exit(2);
}
const raw = fs.readFileSync(path.join(__dirname, 'tasks', task, 'truth.txt'), 'utf8').split('\n').filter(Boolean);
const levels = /^\d /.test(raw[0] ?? '')
  ? raw.map(s => { const [level, file, name] = s.split(' '); return { level: Number(level), file, name: name.split('::').pop() }; })
  : null;
const sites = levels ? [] : raw.map(s => { const i = s.lastIndexOf(':'); return { file: s.slice(0, i), line: Number(s.slice(i + 1)) }; });

/** Matches `got` against `want` one-to-one; returns the hits and what was left over on each side. */
function match(want, got, same, show) {
  const used = new Set();
  const wrong = [];
  for (const g of got) {
    const i = want.findIndex((w, k) => !used.has(k) && same(w, g));
    if (i >= 0) used.add(i);
    else wrong.push(show(g));
  }
  return { hits: used.size, wrong, missed: want.filter((_, k) => !used.has(k)).map(show) };
}

const MODEL = process.env.BENCH_MODEL || 'sonnet';

/** One run's score line, details, and the numbers averaged per arm. */
function scoreRun(file) {
  const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const result = events.find(e => e.type === 'result') ?? {};
  const tools = {};
  const seen = new Set();
  let tokens = 0;
  let afterCg = null; // tool calls after the first codegraph call; null: it never called codegraph
  for (const e of events) {
    if (e.type !== 'assistant') continue;
    const m = e.message ?? {};
    if (!seen.has(m.id)) {
      seen.add(m.id);
      const u = m.usage ?? {};
      tokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0);
    }
    for (const c of m.content ?? []) {
      if (c.type !== 'tool_use') continue;
      tools[c.name] = (tools[c.name] ?? 0) + 1;
      if (afterCg !== null) afterCg++;
      else if (c.name.startsWith('mcp__codegraph__')) afterCg = 0;
    }
  }
  const answer = String(result.result ?? '');
  const calls = Object.values(tools).reduce((a, b) => a + b, 0);
  const toolList = Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n.replace('mcp__codegraph__', 'cg:')} ${c}`).join(', ');
  const cost = ` | turns ${result.num_turns ?? '?'}, tool calls ${calls} (${toolList})${afterCg === null ? '' : `, ${afterCg} after codegraph`}` +
    ` | tokens ${(tokens / 1000).toFixed(0)}k, cost $${(result.total_cost_usd ?? 0).toFixed(2)}, time ${((result.duration_ms ?? 0) / 1000).toFixed(0)} s`;

  const rows = [];
  const detail = [];
  let recall = null;
  if (levels) {
    const at = h => { let i = -1; for (const m of answer.matchAll(new RegExp(`^[#*\\s]*${h}[*\\s:]*$`, 'gm'))) i = m.index; return i; };
    const i1 = at('LEVEL 1');
    const i2 = at('LEVEL 2');
    const sections = { 1: i1 >= 0 ? answer.slice(i1, i2 > i1 ? i2 : undefined) : '', 2: i2 >= 0 ? answer.slice(i2) : '' };
    for (const lvl of [1, 2]) {
      const want = levels.filter(t => t.level === lvl);
      const got = [...sections[lvl].matchAll(/([\w./-]+\.\w+)\s+`?([\w:]+)`?/g)].map(m => ({ file: m[1], name: m[2].split('::').pop() }));
      const r = match(want, got, (w, g) => w.file === g.file && w.name === g.name, x => `${x.file} ${x.name}`);
      rows.push(`L${lvl} recall ${r.hits}/${want.length}, precision ${r.hits}/${got.length}`);
      recall = (recall ?? 0) + r.hits / want.length / 2;
      if (r.wrong.length) detail.push(`   L${lvl} wrong: ${r.wrong.join(', ')}`);
      if (r.missed.length) detail.push(`   L${lvl} missed: ${r.missed.join(', ')}`);
    }
  } else {
    const section = answer.split(/CALL SITES/i).pop() ?? '';
    const got = [...section.matchAll(/([\w./@-]+\.\w+):(\d+)/g)].map(m => ({ file: m[1].replace(/^\.\//, ''), line: Number(m[2]) }));
    const r = match(sites, got, (w, g) => w.file === g.file && Math.abs(w.line - g.line) <= 2, x => `${x.file}:${x.line}`);
    rows.push(`recall ${r.hits}/${sites.length}, precision ${r.hits}/${got.length}`);
    recall = r.hits / sites.length;
    if (r.wrong.length) detail.push(`   reported, not a call to the target: ${r.wrong.join(', ')}`);
    if (r.missed.length) detail.push(`   missed: ${r.missed.join(', ')}`);
  }
  return {
    line: `${rows.join('; ')}${cost}`, detail,
    n: { recall, calls, tokens, cost: result.total_cost_usd ?? 0, time: (result.duration_ms ?? 0) / 1000, usedCg: afterCg !== null, afterCg },
  };
}

for (const arm of arms.length ? arms : ['A', 'B', 'C']) {
  const dir = path.join(RUNS, `${task}-${arm}`, MODEL === 'sonnet' ? '' : MODEL);
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter(f => /^run(-\d+)?\.jsonl$/.test(f)).sort((a, b) => (Number(a.match(/\d+/)?.[0] ?? 1)) - (Number(b.match(/\d+/)?.[0] ?? 1)))
    : [];
  if (files.length === 0) {
    console.log(`${task}-${arm}: no run`);
    continue;
  }
  const runs = files.map(f => ({ f, ...scoreRun(path.join(dir, f)) }));
  for (const r of runs) {
    console.log(`${task}-${arm}${runs.length > 1 ? `#${r.f.match(/\d+/)?.[0] ?? 1}` : ''}: ${r.line}`);
    for (const d of r.detail) console.log(d);
  }
  if (runs.length > 1) {
    const mean = k => runs.reduce((a, r) => a + (r.n[k] ?? 0), 0) / runs.length;
    const used = runs.filter(r => r.n.usedCg);
    console.log(`${task}-${arm} mean of ${runs.length}: recall ${(100 * mean('recall')).toFixed(0)}%, tool calls ${mean('calls').toFixed(1)}, ` +
      `tokens ${(mean('tokens') / 1000).toFixed(0)}k, cost $${mean('cost').toFixed(2)}, time ${mean('time').toFixed(0)} s` +
      (arm === 'A' ? '' : ` | called codegraph in ${used.length}/${runs.length}` +
        (used.length ? `, ${(used.reduce((a, r) => a + r.n.afterCg, 0) / used.length).toFixed(1)} tool calls after it` : '')));
  }
}
