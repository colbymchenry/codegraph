/**
 * Registry of all known agent targets.
 *
 * Adding a new builtin target = create `targets/<id>.ts` exporting an
 * `AgentTarget`, then add it to the array below. Order here is the
 * order they appear in the multiselect prompt, in `--target=all`,
 * and in `--print-config`'s help listing — keep it stable.
 *
 * User defined targets (`./custom.ts`, managed by `codegraph targets add`)
 * follow the builtin ones in `getAllTargets()`. Every lookup below goes
 * through it, so `--target`, detection, the picker, uninstall's sweep,
 * `--refresh` and `--print-config` treat them like builtin targets.
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
import { copilotVscodeTarget } from './copilot-vscode';
import { copilotCliTarget } from './copilot-cli';
import { copilotJetbrainsTarget } from './copilot-jetbrains';
import { bobTarget } from './bob';
import { droidTarget } from './droid';
import { windsurfTarget } from './windsurf';
import { qwenTarget } from './qwen';
import { dshTarget } from './dsh';
import { grokTarget } from './grok';
import { kimiTarget } from './kimi';
import { qoderTarget } from './qoder';
import { piTarget } from './pi';
import { customTargetFamily, loadCustomTargets } from './custom';

export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  claudeTarget,
  cursorTarget,
  codexTarget,
  opencodeTarget,
  hermesTarget,
  geminiTarget,
  antigravityTarget,
  kiroTarget,
  copilotVscodeTarget,
  copilotCliTarget,
  copilotJetbrainsTarget,
  bobTarget,
  droidTarget,
  windsurfTarget,
  qwenTarget,
  dshTarget,
  grokTarget,
  kimiTarget,
  qoderTarget,
  piTarget,
]);

/** The builtin targets, then the user defined ones from `~/.codegraph/targets.json`. */
export function getAllTargets(): AgentTarget[] {
  return [...ALL_TARGETS, ...loadCustomTargets(ALL_TARGETS).targets];
}

/**
 * What telemetry records for a target: a builtin id as it is, and
 * `custom-<family>` for a user defined target, never the name the user gave
 * it. TELEMETRY.md promises agent names only.
 */
export function telemetryTargetId(id: string): string {
  const family = customTargetFamily(id, ALL_TARGETS);
  return family ? `custom-${family}` : id;
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
 *   - `all` — every target in the registry, user defined ones included.
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
