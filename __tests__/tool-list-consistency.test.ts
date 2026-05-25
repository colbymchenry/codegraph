import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const repoRoot = path.resolve(__dirname, '..');
const MCP_TOOLS = [
  'codegraph_search',
  'codegraph_context',
  'codegraph_trace',
  'codegraph_callers',
  'codegraph_callees',
  'codegraph_impact',
  'codegraph_node',
  'codegraph_explore',
  'codegraph_files',
  'codegraph_status',
];

describe('MCP tool list docs stay in sync', () => {
  it('serve help lists every MCP tool named in the README table', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');
    const cli = fs.readFileSync(path.join(repoRoot, 'src/bin/codegraph.ts'), 'utf-8');

    const table = readme.match(/## MCP Tools[\s\S]*?\| `codegraph_search`[\s\S]*?\| `codegraph_status`[^\n]*\n/);
    expect(table).not.toBeNull();

    const helpBlock = cli.match(/console\.error\('Available tools:'\);[\s\S]*?\n      \}/);
    expect(helpBlock).not.toBeNull();

    for (const tool of MCP_TOOLS) {
      expect(table![0]).toContain(`\`${tool}\``);
      expect(helpBlock![0]).toContain(`  ${tool}`);
    }
  });

  it('Claude permission example covers every README-listed MCP tool', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf-8');

    const permissionBlock = readme.match(/"allow": \[[\s\S]*?\]/);
    expect(permissionBlock).not.toBeNull();

    const table = readme.match(/## MCP Tools[\s\S]*?\| `codegraph_search`[\s\S]*?\| `codegraph_status`[^\n]*\n/);
    expect(table).not.toBeNull();

    for (const tool of MCP_TOOLS) {
      expect(table![0]).toContain(`\`${tool}\``);
      expect(permissionBlock![0]).toContain(`mcp__codegraph__${tool}`);
    }
  });
});
