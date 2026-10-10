import { readFileSync } from 'fs';
import { decisionConfig, pointEnabled } from './config';
import type { Verdict } from './types';

let loaded: { path: string; map: Map<string, Verdict> } | null = null;

/** References (by refKey) whose A2/A3 verdict was "none": final for the reference. */
const vetoed = new Set<string>();

/** B1 picks a framework resolver's name heuristic applied, by refKey: the resolver loop stamps them on its answer. */
const applied = new Map<string, Verdict>();

/**
 * The precomputed verdict for one decision instance, or undefined to keep the
 * heuristic. The file is produced offline (scripts/decide-offline.mjs)
 * with each point's floor already applied, so a present entry is authoritative.
 * Synchronous on purpose: resolution and synthesis are synchronous, and each
 * worker thread loads its own copy from the same path.
 */
export function overrideFor(point: string, key: string): Verdict | undefined {
  const cfg = decisionConfig();
  if (cfg.backend === 'auto' && !pointEnabled(cfg, point)) return undefined;
  const path = cfg.overridesPath;
  if (!path) return undefined;
  if (!loaded || loaded.path !== path) loaded = { path, map: load(path) };
  return loaded.map.get(`${point}|${key}`);
}

export function resetOverrides(): void {
  loaded = null;
  vetoed.clear();
  applied.clear();
}

export function noteApplied(refKey: string, v: Verdict): void {
  applied.set(refKey, v);
}

export function appliedFor(refKey: string): Verdict | undefined {
  return applied.get(refKey);
}

/** A site's "none" verdict ends its reference: no later strategy, pass, nor A6 may link it. */
export function vetoReference(refKey: string): void {
  vetoed.add(refKey);
}

export function isVetoed(refKey: string): boolean {
  return vetoed.has(refKey);
}

function load(path: string): Map<string, Verdict> {
  try {
    return new Map(Object.entries(JSON.parse(readFileSync(path, 'utf-8')) as Record<string, Verdict>));
  } catch {
    return new Map();
  }
}

/** True when an override file is configured (sites use it to skip work when nothing can change). */
export function overridesActive(): boolean {
  return !!decisionConfig().overridesPath;
}
