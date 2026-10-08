import { appendFileSync } from 'fs';
import { createHash } from 'crypto';
import type { Node } from '../types';
import { decisionConfig, pointEnabled } from './config';
import { overrideFor, overridesActive } from './overrides';
import type { Cand, DecisionRecord, Verdict } from './types';

/** Records written per (record file, point) — keyed by file so separate runs never share a cap. */
const counts = new Map<string, number>();

const seen = new Set<string>();

/** True when this process records instances for `point` (or for any point when omitted). */
export function isRecording(point?: string): boolean {
  const cfg = decisionConfig();
  if (!cfg.recordPath) return false;
  if (point === undefined) return cfg.points === 'all' || cfg.points.size > 0;
  return pointEnabled(cfg, point);
}

/** Append one instance to the precomputation JSONL. Never throws: recording must not change what CodeGraph returns. */
export function recordDecision(rec: DecisionRecord): void {
  const cfg = decisionConfig();
  if (!cfg.recordPath || !pointEnabled(cfg, rec.point)) return;
  const ck = `${cfg.recordPath}|${rec.point}`;
  const n = counts.get(ck) ?? 0;
  if (n >= cfg.recordMax) return;
  // A key names one decision instance; repeat visits must not consume the cap (and the cap check above bounds `seen`).
  const dk = `${cfg.recordPath}|${rec.point}|${rec.key}`;
  if (seen.has(dk)) return;
  seen.add(dk);
  counts.set(ck, n + 1);
  try {
    appendFileSync(cfg.recordPath, JSON.stringify(rec) + '\n', 'utf-8');
  } catch {
    /* recording is best-effort */
  }
}

/**
 * The one call a synchronous decision site makes: record the instance (when
 * recording that point) and return the precomputed override (when present).
 * `payload` is a thunk so a site pays nothing unless the point is recorded.
 */
export function atSite(point: string, key: string, heuristicPick: string | null, payload: () => Record<string, unknown>): Verdict | undefined {
  if (isRecording(point)) recordDecision({ point, key, payload: payload(), heuristic: { pick: heuristicPick } });
  return overrideFor(point, key);
}

/** Whether a site must consult `point` at all: it is recorded, or an overrides file is set. Sites guard on it so the off path builds no keys or payloads. */
export function deciding(point: string): boolean {
  return isRecording(point) || overridesActive();
}

/**
 * Decision point B2 for one channel over its fan-out cap: the returned function asks
 * whether a dispatcher → handler pair shares one emitter, bus or queue — at most 64
 * pairs per channel, never a self pair — and gives the edge marker for a 'true' verdict.
 */
export function b2Asker(
  site: string,
  event: string,
): (d: string, h: string, locs: () => { dispatcher: { filePath: string; line: number }; handler: { filePath: string; line: number } }) => { decision: string; decisionP: number } | undefined {
  let asked = 0;
  return (d, h, locs) => {
    if (d === h || asked >= 64) return undefined;
    asked++;
    const v = atSite('B2', `${site}:${event}:${d}:${h}`, 'false', () => ({ event, ...locs() }));
    return v?.pick === 'true' ? { decision: 'B2', decisionP: v.p } : undefined;
  };
}

/**
 * Decision point B1, a synthesis site with several same-named candidates: record the
 * instance and return the override — the candidate it picks, or null for "none" — or
 * undefined to keep the heuristic when no override names a current candidate.
 */
export function decideB1(
  key: string,
  site: { kind: string; name: string; filePath: string; line: number },
  cands: readonly Node[],
  heuristic: Node | null | undefined,
): { pick: Node | null; p: number } | undefined {
  const pickId = heuristic?.id ?? null;
  const v = atSite('B1', key, pickId, () => ({ site, candidates: capWithPick(cands, pickId, 32).map(toCand), total: cands.length }));
  if (!v) return undefined;
  if (v.pick === null) return { pick: null, p: v.p };
  const chosen = cands.find((n) => n.id === v.pick);
  return chosen ? { pick: chosen, p: v.p } : undefined;
}

export function toCand(n: Node): Cand {
  return {
    id: n.id,
    name: n.name,
    qualifiedName: n.qualifiedName,
    kind: n.kind,
    filePath: n.filePath,
    line: n.startLine,
    endLine: n.endLine,
    ...(n.signature ? { signature: n.signature } : {}),
    ...(n.isExported !== undefined ? { exported: n.isExported } : {}),
    language: n.language,
  };
}

/** First `max` items, swapping the heuristic's pick in when it would fall past the cap. */
export function capWithPick<T extends { id: string }>(items: readonly T[], pickId: string | null, max: number): T[] {
  const head = items.slice(0, max);
  if (!pickId || head.some((x) => x.id === pickId)) return head;
  const pick = items.find((x) => x.id === pickId);
  return pick ? [...head.slice(0, max - 1), pick] : head;
}

/** Instance key of a reference — stable across re-indexes of the same tree (node ids are content hashes). */
export function refKey(r: { fromNodeId: string; line: number; column: number; referenceKind: string }): string {
  return `${r.fromNodeId}:${r.line}:${r.column}:${r.referenceKind}`;
}

export function refPayload(r: { referenceName: string; referenceKind: string; filePath: string; line: number; column: number }): Record<string, unknown> {
  return { name: r.referenceName, kind: r.referenceKind, filePath: r.filePath, line: r.line, column: r.column };
}

export function hashKey(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16);
}

/** "path/to/file.ts:42" → { filePath, line } (synthesizers record registration sites this way). */
export function splitLoc(at: string | undefined): { filePath: string; line: number } {
  const m = at ? /^(.*):(\d+)$/.exec(at) : null;
  return m ? { filePath: m[1]!, line: Number(m[2]) } : { filePath: at ?? '', line: 0 };
}
