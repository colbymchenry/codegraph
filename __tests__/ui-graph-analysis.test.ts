import { describe, it, expect } from 'vitest';
import { graphCycles, mergeDisplayEdges, projectScene, shortestDirectedPath } from '../ui/src/lib/graph-analysis';
import type { GraphScene, SceneEdge } from '../ui/src/lib/graph-scene';
import { snapshotSvg } from '../ui/src/lib/graph-snapshot';

const edge = (id: string, source: string, target: string, count = 1): SceneEdge => ({ id, source, target, count, originalIds: [id], label: '', width: 1, arrow: true });
const scene = (): GraphScene => ({ kind: 'map', nodes: ['a', 'b', 'c', 'd'].map((id, i) => ({ id, x: i * 200, y: 20, width: 150, height: 40, label: id, sub: '', kind: 'module' })),
  edges: [edge('ab', 'a', 'b', 5), edge('ba', 'b', 'a', 2), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')],
  relations: [edge('ab', 'a', 'b'), edge('ba', 'b', 'a'), edge('bc', 'b', 'c'), edge('cd', 'c', 'd')], groups: [] });

describe('G6 analysis preserves directed semantic relationships', () => {
  it('BFS resolves equal shortest paths by stable target and edge IDs', () => {
    const edges = [edge('ac', 'a', 'c'), edge('cd', 'c', 'd'), edge('ab2', 'a', 'b'), edge('ab1', 'a', 'b'), edge('bd', 'b', 'd')];
    expect(shortestDirectedPath(['a', 'b', 'c', 'd'], edges, 'a', 'd')).toEqual({ nodes: ['a', 'b', 'd'], edges: ['ab1', 'bd'] });
    expect(shortestDirectedPath(['a', 'b', 'c', 'd'], edges.reverse(), 'd', 'a')).toBeNull();
    expect(shortestDirectedPath(['a'], edges, 'a', 'a')).toEqual({ nodes: ['a'], edges: [] });
    expect(shortestDirectedPath(['a'], edges, 'a', 'd')).toBeNull();
  });
  it('finds true cycles, self-loops and ignores missing endpoints', () => {
    expect(graphCycles(['a', 'b', 'c', 'd'], [...scene().relations, edge('dd', 'd', 'd'), edge('outside', 'd', 'missing')])).toEqual([['a', 'b'], ['d']]);
    expect(graphCycles(['a', 'b'], [edge('backward-screen-position', 'b', 'a')])).toEqual([]);
  });
  it('merges only display edges, retaining each direction and provenance', () => {
    const original = scene(); const merged = mergeDisplayEdges(original.edges, true);
    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({ source: 'a', target: 'b', count: 5, reverseCount: 2, originalIds: ['ab', 'ba'] });
    expect(mergeDisplayEdges([edge('za', 'z', 'a', 8)], true)[0]).toMatchObject({ source: 'z', target: 'a', count: 8, reverseCount: 0 });
    expect(original.edges).toHaveLength(4);
  });
  it('folding hides internal edges, aggregates external counts, and cannot invent a path', () => {
    const original = scene(); original.edges.push(edge('ac', 'a', 'c', 7));
    const projected = projectScene(original, [{ id: 'group', label: 'AB', members: ['a', 'b'] }], new Set(['group']), null);
    expect(projected.edges.find(e => e.source === 'group')).toMatchObject({ target: 'c', count: 8, originalIds: ['bc', 'ac'] });
    expect(projected.relations).toBe(original.relations);
    expect(shortestDirectedPath(original.nodes.map(n => n.id), projected.relations, 'a', 'd')?.nodes).toEqual(['a', 'b', 'c', 'd']);
    expect(shortestDirectedPath(original.nodes.map(n => n.id), projected.relations, 'd', 'a')).toBeNull();
    expect(projectScene(original, [], new Set(), new Set(['a', 'b'])).edges).toHaveLength(1);
  });
  it('exports routed geometry and code as escaped standalone SVG', () => {
    const data = scene(); data.nodes[0]!.label = '<script>alert(1)</script>';
    data.nodes[0]!.props = { data: { card: { hop: { source: { from: 7, lines: ['if (a < b) return a;'] }, callRef: { line: 7 } } } } };
    data.edges[0]!.path = 'M10 20 L30 20 Q40 20 40 30 L40 80';
    const svg = snapshotSvg(data);
    expect(svg).toContain('M10 20 L30 20 Q40 20 40 30 L40 80');
    expect(svg).toContain('&lt;script&gt;'); expect(svg).not.toContain('<script>');
    expect(svg).toContain('7  if (a &lt; b) return a;');
  });
  it('aggregates folded screen relations without merging opposite directions',()=>{
    const original=scene();original.kind='screens';original.edges.push(edge('ac','a','c',7),edge('ca','c','a',3));
    const projected=projectScene(original,[{id:'group',label:'AB',members:['a','b']}],new Set(['group']),null);
    expect(projected.edges.find(e=>e.source==='group'&&e.target==='c')).toMatchObject({count:8,originalIds:['bc','ac']});
    expect(projected.edges.find(e=>e.source==='c'&&e.target==='group')).toMatchObject({count:3});
  });
  it('focus keeps only attached terminal decorations and never turns them into real relations',()=>{
    const original=scene();original.kind='flow';original.nodes.push(...['cap-a','cap-d'].map(id=>({...original.nodes[0]!,id,decorative:true,kind:'cap'})));
    original.edges.push(edge('a-cap','a','cap-a'),edge('d-cap','d','cap-d'));
    const projected=projectScene(original,[],new Set(),new Set(['a','b']));
    expect(projected.nodes.map(n=>n.id)).toEqual(['a','b','cap-a']);expect(projected.relations).toBe(original.relations);
  });
});
