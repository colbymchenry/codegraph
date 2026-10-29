/**
 * A `projectPath` that names a file inside an indexed project (#2982).
 *
 * Passing the file it is looking at is an easy agent mistake. It used to be
 * refused with `isError: true` ("Path is not a directory") while a path that
 * doesn't exist at all walked up to the project's `.codegraph/` fine. A file
 * now resolves through its directory like any other path inside the project,
 * and the sensitive-folder refusal still applies to a file inside one.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';

describe('projectPath naming a file (#2982)', { timeout: 30_000 }, () => {
  let project: string;
  let handler: ToolHandler | undefined;

  beforeAll(async () => {
    project = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2982-')));
    fs.mkdirSync(path.join(project, 'src'));
    fs.writeFileSync(path.join(project, 'src', 'a.ts'), 'export function fileTarget() { return 1; }\n');
    const cg = await CodeGraph.init(project, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
    __setLoadCodeGraphForTests(CodeGraph);
  });

  afterAll(async () => {
    __setLoadCodeGraphForTests(null);
    if (handler) await handler.closeAll();
    fs.rmSync(project, { recursive: true, force: true });
  });

  it('resolves a file inside the project to that project', async () => {
    handler = new ToolHandler(null);
    const res = await handler.execute('codegraph_search', {
      query: 'fileTarget',
      projectPath: path.join(project, 'src', 'a.ts'),
    });

    expect(res.isError).toBeUndefined();
    expect(res.content[0]!.text).toMatch(/fileTarget/);
  });

  it.runIf(process.platform !== 'win32')('still refuses a file inside a sensitive folder', async () => {
    const res = await new ToolHandler(null).execute('codegraph_search', {
      query: 'anything',
      projectPath: '/etc/hosts',
    });

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/sensitive/);
  });
});
