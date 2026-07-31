/**
 * Hermes Agent target.
 *
 * Hermes reads MCP servers from `$HERMES_HOME/config.yaml` under the
 * top-level `mcp_servers` key, and exposes discovered MCP tools through
 * dynamic toolsets named `mcp-<server>`. We add:
 *
 *   mcp_servers.codegraph -> `codegraph serve --mcp`
 *   platform_toolsets.cli -> `mcp-codegraph`
 *
 * The second entry matters because Hermes CLI profiles often enable an
 * explicit `platform_toolsets.cli` list. Without `mcp-codegraph` in that
 * list, the MCP server can be configured and connected but its tools may
 * still be filtered out of normal CLI sessions.
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
import { atomicWriteFileSync } from './shared';

type LineRange = { start: number; end: number };

class HermesTarget implements AgentTarget {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes Agent';
  readonly docsUrl = 'https://hermes-agent.nousresearch.com';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = configPath();
    const content = readText(file);
    const installed = fs.existsSync(hermesHome()) || fs.existsSync(file);
    return {
      installed,
      alreadyConfigured: hasCodeGraphMcpServer(content) && hasHermesQuerySkill(),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Hermes Agent uses $HERMES_HOME/config.yaml; re-run with --location=global.'],
      };
    }
    return {
      files: [writeHermesConfig(), writeHermesQuerySkill()],
      notes: [
        'Start a new Hermes session for MCP and skill changes to take effect.',
        'Ask Hermes to use the codegraph-query skill for graph-backed codebase questions.',
      ],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = configPath();
    if (!fs.existsSync(file)) {
      return { files: [{ path: file, action: 'not-found' }, removeHermesQuerySkill()] };
    }

    const before = readText(file);
    const after = removeCodeGraphToolset(removeCodeGraphMcpServer(before));
    const removedSkill = removeHermesQuerySkill();
    if (after === before) {
      return { files: [{ path: file, action: 'not-found' }, removedSkill] };
    }
    atomicWriteFileSync(file, ensureTrailingNewline(after));
    return { files: [{ path: file, action: 'removed' }, removedSkill] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Hermes Agent uses $HERMES_HOME/config.yaml; use --location=global.\n';
    }
    return [
      `# Add to ${configPath()}`,
      '',
      renderCodeGraphMcpBlock().join('\n'),
      '',
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      '    - mcp-codegraph',
      '',
      `# CodeGraph query skill is installed at ${hermesQuerySkillPath()}`,
      '# Load it in Hermes with: /skill codegraph-query',
      '',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [configPath(), hermesQuerySkillPath()] : [];
  }
}

const HERMES_QUERY_SKILL_NAME = 'codegraph-query';

function hermesHome(): string {
  return process.env.HERMES_HOME
    ? path.resolve(process.env.HERMES_HOME)
    : path.join(os.homedir(), '.hermes');
}

function configPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

function hermesQuerySkillPath(): string {
  return path.join(hermesHome(), 'skills', HERMES_QUERY_SKILL_NAME, 'SKILL.md');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function writeHermesConfig(): WriteResult['files'][number] {
  const file = configPath();
  const existed = fs.existsSync(file);
  const before = readText(file);
  const afterMcp = upsertCodeGraphMcpServer(before);
  const after = upsertCodeGraphToolset(afterMcp);

  if (after === before) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, ensureTrailingNewline(after));
  return { path: file, action: existed ? 'updated' : 'created' };
}


function renderHermesQuerySkill(): string {
  return `---
name: ${HERMES_QUERY_SKILL_NAME}
description: Use CodeGraph from Hermes to answer natural-language codebase questions with graph-backed MCP tools, explicit projectPath recovery, and preserved operational notices.
---

# CodeGraph Query for Hermes

Use this skill when a Hermes user asks a natural-language question about an indexed codebase, such as how a feature works, where a symbol is used, what calls a function, what a change might affect, or which files matter for a task.

## Requirements

- Prefer CodeGraph MCP tools from the \`mcp-codegraph\` toolset over raw file reads when graph/index data can answer the question.
- Choose the most specific graph operation available:
  - Search or node lookup for symbol discovery.
  - Context for task-scoped understanding.
  - Trace for flows between symbols or modules.
  - Callers/callees for call relationships.
  - Impact for change-risk questions.
  - Files for project structure questions.
- If the MCP server is unavailable, use the CodeGraph CLI as a manual fallback where possible, for example \`codegraph query <question>\`, \`codegraph context <task>\`, \`codegraph callers <symbol>\`, or \`codegraph impact <symbol>\`.
- Do not invent edges, callers, flows, or source locations. If CodeGraph output is empty or insufficient, say what was missing and recommend a narrower query, re-index, or raw code inspection.

## Project path recovery

Hermes sessions sometimes start outside the indexed repository. If CodeGraph reports that no default project is loaded or that it searched from the wrong directory:

1. Ask for or infer the intended repository path.
2. Retry with an absolute \`projectPath\` argument when using MCP tools.
3. If using CLI fallback, run the command from the repository root or pass the command's path argument when supported.

Never hide this recovery step. The user should know which project index answered the question.

## Preserve operational notices

CodeGraph warnings are part of answer correctness. Preserve notices about:

- stale or pending index updates,
- catch-up sync or filesystem reconciliation,
- worktree/index mismatch,
- not-initialized projects,
- missing or ambiguous symbols.

Surface these notices with the answer instead of summarizing them away.

## Response shape

Answer concisely:

1. Direct answer.
2. Graph evidence: relevant symbols, files, source locations, or paths from CodeGraph output.
3. Operational notices, if any.
4. Suggested next graph query when useful.
`;
}

function hasHermesQuerySkill(): boolean {
  return readText(hermesQuerySkillPath()) === renderHermesQuerySkill();
}

function writeHermesQuerySkill(): WriteResult['files'][number] {
  const file = hermesQuerySkillPath();
  const existed = fs.existsSync(file);
  const before = readText(file);
  const after = renderHermesQuerySkill();
  if (before === after) return { path: file, action: 'unchanged' };
  atomicWriteFileSync(file, ensureTrailingNewline(after));
  return { path: file, action: existed ? 'updated' : 'created' };
}

function removeHermesQuerySkill(): WriteResult['files'][number] {
  const file = hermesQuerySkillPath();
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  fs.rmSync(file);
  const dir = path.dirname(file);
  try {
    fs.rmdirSync(dir);
  } catch {
    // Keep the directory if the user has added other files beside SKILL.md.
  }
  return { path: file, action: 'removed' };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function splitLines(content: string): string[] {
  return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
}

function joinLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function topLevelRange(lines: string[], key: string): LineRange | null {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function childRange(lines: string[], parent: LineRange, child: string): LineRange | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^  \S/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }
  return { start, end };
}

/**
 * Block-range for a 2-space-indented child whose value is a YAML block list.
 *
 * Unlike `childRange`, this handles PyYAML's default `default_flow_style=False`
 * serialization, where list items sit at the SAME indent as the parent key:
 *
 *     cli:
 *     - hermes-cli       # indent 2 — belongs to cli, not a sibling
 *     - browser
 *
 * `childRange`'s `^  \S` heuristic mistakes that first `  - hermes-cli` line
 * for the next sibling key and truncates the block, causing inserts to land
 * before the existing items at a different indent (issue #456). This helper
 * recognizes a `  - ` line as part of the block instead, and reports back
 * the actual indent used by existing items so the inserter matches it.
 */
