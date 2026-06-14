/**
 * codegraph_check — surfaces file-level circular import cycles via the MCP
 * tool surface. Backed by the existing (previously dead-code)
 * CodeGraph.findCircularDependencies() DFS detector.
 *
 * Scope of this suite: the MCP wiring (tool def + dispatch + handler +
 * formatting). The underlying algorithm is already covered elsewhere; we
 * treat it as a black box and assert on the formatted tool output.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('codegraph_check (circular import detection)', () => {
  let dir: string;
  let cg: CodeGraph;
  let h: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-check-'));
    cg = null as unknown as CodeGraph;
    h = null as unknown as ToolHandler;
  });

  afterEach(() => {
    if (cg) try { cg.close(); } catch { /* already closed */ }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Build a two-file import cycle a.ts <-> b.ts, index, and arm the handler. */
  async function withCycle(): Promise<void> {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      "import { b } from './b';\nexport function a() { return b(); }\n",
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      "import { a } from './a';\nexport function b() { return a(); }\n",
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    h = new ToolHandler(cg);
  }

  const text = async (args: Record<string, unknown>): Promise<string> =>
    (await h.execute('codegraph_check', args)).content.map((c) => (c as { text: string }).text).join('\n');

  it('detects a two-file import cycle and names both files in the output', async () => {
    await withCycle();
    const out = await text({});

    expect(out).toMatch(/circular/i);                    // header mentions "circular"
    expect(out).toContain('src/a.ts');                   // both cycle members named
    expect(out).toContain('src/b.ts');
    expect(out).toMatch(/(1 cycle|cycles?:\s*1)/i);      // cycle count present
  });
});
