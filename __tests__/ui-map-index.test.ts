import { describe, expect, it, vi } from 'vitest';
import { buildMapLayout, isEdgeVisible, portPoint } from '../ui/src/lib/map-model';
import { mapSvg } from '../ui/src/lib/export-svg';
import { buildMapIndex, indexedOneHop, cachedPresentation, mapNodeMeasurements } from '../ui/src/lib/map-index';

function fixture() {
  return buildMapLayout({
    modules: ['a', 'b', 'c', 'd'].map(id => ({ id, label: id, files: 1, symbols: 1, test: false, facade: false, generated: 0, generatedFiles: [], languages: [], fileList: { total: 0, shown: 0, truncated: false, items: [] } })),
    links: [['a', 'b'], ['c', 'a'], ['b', 'd']].map(([source, target]) => ({ source: source!, target: target!, count: 10, declared: 10, byKind: [], topPairs: [] })),
  }, { includeTests: false });
}

describe('Map布局索引和展示缓存', () => {
  it('400节点选择变化保留布局尺寸和位置', () => {
  const source = Array.from({ length: 400 }, (_, i) => ({ id: String(i), width: 180, height: 40 }));
  const present = cachedPresentation((node: typeof source[number], flags: string) => ({ id: node.id, position: { x: Number(node.id) * 200, y: 0 }, data: { flags }, ...mapNodeMeasurements(node) }));
  const before = source.map(node => present(node, '00'));
  const after = source.map((node, i) => present(node, i === 200 ? '10' : i >= 195 && i <= 205 ? '00' : '01'));
  expect(after.filter((node, i) => node !== before[i])).toHaveLength(390);
  for (const [i, node] of after.entries()) { expect(node.measured).toEqual({ width: 180, height: 40 }); expect(node.position).toEqual(before[i]!.position); }
});
  it('节点和一跳入出关系可直接定位，不扩展第二跳', () => {
    const layout = fixture();
    const index = buildMapIndex(layout);
    expect(index.nodeById.get('a')).toBe(layout.nodes.find(n => n.id === 'a'));
    expect([...indexedOneHop(index, 'a', 'in')!]).toEqual(['a', 'c']);
    expect([...indexedOneHop(index, 'a', 'out')!]).toEqual(['a', 'b']);
    expect([...indexedOneHop(index, 'a', 'both')!]).toEqual(['a', 'c', 'b']);
    expect(indexedOneHop(index, null, 'both')).toBeNull();
    expect(indexedOneHop(null, 'a', 'both')).toBeNull();
  });
  it('入出边索引与现有选中边语义一致，概览保持原可见性', () => {
    const layout = fixture(); const index = buildMapIndex(layout);
    expect(index.atRest).toEqual(layout.edges.filter(edge => isEdgeVisible(edge, null)));
    for (const node of layout.nodes) {
      expect(index.incident.get(node.id) ?? []).toEqual(layout.edges.filter(edge => isEdgeVisible(edge, node.id)));
    }
  });
  it('固定锚点仍使用原始扇出端口，坐标和SVG导出一致', () => {
    const layout = fixture();
    const source = layout.nodes.find(node => node.id === 'a')!;
    const other = layout.nodes.find(node => node.id === 'c')!;
    const extra = { ...layout.edges[0]!, id: 'extra', source: 'a', target: 'c', sourceHandle: 's:extra', targetHandle: 't:extra' };
    source.ports.bottom.push({ id: extra.id, type: 'source' }); source.sourceHandles.push(extra.id);
    other.ports.top.push({ id: extra.id, type: 'target' }); other.targetHandles.push(extra.id);
    layout.edges.push(extra);
    const index = buildMapIndex(layout);
    const svg = mapSvg(layout, { selected: 'a' });
    const rounded = (value: number) => Math.round(value * 10) / 10;
    for (const edge of layout.edges.filter(edge => edge.source === 'a')) {
      const points = index.edgePoints.get(edge.id)!;
      expect(points.source).toEqual(portPoint(index.nodeById.get(edge.source)!, edge.id, 'source'));
      expect(points.target).toEqual(portPoint(index.nodeById.get(edge.target)!, edge.id, 'target'));
      const { x: sx, y: sy } = points.source; const { x: tx, y: ty } = points.target;
      const mid = (sy + ty) / 2;
      expect(svg).toContain(`M${rounded(sx)},${rounded(sy)} C${rounded(sx)},${rounded(mid)} ${rounded(tx)},${rounded(mid)} ${rounded(tx)},${rounded(ty)}`);
    }
    const points = layout.edges.filter(edge => edge.source === 'a').map(edge => index.edgePoints.get(edge.id)!.source.x);
    expect(new Set(points).size).toBe(2);
  });
  it('悬停改变仅替换相关展示对象，未变化节点或边保留引用', () => {
    const build = vi.fn((source: object, flags: string) => ({ source, flags }));
    const present = cachedPresentation(build);
    const a = {}; const b = {};
    const firstA = present(a, '0'); const firstB = present(b, '0');
    expect(present(a, '0')).toBe(firstA);
    const hotA = present(a, '1');
    expect(hotA).not.toBe(firstA);
    expect(present(a, '1')).toBe(hotA);
    expect(present(b, '0')).toBe(firstB);
    expect(build).toHaveBeenCalledTimes(3);
    const changedLayout = cachedPresentation(build);
    expect(changedLayout(a, '1')).not.toBe(hotA);
  });
});

