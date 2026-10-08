import type { DecisionRequest, PointSpec } from '../types';
import { candidateOptions, cands, choiceToCandidate, code, findLine, head, imports, noulToVerdict } from './common';

const SITE_LABEL: Record<string, string> = {
  emitter: 'the event',
  jsx: 'the JSX element',
  vue: 'the Vue template reference',
  rn: 'the React Native event',
  gin: 'the Gin middleware',
  thunk: 'the dispatched Redux thunk',
  registry: 'the registry entry',
  cfnptr: 'the C function pointer',
  'swift-objc': 'the Swift call bridged to Objective-C',
  'rn-bridge': 'the native module method',
  'name-heuristic': 'the framework reference',
};

export const B1: PointSpec = {
  id: 'B1',
  build(rec, ctx) {
    const cs = cands(rec);
    if (cs.length < 2) return null;
    const s = rec.payload.site as { kind: string; name: string; filePath: string; line: number };
    const line = s.line > 0 ? s.line : findLine(ctx, s.filePath, s.name);
    const what = SITE_LABEL[s.kind] ?? s.kind;
    return {
      state: { wiring: { kind: what, name: s.name, file: s.filePath, line, code: code(ctx, s.filePath, line) } },
      questions: {
        target: {
          type: 'choice',
          instructions: `At ${s.filePath}${line ? `:${line}` : ''}, ${what} \`${s.name}\` is wired to a handler. Which listed definition does it reach at runtime? Choose "none" if none of them.`,
          criteria: candidateOptions(cs, { none: 'None of the listed definitions' }),
        },
      },
    };
  },
  interpret: (res, rec) => choiceToCandidate(res, 'target', cands(rec)),
};

export const B2: PointSpec = {
  id: 'B2',
  build(rec, ctx) {
    const p = rec.payload as { event: string; dispatcher: { filePath: string; line: number }; handler: { filePath: string; line: number } };
    return {
      state: {
        event: p.event,
        dispatch: { file: p.dispatcher.filePath, line: p.dispatcher.line, code: code(ctx, p.dispatcher.filePath, p.dispatcher.line, 1) },
        handler_registration: { file: p.handler.filePath, line: p.handler.line, code: code(ctx, p.handler.filePath, p.handler.line, 1) },
      },
      questions: {
        reaches: {
          type: 'noul',
          instructions: `Does the dispatch of \`${p.event}\` at ${p.dispatcher.filePath}:${p.dispatcher.line} reach the handler registered at ${p.handler.filePath}:${p.handler.line}, i.e. do both use the same emitter, bus or queue instance?`,
        },
      },
    };
  },
  interpret: (res) => noulToVerdict(res, 'reaches'),
};

export const B3: PointSpec = {
  id: 'B3',
  build(rec, ctx): DecisionRequest | null {
    if (rec.payload.kind === 'client') {
      const c = rec.payload.call as { receiver: string; verb: string; filePath: string; line: number };
      // clientFor() has no position: find the first call through this receiver in the file.
      const line = c.line > 0 ? c.line : findLine(ctx, c.filePath, `${c.receiver}.`);
      const call = c.verb ? `${c.receiver}.${c.verb}(…)` : `${c.receiver}.…(…)`;
      return {
        state: { call: { receiver: c.receiver, file: c.filePath, line, code: code(ctx, c.filePath, line) }, imports: imports(ctx, c.filePath) },
        questions: { client: { type: 'noul', instructions: `In ${c.filePath}, is \`${call}\` an HTTP client sending requests to a server (not a server or router registering routes, and not an unrelated object)?` } },
      };
    }
    const routes = cands(rec, 'routes');
    if (routes.length < 2) return null;
    const s = rec.payload.site as { method: string; display: string; filePath: string; line: number };
    return {
      state: { request: { method: s.method, path: s.display, file: s.filePath, line: s.line, code: code(ctx, s.filePath, s.line) } },
      questions: {
        route: {
          type: 'choice',
          instructions: `The client request ${s.method.toUpperCase()} ${s.display} at ${s.filePath}:${s.line} matches several server routes equally well. Which listed route handles it? Choose "none" if none does.`,
          criteria: candidateOptions(routes, { none: 'None of the listed routes' }),
        },
      },
    };
  },
  interpret: (res, rec) => (rec.payload.kind === 'client' ? noulToVerdict(res, 'client') : choiceToCandidate(res, 'route', cands(rec, 'routes'))),
};

const MANIFESTS = ['package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'composer.json', 'Gemfile', 'Package.swift'];

export const B5: PointSpec = {
  id: 'B5',
  build(rec, ctx) {
    const fw = String(rec.payload.framework);
    const manifests = MANIFESTS.map((f) => ({ file: f, text: head(ctx, f, 80, 2500) })).filter((m) => m.text);
    return {
      state: { manifests, sample_files: ctx.listFiles?.(60) ?? [] },
      questions: { uses: { type: 'noul', instructions: `Does this project use the \`${fw}\` framework or library in its own source code (not only in tests, fixtures or examples)?` } },
    };
  },
  interpret: (res) => noulToVerdict(res, 'uses'),
};
