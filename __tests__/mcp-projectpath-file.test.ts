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

  // A file never reaches more than the folder holding it: whatever the folder's
  // answer is (the project's results, a sensitive-folder refusal, the
  // not-indexed guidance), the file gets that same answer.
  it('answers a file exactly as it answers the folder holding it', async () => {
    const ask = async (projectPath: string) => {
      const h = new ToolHandler(null);
      try {
        const res = await h.execute('codegraph_search', { query: 'fileTarget', projectPath });
        return { isError: res.isError, text: res.content[0]!.text };
      } finally {
        await h.closeAll();
      }
    };
    const ssh = path.join(os.homedir(), '.ssh');
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2982-outside-')));
    try {
      fs.mkdirSync(ssh, { recursive: true });
      fs.writeFileSync(path.join(ssh, 'known_hosts'), 'example.com ssh-ed25519 AAAA\n');
      fs.writeFileSync(path.join(outside, 'notes.txt'), 'hi\n');
      const files = [
        path.join(project, 'src', 'a.ts'),
        path.join(ssh, 'known_hosts'),
        path.join(outside, 'notes.txt'),
        ...(process.platform === 'win32' && fs.existsSync('C:\\Windows\\win.ini') ? ['C:\\Windows\\win.ini'] : []),
      ];
      for (const file of files) {
        expect({ file, ...(await ask(file)) }).toEqual({ file, ...(await ask(path.dirname(file))) });
      }
      const refused = await ask(path.join(ssh, 'known_hosts'));
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/sensitive/);
    } finally {
      fs.rmSync(ssh, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
