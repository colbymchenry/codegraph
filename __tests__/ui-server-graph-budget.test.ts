import { describe, it, expect, vi } from 'vitest';
import { graphBudget, programBudget, enforceStepsBudget, enforceFlowBudget } from '../src/ui-server/api/graph-budget';
import { buildScreens } from '../src/ui-server/api/screens';

describe('服务端图形预算', () => {
  it('统计程序 fork 图形，超限保留入口但不发送待绘制数组', () => {
    const root = [{ kind: 'fork', arms: [{ body: [{ kind: 'fork', arms: [] }] }] }];
    expect(programBudget(399, 10, root)).toMatchObject({ nodes: 401, edges: 14, exceeded: true });
    const payload = { anchor: { id: 'a' }, steps: Array(399).fill({}), links: Array(10).fill({}), program: { root } };
    expect(enforceStepsBudget(payload)).toMatchObject({ anchor: { id: 'a' }, steps: [], links: [], program: null, budget: { exceeded: true }, detailsDeferred: true });
    expect(graphBudget(400, 2000).exceeded).toBe(false);
  });
  it('屏幕超过400个时不读取导航边或构建转场', async () => {
    const incoming = vi.fn(() => { throw new Error('不应读取全部导航边'); });
    const cg = { getStats: () => ({ edgeCount: 1000000, fileCount: 500 }), getLastIndexedAt: () => 1, getNodesByKind: () => Array.from({ length: 401 }, (_, i) => ({ id: `r${i}`, name: `/page${i}`, filePath: `src/p${i}.tsx` })), getIncomingEdgesTo: incoming };
    const payload = await buildScreens(cg as any, '/repo', new URLSearchParams('bounded=1'));
    expect(payload).toMatchObject({ screens: [], origins: [], links: [], budget: { nodes: 401, exceeded: true }, detailsDeferred: true });
    expect(incoming).not.toHaveBeenCalled();
  });
  it('flow沿用节点去重、边和边界计数，超限显式说明', () => {
    const payload = { flows: [{ hops: Array.from({ length: 401 }, (_, i) => ({ node: { id: String(i) } })), boundary: null }], reason: null };
    expect(enforceFlowBudget(payload)).toMatchObject({ flows: [], budget: { nodes: 401, edges: 401, exceeded: true }, detailsDeferred: true });
  });
});
