import type { Answer, DecisionRequest, DecisionResponse, Question } from './types';

export interface ClientOptions {
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * POST one SystemOne request to JEV or hosted Clef.
 * Returns null on ANY failure — network, timeout, non-2xx, malformed body —
 * so every caller falls back to its heuristic.
 */
export async function askSystemOne(req: DecisionRequest, opts: ClientOptions): Promise<DecisionResponse | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
  const t0 = Date.now();
  try {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}) },
      body: JSON.stringify({ model: opts.model, state: req.state, questions: req.questions }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    type Body = { model?: unknown; answers?: Record<string, unknown>; usage?: { input_tokens?: unknown; prompt_tokens?: unknown; output_tokens?: unknown } };
    const raw = (await res.json()) as Body & { result?: Body };
    // Cloudflare wraps its model output in { result, success, errors }; JEV does not.
    const body: Body = raw.result && typeof raw.result === 'object' && raw.result.answers ? raw.result : raw;
    const answers = normalizeAnswers(req.questions, body.answers ?? {});
    if (!answers) return null;
    return {
      model: typeof body.model === 'string' ? body.model : opts.model,
      answers,
      usage: { inputTokens: Number(body.usage?.input_tokens ?? body.usage?.prompt_tokens) || 0, outputTokens: Number(body.usage?.output_tokens) || 0 },
      latencyMs: Date.now() - t0,
      cached: false,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Validate provider answers against the question's type before applying them. */
export function normalizeAnswers(questions: Record<string, Question>, raw: Record<string, unknown>): Record<string, Answer> | null {
  const out: Record<string, Answer> = {};
  for (const [id, q] of Object.entries(questions)) {
    const a = raw[id] as Record<string, unknown> | undefined;
    if (!a || typeof a !== 'object') return null;
    if (q.type === 'noul') {
      const p = a.noul;
      if (!isProbability(p)) return null;
      out[id] = { type: 'noul', noul: p };
      continue;
    }
    const probabilities = toProbabilities(a.probabilities);
    const confidence = a.confidence;
    if (confidence !== undefined && !isProbability(confidence)) return null;
    if (q.type === 'choice') {
      if (typeof a.choice !== 'string' || !Object.hasOwn(q.criteria, a.choice)) return null;
      out[id] = { type: 'choice', choice: a.choice, confidence: confidence ?? probabilities[a.choice] ?? 0, probabilities };
    } else {
      const score = a.score;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > q.criteria.length - 1) return null;
      out[id] = { type: 'score', score, confidence: confidence ?? 0, probabilities };
    }
  }
  return out;
}

function isProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function toProbabilities(v: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (isProbability(x)) out[k] = x;
    }
  }
  return out;
}
