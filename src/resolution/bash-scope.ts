import * as posix from 'node:path/posix';
import type { Node } from '../types';
import type { ResolutionContext } from './types';

/**
 * Bash keeps ONE function namespace per process: sourcing shares functions,
 * executing does not. Reachability is co-membership in some file's forward
 * closure — the model the two-tier gate below implements. Derived from the
 * import NODES the extractor created for sourcing statements, so it never
 * depends on whether a particular reference has become an edge yet.
 */

export type BashSourceClosure = Map<string, Set<string>>;

const closureMemos = new WeakMap<ResolutionContext, BashSourceClosure>();

export function clearBashScopeMemos(context: ResolutionContext): void {
  closureMemos.delete(context);
}

/** Forward closure per bash file: the file itself plus everything it transitively sources. */
export function buildSourceClosure(context: ResolutionContext): BashSourceClosure {
  const memo = closureMemos.get(context);
  if (memo) return memo;

  const sourcingEdges = new Map<string, Set<string>>();
  for (const node of context.getNodesByKind('import')) {
    if (node.language !== 'bash') continue;
    const target = resolveScriptPath(node.name, node.filePath);
    if (!target) continue;
    let set = sourcingEdges.get(node.filePath);
    if (!set) {
      set = new Set();
      sourcingEdges.set(node.filePath, set);
    }
    set.add(target);
  }

  const closures: BashSourceClosure = new Map();
  const compute = (file: string, seen: Set<string>): Set<string> => {
    const cached = closures.get(file);
    if (cached) return cached;
    if (seen.has(file)) return seen;
    seen.add(file);
    const out = new Set<string>([file]);
    for (const target of sourcingEdges.get(file) ?? []) {
      for (const f of compute(target, seen)) out.add(f);
    }
    seen.delete(file);
    closures.set(file, out);
    return out;
  };
  for (const file of sourcingEdges.keys()) compute(file, new Set());

  closureMemos.set(context, closures);
  return closures;
}

function resolveScriptPath(name: string, fromFile: string): string | null {
  if (!name.startsWith('./') && !name.startsWith('../')) return null;
  const dir = posix.dirname(fromFile);
  return posix.normalize(posix.join(dir, name));
}

export type GateVerdict =
  | { accept: 'full' | 'reduced'; confidence: number }
  | { accept: false };

/** Pure decision: is `candidate` reachable from the referencing file's process? */
export function gateBashNameMatch(
  refFilePath: string,
  candidateFilePath: string,
  closures: BashSourceClosure
): GateVerdict {
  if (refFilePath === candidateFilePath) return { accept: 'full', confidence: 0.92 };
  for (const closure of closures.values()) {
    if (closure.has(refFilePath) && closure.has(candidateFilePath)) {
      return { accept: 'reduced', confidence: 0.75 };
    }
  }
  return { accept: false };
}

/** Pick the reachable winner among same-named bash function candidates, or null. */
export function selectReachableBashFunction(
  refFilePath: string,
  candidates: Node[],
  closures: BashSourceClosure
): Node | null {
  let best: Node | null = null;
  let bestConfidence = 0;
  let tied = false;
  for (const candidate of candidates) {
    const verdict = gateBashNameMatch(refFilePath, candidate.filePath, closures);
    if (!verdict.accept) continue;
    if (verdict.confidence > bestConfidence) {
      best = candidate;
      bestConfidence = verdict.confidence;
      tied = false;
    } else if (verdict.confidence === bestConfidence && candidate.filePath !== best?.filePath) {
      // Several closure files define the name — stay unresolved rather than
      // guess which one the process actually sees.
      tied = true;
    }
  }
  return tied ? null : best;
}
