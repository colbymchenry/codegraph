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

  /** Build an acyclic two-file graph: c.ts imports d.ts, d.ts imports nothing. */
  async function withoutCycle(): Promise<void> {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'c.ts'),
      "import { d } from './d';\nexport function c() { return d(); }\n",
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'd.ts'),
      "export function d() { return 42; }\n",
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    h = new ToolHandler(cg);
  }

  it('reports a clean success message (not an error) when there are no cycles', async () => {
    await withoutCycle();
    const result = await h.execute('codegraph_check', {});
    expect(result.isError).toBeFalsy();                 // happy path, never isError
    const out = result.content.map((c) => (c as { text: string }).text).join('\n');
    expect(out.toLowerCase()).toContain('no circular');
  });

  it('reports each cycle separately when more than one exists', async () => {
    // Two independent cycles: x<->y in src/, and p<->q in other/.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'other'));
    fs.writeFileSync(path.join(dir, 'src', 'x.ts'),
      "import { y } from './y';\nexport function x() { return y(); }\n");
    fs.writeFileSync(path.join(dir, 'src', 'y.ts'),
      "import { x } from './x';\nexport function y() { return x(); }\n");
    fs.writeFileSync(path.join(dir, 'other', 'p.ts'),
      "import { q } from './q';\nexport function p() { return q(); }\n");
    fs.writeFileSync(path.join(dir, 'other', 'q.ts'),
      "import { p } from './p';\nexport function q() { return p(); }\n");
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    h = new ToolHandler(cg);

    const out = await text({});
    expect(out).toMatch(/2 cycles/i);
    expect(out).toMatch(/Cycle 1/);
    expect(out).toMatch(/Cycle 2/);
    // All four files appear somewhere in the output.
    for (const f of ['src/x.ts', 'src/y.ts', 'other/p.ts', 'other/q.ts']) {
      expect(out).toContain(f);
    }
  });

  it('is callable directly but NOT listed in the default tool surface', async () => {
    await withoutCycle();
    const result = await h.execute('codegraph_check', {});
    expect(result.isError).toBeFalsy();                       // callable

    // Default surface (no cg armed): the 4-tool trim. codegraph_check is
    // intentionally absent here — agents won't see it in tools/list unless
    // CODEGRAPH_MCP_TOOLS re-enables it.
    const unlisted = new ToolHandler(null).getTools().map((t) => t.name);
    expect(unlisted).not.toContain('codegraph_check');
  });
});
