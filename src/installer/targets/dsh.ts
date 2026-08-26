/**
 * DSH (DeepSeek Harness) target.
 *
 * The first instructions-only target: DSH has no MCP client, so there
 * is no server config to write. Its agents pick up instructions from
 * plain markdown instead:
 *
 *   - local  → `<project-root>/AGENTS.md`   (workspace instruction
 *     candidates are AGENTS.md / CLAUDE.md; we write only AGENTS.md so
 *     the same marker block never lands in two files)
 *   - global → `<DSH_HOME>/AGENTS.md`       (a single user-global
 *     instruction file; DSH_HOME defaults to `~/.dsh`)
 *
 * Both surfaces are re-read by running sessions (content-digested each
 * turn), so unlike MCP-wired targets there is nothing to restart.
 * Agents drive CodeGraph through its CLI (`codegraph explore …`),
 * which prints the same output as the codegraph_explore MCP tool —
 * exactly the "non-MCP harness" audience the shared instructions
 * block was reintroduced for (#704).
 *
 * No permissions concept — there are no MCP tools to auto-allow, and
 * shell invocations follow whatever permission policy the harness
 * already runs under. `autoAllow` is silently ignored.
 *
 * Docs: https://colbymchenry.github.io/codegraph/
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AgentTarget,
  DetectionResult,
  InstallOptions,
  Location,
  WriteResult,
} from './types';
import { CODEGRAPH_SECTION_START, CODEGRAPH_SECTION_END } from '../instructions-template';
import {
  upsertInstructionsEntry,
  removeMarkedSection,
} from './shared';

/** `$DSH_HOME` when set, else `~/.dsh`. Mirrors DSH's own resolution order. */
function dshHome(): string {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function instructionsPath(loc: Location): string {
  return loc === 'global'
    ? path.join(dshHome(), 'AGENTS.md')
    : path.join(process.cwd(), 'AGENTS.md');
}

class DshTarget implements AgentTarget {
  readonly id = 'dsh' as const;
  readonly displayName = 'DSH (DeepSeek Harness)';
  // AGENTS.md is content-digested every turn by running sessions, so a
  // restart adds nothing.
  readonly requiresRestart = false;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = instructionsPath(loc);
    let alreadyConfigured = false;
    try {
      alreadyConfigured =
        fs.existsSync(file) &&
        fs.readFileSync(file, 'utf-8').includes(CODEGRAPH_SECTION_START);
    } catch { /* unreadable → treat as unconfigured */ }
    // Best-effort "is DSH present here" heuristic, mirroring the other
    // targets: the harness home (global) or an existing workspace
    // instructions file / git root (local). False negatives just mean
    // the user opts in manually.
    const installed =
      loc === 'global'
        ? fs.existsSync(dshHome())
        : fs.existsSync(file) || fs.existsSync(path.join(process.cwd(), '.git'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [upsertInstructionsEntry(instructionsPath(loc))];
    return {
      files,
      notes: [
        'No MCP config written — DSH has no MCP client; its agent calls the `codegraph` CLI via its shell tool.',
        'Running DSH sessions pick up AGENTS.md changes automatically; no restart needed.',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    return {
      files: [
        {
          path: instructionsPath(loc),
          action: removeMarkedSection(
            instructionsPath(loc),
            CODEGRAPH_SECTION_START,
            CODEGRAPH_SECTION_END,
          ),
        },
      ],
    };
  }

  printConfig(loc: Location): string {
    return [
      `# DSH (${loc}) — no MCP config; CodeGraph is wired through the`,
      `# ${instructionsPath(loc)} instructions block (DSH loads AGENTS.md`,
      `# every turn; its agent runs \`codegraph\` commands via its shell tool):`,
      '',
      '<!-- CODEGRAPH_START -->',
      '## CodeGraph',
      '',
      'In repositories indexed by CodeGraph (a `.codegraph/` directory exists at the repo root), reach for it BEFORE grep/find or reading files:',
      '',
      '- Shell: `codegraph explore "<symbol names or question>"` answers most code questions in one call.',
      '- If there is no `.codegraph/` directory, skip CodeGraph entirely.',
      '<!-- CODEGRAPH_END -->',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return [instructionsPath(loc)];
  }
}

export const dshTarget = new DshTarget();
