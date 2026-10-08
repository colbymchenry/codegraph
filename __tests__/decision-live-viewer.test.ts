import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { CodeGraph } from '../src';
import { buildSteps } from '../src/ui-server/api/steps';
import { resetDecisionConfig } from '../src/decision/config';
import { resetLive } from '../src/decision/live';

afterEach(() => { vi.unstubAllEnvs(); resetDecisionConfig(); resetLive(); });
it('F1 changes, adds and vetoes real effect sites, with identical fallback on failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cg-live-viewer-'));
  writeFileSync(join(root, 'entry.ts'), "export function entry() {\n  fetch('/health');\n  mystery.send('payload');\n}\n");
  const cg = CodeGraph.initSync(root); await cg.indexAll();
  const anchor = cg.getNodesByName('entry').find(n => n.kind === 'function')!.id;
  const query = new URLSearchParams({ anchor });
  const normalized = (x: unknown) => JSON.stringify(x, (k, v) => k === 'timing' ? undefined : v);
  const off = await buildSteps(cg, root, query);
  expect(off.steps.filter(s => s.kind === 'effect').map(s => s.effect?.category)).toEqual(['network']);
  let veto = false, malformed = false, hits = 0;
  const server = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      hits++; const body = JSON.parse(raw); const category = body.state.call.text === 'fetch' ? veto ? 'none' : 'database' : 'queue';
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(malformed ? {} : { model: 'fixture', answers: { category: { choice: category, confidence: 1, probabilities: {} }, write: { noul: 1 } }, usage: {} }));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/systemone`;
  const live = (endpoint: string) => {
    vi.stubEnv('CODEGRAPH_DECISIONS', 'cf'); vi.stubEnv('CODEGRAPH_DECISIONS_URL', endpoint);
    vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'F1'); vi.stubEnv('CODEGRAPH_DECISIONS_TIMEOUT_MS', '100'); resetDecisionConfig(); resetLive();
  };
  try {
    live(url); const changed = await buildSteps(cg, root, query);
    expect(hits).toBeGreaterThan(0);
    expect(changed.steps.filter(s => s.kind === 'effect').map(s => s.effect?.category).sort()).toEqual(['database', 'queue']);
    veto = true; const removed = await buildSteps(cg, root, query);
    expect(removed.steps.filter(s => s.kind === 'effect').map(s => s.effect?.category)).toEqual(['queue']);
    malformed = true; expect(normalized(await buildSteps(cg, root, query))).toBe(normalized(off));
    live('http://127.0.0.1:9/v1/systemone'); expect(normalized(await buildSteps(cg, root, query))).toBe(normalized(off));
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); cg.close(); rmSync(root, { recursive: true, force: true }); }
}, 120_000);
