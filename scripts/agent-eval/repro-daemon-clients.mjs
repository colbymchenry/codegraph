#!/usr/bin/env node
// Reproduction harness B — the FAITHFUL opencode scenario.
//
// Spawns N real `codegraph serve --mcp --path <repo>` processes (each becomes a
// proxy that attaches to ONE shared daemon — exactly what opencode does with N
// subagents), drives clean MCP JSON-RPC over each child's stdio, then fires ONE
// concurrent wave of codegraph_explore tools/call across all N and measures
// end-to-end latency + timeouts. This captures transport-flush starvation: a
// daemon event-loop blocked in synchronous explore compute can neither read the
// next request nor flush a finished response.
//
// Usage: node repro-daemon-clients.mjs <repo> <N=10> [perCallTimeoutMs=60000] [warm=1]
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';

const [, , repoRaw, nRaw, timeoutRaw, warmRaw] = process.argv;
const repo = resolve(repoRaw || '.');
const N = Number(nRaw) || 10;
const TIMEOUT_MS = Number(timeoutRaw) || 60000;
const WARM = warmRaw === undefined ? true : warmRaw !== '0';
const CLI = resolve('dist/bin/codegraph.js');

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
];

function makeClient(id) {
  const child = spawn('node', [CLI, 'serve', '--mcp', '--path', repo], {
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_MCP_LOG_ATTACH: '0' },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let buf = '';
  const waiters = new Map(); // id -> resolve
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && waiters.has(msg.id)) {
        waiters.get(msg.id)(msg);
        waiters.delete(msg.id);
      }
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params, rpcId, timeoutMs) =>
    new Promise((res) => {
      let timer;
      if (timeoutMs) timer = setTimeout(() => { waiters.delete(rpcId); res({ __timeout: true }); }, timeoutMs);
      waiters.set(rpcId, (m) => { if (timer) clearTimeout(timer); res(m); });
      send({ jsonrpc: '2.0', id: rpcId, method, params });
    });
  return { id, child, send, request };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const clients = Array.from({ length: N }, (_, i) => makeClient(i));

// Initialize every client (handshake is answered locally by each proxy, instant).
await Promise.all(clients.map((c) =>
  c.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'repro', version: '1' } }, `init-${c.id}`, 10000)
    .then(() => c.send({ jsonrpc: '2.0', method: 'initialized' }))
));

// Warm the daemon: one explore through client 0 forces daemon spawn + project
// open + catch-up gate to complete, so the concurrent wave measures the STEADY
// state (the user's real scenario after the first call), not cold start.
if (WARM) {
  process.stderr.write('[repro] warming daemon (first explore triggers spawn+open+catchup)...\n');
  const t0 = performance.now();
  const r = await clients[0].request('tools/call', { name: 'codegraph_explore', arguments: { query: QUERIES[0] } }, 'warm-0', 120000);
  process.stderr.write(`[repro] warm explore took ${Math.round(performance.now() - t0)}ms (timeout=${!!r.__timeout})\n`);
  await sleep(500);
}

// THE WAVE: fire one explore on every client as simultaneously as possible.
process.stderr.write(`[repro] firing ${N} concurrent explores...\n`);
const waveStart = performance.now();
const results = await Promise.all(clients.map((c, i) => {
  const started = performance.now();
  return c.request('tools/call', { name: 'codegraph_explore', arguments: { query: QUERIES[i % QUERIES.length] } }, `call-${c.id}`, TIMEOUT_MS)
    .then((m) => ({
      id: c.id,
      ms: Math.round(performance.now() - started),
      timedOut: !!m.__timeout,
      ok: !!m.result && !m.result.isError,
      chars: m.result?.content?.[0]?.text?.length ?? 0,
    }));
}));
const waveMs = Math.round(performance.now() - waveStart);

const lat = results.map((r) => r.ms).sort((a, b) => a - b);
const timeouts = results.filter((r) => r.timedOut).length;
const p = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];

console.log('='.repeat(64));
console.log(`HARNESS B (real daemon + ${N} proxies)   repo=${repo}`);
console.log(`warm=${WARM}  perCallTimeout=${TIMEOUT_MS}ms`);
console.log('-'.repeat(64));
console.log(`wave wall-clock: ${waveMs}ms`);
console.log(`per-call latency  min=${lat[0]}  p50=${p(0.5)}  p90=${p(0.9)}  max=${lat[lat.length - 1]}  (ms)`);
console.log(`TIMEOUTS (>${TIMEOUT_MS}ms): ${timeouts} / ${N}`);
console.log(`completion order (id:ms): ${results.slice().sort((a,b)=>a.ms-b.ms).map(r=>`${r.id}:${r.ms}`).join('  ')}`);
console.log('='.repeat(64));

for (const c of clients) { try { c.child.stdin.end(); c.child.kill('SIGTERM'); } catch {} }
await sleep(300);
process.exit(0);
