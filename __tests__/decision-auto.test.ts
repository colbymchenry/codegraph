import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { spawnSync } from 'child_process';
import { createDatabase } from '../src/db/sqlite-adapter';
import { CodeGraph } from '../src';
import { DecisionCache } from '../src/decision/cache';
import { decisionConfig, floorFor, resetDecisionConfig } from '../src/decision/config';
import { decideLive, decisionStatus, isLive, resetLive } from '../src/decision/live';
import { overrideFor, resetOverrides } from '../src/decision/overrides';
import type { DecisionRecord } from '../src/decision/types';

const calls: Array<{ model: string; auth: string | undefined }> = [];
let root: string;
let usedNeurons: unknown;
let probability = (_model: string) => .99;

function rec(point = 'D1', key = 'k'): DecisionRecord {
  return { point, key, heuristic: { pick: 'false' }, payload: {
    prompt: `trace request flow ${key}`,
    ref: { name: 'run', kind: 'calls', filePath: 'a.ts', line: 1, column: 0 },
    call: { receiver: 'service', method: 'run', filePath: 'a.ts', line: 1 },
    candidates: [0, 1].map(n => ({ id: `n${n}`, name: 'run', qualifiedName: `Service${n}.run`, kind: 'method', filePath: `s${n}.ts`, line: 1 })),
  } };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cg-auto-'));
  calls.length = 0;
  usedNeurons = 500;
  probability = () => .99;
  for (const [k, v] of Object.entries({
    CODEGRAPH_DECISIONS: 'auto', CODEGRAPH_DECISION_POINTS: 'all',
    CLOUDFLARE_ACCOUNT_ID: 'fixture', CLOUDFLARE_API_TOKEN: 'cf-token', JEV_API_KEY: 'jev-token',
    CODEGRAPH_CF_USAGE_DB: join(root, 'quota.sqlite'), CODEGRAPH_DECISION_CACHE: join(root, 'cache.sqlite'),
    CODEGRAPH_DECISION_LEDGER: join(root, 'ledger.jsonl'),
    CODEGRAPH_DECISION_ALLOW_REMOTE_PROMPTS: '1',
  })) vi.stubEnv(k, v);
  resetDecisionConfig();
  resetLive();
  vi.stubGlobal('fetch', vi.fn(async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.query) return new Response(JSON.stringify({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: usedNeurons } }] }] } } }));
    calls.push({ model: body.model, auth: opts.headers.authorization });
    const p = probability(body.model);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]: [string, any]) => [id,
      q.type === 'noul' ? { noul: p } : { choice: Object.keys(q.criteria)[0], confidence: p },
    ]));
    return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1000 } }));
  }));
});

afterEach(() => {
  resetLive();
  resetOverrides();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetDecisionConfig();
  rmSync(root, { recursive: true, force: true });
});

