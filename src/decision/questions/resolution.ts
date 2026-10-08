import type { BuildContext, DecisionRecord, DecisionRequest, PointSpec } from '../types';
import { candidateOptions, cands, choiceToCandidate, code, head, imports } from './common';

interface RefP { name: string; kind: string; filePath: string; line: number; column: number }
const refOf = (rec: DecisionRecord): RefP => rec.payload.ref as RefP;

function whichDefinition(rec: DecisionRecord, ctx: BuildContext, lead: string, minCands: number): DecisionRequest | null {
  const cs = cands(rec);
  if (cs.length < minCands) return null;
  const r = refOf(rec);
  return {
    state: { reference: { name: r.name, kind: r.kind, file: r.filePath, line: r.line, code: code(ctx, r.filePath, r.line, 4) }, imports: head(ctx, r.filePath, 80) },
    questions: {
      target: {
        type: 'choice',
        instructions: `${lead} The reference is \`${r.name}\` at ${r.filePath}:${r.line}. Use the code and the file's imports to decide which listed definition it means. Choose "none" if it means something not listed (a library, a builtin, or another definition).`,
        criteria: candidateOptions(cs, { none: 'None of the listed definitions' }),
      },
    },
  };
}

export const A1: PointSpec = {
  id: 'A1',
  build: (rec, ctx) => whichDefinition(rec, ctx, 'Several definitions share this name.', 2),
  interpret: (res, rec) => choiceToCandidate(res, 'target', cands(rec)),
};

export const A3: PointSpec = {
  id: 'A3',
  build: (rec, ctx) => whichDefinition(rec, ctx, `Several types named \`${String(rec.payload.typeName)}\` declare \`${String(rec.payload.methodName)}\`.`, 2),
  interpret: (res, rec) => choiceToCandidate(res, 'target', cands(rec)),
};

export const A6: PointSpec = {
  id: 'A6',
  build: (rec, ctx) => whichDefinition(rec, ctx, 'The resolver could not link this reference. These project definitions share its name.', 1),
  interpret: (res, rec) => choiceToCandidate(res, 'target', cands(rec)),
};

export const A2: PointSpec = {
  id: 'A2',
  build(rec, ctx) {
    const cs = cands(rec);
    if (cs.length < 1) return null;
    const c = rec.payload.call as { receiver: string; method: string; filePath: string; line: number };
    return {
      state: { call: { receiver: c.receiver, method: c.method, file: c.filePath, line: c.line, code: code(ctx, c.filePath, c.line) }, imports: imports(ctx, c.filePath) },
      questions: {
        target: {
          type: 'choice',
          instructions: `\`${c.receiver}.${c.method}(…)\` is called at ${c.filePath}:${c.line} and the type of \`${c.receiver}\` is not declared. Which listed method is called? Choose "external" if \`${c.receiver}\` is a library, framework or builtin object.`,
          criteria: candidateOptions(cs, { external: 'A library, framework or builtin object — none of the listed methods' }),
        },
      },
    };
  },
  interpret: (res, rec) => choiceToCandidate(res, 'target', cands(rec), ['external']),
};
