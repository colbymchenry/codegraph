/**
 * The completeness footer only calls WHOLE files complete (#1918).
 *
 * On projects that earn the completeness signal, explore used to end every
 * response with "Complete source for N files is included above — do NOT
 * re-read them", even when those files were rendered as slices with gap
 * markers. The agent saw both the gaps and the promise, and Read the file.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

describe('codegraph_explore completeness footer', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-complete-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    // A god-file far over the per-file budget, so explore has to slice it.
    const fat: string[] = ['export class Engine {'];
    for (let i = 0; i < 200; i++) {
      fat.push(`  step${i}(input: string): string {`);
      for (let j = 0; j < 6; j++) fat.push(`    input = input.replace("a${j}", "b${i}_${j}");`);
      fat.push(`    return input;`, `  }`);
    }
    fat.push('}');
    fs.writeFileSync(path.join(srcDir, 'engine.ts'), fat.join('\n'));
    // A small file that fits whole.
    fs.writeFileSync(
      path.join(srcDir, 'runner.ts'),
      `import { Engine } from './engine';\nexport function runStep7(e: Engine) { return e.step7('x'); }\n`,
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  async function exploreAsMediumProject(query: string): Promise<string> {
    // The signal is gated to projects of >= 500 files; fake the tier.
    const spy = vi.spyOn(cg, 'getStats').mockReturnValue({ fileCount: 1000 } as ReturnType<CodeGraph['getStats']>);
    try {
      const result = await handler.execute('codegraph_explore', { query });
      return result.content?.[0]?.text ?? '';
    } finally {
      spy.mockRestore();
    }
  }

  it('names a sliced file as a slice instead of calling it complete', async () => {
    const text = await exploreAsMediumProject('src/engine.ts runStep7 step7');
    // The fixture must actually have been sliced, or this test proves nothing.
    expect(text).toContain('(gap');
    expect(text).toMatch(/\*\*1 file is shown as slices\*\*/);
    expect(text).toContain('Complete source for 1 file is included above');
    expect(text).not.toMatch(/Complete source for 2 files/);
  });

  it('never points the agent at a tool it is not given', async () => {
    const text = await exploreAsMediumProject('src/engine.ts runStep7 step7');
    expect(text).not.toContain('codegraph_node');
  });

  it('keeps the small-project trim note, without naming a hidden tool', async () => {
    const result = await handler.execute('codegraph_explore', { query: 'src/engine.ts runStep7 step7' });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('(gap');
    expect(text).toContain('Some file sections were trimmed for size.');
    expect(text).not.toContain('Complete source for');
    expect(text).not.toContain('codegraph_node');
  });
});