function listChildBlock(
  lines: string[],
  parent: LineRange,
  child: string,
): (LineRange & { itemIndent: string }) | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^( *)/);
    const indent = indentMatch?.[1]?.length ?? 0;
    if (indent >= 4) continue;
    if (indent === 2 && /^  - /.test(line)) continue;
    end = i;
    break;
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }

  let itemIndent = '    ';
  for (let i = start + 1; i < end; i++) {
    const m = (lines[i] ?? '').match(/^( +)- /);
    if (m && m[1]) {
      itemIndent = m[1];
      break;
    }
  }
  return { start, end, itemIndent };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function renderCodeGraphMcpChild(): string[] {
  return [
    '  codegraph:',
    '    command: codegraph',
    '    args:',
    '      - serve',
    '      - --mcp',
    '    timeout: 120',
    '    connect_timeout: 60',
    '    enabled: true',
  ];
}

function renderCodeGraphMcpBlock(): string[] {
  return ['mcp_servers:', ...renderCodeGraphMcpChild()];
}

function hasCodeGraphMcpServer(content: string): boolean {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  return !!parent && !!childRange(lines, parent, 'codegraph');
}

function upsertCodeGraphMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  const child = parent ? childRange(lines, parent, 'codegraph') : null;
  const replacement = renderCodeGraphMcpChild();

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...renderCodeGraphMcpBlock());
    return joinLines(lines);
  }

  if (child) {
    const existing = lines.slice(child.start, child.end);
    if (arrayEqual(existing, replacement)) return joinLines(lines);
    lines.splice(child.start, child.end - child.start, ...replacement);
    return joinLines(lines);
  }

  lines.splice(parent.end, 0, ...replacement);
  return joinLines(lines);
}

function removeCodeGraphMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  const child = parent ? childRange(lines, parent, 'codegraph') : null;
  if (!child) return content;
  lines.splice(child.start, child.end - child.start);
  return joinLines(lines);
}

function upsertCodeGraphToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('platform_toolsets:', '  cli:', '    - hermes-cli', '    - mcp-codegraph');
    return joinLines(lines);
  }

  if (!cli) {
    lines.splice(parent.end, 0, '  cli:', '    - hermes-cli', '    - mcp-codegraph');
    return joinLines(lines);
  }

  const hasEntry = lines
    .slice(cli.start + 1, cli.end)
    .some((line) => line.trim() === '- mcp-codegraph');
  if (hasEntry) return joinLines(lines);

  lines.splice(cli.end, 0, `${cli.itemIndent}- mcp-codegraph`);
  return joinLines(lines);
}

function removeCodeGraphToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;
  if (!cli) return content;

  const hasEntry = lines
    .slice(cli.start + 1, cli.end)
    .some((line) => line.trim() === '- mcp-codegraph');
  if (!hasEntry) return content;

  const next = lines.filter((line, idx) => {
    if (idx <= cli.start || idx >= cli.end) return true;
    return line.trim() !== '- mcp-codegraph';
  });
  return joinLines(next);
}

function arrayEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

export const hermesTarget: AgentTarget = new HermesTarget();
