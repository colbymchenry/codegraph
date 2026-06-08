/**
 * codegraph_node FILE-VIEW mode: a bare `file` (no `symbol`) returns that file's
 * symbol map + graph role (dependents), and verbatim bodies with includeCode —
 * a Read replacement for a source file that also surfaces the blast radius.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_node file-view (Read replacement)', () => {
  let dir: string;
  let cg: CodeGraph;
  let h: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fileview-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function helper(x: number) {\n  return x + 1;\n}\nexport class Widget {\n  build() { return helper(1); }\n}\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      "import { helper } from './a';\nexport function useHelper() { return helper(2); }\n",
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    h = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const text = async (args: Record<string, unknown>): Promise<string> =>
    (await h.execute('codegraph_node', args)).content.map((c) => c.text).join('\n');

  it("a bare file (no symbol) returns the file's symbols + dependents", async () => {
    const out = await text({ file: 'a.ts' });
    expect(out).toContain('src/a.ts');
    expect(out).toContain('helper');
    expect(out).toContain('Widget');
    expect(out).toMatch(/depended on by 1 file/i);
    expect(out).toContain('src/b.ts'); // the dependent file (blast radius)
  });

  it('resolves by basename and returns verbatim bodies with includeCode', async () => {
    const out = await text({ file: 'a.ts', includeCode: true });
    expect(out).toContain('return x + 1'); // helper body
    expect(out).toContain('class Widget'); // class body, verbatim
    // It must NOT steer the agent back to Read — it is the Read replacement.
    expect(out.toLowerCase()).not.toContain('read `src/a.ts`');
  });

  it('still works as a normal symbol lookup (no regression)', async () => {
    const out = await text({ symbol: 'helper', includeCode: true });
    expect(out).toContain('helper');
    expect(out).toContain('return x + 1');
  });

  it('a miss returns a helpful message, not a crash', async () => {
    const out = await text({ file: 'does-not-exist.ts' });
    expect(out).toMatch(/no indexed file matches/i);
  });
});
