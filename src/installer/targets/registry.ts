/**
 * Registry of all known agent targets.
 *
 * Adding a new target = create `targets/<id>.ts` exporting an
 * `AgentTarget`, then add it to the array below. Order here is the
 * order they appear in the multiselect prompt, in `--target=all`,
 * and in `--print-config`'s help listing — keep it stable.
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
import { ampTarget } from './amp';
import { augmentTarget } from './augment';
import { bobTarget } from './bob';
import { openclawTarget } from './openclaw';
import { clineTarget } from './cline';
import { codeartsTarget } from './codearts';
import { codebuddyTarget } from './codebuddy';
import { codemakerTarget } from './codemaker';
import { codestudioTarget } from './codestudio';
import { commandCodeTarget } from './command-code';
import { continueTarget } from './continue';
import { cortexTarget } from './cortex';
import { crushTarget } from './crush';
import { deepagentsTarget } from './deepagents';
import { devinTarget } from './devin';
import { droidTarget } from './droid';
import { firebenderTarget } from './firebender';
import { forgecodeTarget } from './forgecode';
import { githubCopilotTarget } from './github-copilot';
import { gooseTarget } from './goose';
import { junieTarget } from './junie';
import { iflowTarget } from './iflow';
import { kilocodeTarget } from './kilocode';
import { mcpjamTarget } from './mcpjam';
import { mistralVibeTarget } from './mistral-vibe';
import { muxTarget } from './mux';
import { openhandsTarget } from './openhands';
import { pipiTarget } from './pipi';
import { qoderTarget } from './qoder';
import { qwenTarget } from './qwen';
import { rovodevTarget } from './rovodev';
import { rooTarget } from './roo';
import { tabnineTarget } from './tabnine';
import { traeTarget } from './trae';
import { traeCnTarget } from './trae-cn';
import { windsurfTarget } from './windsurf';
import { zencoderTarget } from './zencoder';
import { neovateTarget } from './neovate';
import { pochipochiTarget } from './pochipochi';
import { adalTarget } from './adal';

import { aiderTarget } from './aider';
export const ALL_TARGETS: readonly AgentTarget[] = Object.freeze([
  claudeTarget,
  cursorTarget,
  codexTarget,
  opencodeTarget,
  hermesTarget,
  geminiTarget,
  antigravityTarget,
  kiroTarget,
  aiderTarget,
  ampTarget,
  augmentTarget,
  bobTarget,
  openclawTarget,
  clineTarget,
  codeartsTarget,
  codebuddyTarget,
  codemakerTarget,
  codestudioTarget,
  commandCodeTarget,
  continueTarget,
  cortexTarget,
  crushTarget,
  deepagentsTarget,
  devinTarget,
  droidTarget,
  firebenderTarget,
  forgecodeTarget,
  githubCopilotTarget,
  gooseTarget,
  junieTarget,
  iflowTarget,
  kilocodeTarget,
  mcpjamTarget,
  mistralVibeTarget,
  muxTarget,
  openhandsTarget,
  pipiTarget,
  qoderTarget,
  qwenTarget,
  rovodevTarget,
  rooTarget,
  tabnineTarget,
  traeTarget,
  traeCnTarget,
  windsurfTarget,
  zencoderTarget,
  neovateTarget,
  pochipochiTarget,
  adalTarget,
]);

export function getTarget(id: string): AgentTarget | undefined {
  return ALL_TARGETS.find((t) => t.id === id);
}

export function listTargetIds(): TargetId[] {
  return ALL_TARGETS.map((t) => t.id);
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
  return ALL_TARGETS.map((target) => ({
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
 *   - `all` — every target in the registry.
 *   - `none` — empty list (caller skips agent writes entirely).
 *   - csv list — `'claude,cursor'` etc. Unknown ids throw.
 */
export function resolveTargetFlag(value: string, loc: Location): AgentTarget[] {
  if (value === 'none') return [];
  if (value === 'all') return [...ALL_TARGETS];
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