describe('手动排列与连线几何', () => {
  it('拖动只平移对应端口，不改变原始布局和依赖方向', async () => {
    const { positionedMapPoints, positionedMapLayout } = await import('../ui/src/lib/map-index');
    const layout = fixture(); const index = buildMapIndex(layout); const edge = layout.edges[0]!;
    const from = index.nodeById.get(edge.source)!; const to = index.nodeById.get(edge.target)!;
    const positions = new Map([[from.id, { x: from.x + 90, y: from.y - 60 }], [to.id, { x: to.x - 30, y: to.y + 40 }]]);
    const before = index.edgePoints.get(edge.id)!;
    expect(positionedMapPoints(index, edge, positions)).toEqual({ source: { x: before.source.x + 90, y: before.source.y - 60 }, target: { x: before.target.x - 30, y: before.target.y + 40 } });
    const moved = positionedMapLayout(layout, positions);
    expect(moved.edges).toBe(layout.edges);
    expect(moved.nodes.find(n => n.id === from.id)?.x).toBe(from.x + 90);
    expect(layout.nodes.find(n => n.id === from.id)?.x).toBe(from.x);
    expect(moved.layers).toEqual([]);
    const svg = mapSvg(moved, { selected: from.id });
    const start = positionedMapPoints(index, edge, positions).source;
    expect(svg).toContain(`M${Math.round(start.x * 10) / 10},${Math.round(start.y * 10) / 10}`);
    expect(svg).toContain('marker-end=');
    expect(svg).not.toContain('animation');
  });
  it('未拖动时保留自动布局，项目与范围分别保存位置', async () => {
    const { positionedMapLayout } = await import('../ui/src/lib/map-index');
    const { readGraphHistory, saveGraphHistory } = await import('../ui/src/lib/graph-history');
    const layout = fixture();
    expect(positionedMapLayout(layout, new Map())).toBe(layout);
    saveGraphHistory('drag/p/a/map?depth=1', { positions: { same: { x: 100, y: 200 } } });
    expect(readGraphHistory('drag/p/a/map?depth=1').positions?.same).toEqual({ x: 100, y: 200 });
    expect(readGraphHistory('drag/p/b/map?depth=1').positions).toBeUndefined();
    expect(readGraphHistory('drag/p/a/map?depth=2').positions).toBeUndefined();
  });
});
