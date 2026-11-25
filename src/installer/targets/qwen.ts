/**
 * Qwen Code target.
 *
 *   - MCP server entry under `mcpServers` in `settings.json`: `$QWEN_HOME`
 *     (default `~/.qwen`) when global, `./.qwen` when local. Qwen documents a
 *     stdio entry as `{ command, args }`.
 *   - Instructions to `QWEN.md`: in `$QWEN_HOME` when global, at the project
 *     root when local.
 *   - With `autoAllow`, `permissions.allow` gains `mcp__codegraph`, Qwen's rule
 *     for every tool of one server. It is not Claude's `mcp__codegraph__*`.
 *
 * Qwen reads `settings.json` with comments allowed and keeps them when it saves
 * the file, so this target's edits keep them too (see `./json-config.ts`).
 *
 * Docs: https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/
 *       https://qwenlm.github.io/qwen-code-docs/en/users/configuration/settings/
 *       https://qwenlm.github.io/qwen-code-docs/en/users/features/memory/
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types';
import {
  editJson,
  hasCodegraphServer,
  parseJsonConfig,
  removeCodegraphServer,
  upsertCodegraphServer,
} from './json-config';
import {
  configDirFromEnv,
  getStdioServerConfig,
  removeInstructionsEntry,
  upsertInstructionsEntry,
} from './shared';

const ALLOW_RULE = 'mcp__codegraph';

function configDir(loc: Location): string {
  return loc === 'global'
    ? configDirFromEnv('QWEN_HOME', path.join(os.homedir(), '.qwen'))
    : path.join(process.cwd(), '.qwen');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

function instructionsPath(loc: Location): string {
  return loc === 'global' ? path.join(configDir('global'), 'QWEN.md') : path.join(process.cwd(), 'QWEN.md');
}

/** Adds the rule, unless `permissions` or its `allow` is something this can't add to. */
function addAllowRule(text: string): string {
  const { permissions } = parseJsonConfig(text);
  if (permissions === undefined) return editJson(text, ['permissions', 'allow'], [ALLOW_RULE]);
  if (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions)) return text;
  if (permissions.allow === undefined) return editJson(text, ['permissions', 'allow'], [ALLOW_RULE]);
  if (!Array.isArray(permissions.allow) || permissions.allow.includes(ALLOW_RULE)) return text;
  return editJson(text, ['permissions', 'allow', -1], ALLOW_RULE, { isArrayInsertion: true });
}

/** Takes the rule out, with an `allow` or `permissions` left empty by that. */
function removeAllowRule(text: string): string {
  const { permissions } = parseJsonConfig(text);
  const at = Array.isArray(permissions?.allow) ? permissions.allow.indexOf(ALLOW_RULE) : -1;
  if (at === -1) return text;
  if (permissions.allow.length > 1) return editJson(text, ['permissions', 'allow', at], undefined);
  const rest = editJson(text, ['permissions', 'allow'], undefined);
  return Object.keys(permissions).length === 1 ? editJson(rest, ['permissions'], undefined) : rest;
}

class QwenTarget implements AgentTarget {
  readonly id = 'qwen' as const;
  readonly displayName = 'Qwen Code';
  readonly docsUrl = 'https://qwenlm.github.io/qwen-code-docs/en/users/features/mcp/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    return {
      installed: fs.existsSync(configDir(loc)),
      alreadyConfigured: hasCodegraphServer(file),
      configPath: file,
    };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const settings = upsertCodegraphServer(
      settingsJsonPath(loc),
      getStdioServerConfig(),
      opts.autoAllow ? addAllowRule : undefined,
    );
    return {
      files: [settings, upsertInstructionsEntry(instructionsPath(loc))],
      notes: ['Restart any running Qwen Code session to pick up the MCP server.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return {
      files: [
        removeCodegraphServer(settingsJsonPath(loc), removeAllowRule),
        removeInstructionsEntry(instructionsPath(loc)),
      ],
    };
  }

  printConfig(loc: Location): string {
    const snippet = JSON.stringify({ mcpServers: { codegraph: getStdioServerConfig() } }, null, 2);
    return `# Add to ${settingsJsonPath(loc)}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

export const qwenTarget: AgentTarget = new QwenTarget();
