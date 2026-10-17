import { AntVDagreLayout } from '@antv/layout';
import type { MapLayout } from './map-model';
import { graphCycles } from './graph-analysis';

/** AntV layout runs inside our cancellable worker; semantic metadata stays intact. */
export async function layoutArchitecture(layout: MapLayout): Promise<MapLayout> {
  if (!layout.nodes.length) return layout;
  const directories = new Map<string,typeof layout.nodes>();
  for(const node of layout.nodes){const slash=node.id.lastIndexOf('/');const id=slash<0?node.id:node.id.slice(0,slash);const members=directories.get(id)??[];members.push(node);directories.set(id,members);}
  if(directories.size>1&&[...directories.values()].some(members=>members.length>1)) {
    const owner=new Map([...directories].flatMap(([id,members])=>members.map(n=>[n.id,id] as const)));
    const inner=new Map<string,MapLayout>();
    for(const [id,members] of directories){const ids=new Set(members.map(n=>n.id));inner.set(id,await layoutCondensed({...layout,nodes:members,edges:layout.edges.filter(e=>ids.has(e.source)&&ids.has(e.target))}));}
    const shells=[...directories].map(([id,members])=>({...members[0]!,id,width:inner.get(id)!.width+32,height:inner.get(id)!.height+48}));
    const outer=await layoutCondensed({...layout,nodes:shells,edges:layout.edges.map(e=>({...e,source:owner.get(e.source)!,target:owner.get(e.target)!})).filter(e=>e.source!==e.target)});
    const placed=outer.nodes.flatMap(shell=>inner.get(shell.id)!.nodes.map(n=>({...n,x:n.x+shell.x+16,y:n.y+shell.y+32})));
    return {...layout,nodes:placed,layers:[],edges:layout.edges.map(e=>({...e,controlPoints:undefined})),width:Math.max(...placed.map(n=>n.x+n.width))+48,height:Math.max(...placed.map(n=>n.y+n.height))+48};
  }
  return layoutCondensed(layout);
}

async function layoutCondensed(layout:MapLayout):Promise<MapLayout> {
  // AntV Dagre expands each node by twice these separations before ranking.
  const algorithm = new AntVDagreLayout({ rankdir: 'LR', nodesep: 14, ranksep: 48, controlPoints: true,
    nodeSize: (node: Record<string, any>) => [node.width, node.height],
  });
  const nodes = layout.nodes.slice().sort((a, b) => a.id < b.id ? -1 : 1);
  // Condense cycles before Dagre: a dense SCC otherwise creates thousands of dummy ranks.
  const cycles = graphCycles(nodes.map(n => n.id), layout.edges.filter(e => !e.thin));
  const owner = new Map(cycles.flatMap((members, i) => members.map(id => [id, `scc:${i}`] as const)));
  const groups = new Map<string, typeof nodes>();
  for (const node of nodes) { const id = owner.get(node.id) ?? node.id; const list = groups.get(id) ?? []; list.push(node); groups.set(id, list); }
  const cells = new Map([...groups].map(([id, members]) => [id, { width: Math.max(...members.map(n => n.width)) + 70,
    height: Math.max(...members.map(n => n.height)) + 70, columns: Math.ceil(Math.sqrt(members.length)) }]));
  const condensedEdges = new Map<string, { id: string; source: string; target: string }>();
  for (const edge of layout.edges.filter(e => !e.thin)) {
    const source = owner.get(edge.source) ?? edge.source, target = owner.get(edge.target) ?? edge.target;
    if (source !== target) { const id = JSON.stringify([source, target]); condensedEdges.set(id, { id, source, target }); }
  }
  try {
    await algorithm.execute({ nodes: [...groups].map(([id, members]) => { const cell = cells.get(id)!; return { id,
      width: members.length === 1 ? members[0]!.width : cell.columns * cell.width,
      height: members.length === 1 ? members[0]!.height : Math.ceil(members.length / cell.columns) * cell.height }; }),
      edges: [...condensedEdges.values()] });
    const positions = new Map<string, { x: number; y: number }>();
    algorithm.forEachNode(n => positions.set(String(n.id), { x: n.x, y: n.y }));
    const points = new Map<string, [number, number][]>();
    algorithm.forEachEdge(e => { if (e.points) points.set(String(e.id), e.points.map(p => Array.isArray(p) ? [p[0]!, p[1]!] : [(p as any).x, (p as any).y])); });
    const placed = [...groups].flatMap(([id, members]) => {
      const p = positions.get(id)!, cell = cells.get(id)!;
      return members.map((n, i) => members.length === 1 ? { ...n, x: p.x - n.width / 2 + 48, y: p.y - n.height / 2 + 48 } :
        { ...n, x: p.x - cell.columns * cell.width / 2 + i % cell.columns * cell.width + 48,
          y: p.y - Math.ceil(members.length / cell.columns) * cell.height / 2 + Math.floor(i / cell.columns) * cell.height + 48 });
    });
    return { ...layout, nodes: placed, layers: [],
      edges: layout.edges.map(e => ({ ...e, controlPoints: points.get(JSON.stringify([owner.get(e.source) ?? e.source, owner.get(e.target) ?? e.target]))?.slice(1, -1).map(([x, y]) => [x + 48, y + 48] as [number, number]) })),
      width: Math.max(...placed.map(n => n.x + n.width)) + 48, height: Math.max(...placed.map(n => n.y + n.height)) + 48 };
  } finally { algorithm.destroy(); }
}
