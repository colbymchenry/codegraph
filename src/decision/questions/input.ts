import type { PointSpec } from '../types';
import { clip, head, noulToVerdict } from './common';

export const G1: PointSpec = {
  id: 'G1',
  build(rec, ctx) {
    const f = String(rec.payload.filePath);
    return { state: { path: f, head: head(ctx, f, 40) }, questions: { generated: { type: 'noul', instructions: `Is \`${f}\` machine-generated (written by a code generator or build tool) rather than written by hand?` } } };
  },
  interpret: (res) => noulToVerdict(res, 'generated'),
};

export const D1: PointSpec = {
  id: 'D1',
  build(rec) {
    return {
      state: { prompt: clip(String(rec.payload.prompt), 2000) },
      questions: { structural: { type: 'noul', instructions: 'Is the user asking how their code is structured or behaves: how something works, where something is, what calls what, how a flow goes, or what a change affects?' } },
    };
  },
  interpret: (res) => noulToVerdict(res, 'structural'),
};
