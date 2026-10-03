import { describe, it, expect } from 'vitest';
import { calculateLayout } from '../ui/src/lib/graph-layout-runner';
import { compactMapPositions } from '../ui/src/lib/map-compact';

describe('聚焦图紧凑排列', () => {
  const data = {
    nodes: ['anchor', 'incoming', 'outgoing', 'mutual'].map(id => ({ id, width: id === 'incoming' ? 500 : 200, height: 40 })),
    edges: [{ source: 'incoming', target: 'anchor' }, { source: 'anchor', target: 'outgoing' }, { source: 'anchor', target: 'mutual' }, { source: 'mutual', target: 'anchor' }],
    selected: 'anchor',
  };
  it('保留全部节点，上游在前、下游在后，不依赖旧全图坐标', () => {
    const positions = compactMapPositions(data);
    expect(Object.keys(positions).sort()).toEqual(data.nodes.map(node => node.id).sort());
    expect(positions.incoming!.x).toBeLessThan(positions.anchor!.x);
    expect(positions.outgoing!.x).toBeGreaterThan(positions.anchor!.x);
    expect(positions.mutual!.y).toBeGreaterThan(positions.anchor!.y);
    expect(compactMapPositions({ ...data, nodes: [...data.nodes].reverse(), edges: [...data.edges].reverse() })).toEqual(positions);
    expect(calculateLayout('map-compact', data, {})).toEqual(positions);
  });
  it('按实际宽高留出间距，400个双向邻居仍不重叠', () => {
    const nodes = Array.from({ length: 400 }, (_, i) => ({ id: `n${i}`, width: 150 + i % 4 * 90, height: 40 + i % 3 * 10 }));
    const edges = nodes.slice(1).flatMap(node => [{ source: 'n0', target: node.id }, { source: node.id, target: 'n0' }]);
    const positions = compactMapPositions({ nodes, edges, selected: 'n0' });
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!; const b = nodes[j]!; const x = positions[a.id]!; const y = positions[b.id]!;
      expect(x.x + a.width <= y.x || y.x + b.width <= x.x || x.y + a.height <= y.y || y.y + b.height <= x.y).toBe(true);
    }
  });
  it('Worker入口拒绝超预算紧凑任务', () => {
    expect(() => calculateLayout('map-compact', { ...data, nodes: new Array(401) }, {})).toThrow('400');
  });
});
