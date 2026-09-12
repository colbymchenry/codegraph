import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('Haskell production/test ranking audit', () => {
  let dir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-hs-low-value-'));
    const files: Record<string, string> = {
      'src/Pipeline.hs': `module Pipeline where
processItem value = value + 1
helperStep value = value * 2
`,
      'src/PipelineSpec.hs': `module PipelineSpec where
processItem value =
  let adjusted = value + 100
      observed = adjusted * 10
  in observed
helperStep value =
  let doubled = value * 2
      observed = doubled + 100
  in observed
`,
      'src/Support.hs': `module Support where
supportStep value = value - 1
`,
    };
    for (const [rel, body] of Object.entries(files)) {
      const abs = path.join(dir, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, body);
    }
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    handler = new ToolHandler(cg);
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a longer FooSpec.hs namesake from displacing production definitions', async () => {
    const result = await handler.execute('codegraph_explore', {
      query: 'processItem helperStep supportStep',
    });
    const text = result.content?.[0]?.text ?? '';
    const production = text.indexOf('**`src/Pipeline.hs`**');
    const spec = text.indexOf('**`src/PipelineSpec.hs`**');
    expect(production).toBeGreaterThanOrEqual(0);
    expect(spec).toBe(-1);
  });
});
