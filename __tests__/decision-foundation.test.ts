import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { DecisionCache, decisionKey, stableJson } from '../src/decision/cache';
import { askSystemOne, normalizeAnswers } from '../src/decision/client';
import { floorFor, pointEnabled, readDecisionConfig, resetDecisionConfig, decisionConfig } from '../src/decision/config';
import { writeLedger } from '../src/decision/ledger';
import { atSite, capWithPick, isRecording, refKey, toCand } from '../src/decision/record';
import { overrideFor, resetOverrides } from '../src/decision/overrides';
import { decideLive, isLive, resetLive } from '../src/decision/live';
import { parallelResolveDisabled } from '../src/resolution/resolver-pool';

afterEach(() => {
  vi.unstubAllEnvs();
  resetDecisionConfig();
});

describe('decision config', () => {
  it('is fully off with no environment', () => {
    const cfg = readDecisionConfig({});
    expect(cfg.backend).toBe('off');
    expect(cfg.recordPath).toBeUndefined();
    expect(cfg.overridesPath).toBeUndefined();
    expect(pointEnabled(cfg, 'A1')).toBe(false);
  });

  it('reads backend, endpoint defaults, points and floors', () => {
    const cfg = readDecisionConfig({ CODEGRAPH_DECISIONS: 'jev', JEV_API_KEY: 'k', CODEGRAPH_DECISION_POINTS: 'A1, C2', CODEGRAPH_DECISION_FLOORS: '{"A1":0.85,"bad":3}' });
    expect(cfg.backend).toBe('jev');
    expect(cfg.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(cfg.model).toBe('jev-latest');
    expect(cfg.apiKey).toBe('k');
    expect(pointEnabled(cfg, 'C2')).toBe(true);
    expect(pointEnabled(cfg, 'B1')).toBe(false);
    expect(floorFor(cfg, 'A1')).toBe(0.85);
    expect(floorFor(cfg, 'B1')).toBe(0.7);
    expect(cfg.floors.bad).toBeUndefined();
  });

  it('never hands the Jev key to Cloudflare', () => {
    const cfg = readDecisionConfig({ CODEGRAPH_DECISIONS: 'cf', JEV_API_KEY: 'k' });
    expect(cfg.url).toBe('');
    expect(cfg.apiKey).toBeUndefined();
  });

  it('builds the Workers AI endpoint for cf with its own token and model', () => {
    const cfg = readDecisionConfig({ CODEGRAPH_DECISIONS: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acc', CLOUDFLARE_API_TOKEN: 't', JEV_API_KEY: 'k' });
    expect(cfg.url).toBe('https://api.cloudflare.com/client/v4/accounts/acc/ai/run/@cf/cloudflare/clef');
    expect(cfg.model).toBe('clef');
    expect(cfg.apiKey).toBe('t');
    expect(readDecisionConfig({ CODEGRAPH_DECISIONS: 'cf', CLOUDFLARE_ACCOUNT_ID: 'acc', CF_MODEL: 'clef-flash' }).url).toMatch(/@cf\/cloudflare\/clef-flash$/);
    expect(readDecisionConfig({ CODEGRAPH_DECISIONS: 'cf' }).url).toBe(''); // no account → fails closed
  });

  it('treats empty strings as unset (vitest.config clears the vars)', () => {
    const cfg = readDecisionConfig({ CODEGRAPH_DECISIONS: '', CODEGRAPH_DECISION_RECORD: '', CODEGRAPH_DECISION_POINTS: '' });
    expect(cfg.backend).toBe('off');
    expect(cfg.recordPath).toBeUndefined();
  });

  it('caches process.env until reset', () => {
    vi.stubEnv('CODEGRAPH_DECISIONS', 'cf');
    expect(decisionConfig().backend).toBe('cf');
    vi.stubEnv('CODEGRAPH_DECISIONS', 'jev');
    expect(decisionConfig().backend).toBe('cf');
    resetDecisionConfig();
    expect(decisionConfig().backend).toBe('jev');
  });
});

interface Fake { url: string; requests: Array<{ headers: http.IncomingHttpHeaders; body: any }>; close(): Promise<void> }

async function fakeServer(reply: (body: any) => { status?: number; json?: unknown; delayMs?: number }): Promise<Fake> {
  const requests: Fake['requests'] = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ headers: req.headers, body });
      const r = reply(body);
      setTimeout(() => {
        res.writeHead(r.status ?? 200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.json ?? {}));
      }, r.delayMs ?? 0);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/systemone`,
    requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const Q = {
  pick: { type: 'choice' as const, instructions: 'which?', criteria: { x: 'X', y: 'Y' } },
  yes: { type: 'noul' as const, instructions: 'yes?' },
  how: { type: 'score' as const, instructions: 'how much?', criteria: ['low', 'mid', 'high'] },
};

describe('askSystemOne', () => {
  it.each([null, false, '', '0', -0.01, 1.01, Infinity, NaN])('rejects malformed boolean probabilities (%s)', (noul) => {
    expect(normalizeAnswers({ yes: Q.yes }, { yes: { noul } })).toBeNull();
  });

  it('rejects invalid choice, confidence and score values', () => {
    expect(normalizeAnswers({ pick: Q.pick }, { pick: { choice: 'unknown', confidence: 1 } })).toBeNull();
    expect(normalizeAnswers({ pick: Q.pick }, { pick: { choice: 'x', confidence: 2 } })).toBeNull();
    expect(normalizeAnswers({ how: Q.how }, { how: { score: null, confidence: 1 } })).toBeNull();
    expect(normalizeAnswers({ how: Q.how }, { how: { score: 3, confidence: 1 } })).toBeNull();
    expect(normalizeAnswers({ pick: Q.pick }, { pick: { choice: 'x', probabilities: { x: 4 } } })?.pick)
      .toMatchObject({ confidence: 0 });
  });

  it('normalizes a Jev-shaped response (answers carry no type field) and sends the bearer key', async () => {
    const s = await fakeServer(() => ({ json: { model: 'jev-1', answers: { pick: { choice: 'y', confidence: 0.8, probabilities: { x: 0.2, y: 0.8 } }, yes: { noul: 0.9 }, how: { score: 1.7, confidence: 0.6, probabilities: { 0: 0.1, 1: 0.3, 2: 0.6 } } }, usage: { input_tokens: 42, output_tokens: 0 } } }));
    try {
      const res = await askSystemOne({ state: { a: 1 }, questions: Q }, { url: s.url, model: 'jev-latest', apiKey: 'secret', timeoutMs: 2000 });
      expect(res?.answers.pick).toEqual({ type: 'choice', choice: 'y', confidence: 0.8, probabilities: { x: 0.2, y: 0.8 } });
      expect(res?.answers.yes).toEqual({ type: 'noul', noul: 0.9 });
      expect(res?.answers.how).toMatchObject({ type: 'score', score: 1.7, confidence: 0.6 });
      expect(res?.usage.inputTokens).toBe(42);
      expect(res?.cached).toBe(false);
      expect(s.requests[0]!.headers.authorization).toBe('Bearer secret');
      expect(s.requests[0]!.body).toMatchObject({ model: 'jev-latest', state: { a: 1 } });
    } finally { await s.close(); }
  });

  it('accepts typed answers and sends no auth header without a key', async () => {
    const s = await fakeServer(() => ({ json: { model: 'clef-flash', answers: { yes: { type: 'noul', noul: 0.3 } }, usage: { input_tokens: 7, output_tokens: 0 } } }));
    try {
      const res = await askSystemOne({ state: 's', questions: { yes: Q.yes } }, { url: s.url, model: 'clef-flash', timeoutMs: 2000 });
      expect(res?.answers.yes).toEqual({ type: 'noul', noul: 0.3 });
      expect(s.requests[0]!.headers.authorization).toBeUndefined();
    } finally { await s.close(); }
  });

  it('unwraps the Cloudflare REST envelope ({ result, success })', async () => {
    const s = await fakeServer(() => ({ json: { result: { model: 'clef', answers: { yes: { noul: 0.8 } }, usage: { prompt_tokens: 9 } }, success: true, errors: [], messages: [] } }));
    try {
      const res = await askSystemOne({ state: 's', questions: { yes: Q.yes } }, { url: s.url, model: 'clef', apiKey: 'cf-token', timeoutMs: 2000 });
      expect(res?.answers.yes).toEqual({ type: 'noul', noul: 0.8 });
      expect(res?.usage.inputTokens).toBe(9);
      expect(s.requests[0]!.headers.authorization).toBe('Bearer cf-token');
    } finally { await s.close(); }
  });

  it('returns null — never throws — on HTTP errors, malformed answers, timeouts and dead ports', async () => {
    const err = await fakeServer(() => ({ status: 500, json: { error: 'boom' } }));
    const bad = await fakeServer(() => ({ json: { answers: { pick: { confidence: 0.9 } } } }));
    const slow = await fakeServer(() => ({ delayMs: 500, json: { answers: { yes: { noul: 0.5 } } } }));
    try {
      const req = { state: 1, questions: { pick: Q.pick } };
      expect(await askSystemOne(req, { url: err.url, model: 'm', timeoutMs: 2000 })).toBeNull();
      expect(await askSystemOne(req, { url: bad.url, model: 'm', timeoutMs: 2000 })).toBeNull();
      expect(await askSystemOne({ state: 1, questions: { yes: Q.yes } }, { url: slow.url, model: 'm', timeoutMs: 100 })).toBeNull();
      expect(await askSystemOne(req, { url: 'http://127.0.0.1:9/v1/systemone', model: 'm', timeoutMs: 500 })).toBeNull();
    } finally { await Promise.all([err.close(), bad.close(), slow.close()]); }
  });
});

describe('decision cache and ledger', () => {
  it('hashes equal requests equally regardless of key order', () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { y: 1, x: 2 }] } })).toBe(stableJson({ a: { c: [3, { x: 2, y: 1 }], d: 2 }, b: 1 }));
    const q = { k: { type: 'noul' as const, instructions: 'i' } };
    expect(decisionKey('m', { state: { a: 1, b: 2 }, questions: q })).toBe(decisionKey('m', { state: { b: 2, a: 1 }, questions: q }));
    expect(decisionKey('m', { state: 1, questions: q })).not.toBe(decisionKey('other', { state: 1, questions: q }));
  });

  it('round-trips a response and marks the hit as cached', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dcache-'));
    try {
      const cache = new DecisionCache(path.join(dir, 'sub', 'd.sqlite'));
      const res = { model: 'm', answers: { k: { type: 'noul' as const, noul: 0.7 } }, usage: { inputTokens: 3, outputTokens: 0 }, latencyMs: 12, cached: false };
      expect(cache.get('x')).toBeNull();
      cache.put('x', res);
      expect(cache.get('x')).toEqual({ ...res, cached: true });
      cache.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('waits for a concurrent process to release the cache write lock', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dcache-lock-'));
    const file = path.join(dir, 'd.sqlite');
    const cache = new DecisionCache(file);
    const writer = spawn(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('BEGIN IMMEDIATE');
      process.stdout.write('locked');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 200);
    `, file], { stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(writer, 'exit');
    try {
      await once(writer.stdout!, 'data');
      const res = { model: 'm', answers: {}, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 1, cached: false };
      cache.put('concurrent', res);
      expect(cache.get('concurrent')).toEqual({ ...res, cached: true });
    } finally {
      await exited;
      cache.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('appends ledger lines only when a ledger path is configured', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dledger-'));
    try {
      const file = path.join(dir, 'ledger.jsonl');
      const entry = { ts: 1, point: 'A1', key: 'k', backend: 'cf', model: 'm', verdict: null, applied: false, heuristic: null, latencyMs: -1, cached: false, inputTokens: 0 };
      writeLedger(entry);
      expect(fs.existsSync(file)).toBe(false);
      vi.stubEnv('CODEGRAPH_DECISION_LEDGER', file);
      resetDecisionConfig();
      writeLedger(entry);
      expect(fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l))).toEqual([entry]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('record / override sites', () => {
  afterEach(() => resetOverrides());

  it('records only listed points, and only when a record path is set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drec-'));
    try {
      const file = path.join(dir, 'r.jsonl');
      expect(atSite('A1', 'k0', null, () => ({ a: 1 }))).toBeUndefined();
      expect(fs.existsSync(file)).toBe(false);
      vi.stubEnv('CODEGRAPH_DECISION_RECORD', file);
      vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A1');
      resetDecisionConfig();
      expect(isRecording('A1')).toBe(true);
      expect(isRecording('B1')).toBe(false);
      let built = 0;
      atSite('A1', 'k1', 'n1', () => { built++; return { a: 1 }; });
      atSite('B1', 'k2', 'n2', () => { built++; return { b: 1 }; });
      expect(built).toBe(1); // the payload thunk runs only when recording that point
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(lines).toEqual([{ point: 'A1', key: 'k1', payload: { a: 1 }, heuristic: { pick: 'n1' } }]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('caps records per point', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drec-'));
    try {
      const file = path.join(dir, 'r.jsonl');
      vi.stubEnv('CODEGRAPH_DECISION_RECORD', file);
      vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'all');
      vi.stubEnv('CODEGRAPH_DECISION_RECORD_MAX', '2');
      resetDecisionConfig();
      for (let i = 0; i < 5; i++) atSite('A1', `k${i}`, null, () => ({}));
      expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes one line per key, and a repeat visit does not consume the cap', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drec-'));
    try {
      const file = path.join(dir, 'r.jsonl');
      vi.stubEnv('CODEGRAPH_DECISION_RECORD', file);
      vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A1');
      vi.stubEnv('CODEGRAPH_DECISION_RECORD_MAX', '2');
      resetDecisionConfig();
      atSite('A1', 'k1', null, () => ({}));
      atSite('A1', 'k1', null, () => ({}));
      atSite('A1', 'k2', null, () => ({}));
      const keys = fs.readFileSync(file, 'utf-8').trim().split('\n').map((l) => JSON.parse(l).key);
      expect(keys).toEqual(['k1', 'k2']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('serves overrides from the precomputed file by "point|key"', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dovr-'));
    try {
      const file = path.join(dir, 'o.json');
      fs.writeFileSync(file, JSON.stringify({ 'A1|k1': { pick: 'n2', p: 0.91 }, 'A1|k2': { pick: null, p: 0.8 } }));
      expect(overrideFor('A1', 'k1')).toBeUndefined();
      vi.stubEnv('CODEGRAPH_DECISION_OVERRIDES', file);
      resetDecisionConfig();
      expect(overrideFor('A1', 'k1')).toEqual({ pick: 'n2', p: 0.91 });
      expect(overrideFor('A1', 'k2')).toEqual({ pick: null, p: 0.8 });
      expect(overrideFor('A1', 'nope')).toBeUndefined();
      expect(atSite('A1', 'k1', 'n1', () => ({}))).toEqual({ pick: 'n2', p: 0.91 });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps the heuristic pick when capping candidates', () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `n${i}` }));
    const capped = capWithPick(items, 'n39', 32);
    expect(capped).toHaveLength(32);
    expect(capped.map((c) => c.id)).toContain('n39');
    expect(capWithPick(items, null, 32)).toEqual(items.slice(0, 32));
  });

  it('maps nodes and refs to stable shapes', () => {
    expect(refKey({ fromNodeId: 'f', line: 3, column: 4, referenceKind: 'calls' })).toBe('f:3:4:calls');
    const cand = toCand({ id: 'n', kind: 'method', name: 'run', qualifiedName: 'A.run', filePath: 'a.ts', language: 'typescript', startLine: 2, endLine: 9, startColumn: 0, endColumn: 1, signature: 'run(): void', isExported: true } as any);
    expect(cand).toEqual({ id: 'n', name: 'run', qualifiedName: 'A.run', kind: 'method', filePath: 'a.ts', line: 2, endLine: 9, signature: 'run(): void', exported: true, language: 'typescript' });
  });

  it('forces sequential resolution while recording', () => {
    expect(parallelResolveDisabled()).toBe(false);
    vi.stubEnv('CODEGRAPH_DECISION_RECORD', path.join(os.tmpdir(), 'x.jsonl'));
    vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A1');
    resetDecisionConfig();
    expect(parallelResolveDisabled()).toBe(true);
  });

  it('forces sequential resolution under decision overrides (veto state is per thread)', () => {
    expect(parallelResolveDisabled()).toBe(false);
    vi.stubEnv('CODEGRAPH_DECISION_OVERRIDES', path.join(os.tmpdir(), 'x.json'));
    resetDecisionConfig();
    expect(parallelResolveDisabled()).toBe(true);
  });
});

describe('decideLive', () => {
  afterEach(() => resetLive());
  const cand = { id: 'n0', name: 'run', qualifiedName: 'Svc.run', kind: 'method', filePath: 'src/s.ts', line: 3 };
  const a6 = { point: 'A6', key: 'k', payload: { ref: { name: 'run', kind: 'calls', filePath: 'src/a.ts', line: 1, column: 0 }, candidates: [cand] }, heuristic: { pick: 'n0' } };

  it('is a no-op when off', async () => {
    expect(isLive('A6')).toBe(false);
    expect(await decideLive(a6, { root: os.tmpdir() })).toBeNull();
  });

  it('asks once, caches, applies the floor, and writes the ledger', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dlive-'));
    const s = await fakeServer(() => ({ json: { model: 'clef-flash', answers: { target: { choice: 'c0', confidence: 0.9 } }, usage: { input_tokens: 5, output_tokens: 0 } } }));
    try {
      vi.stubEnv('CODEGRAPH_DECISIONS', 'cf');
      vi.stubEnv('CODEGRAPH_DECISIONS_URL', s.url);
      vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A6');
      vi.stubEnv('CODEGRAPH_DECISION_CACHE', path.join(dir, 'c.sqlite'));
      vi.stubEnv('CODEGRAPH_DECISION_LEDGER', path.join(dir, 'l.jsonl'));
      resetDecisionConfig();
      expect(await decideLive(a6, { root: dir })).toEqual({ pick: 'n0', p: 0.9 });
      expect(await decideLive(a6, { root: dir })).toEqual({ pick: 'n0', p: 0.9 });
      expect(s.requests).toHaveLength(1); // second answer came from the cache
      vi.stubEnv('CODEGRAPH_DECISION_FLOORS', '{"A6":0.95}');
      resetDecisionConfig();
      expect(await decideLive(a6, { root: dir })).toBeNull(); // below the floor → keep the heuristic
      const ledger = fs.readFileSync(path.join(dir, 'l.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
      expect(ledger.map((e) => [e.applied, e.cached])).toEqual([[true, false], [true, true], [false, true]]);
    } finally { await s.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('falls back (null) when the backend is unreachable', async () => {
    vi.stubEnv('CODEGRAPH_DECISIONS', 'cf');
    vi.stubEnv('CODEGRAPH_DECISIONS_URL', 'http://127.0.0.1:9/v1/systemone');
    vi.stubEnv('CODEGRAPH_DECISION_POINTS', 'A6');
    vi.stubEnv('CODEGRAPH_DECISIONS_TIMEOUT_MS', '300');
    resetDecisionConfig();
    expect(await decideLive(a6, { root: os.tmpdir() })).toBeNull();
  });
});
