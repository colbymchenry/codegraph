import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createServer } from 'http';
import type { AddressInfo } from 'net';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { resetDecisionConfig } from '../src/decision/config';
import { resetLive } from '../src/decision/live';

const dirs: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); resetDecisionConfig(); resetLive(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
async function fixture(count = 10) {
  const root = mkdtempSync(join(tmpdir(), 'cg-live-explore-')); dirs.push(root);
  for (let i = 0; i < count; i++) {
    mkdirSync(join(root, `src/m${i}`), { recursive: true });
    writeFileSync(join(root, `src/m${i}/render.ts`), `export function render() { return ${i}; }\n`);
  }
  mkdirSync(join(root, 'tests'));
  writeFileSync(join(root, 'tests/render.test.ts'), 'export function render() { return 999; }\n');
  const cg = CodeGraph.initSync(root); await cg.indexAll(); cg.close(); return root;
}
async function explore(root: string, query = 'render') {
  const cg = CodeGraph.openSync(root);
  try { return await new ToolHandler(cg).execute('codegraph_explore', { query }); } finally { cg.close(); }
}
async function server(answer: (body: any) => unknown) {
  const requests: any[] = [];
  const s = createServer((req, res) => {
    let raw = ''; req.on('data', c => raw += c); req.on('end', () => {
      const body = JSON.parse(raw); requests.push(body);
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(answer(body)));
    });
  });
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r));
  return { requests, url: `http://127.0.0.1:${(s.address() as AddressInfo).port}/v1/systemone`, close: () => new Promise<void>(r => { s.closeAllConnections(); s.close(() => r()); }) };
}
function live(point: string, url: string) {
  vi.stubEnv('CODEGRAPH_DECISIONS', 'cf'); vi.stubEnv('CODEGRAPH_DECISIONS_URL', url);
  vi.stubEnv('CODEGRAPH_DECISION_POINTS', point); vi.stubEnv('CODEGRAPH_DECISIONS_QUERY_TIMEOUT_MS', '100');
  resetDecisionConfig(); resetLive();
}
const envelope = (answers: unknown) => ({ model: 'fixture', answers, usage: { input_tokens: 1, output_tokens: 1 } });

it('C2 can admit a test file for a question the word heuristic treats as production code', async () => {
  const root = await fixture(3), off = await explore(root);
  expect(off.content[0]!.text).not.toContain('tests/render.test.ts');
  const s = await server(body => envelope(Object.fromEntries(Object.keys(body.questions).map(k => [k, { noul: 1 }]))));
  try {
    live('C2', s.url);
    const out = await explore(root);
    expect(s.requests.some(r => r.questions.symbol)).toBe(true);
    expect(s.requests.some(r => r.questions.test)).toBe(true);
    expect(out.content[0]!.text).toContain('tests/render.test.ts');
  } finally { await s.close(); }
}, 120_000);

it('C3 reranks the actual entry pool and retains the cap', async () => {
  const root = await fixture(), cg = CodeGraph.openSync(root);
  try {
    const off = await cg.findRelevantContext('render', { searchLimit: 8, traversalDepth: 0 });
    const target = cg.getNodesInFile('src/m9/render.ts').find(n => n.kind === 'function')!;
    expect(off.roots).not.toContain(target.id);
    const out = await cg.findRelevantContext('render', { searchLimit: 8, traversalDepth: 0,
      rerank: async (_q, pool) => [pool.find(r => r.node.id === target.id)!, ...pool.filter(r => r.node.id !== target.id)],
    });
    expect(out.roots).toHaveLength(8); expect(out.roots[0]).toBe(target.id);
  } finally { cg.close(); }
  const s = await server(body => envelope(Object.fromEntries(Object.entries(body.questions).map(([k, q]: [string, any]) => [k, { score: q.instructions.includes('src/m9/render.ts') ? 4 : 0, confidence: 1 }]))));
  try { live('C3', s.url); await explore(root); expect(s.requests).toHaveLength(1); } finally { await s.close(); }
}, 120_000);

it('C5 changes the low-confidence note using the files explore can actually show', async () => {
  const root = await fixture(), off = await explore(root);
  const s = await server(() => envelope({ answers: { noul: 0 } }));
  try {
    live('C5', s.url); const out = await explore(root);
    expect(s.requests).toHaveLength(1); expect(s.requests[0].state.files.length).toBeLessThanOrEqual(4);
    const note = ' Matched on common words only — if these files look off-target, re-run codegraph_explore with the exact symbol names you are after.';
    expect(out.content[0]!.text).toContain(note);
    expect(out.content[0]!.text.replace(note, '')).toBe(off.content[0]!.text);
  } finally { await s.close(); }
}, 120_000);

it('unreachable, malformed and below-floor backends preserve the complete heuristic output', async () => {
  const root = await fixture(), off = await explore(root);
  live('C2,C3,C5', 'http://127.0.0.1:9/v1/systemone');
  const dead = await explore(root); expect(dead.isError).toBeFalsy(); expect(dead.content[0]!.text).toBe(off.content[0]!.text);
  for (const answer of [() => ({}), (body: any) => envelope(Object.fromEntries(Object.keys(body.questions).map(k => [k, { noul: 0.5, score: 4, confidence: 0.5 }])) )]) {
    const s = await server(answer);
    try { live('C2,C3,C5', s.url); const out = await explore(root); expect(out.isError).toBeFalsy(); expect(out.content[0]!.text).toBe(off.content[0]!.text); } finally { await s.close(); }
  }
}, 120_000);
