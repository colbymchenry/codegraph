import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import CodeGraph from '../src/index';
import { ToolHandler, __setLoadCodeGraphForTests } from '../src/mcp/tools';

const roots: string[] = [];
let handler: ToolHandler | null = null;

afterEach(() => {
  handler?.closeAll();
  handler = null;
  __setLoadCodeGraphForTests(null);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('trims idle projects while another project call remains active', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-cache-'));
  roots.push(root);
  __setLoadCodeGraphForTests(CodeGraph);
  handler = new ToolHandler(null);
  const cache = handler as unknown as {
    projectCache: Map<string, CodeGraph>;
    getCodeGraph(projectPath: string): CodeGraph;
    trimProjectCache(): void;
  };
  let oldest: CodeGraph | undefined;
  for (let i = 0; i < 21; i++) {
    const project = path.join(root, `project-${i}`);
    fs.mkdirSync(project);
    CodeGraph.initSync(project).close();
    const opened = cache.getCodeGraph(project);
    if (i === 0) oldest = opened;
  }
  let finish!: (result: { content: [{ type: 'text'; text: string }] }) => void;
  const pending = new Promise<{ content: [{ type: 'text'; text: string }] }>(resolve => { finish = resolve; });
  vi.spyOn(cache as unknown as { dispatchTool(): typeof pending }, 'dispatchTool')
    .mockReturnValue(pending);
  const alias = path.join(root, 'active-alias');
  if (process.platform !== 'win32') fs.symlinkSync(path.join(root, 'project-0'), alias, 'dir');
  const activeCall = handler.executeReadTool('codegraph_search', {
    projectPath: process.platform === 'win32' ? path.join(root, 'project-0') : alias,
  });
  const close = vi.spyOn(oldest!, 'close');
  cache.trimProjectCache();
  expect(cache.projectCache.size).toBe(20);
  expect(close).not.toHaveBeenCalled();

  const extra = path.join(root, 'project-extra');
  fs.mkdirSync(extra);
  CodeGraph.initSync(extra).close();
  cache.getCodeGraph(extra);
  cache.trimProjectCache();
  expect(cache.projectCache.size).toBe(20);
  expect(close).not.toHaveBeenCalled();

  finish({ content: [{ type: 'text', text: 'done' }] });
  await activeCall;
  const last = path.join(root, 'project-last');
  fs.mkdirSync(last);
  CodeGraph.initSync(last).close();
  cache.getCodeGraph(last);
  cache.trimProjectCache();
  expect(close).toHaveBeenCalledOnce();
});
