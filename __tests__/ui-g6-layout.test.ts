import { describe, it, expect } from 'vitest';
import { buildMapLayout } from '../ui/src/lib/map-model';
import { layoutArchitecture } from '../ui/src/lib/g6-layout';

function fixture(count: number, cycle = false) {
  return buildMapLayout({ modules: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, label: `n${i}`, files: 1, symbols: 1, test: false, facade: false, generated: 0, generatedFiles: [], languages: [], fileList: { total: 0, shown: 0, truncated: false, items: [] } })),
    links: Array.from({ length: cycle ? count * 5 : count - 1 }, (_, i) => ({ source: `n${cycle ? Math.floor(i / 5) : i}`, target: `n${cycle ? (Math.floor(i / 5) + i % 5 + 1) % count : i + 1}`, count: 10, declared: 10, byKind: [], topPairs: [] })) }, { includeTests: false });
}
describe('AntV architecture layout', () => {
  it('reserves non-overlapping areas for directory groups',async()=>{
    const input=fixture(4);const ids=['src/a/one','src/b/one','src/a/two','src/b/two'];
    const renamed=new Map(input.nodes.map((n,i)=>[n.id,ids[i]!]));
    input.nodes=input.nodes.map(n=>({...n,id:renamed.get(n.id)!}));input.edges=input.edges.map(e=>({...e,source:renamed.get(e.source)!,target:renamed.get(e.target)!}));
    const placed=await layoutArchitecture(input);
    const box=(prefix:string)=>{const n=placed.nodes.filter(n=>n.id.startsWith(prefix));return {left:Math.min(...n.map(n=>n.x)),right:Math.max(...n.map(n=>n.x+n.width)),top:Math.min(...n.map(n=>n.y)),bottom:Math.max(...n.map(n=>n.y+n.height))};};
    const a=box('src/a/'),b=box('src/b/');expect(a.right<b.left||b.right<a.left||a.bottom<b.top||b.bottom<a.top).toBe(true);
    expect(placed.edges.map(e=>e.id)).toEqual(input.edges.map(e=>e.id));
  });
  it('lays dependencies left to right without changing domain edges', async () => {
    const original = fixture(5); const placed = await layoutArchitecture(original);
    for (const e of original.edges) expect(placed.nodes.find(n => n.id === e.source)!.x).toBeLessThan(placed.nodes.find(n => n.id === e.target)!.x);
    expect(placed.edges.map(e => [e.id, e.source, e.target])).toEqual(original.edges.map(e => [e.id, e.source, e.target]));
    expect(await layoutArchitecture(original)).toEqual(placed);
  });
  it('condenses a 400 node / 2000 edge SCC without dummy-rank explosion', async () => {
    const before = performance.now(); const placed = await layoutArchitecture(fixture(400, true));
    expect(placed.nodes).toHaveLength(400); expect(placed.edges).toHaveLength(2000);
    expect(placed.nodes.every(n => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(new Set(placed.nodes.map(n => `${n.x},${n.y}`)).size).toBe(400);
    expect(placed.width).toBeLessThan(10000); expect(placed.height).toBeLessThan(5000);
    console.info(`G6 400/2000 layout: ${Math.round(performance.now() - before)}ms`);
  });
});
