import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, realpathSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { execFile } from 'child_process';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { CodeGraph } from '../src';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
it('D1 applies model verdicts, preserves failed responses, and refuses remote prompts by default', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'cg-live-hook-'))); dirs.push(root);
  writeFileSync(join(root, 'orders.ts'), 'export function submitOrder() { return true; }\n');
  const cg = CodeGraph.initSync(root); await cg.indexAll(); cg.close();
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('CODEGRAPH_DECISION')));
  const env = { ...base, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_NO_RELAUNCH: '1', CODEGRAPH_WASM_RELAUNCHED: '1', CODEGRAPH_NO_PROMPT_HOOK: '0', CODEGRAPH_PROMPT_HOOK: '1', CODEGRAPH_DECISION_POINTS: 'D1', CODEGRAPH_DECISIONS_QUERY_TIMEOUT_MS: '100' };
  // execFile has no input option: feed the real hook's stdin, keeping its event loop free for the HTTP fixture.
  const run = (prompt: string, extra = {}) => new Promise<string>((resolveRun, reject) => {
    const child = execFile(process.execPath, [resolve(__dirname, '../dist/bin/codegraph.js'), 'prompt-hook'], { cwd: root, env: { ...env, ...extra }, encoding: 'utf8', timeout: 15_000, maxBuffer: 1 << 20 }, (err, stdout) => err ? reject(err) : resolveRun(stdout));
    child.stdin!.end(JSON.stringify({ prompt, cwd: root }));
  });
  const ordinary = 'Please help', structural = 'trace the request flow';
  expect(await run(ordinary)).toBe(''); const off = await run(structural); expect(off).toContain('<codegraph_context');
  let value: number | null = 1, malformed = false, hits = 0;
  const server = createServer((req, res) => { req.resume(); req.on('end', () => { hits++; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(malformed ? {} : { answers: { structural: { noul: value } }, model: 'fixture', usage: {} })); }); });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  const model = { CODEGRAPH_DECISIONS: 'cf', CODEGRAPH_DECISIONS_URL: url };
  try {
    expect(await run(ordinary, model)).toContain('<codegraph_context'); expect(hits).toBe(1);
    value = 0; expect(await run(structural, model)).toBe('');
    const edit = 'Translate the sentence about submitOrder() into Korean';
    const symbolFallback = await run(edit); expect(symbolFallback).toContain('<codegraph_context');
    value = .05;
    expect(await run(edit, model)).toBe(''); // A strong negative must also stop the verified-symbol fallback.
    value = .1; expect(await run(edit, model)).toBe(symbolFallback); // Preserve symbol evidence below the stronger veto floor.
    value = .55; expect(await run(edit, model)).toBe(symbolFallback); // Uncertain answers still use the heuristic.
    value = null; expect(await run(structural, model)).toBe(off);
    malformed = true; expect(await run(structural, model)).toBe(off);
    expect(await run(structural, { ...model, CODEGRAPH_DECISIONS_URL: 'http://127.0.0.1:9/v1/systemone' })).toBe(off);
    const ledger = join(root, 'remote.ledger.jsonl');
    expect(await run(structural, { ...model, CODEGRAPH_DECISIONS_URL: 'https://localhost.example.invalid/v1/systemone', CODEGRAPH_DECISION_LEDGER: ledger })).toBe(off);
    expect(existsSync(ledger)).toBe(false);
    expect(await run(structural, { CODEGRAPH_DECISIONS: 'auto', CODEGRAPH_DECISION_LEDGER: ledger })).toBe(off);
    expect(existsSync(ledger)).toBe(false);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
}, 120_000);
