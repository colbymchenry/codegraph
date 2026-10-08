/**
 * Decision-model contracts — the "SystemOne" request/response format shared by
 * TypeSafe Jev and Cloudflare Clef. A decision model answers typed questions
 * about a state with calibrated probabilities and never generates text.
 * CodeGraph consults one at a heuristic decision site only when explicitly
 * enabled (./config); every entry point is inert by default.
 */

export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string> }
  | { type: 'score'; instructions: string; criteria: string[] };

export interface DecisionRequest {
  /** Text or JSON the questions are about. Keep it small: irrelevant context hurts these models. */
  state: unknown;
  questions: Record<string, Question>;
}

export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> }
  | { type: 'score'; score: number; confidence: number; probabilities: Record<string, number> };

export interface DecisionResponse {
  model: string;
  answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number };
  latencyMs: number;
  cached: boolean;
}

/** auto = free-Clef/JEV policy; cf / jev = an explicitly selected hosted provider. */
export type Backend = 'off' | 'auto' | 'cf' | 'jev';

/**
 * What a site does with an answer. `pick` is a candidate id, an option name
 * ('true' / 'false' / a category), or null for "none of these"; `p` is the
 * model's probability for that pick. Ranking points also carry `ranking`.
 */
export interface Verdict {
  pick: string | null;
  p: number;
  ranking?: Array<{ id: string; score: number }>;
}

/** A definition offered to the model as an option. */
export interface Cand {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  line: number;
  endLine?: number;
  signature?: string;
  exported?: boolean;
  language?: string;
}

/** One decision instance: recorded for precomputation or built for a live call. */
export interface DecisionRecord {
  point: string;
  key: string;
  payload: Record<string, unknown>;
  heuristic: { pick: string | null; confidence?: number };
}

/** Project source access for building decision requests. */
export interface BuildContext {
  readLines(filePath: string, start: number, end: number): string[];
  listFiles?(limit: number): string[];
}

/** A decision point's model contract. `build` → null means "not askable" (e.g. a single candidate). */
export interface PointSpec {
  id: string;
  build(rec: DecisionRecord, ctx: BuildContext): DecisionRequest | null;
  interpret(res: DecisionResponse, rec: DecisionRecord): Verdict | null;
}
