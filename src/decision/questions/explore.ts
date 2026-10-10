import type { DecisionRequest, PointSpec, Question } from '../types';
import { cands, clip, noulToVerdict, scoresToRanking } from './common';

const RELEVANCE = ['Unrelated', 'Shares words only', 'Same area of the code', 'Directly involved', 'The core of the answer'];

export const C2: PointSpec = {
  id: 'C2',
  build(rec): DecisionRequest | null {
    const q = clip(String(rec.payload.query), 400);
    if (rec.payload.kind === 'test') {
      return { state: { question: q }, questions: { test: { type: 'noul', instructions: `Is the question «${q}» asking about test code (tests, specs, fixtures or mocks)?` } } };
    }
    const t = String(rec.payload.token);
    return { state: { question: q, token: t }, questions: { symbol: { type: 'noul', instructions: `In the question «${q}», is \`${t}\` used as the name of a code symbol (a function, class, method or variable) rather than as an ordinary word?` } } };
  },
  interpret: (res, rec) => noulToVerdict(res, rec.payload.kind === 'test' ? 'test' : 'symbol'),
};

export const C3: PointSpec = {
  id: 'C3',
  build(rec) {
    const hits = cands(rec, 'hits').slice(0, 24);
    if (hits.length < 2) return null;
    const q = clip(String(rec.payload.query), 400);
    const questions: Record<string, Question> = {};
    hits.forEach((h, i) => {
      questions[`s${i}`] = { type: 'score', instructions: `How useful is \`${h.qualifiedName || h.name}\` (${h.kind} in ${h.filePath}:${h.line}) as a starting point for answering «${q}»?`, criteria: RELEVANCE };
    });
    return { state: { question: q }, questions };
  },
  interpret: (res, rec) => scoresToRanking(res, cands(rec, 'hits').slice(0, 24).map((h) => h.id), Number(rec.payload.k ?? 8)),
};

export const C5: PointSpec = {
  id: 'C5',
  build(rec) {
    const q = clip(String(rec.payload.query), 400);
    const retry = ((rec.payload.retry as string[] | undefined) ?? []).slice(0, 12);
    const questions: Record<string, Question> = {
      answers: {
        type: 'noul',
        instructions: rec.payload.empty
          ? `The search for «${q}» found nothing. Is it likely that the code base simply does not contain what the question asks about?`
          : `Does a search result made of these files and symbols contain the code needed to answer «${q}»?`,
      },
    };
    if (retry.length >= 2) questions.retry = { type: 'choice', instructions: `Which name should the next search for «${q}» use?`, criteria: Object.fromEntries(retry.map((r, i) => [`r${i}`, r])) };
    return { state: { question: q, files: ((rec.payload.files as string[]) ?? []).slice(0, 10), symbols: ((rec.payload.symbols as string[]) ?? []).slice(0, 20) }, questions };
  },
  interpret(res, rec) {
    const v = noulToVerdict(res, 'answers');
    if (!v) return null;
    const retry = res.answers.retry;
    const names = (rec.payload.retry as string[] | undefined) ?? [];
    const ranking = retry && retry.type === 'choice'
      ? Object.entries(retry.probabilities).sort((a, b) => b[1] - a[1]).map(([k, s]) => ({ id: names[Number(k.slice(1))] ?? k, score: s }))
      : undefined;
    return { pick: v.pick === 'true' ? 'sufficient' : 'insufficient', p: v.p, ...(ranking ? { ranking } : {}) };
  },
};
