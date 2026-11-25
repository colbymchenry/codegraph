#!/usr/bin/env node
// Reproduction harness A — does the shared daemon serialize concurrent explore?
//
// Mirrors the daemon's reality: ONE CodeGraph + ONE ToolHandler (as MCPEngine
// shares across all sessions), then fires N concurrent codegraph_explore calls
// and measures:
//   - each call's wall-clock latency + completion order
//   - an event-loop HEARTBEAT (setInterval 50ms): the max gap between ticks is a
//     direct measure of how long synchronous compute blocked the loop. In the
//     real daemon a blocked loop can't flush a finished response or read the
//     next request, so this gap is what starves the MCP transport.
//
// Usage: node repro-concurrent-explore.mjs <repo-with-.codegraph> <N> [timeoutMs]
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [, , repo, nRaw, timeoutRaw] = process.argv;
if (!repo) {
  console.error('usage: repro-concurrent-explore.mjs <repo> <N=10> [timeoutMs=60000]');
  process.exit(1);
}
const N = Number(nRaw) || 10;
const TIMEOUT_MS = Number(timeoutRaw) || 60000; // ~ MCP SDK default request timeout

const load = async (rel) => import(pathToFileURL(resolve(rel)).href);
const idx = await load('dist/index.js');
const tools = await load('dist/mcp/tools.js');
const CodeGraph = idx.default?.default ?? idx.default ?? idx.CodeGraph;
const ToolHandler = tools.ToolHandler ?? tools.default?.ToolHandler;

// Distinct queries so no two calls are trivially identical. Mix of NL questions
// (exercise FTS + RWR over the whole graph) — the expensive explore path.
const QUERIES = [
  'how does the text model handle edits and undo',
  'how does the file service watch for changes on disk',
  'how does the keybinding service resolve a chord to a command',
  'how does the extension host activate an extension',
  'how does the editor render decorations in the viewport',
  'how does the search service stream results to the UI',
  'how does the terminal process manager spawn a shell',
  'how does the configuration service merge user and workspace settings',
  'how does the debug adapter forward breakpoints to the runtime',
  'how does the quick input widget filter its items',
  'how does the notification service queue and show toasts',
  'how does the git extension compute the diff for a file',
  'how does the language features registry dispatch a hover request',
  'how does the workbench layout restore editor groups on reload',
  'how does the storage service persist state between sessions',
  'how does the menu service build a context menu from contributions',
];

const cg = CodeGraph.openSync(repo);
let fileCount = 0;
try { fileCount = cg.getStats().fileCount; } catch {}
const handler = new ToolHandler(cg);

// --- event-loop heartbeat ---
let lastTick = performance.now();
let maxGap = 0;
const gaps = [];
const hb = setInterval(() => {
  const now = performance.now();
  const gap = now - lastTick;
  lastTick = now;
  if (gap > 60) gaps.push(Math.round(gap)); // expected ~50ms; record stalls
  if (gap > maxGap) maxGap = gap;
}, 50);

function runOne(i) {
  const q = QUERIES[i % QUERIES.length];
  const startedAt = performance.now();
  let timer;
  const timeout = new Promise((res) => {
    timer = setTimeout(() => res({ timedOut: true }), TIMEOUT_MS);
  });
  const work = handler
    .execute('codegraph_explore', { query: q })
    .then((r) => ({ ok: !r.isError, chars: r.content?.[0]?.text?.length ?? 0 }))
    .catch((e) => ({ ok: false, err: String(e?.message ?? e) }));
  return Promise.race([work, timeout]).then((r) => {
    clearTimeout(timer);
    return { i, q, ms: Math.round(performance.now() - startedAt), ...r };
  });
}

// Baseline: one warm single call (so the first-call cold paths don't skew N).
const warmStart = performance.now();
await runOne(0);
const warmMs = Math.round(performance.now() - warmStart);

// Reset heartbeat stats for the concurrent run.
gaps.length = 0; maxGap = 0; lastTick = performance.now();

const batchStart = performance.now();
const results = await Promise.all(Array.from({ length: N }, (_, i) => runOne(i)));
const batchMs = Math.round(performance.now() - batchStart);
clearInterval(hb);

const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const timeouts = results.filter((r) => r.timedOut).length;
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];

console.log('='.repeat(64));
console.log(`repo=${repo}`);
console.log(`fileCount=${fileCount}  N=${N}  perCallTimeout=${TIMEOUT_MS}ms`);
console.log(`single warm explore: ${warmMs}ms`);
console.log('-'.repeat(64));
console.log(`concurrent batch wall-clock: ${batchMs}ms`);
console.log(`per-call latency  min=${lat[0]}  p50=${p(0.5)}  p90=${p(0.9)}  max=${lat[lat.length - 1]}  (ms)`);
console.log(`TIMEOUTS (>${TIMEOUT_MS}ms): ${timeouts} / ${N}`);
console.log(`event-loop max stall: ${Math.round(maxGap)}ms   stalls>60ms: ${gaps.length}`);
console.log(`  sum of stalls: ${gaps.reduce((a, b) => a + b, 0)}ms   biggest 5: ${gaps.sort((a,b)=>b-a).slice(0,5).join(', ')}`);
console.log('-'.repeat(64));
console.log('SERIALIZATION CHECK:');
console.log(`  if serialized, batch ≈ N×single = ~${N * warmMs}ms;  actual=${batchMs}ms  (ratio ${(batchMs / (N * warmMs)).toFixed(2)})`);
console.log(`  max latency / single = ${(lat[lat.length - 1] / warmMs).toFixed(1)}× (≈N means last call waited for all others)`);
console.log('='.repeat(64));
try { cg.close?.(); } catch {}
