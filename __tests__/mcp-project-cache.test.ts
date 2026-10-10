import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, expect, it, vi } from 'vitest';
import CodeGraph from '../src/index';
import { ToolHandler, MAX_CACHED_PROJECTS, __setLoadCodeGraphForTests } from '../src/mcp/tools';

const roots: string[] = [];
let handler: ToolHandler | null = null;

afterEach(async () => {
  await handler?.closeAll();
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
    trimProjects(): void;
  };
  const first = path.join(root, 'project-0');
  fs.mkdirSync(first);
  CodeGraph.initSync(first).close();
  const oldest = cache.getCodeGraph(first);
  let finish!: (result: { content: [{ type: 'text'; text: string }] }) => void;
  const pending = new Promise<{ content: [{ type: 'text'; text: string }] }>(resolve => { finish = resolve; });
  vi.spyOn(cache as unknown as { dispatchTool(): typeof pending }, 'dispatchTool')
    .mockReturnValue(pending);
  const alias = path.join(root, 'active-alias');
  if (process.platform !== 'win32') fs.symlinkSync(first, alias, 'dir');
  const activeCall = handler.executeReadTool('codegraph_search', {
    projectPath: process.platform === 'win32' ? first : alias,
  });
  for (let i = 1; i <= MAX_CACHED_PROJECTS; i++) {
    const project = path.join(root, `project-${i}`);
    fs.mkdirSync(project);
    CodeGraph.initSync(project).close();
    cache.getCodeGraph(project);
  }
  const close = vi.spyOn(oldest!, 'close');
  cache.trimProjects();
  expect(cache.projectCache.size).toBe(MAX_CACHED_PROJECTS);
  expect(close).not.toHaveBeenCalled();

  const extra = path.join(root, 'project-extra');
  fs.mkdirSync(extra);
  CodeGraph.initSync(extra).close();
  cache.getCodeGraph(extra);
  cache.trimProjects();
  expect(cache.projectCache.size).toBe(MAX_CACHED_PROJECTS);
  expect(close).not.toHaveBeenCalled();

  finish({ content: [{ type: 'text', text: 'done' }] });
  await activeCall;
  const last = path.join(root, 'project-last');
  fs.mkdirSync(last);
  CodeGraph.initSync(last).close();
  cache.getCodeGraph(last);
  cache.trimProjects();
  expect(close).toHaveBeenCalledOnce();
});

it('waits for a pinned read before finishing closeAll even with an empty cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cache-close-'));
  roots.push(root);
  CodeGraph.initSync(root).close();
  handler = new ToolHandler(null);
  let finish!: (result: { content: [{ type: 'text'; text: string }] }) => void;
  const pending = new Promise<{ content: [{ type: 'text'; text: string }] }>(resolve => { finish = resolve; });
  vi.spyOn(handler as unknown as { dispatchTool(): typeof pending }, 'dispatchTool').mockReturnValue(pending);
  const activeCall = handler.executeReadTool('codegraph_search', { projectPath: root });
  let closed = false;
  const closing = handler.closeAll().then(() => { closed = true; });
  await Promise.resolve();
  expect(closed).toBe(false);
  finish({ content: [{ type: 'text', text: 'done' }] });
  await activeCall;
  await closing;
  expect(closed).toBe(true);
});
