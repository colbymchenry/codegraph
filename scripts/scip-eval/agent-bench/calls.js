// calls.js <task> <arm>: the run's tool calls in order — Bash commands and codegraph queries, shortened.
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNS = process.env.BENCH_RUNS || path.join(os.homedir(), '.cache/codegraph-scip-eval/bench');
const [task, arm] = process.argv.slice(2);
if (!task || !arm) {
  console.error('usage: calls.js <task> <arm>');
  process.exit(2);
}
let i = 0;
for (const l of fs.readFileSync(path.join(RUNS, `${task}-${arm}`, 'run.jsonl'), 'utf8').split('\n')) {
  if (!l) continue;
  const e = JSON.parse(l);
  if (e.type !== 'assistant') continue;
  for (const c of e.message?.content ?? []) {
    if (c.type !== 'tool_use') continue;
    const what = c.input?.command ?? c.input?.query ?? JSON.stringify(c.input);
    console.log(`${++i}. ${c.name.replace('mcp__codegraph__', 'cg:')}: ${String(what).replace(/\s+/g, ' ').slice(0, 170)}`);
  }
}
