// calls.js <task> <arm> [n]: run n's tool calls in order (default the first) — Bash commands and codegraph queries, shortened.
// BENCH_MODEL picks the model's logs, as bench.sh writes them.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNS = process.env.BENCH_RUNS || path.join(os.homedir(), '.cache/codegraph-scip-eval/bench');
const MODEL = process.env.BENCH_MODEL || 'sonnet';
const [task, arm, n = '1'] = process.argv.slice(2);
if (!task || !arm) {
  console.error('usage: calls.js <task> <arm> [n]');
  process.exit(2);
}
const dir = path.join(RUNS, `${task}-${arm}`, MODEL === 'sonnet' ? '' : MODEL);
const file = [path.join(dir, `run-${n}.jsonl`), ...(n === '1' ? [path.join(dir, 'run.jsonl')] : [])].find(f => fs.existsSync(f));
if (!file) {
  console.error(`no run ${n} in ${dir}`);
  process.exit(1);
}
let i = 0;
for (const l of fs.readFileSync(file, 'utf8').split('\n')) {
  if (!l) continue;
  const e = JSON.parse(l);
  if (e.type !== 'assistant') continue;
  for (const c of e.message?.content ?? []) {
    if (c.type !== 'tool_use') continue;
    const what = c.input?.command ?? c.input?.query ?? JSON.stringify(c.input);
    console.log(`${++i}. ${c.name.replace('mcp__codegraph__', 'cg:')}: ${String(what).replace(/\s+/g, ' ').slice(0, 170)}`);
  }
}
