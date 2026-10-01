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

it('evicts idle projects while a call through an alias holds one connection open', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-cache-'));
  roots.push(root);
  __setLoadCodeGraphForTests(CodeGraph);
  handler = new ToolHandler(null);
  const cache = handler as unknown as {
    projectCache: Map<string, CodeGraph>;
    getCodeGraph(projectPath: string): CodeGraph;
  };
  const project = (name: string): string => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    CodeGraph.initSync(dir).close();
    return dir;
  };
  const first = project('first');
  const opened = cache.getCodeGraph(first);
  const close = vi.spyOn(opened, 'close');
  const alias = path.join(root, 'alias');
  if (process.platform !== 'win32') fs.symlinkSync(first, alias, 'dir');

  let started!: () => void;
  const dispatched = new Promise<void>(resolve => { started = resolve; });
  let finish!: (result: { content: [{ type: 'text'; text: string }] }) => void;
  const pending = new Promise<{ content: [{ type: 'text'; text: string }] }>(resolve => { finish = resolve; });
  vi.spyOn(handler, 'executeReadTool').mockImplementation(async () => { started(); return pending; });
  const active = handler.execute('codegraph_explore', {
    projectPath: process.platform === 'win32' ? first : alias,
    query: 'first',
  });
  await dispatched;
  for (let i = 0; i < MAX_CACHED_PROJECTS + 1; i++) cache.getCodeGraph(project(`idle-${i}`));
  expect(cache.projectCache.size).toBe(MAX_CACHED_PROJECTS);
  expect(close).not.toHaveBeenCalled();

  finish({ content: [{ type: 'text', text: 'done' }] });
  await active;
  for (let i = 0; i < MAX_CACHED_PROJECTS + 1; i++) cache.getCodeGraph(project(`later-${i}`));
  expect(close).toHaveBeenCalledOnce();
});
