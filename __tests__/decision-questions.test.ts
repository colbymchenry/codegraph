import { describe, expect, it } from 'vitest';
import { POINTS } from '../src/decision/questions';
import type { Answer, BuildContext, Cand, DecisionRecord, DecisionResponse } from '../src/decision/types';

const ctx: BuildContext = {
  readLines: (_f, start, end) => Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => `line ${start + i} import x from 'y'`),
  listFiles: () => ['src/a.ts', 'package.json'],
};
const cand = (i: number): Cand => ({ id: `n${i}`, name: `run${i}`, qualifiedName: `Svc${i}.run`, kind: 'method', filePath: `src/s${i}.ts`, line: 10 + i, signature: 'run(): void' });
const two = [cand(0), cand(1)];
const ref = { name: 'run', kind: 'calls', filePath: 'src/app.ts', line: 5, column: 2 };
const rec = (point: string, payload: Record<string, unknown>, pick: string | null = null): DecisionRecord => ({ point, key: `${point}-k`, payload, heuristic: { pick } });

/** One askable record per point — the payload contract the hooks must produce. */
const FIXTURES: DecisionRecord[] = [
  rec('A1', { ref, candidates: two, total: 2 }, 'n0'),
  rec('A2', { call: { receiver: 'svc', method: 'run', filePath: 'src/app.ts', line: 5 }, candidates: two, total: 2 }, 'n0'),
  rec('A3', { ref, typeName: 'Svc', methodName: 'run', candidates: two, total: 2 }, 'n0'),
  rec('A6', { ref, candidates: [cand(0)] }),
  rec('B1', { site: { kind: 'emitter', name: 'save', filePath: 'src/bus.ts', line: 3 }, candidates: two, total: 2 }, 'n0'),
  rec('B2', { event: 'save', dispatcher: { filePath: 'src/a.ts', line: 2 }, handler: { filePath: 'src/b.ts', line: 9 } }, 'false'),
  rec('B3', { kind: 'client', call: { receiver: 'api', verb: 'get', filePath: 'src/c.ts', line: 4 } }, 'true'),
  rec('B5', { framework: 'express', detected: true }, 'true'),
  rec('C2', { kind: 'token', query: 'check the latest version', token: 'check' }, 'false'),
  rec('C3', { query: 'how does run work', hits: two, k: 1 }, 'n0'),
  rec('C5', { query: 'how does run work', files: ['src/s0.ts'], symbols: ['run0'], empty: false, retry: ['Svc0.run', 'Svc1.run'] }, 'sufficient'),
  rec('D1', { prompt: '결제 흐름이 어떻게 처리돼?' }, 'true'),
  rec('F1', { call: { text: 'db.users.insert(u)', kind: 'calls', language: 'typescript', receiverType: null, args: 'u', enclosing: 'createUser', filePath: 'src/u.ts', line: 7 }, project: 'api' }, 'database'),
  rec('G1', { filePath: 'src/gen/api.ts' }, 'false'),
];

function fakeAnswers(questions: Record<string, { type: string; criteria?: unknown }>, choiceIndex = 0): DecisionResponse {
  const answers: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    if (q.type === 'noul') answers[id] = { type: 'noul', noul: 0.8 };
    else if (q.type === 'choice') {
      const keys = Object.keys(q.criteria as Record<string, string>);
      const choice = keys[Math.min(choiceIndex, keys.length - 1)]!;
      answers[id] = { type: 'choice', choice, confidence: 0.8, probabilities: Object.fromEntries(keys.map((k) => [k, k === choice ? 0.8 : 0.2 / (keys.length - 1)])) };
    } else answers[id] = { type: 'score', score: Number(id.slice(1)) % 2 === 0 ? 1 : 3, confidence: 0.6, probabilities: {} };
  }
  return { model: 'm', answers, usage: { inputTokens: 1, outputTokens: 0 }, latencyMs: 1, cached: false };
}

describe('decision point specs', () => {
  it('covers every point that asks a model', () => {
    expect(FIXTURES.map((f) => f.point).sort()).toEqual(Object.keys(POINTS).sort());
  });

  for (const f of FIXTURES) {
    it(`${f.point}: builds valid typed questions and interprets an answer`, () => {
      const spec = POINTS[f.point]!;
      const req = spec.build(f, ctx);
      expect(req).not.toBeNull();
      for (const q of Object.values(req!.questions)) {
        expect(q.instructions.length).toBeGreaterThan(10);
        if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeGreaterThanOrEqual(2);
        if (q.type === 'choice') expect(Object.keys(q.criteria).length).toBeLessThanOrEqual(255);
        if (q.type === 'score') expect(q.criteria.length).toBeGreaterThanOrEqual(2);
        if (q.type === 'score') expect(q.criteria.length).toBeLessThanOrEqual(10);
      }
      expect(Object.keys(req!.questions).length).toBeLessThanOrEqual(64); // Clef: 1–64 questions per request
      expect(spec.interpret(fakeAnswers(req!.questions as any), f)).not.toBeNull();
    });
  }

  it('maps choice options back to candidate ids, and "none"/"external" to null', () => {
    const a1 = FIXTURES.find((f) => f.point === 'A1')!;
    const req = POINTS.A1!.build(a1, ctx)!;
    expect(POINTS.A1!.interpret(fakeAnswers(req.questions as any, 1), a1)).toEqual({ pick: 'n1', p: 0.8 });
    expect(POINTS.A1!.interpret(fakeAnswers(req.questions as any, 99), a1)).toEqual({ pick: null, p: 0.8 }); // last option = none
    const a2 = FIXTURES.find((f) => f.point === 'A2')!;
    expect(POINTS.A2!.interpret(fakeAnswers(POINTS.A2!.build(a2, ctx)!.questions as any, 99), a2)!.pick).toBeNull();
  });

  it('ranks score points by expected score', () => {
    const c3 = FIXTURES.find((f) => f.point === 'C3')!;
    const v = POINTS.C3!.interpret(fakeAnswers(POINTS.C3!.build(c3, ctx)!.questions as any), c3)!;
    expect(v.ranking!.map((r) => r.id)).toEqual(['n1', 'n0']); // s1 scored 3, s0 scored 1
  });

  it('preserves multiline import aliases and bounds the source supplied for reference resolution', () => {
    const lines = Array.from({ length: 160 }, () => '');
    lines.splice(0, 4, 'import {', '  Service as LocalService,', "} from './service';", '');
    lines[96] = 'const svc = new LocalService();';
    lines[99] = 'svc.run();';
    lines[140] = 'outside the call window';
    const sources: BuildContext = { readLines: (_file, start, end) => lines.slice(start - 1, end) };
    for (const point of ['A1', 'A6']) {
      const request = POINTS[point]!.build(rec(point, { ref: { ...ref, line: 100 }, candidates: two }), sources)!;
      const state = request.state as { reference: { code: string }; imports: string };
      expect(state.reference.code).toContain('const svc = new LocalService();');
      expect(state.reference.code).toContain('svc.run();');
      expect(state.reference.code).not.toContain('outside the call window');
      expect(state.imports).toContain("Service as LocalService,\n} from './service';");
      expect(state.imports.length).toBeLessThanOrEqual(4000);
    }
  });

  it('returns null (not askable) for single-candidate choice points', () => {
    expect(POINTS.A1!.build(rec('A1', { ref, candidates: [cand(0)] }), ctx)).toBeNull();
    expect(POINTS.B1!.build(rec('B1', { site: { kind: 'jsx', name: 'X', filePath: 'a.tsx', line: 0 }, candidates: [cand(0)] }), ctx)).toBeNull();
  });
});