describe('automatic decision policy', () => {
  it.each([['A1', 'clef-flash', 'cf-token', .6], ['A2', 'jev-latest', 'jev-token', .6], ['A6', 'clef-flash', 'cf-token', .7], ['D1', 'clef', 'cf-token', .8]])
    ('routes %s to its selected model with its tested floor', async (point, model, token, floor) => {
      expect(floorFor(decisionConfig(), point)).toBe(floor);
      expect(await decideLive(rec(point), { root })).not.toBeNull();
      expect(calls).toEqual([{ model, auth: `Bearer ${token}` }]);
    });

  it.each(['A3', 'B1', 'B4', 'C2', 'C3', 'C5', 'E1', 'F1', 'G3', 'H1', 'unknown'])
    ('keeps %s off even when all points are requested', async point => {
      expect(isLive(point)).toBe(false);
      expect(await decideLive(rec(point), { root })).toBeNull();
      expect(calls).toHaveLength(0);
    });

  it.each([10000, 20000, -1, '100', null])('uses JEV for exhausted or invalid reported usage %s', async usage => {
    usedNeurons = usage;
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(calls).toEqual([{ model: 'jev-latest', auth: 'Bearer jev-token' }]);
  });

  it('uses live usage instead of legacy manual settings, and requires Cloudflare credentials', async () => {
    vi.stubEnv('CODEGRAPH_CF_FREE_NEURONS', '0');
    vi.stubEnv('CODEGRAPH_CF_FREE_DAY', '2000-01-01'); resetDecisionConfig();
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(calls.at(-1)?.model).toBe('clef');
    vi.stubEnv('CLOUDFLARE_API_TOKEN', ''); resetDecisionConfig();
    expect(await decideLive(rec('A1'), { root })).not.toBeNull();
    expect(calls.at(-1)?.model).toBe('jev-latest');
  });

  it('does not release an unreported failed request reservation, and falls back to JEV', async () => {
    usedNeurons = 8500;
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => String(url).includes('/ai/run/')
      ? new Response('{}', { status: 500 }) : fetch(url, opts)));
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(await decideLive(rec('D1', 'next'), { root })).not.toBeNull();
    expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => String(url).includes('/ai/run/'))).toHaveLength(1);
    expect(calls.map(c => c.model)).toEqual(['jev-latest', 'jev-latest']);
  });

  it('uses JEV when only its confidence passes, and shares the ledger with offline decisions', async () => {
    probability = model => model === 'clef' ? .7 : .99;
    expect(await decideLive(rec(), { root })).toEqual({ pick: 'true', p: .99 });
    expect(calls.map(c => c.model)).toEqual(['clef', 'jev-latest']);
    const ledger = readFileSync(join(root, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(ledger.map(e => [e.backend, e.model, e.applied])).toEqual([['cf', 'clef', false], ['jev', 'jev-latest', true]]);
  });

  it('shares a quota across cache handles and UTC days; an oversized reservation never fits', () => {
    const a = new DecisionCache(join(root, 'shared.sqlite'));
    const b = new DecisionCache(join(root, 'shared.sqlite'));
    try {
      expect(a.reserveNeurons('account', '2026-10-08', 7, 10)).toBe(true);
      expect(b.reserveNeurons('account', '2026-10-08', 4, 10)).toBe(false);
      expect(b.reserveNeurons('account', '2026-10-08', 3, 10)).toBe(true);
      expect(a.reserveNeurons('account', '2026-10-09', 11, 10)).toBe(false);
      expect(a.reserveNeurons('account', '2026-10-09', 10, 10)).toBe(true);
      a.settleNeurons('account', '2026-10-08', 7, 2);
      expect(b.reserveNeurons('account', '2026-10-08', 5, 10)).toBe(true);
    } finally { a.close(); b.close(); }
  });

  it('reserves before awaiting a response, so simultaneous requests cannot overspend', async () => {
    usedNeurons = 8500;
    const fetch = globalThis.fetch;
    let release!: () => void;
    const pending = new Promise<void>(r => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => {
      if (String(url).includes('/ai/run/')) await pending;
      return fetch(url, opts);
    }));
    const first = decideLive(rec(), { root });
    try {
      expect(await decideLive(rec('D1', 'next'), { root })).not.toBeNull();
      expect(calls.map(c => c.model)).toEqual(['jev-latest']);
      expect(vi.mocked(globalThis.fetch).mock.calls.filter(([url]) => !String(url).endsWith('/graphql'))).toHaveLength(2);
    } finally { release(); await first; }
  });

  it('uses JEV if the shared quota store cannot be opened', async () => {
    const path = join(root, 'not-a-directory'); writeFileSync(path, 'fixture');
    vi.stubEnv('CODEGRAPH_CF_USAGE_DB', join(path, 'quota.sqlite')); resetDecisionConfig();
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(calls.map(c => c.model)).toEqual(['jev-latest']);
  });

  it('precomputes accepted index overrides and applies them to a real graph', async () => {
    const project = join(root, 'project'), input = join(root, 'decisions.jsonl'), output = join(root, 'overrides.json');
    for (const [file, source] of Object.entries({
      'a/util.c': 'int helper(void) { return 1; }\n',
      'b/util.c': 'int helper(void) { return 2; }\n',
      'src/main.c': 'int helper(void);\nint main(void) { return helper(); }\n',
    })) {
      const path = join(project, file);
      mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, source);
    }
    vi.stubEnv('CODEGRAPH_DECISION_RECORD', input);
    vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A1'); resetDecisionConfig();
    const cg = CodeGraph.initSync(project);
    try { await cg.indexAll(); } finally { cg.close(); }
    const recorded = readFileSync(input, 'utf8').trim().split('\n').map(JSON.parse).find(r => r.point === 'A1');
    expect(recorded).toBeDefined();
    const low = rec('A1', 'low'); low.payload.ref = { ...(low.payload.ref as object), name: 'low' };
    writeFileSync(input, [recorded, low, rec('F1'), rec('D1')].map(JSON.stringify).join('\n') + '\n');
    // The real CLI runs in a child, with every network request replaced before imports.
    const preload = join(root, 'fetch-fixture.mjs');
    writeFileSync(preload, `globalThis.fetch = async (_url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.query) return new Response(JSON.stringify({ data: { viewer: { accounts: [{ aiInferenceAdaptiveGroups: [{ sum: { totalNeurons: 500 } }] }] } } }));
      const confidence = body.state.reference?.name === 'low' ? .59 : .99;
      const answers = Object.fromEntries(Object.entries(body.questions).map(([id, q]) => [id,
        q.type === 'noul' ? { noul: confidence } : { choice: Object.keys(q.criteria)[0], confidence }]));
      return new Response(JSON.stringify({ model: body.model, answers, usage: { input_tokens: 1000 } }));
    };`);
    const run = spawnSync(process.execPath, ['--import', preload, resolve(__dirname, '../scripts/decide-offline.mjs'),
      '--records', input, '--root', project, '--output', output], { env: { ...process.env }, encoding: 'utf8', timeout: 15_000 });
    expect(run.status, run.stderr).toBe(0);
    const pick = recorded.payload.candidates[0].id;
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ [`A1|${recorded.key}`]: { pick, p: .99 } });
    const ledger = readFileSync(join(root, 'ledger.jsonl'), 'utf8');
    writeFileSync(input, [recorded, null].map(JSON.stringify).join('\n') + '\n');
    const invalid = spawnSync(process.execPath, ['--import', preload, resolve(__dirname, '../scripts/decide-offline.mjs'),
      '--records', input, '--root', project, '--output', output], { env: { ...process.env }, encoding: 'utf8', timeout: 15_000 });
    expect(invalid.status).not.toBe(0);
    expect(readFileSync(join(root, 'ledger.jsonl'), 'utf8')).toBe(ledger);
    expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({ [`A1|${recorded.key}`]: { pick, p: .99 } });
    vi.stubEnv('CODEGRAPH_DECISION_RECORD', ''); vi.stubEnv('CODEGRAPH_DECISION_OVERRIDES', output); resetDecisionConfig();
    rmSync(join(project, '.codegraph'), { recursive: true, force: true });
    const applied = CodeGraph.initSync(project);
    try { await applied.indexAll(); } finally { applied.close(); }
    const { db } = createDatabase(join(project, '.codegraph/codegraph.db'), { readOnly: true });
    try { expect(db.prepare("SELECT target FROM edges WHERE json_extract(metadata, '$.decision') = 'A1'").all()).toEqual([{ target: pick }]); }
    finally { db.close(); }
  }, 30_000);

  it('reuses a free cached decision without spending quota again', async () => {
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, 'ledger.jsonl'), 'utf8').trim().split('\n').at(-1)!).cached).toBe(true);
  });

  it('falls back to the heuristic when no eligible credential is available', async () => {
    vi.stubEnv('CLOUDFLARE_API_TOKEN', ''); vi.stubEnv('JEV_API_KEY', ''); resetDecisionConfig();
    expect(await decideLive(rec(), { root })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('keeps A2 off without a JEV key even when Clef has free quota', async () => {
    vi.stubEnv('JEV_API_KEY', ''); resetDecisionConfig();
    expect(await decideLive(rec('A2'), { root })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports exhausted routing without making an inference request', async () => {
    usedNeurons = 41258.22;
    expect(await decisionStatus()).toMatchObject({
      mode: 'auto', cloudflare: { status: 'exhausted', usedNeurons: 41258.22, remainingNeurons: 0, availableNeurons: 0 },
      routes: { A1: 'jev', A2: 'jev', A6: 'jev', D1: 'jev' },
    });
    expect(calls).toHaveLength(0);
  });

  it('reports free routing and A2 stays on JEV, without making an inference request', async () => {
    expect(await decisionStatus()).toMatchObject({
      cloudflare: { status: 'free', availableNeurons: 9500 },
      routes: { A1: 'clef-flash', A2: 'jev', A6: 'clef-flash', D1: 'clef' },
    });
    expect(calls).toHaveLength(0);
  });

  it.each(['', '0'])('reports D1 as off without remote prompt consent (%s)', async (consent) => {
    vi.stubEnv('CODEGRAPH_DECISION_ALLOW_REMOTE_PROMPTS', consent);
    expect(await decisionStatus()).toMatchObject({
      routes: { A1: 'clef-flash', A2: 'jev', A6: 'clef-flash', D1: 'off' },
    });
    expect(calls).toHaveLength(0);
  });

  it('distinguishes unknown usage from zero allowance in the ledger and status', async () => {
    const fetch = globalThis.fetch;
    vi.stubGlobal('fetch', vi.fn(async (url, opts) => String(url).endsWith('/graphql')
      ? new Response(JSON.stringify({ errors: [{ message: 'not authorized' }] })) : fetch(url, opts)));
    expect(await decideLive(rec(), { root })).not.toBeNull();
    expect(calls.map(c => c.model)).toEqual(['jev-latest']);
    const ledger = JSON.parse(readFileSync(join(root, 'ledger.jsonl'), 'utf8'));
    expect(ledger.cloudflare).toMatchObject({ status: 'unknown', remainingNeurons: null, reason: 'api_error' });
    expect(await decisionStatus()).toMatchObject({ cloudflare: { status: 'unknown', availableNeurons: null } });
  });

  it('skips the usage API for A2 and disabled points', async () => {
    await decideLive(rec('A2'), { root });
    await decideLive(rec('F1'), { root });
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([url]) => String(url).endsWith('/graphql'))).toBe(false);
  });

  it('ignores unproven overrides in auto mode and respects explicitly disabled points', () => {
    const file = join(root, 'overrides.json');
    writeFileSync(file, JSON.stringify({ 'A1|k': { pick: 'n0', p: .9 }, 'F1|k': { pick: 'network', p: .99 } }));
    vi.stubEnv('CODEGRAPH_DECISION_OVERRIDES', file); resetDecisionConfig();
    expect(overrideFor('A1', 'k')).toEqual({ pick: 'n0', p: .9 });
    expect(overrideFor('F1', 'k')).toBeUndefined();
    vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'D1'); resetDecisionConfig();
    expect(overrideFor('A1', 'k')).toBeUndefined();
  });
});
