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

it('keeps in-use project connections open until the active call finishes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-project-cache-'));
  roots.push(root);
  __setLoadCodeGraphForTests(CodeGraph);
  handler = new ToolHandler(null);
  const cache = handler as unknown as {
    activeOperations: number;
    projectCache: Map<string, CodeGraph>;
    getCodeGraph(projectPath: string): CodeGraph;
    trimProjectCache(): void;
  };
  cache.activeOperations = 1;
  let oldest: CodeGraph | undefined;
  for (let i = 0; i < 21; i++) {
    const project = path.join(root, `project-${i}`);
    fs.mkdirSync(project);
    CodeGraph.initSync(project).close();
    const opened = cache.getCodeGraph(project);
    if (i === 0) oldest = opened;
  }
  const close = vi.spyOn(oldest!, 'close');
  cache.trimProjectCache();
  expect(cache.projectCache.size).toBe(21);
  expect(close).not.toHaveBeenCalled();

  cache.activeOperations = 0;
  cache.trimProjectCache();
  expect(cache.projectCache.size).toBe(20);
  expect(close).toHaveBeenCalledOnce();
});
