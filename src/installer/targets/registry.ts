/**
 * Registry of all known agent targets.
 *
 * Adding a new built-in target = create `targets/<id>.ts` exporting an
 * `AgentTarget`, then add it to the array below. Order here is the
 * order they appear in the multiselect prompt, in `--target=all`,
 * and in `--print-config`'s help listing — keep it stable.
 *
 * User-defined custom targets (`./custom.ts`, managed by
 * `codegraph targets add`) are appended after the built-ins by
 * `getAllTargets()` — every resolution path below goes through it, so
 * customs behave exactly like built-ins for `--target`, detection,
 * uninstall sweeps, and `--print-config`.
 */

import { AgentTarget, Location, TargetId } from './types';
import { claudeTarget } from './claude';
import { cursorTarget } from './cursor';
import { codexTarget } from './codex';
import { opencodeTarget } from './opencode';
import { hermesTarget } from './hermes';
import { geminiTarget } from './gemini';
import { antigravityTarget } from './antigravity';
import { kiroTarget } from './kiro';
import { loadCustomTargets } from './custom';

export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  claudeTarget,
  cursorTarget,
  codexTarget,
  opencodeTarget,
  hermesTarget,
  geminiTarget,
  antigravityTarget,
  kiroTarget,
]);

/** Built-ins + user-defined custom targets, in that order. */
export function getAllTargets(): AgentTarget[] {
  const builtinIds = ALL_TARGETS.map((t) => t.id);
  return [...ALL_TARGETS, ...loadCustomTargets(builtinIds).targets];
}

export function getTarget(id: string): AgentTarget | undefined {
  return getAllTargets().find((t) => t.id === id);
}

export function listTargetIds(): TargetId[] {
  return getAllTargets().map((t) => t.id);
}

/**
 * Run `detect()` for every target at the given location. Returns the
 * full registry zipped with detection results — orchestrator uses
 * this to seed the multiselect prompt with installed agents
 * pre-checked.
 */
export function detectAll(loc: Location): Array<{
  target: AgentTarget;
  detection: ReturnType<AgentTarget['detect']>;
}> {
  return getAllTargets().map((target) => ({
    target,
    detection: target.detect(loc),
  }));
}

/**
 * Resolve a `--target=` flag value to a list of `AgentTarget`
 * instances. Accepts:
 *
 *   - `auto` — return all targets whose `detect().installed` is true,
 *     or `['claude']` as a fallback if none detected (least-surprise
 *     for existing users).
 *   - `all` — every target in the registry (built-in + custom).
 *   - `none` — empty list (caller skips agent writes entirely).
 *   - csv list — `'claude,cursor'` etc. Unknown ids throw.
 */
export function resolveTargetFlag(value: string, loc: Location): AgentTarget[] {
  if (value === 'none') return [];
  if (value === 'all') return getAllTargets();
  if (value === 'auto') {
    const detected = detectAll(loc).filter(({ detection }) => detection.installed);
    if (detected.length > 0) return detected.map(({ target }) => target);
    const fallback = getTarget('claude');
    return fallback ? [fallback] : [];
  }

  const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
  const resolved: AgentTarget[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const t = getTarget(id);
    if (t) resolved.push(t);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    const known = listTargetIds().join(', ');
    throw new Error(
      `Unknown --target id(s): ${unknown.join(', ')}. Known: ${known}, plus 'auto' / 'all' / 'none'.`,
    );
  }
  return resolved;
}
