import { describe, expect, it } from 'vitest';
import { graphBudget, oneHop, programBudget } from '../ui/src/lib/graph-budget';
import { readGraphHistory, saveGraphHistory } from '../ui/src/lib/graph-history';

import { createHttpAdapter } from '../ui/src/lib/adapter';
import { moduleTarget } from '../ui/src/lib/map-scope';
import { calculateLayout } from '../ui/src/lib/graph-layout-runner';

describe('图谱工作台范围与轻量历史', () => {
  it('Map请求把可选范围筛选与按需详情传给HTTP预算入口', async () => {
    const requests: string[] = [];
    const adapter = createHttpAdapter({ fetch: async input => { requests.push(String(input)); return new Response('{}'); } });
    await adapter.map({ root: 'src/lib', depth: 2, includeTests: false, minWeight: 8, details: true });
    const query = new URL(requests[0]!, 'http://localhost/').searchParams;
    expect(Object.fromEntries(query)).toEqual({ bounded: '1', root: 'src/lib', depth: '2', tests: '0', minWeight: '8', details: '1' });
    await adapter.map({ includeTests: true });
    expect(new URL(requests[1]!, 'http://localhost/').searchParams.get('tests')).toBe('1');
    await adapter.map();
    const defaults = new URL(requests[2]!, 'http://localhost/').searchParams;
    expect(defaults.has('tests')).toBe(false);
    expect(defaults.has('details')).toBe(false);
  });
  it('门面、根文件聚合桶与目录保持不同导航语义', () => {
    expect(moduleTarget({ id: 'src/index.ts', facade: true })).toEqual({ kind: 'file', path: 'src/index.ts' });
    expect(moduleTarget({ id: 'src/(root files)', facade: false })).toEqual({ kind: 'root-files', path: 'src' });
    expect(moduleTarget({ id: '(root files)', facade: false })).toEqual({ kind: 'root-files', path: '' });
    expect(moduleTarget({ id: 'src/lib', facade: false })).toEqual({ kind: 'directory', path: 'src/lib' });
  });
  it('预算边界允许等于上限，任一维度超出都拒绝', () => {
    expect(graphBudget(400, 2000).exceeded).toBe(false);
    expect(graphBudget(401, 1).exceeded).toBe(true);
    expect(graphBudget(1, 2001).exceeded).toBe(true);
  });
  it('布局入口在读取节点详情前拒绝超预算输入', () => {
    expect(() => calculateLayout('map', { modules: new Array(401), links: [] }, { includeTests: true })).toThrow('400');
  });
  it('顺序图预算计入嵌套分支生成的决策节点', () => {
    const root = [{ kind: 'block', body: [{ kind: 'fork', arms: [{ body: [{ kind: 'fork', arms: [] }] }] }] }];
    expect(programBudget(399, 10, root).exceeded).toBe(true);
    expect(programBudget(398, 10, root).nodes).toBe(400);
  });
  it('一跳聚焦保持方向且不扩展第二跳或无关节点', () => {
    const edges = [{ source: 'a', target: 'b' }, { source: 'c', target: 'a' }, { source: 'b', target: 'd' }];
    expect([...oneHop('a', edges, 'out')!]).toEqual(['a', 'b']);
    expect([...oneHop('a', edges, 'in')!]).toEqual(['a', 'c']);
    expect([...oneHop('a', edges, 'both')!]).toEqual(['a', 'b', 'c']);
    expect(oneHop(null, edges, 'both')).toBeNull();
  });
  it('项目与完整URL隔离，局部更新保留选择和视口', () => {
    const a = '#/p/a/map?depth=2';
    saveGraphHistory(a, { selected: 'src', viewport: { x: 20, y: -5, zoom: .8 } });
    saveGraphHistory(a, { scroll: 400 });
    expect(readGraphHistory(a)).toEqual({ selected: 'src', viewport: { x: 20, y: -5, zoom: .8 }, scroll: 400 });
    expect(readGraphHistory('#/p/b/map?depth=2')).toEqual({});
    expect(readGraphHistory('#/p/a/map?depth=3')).toEqual({});
  });
  it('轻量历史容量有限，不保存大图', () => {
    saveGraphHistory('old', { selected: 'gone' });
    for (let i = 0; i < 101; i++) saveGraphHistory(`page-${i}`, { selected: String(i) });
    expect(readGraphHistory('old')).toEqual({});
    expect(readGraphHistory('page-100')).toEqual({ selected: '100' });
  });
});
