import type { BuildContext, Cand, DecisionRecord, DecisionResponse, Verdict } from '../types';

export const MAX_CHOICES = 32;

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Choice criteria c0..cN for candidates plus named extra options ("none", "external", …). */
export function candidateOptions(cands: readonly Cand[], extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {};
  cands.slice(0, MAX_CHOICES).forEach((c, i) => {
    const sig = c.signature ? ` — ${clip(c.signature, 160)}` : '';
    out[`c${i}`] = `${c.qualifiedName || c.name} (${c.kind}) in ${c.filePath}:${c.line}${sig}`;
  });
  return { ...out, ...extra };
}

/** Choice answer → candidate id (option c<i>); a "none"-like option → pick null. */
export function choiceToCandidate(res: DecisionResponse, qid: string, cands: readonly Cand[], noneOptions: readonly string[] = ['none']): Verdict | null {
  const a = res.answers[qid];
  if (!a || a.type !== 'choice') return null;
  if (noneOptions.includes(a.choice)) return { pick: null, p: a.confidence };
  const m = /^c(\d+)$/.exec(a.choice);
  const c = m ? cands[Number(m[1])] : undefined;
  return c ? { pick: c.id, p: a.confidence } : null;
}

/** Choice answer → the option name; listed options → pick null. */
export function choiceToOption(res: DecisionResponse, qid: string, noneOptions: readonly string[] = []): Verdict | null {
  const a = res.answers[qid];
  if (!a || a.type !== 'choice') return null;
  return { pick: noneOptions.includes(a.choice) ? null : a.choice, p: a.confidence };
}

/** Noul answer → 'true' / 'false', with the probability of the chosen side. */
export function noulToVerdict(res: DecisionResponse, qid: string): Verdict | null {
  const a = res.answers[qid];
  if (!a || a.type !== 'noul') return null;
  return a.noul >= 0.5 ? { pick: 'true', p: a.noul } : { pick: 'false', p: 1 - a.noul };
}

/** Score answers s0..sN → ranking by expected score (stable: ties keep the heuristic order); p = mean confidence of the top k. */
export function scoresToRanking(res: DecisionResponse, ids: readonly string[], topK: number): Verdict | null {
  const scored: Array<{ id: string; score: number; confidence: number }> = [];
  ids.forEach((id, i) => {
    const a = res.answers[`s${i}`];
    if (a && a.type === 'score') scored.push({ id, score: a.score, confidence: a.confidence });
  });
  if (scored.length !== ids.length || scored.length === 0) return null;
  const ranked = [...scored].sort((x, y) => y.score - x.score);
  const top = ranked.slice(0, Math.max(1, topK));
  return { pick: null, p: top.reduce((s, x) => s + x.confidence, 0) / top.length, ranking: ranked.map(({ id, score }) => ({ id, score })) };
}

export function cands(rec: DecisionRecord, field = 'candidates'): Cand[] {
  const v = rec.payload[field];
  return Array.isArray(v) ? (v as Cand[]).slice(0, MAX_CHOICES) : [];
}

/** `around` lines either side of `line`, clipped per line. */
export function code(ctx: BuildContext, filePath: string, line: number, around = 2): string {
  if (!filePath || !(line > 0)) return '';
  return ctx.readLines(filePath, Math.max(1, line - around), line + around).map((l) => clip(l, 240)).join('\n');
}

export function imports(ctx: BuildContext, filePath: string): string[] {
  return ctx.readLines(filePath, 1, 60).filter((l) => /^\s*(import|from|require|using|use|#include|package)\b/.test(l)).slice(0, 25).map((l) => clip(l, 200));
}

export function head(ctx: BuildContext, filePath: string, lines: number, maxChars = 4000): string {
  return ctx.readLines(filePath, 1, lines).join('\n').slice(0, maxChars);
}

/** First line (1-based) containing `needle`, for sites that only know the file; 0 if absent. */
export function findLine(ctx: BuildContext, filePath: string, needle: string, maxLines = 4000): number {
  const i = ctx.readLines(filePath, 1, maxLines).findIndex((l) => l.includes(needle));
  return i >= 0 ? i + 1 : 0;
}
