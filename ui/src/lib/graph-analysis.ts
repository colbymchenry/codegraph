import type { GraphRelation, GraphScene, SceneEdge, SceneGroup } from './graph-scene';

const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Stable BFS over loaded, filtered real edges. Folding does not change this graph. */
export function shortestDirectedPath(nodes: readonly string[], edges: readonly GraphRelation[], from: string, to: string): { nodes: string[]; edges: string[] } | null {
  const present = new Set(nodes);
  if (!present.has(from) || !present.has(to)) return null;
  const outgoing = new Map<string, GraphRelation[]>();
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    const list = outgoing.get(edge.source) ?? []; list.push(edge); outgoing.set(edge.source, list);
  }
  for (const list of outgoing.values()) list.sort((a, b) => compare(a.target, b.target) || compare(a.id, b.id));
  const previous = new Map<string, GraphRelation | null>([[from, null]]), queue = [from];
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]!;
    if (id === to) {
      const path = [id], pathEdges: string[] = [];
      let edge = previous.get(id);
      while (edge) { pathEdges.push(edge.id); path.push(edge.source); edge = previous.get(edge.source); }
      return { nodes: path.reverse(), edges: pathEdges.reverse() };
    }
    for (const edge of outgoing.get(id) ?? []) if (!previous.has(edge.target)) {
      previous.set(edge.target, edge); queue.push(edge.target);
    }
  }
  return null;
}

/** Tarjan SCC, including actual self-loops, never inferred from screen coordinates. */
export function graphCycles(ids: readonly string[], edges: readonly GraphRelation[]): string[][] {
  const adjacency = new Map(ids.map(id => [id, [] as string[]]));
  for (const e of edges) if (adjacency.has(e.source) && adjacency.has(e.target)) adjacency.get(e.source)!.push(e.target);
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], active = new Set<string>();
  const result: string[][] = []; let sequence = 0;
  function visit(id: string) {
    index.set(id, sequence); low.set(id, sequence++); stack.push(id); active.add(id);
    for (const target of adjacency.get(id)!.sort(compare)) {
      if (!index.has(target)) { visit(target); low.set(id, Math.min(low.get(id)!, low.get(target)!)); }
      else if (active.has(target)) low.set(id, Math.min(low.get(id)!, index.get(target)!));
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = []; let next: string;
      do { next = stack.pop()!; active.delete(next); group.push(next); } while (next !== id);
      if (group.length > 1 || adjacency.get(id)!.includes(id)) result.push(group.sort(compare));
    }
  }
  for (const id of [...ids].sort(compare)) if (!index.has(id)) visit(id);
  return result.sort((a, b) => compare(a[0]!, b[0]!));
}

export function mergeDisplayEdges(edges: readonly SceneEdge[], bidirectional: boolean): SceneEdge[] {
  const groups = new Map<string, SceneEdge>();
  for (const original of edges) {
    const reversed = bidirectional && compare(original.source, original.target) > 0;
    const source = reversed ? original.target : original.source, target = reversed ? original.source : original.target;
    const key = JSON.stringify([source, target]);
    const current = groups.get(key);
    if (!current) groups.set(key, { ...original, id: `display:${key}`, source, target,
      count: reversed ? 0 : original.count ?? 1, reverseCount: reversed ? original.count ?? 1 : 0,
      points: reversed ? original.points?.slice().reverse() : original.points,
      originalIds: [...original.originalIds] });
    else {
      if (reversed) current.reverseCount = (current.reverseCount ?? 0) + (original.count ?? 1);
      else current.count = (current.count ?? 0) + (original.count ?? 1);
      current.originalIds.push(...original.originalIds);
      current.hot ||= original.hot; current.flowing ||= original.flowing;
      current.dashed &&= original.dashed;
    }
  }
  return [...groups.values()].map(edge => {
    // Keep a single directed edge pointing in its original direction.
    if (!edge.count && edge.reverseCount) return { ...edge, source: edge.target, target: edge.source,
      count: edge.reverseCount, reverseCount: 0, points: edge.points?.slice().reverse(), label: String(edge.reverseCount) };
    // A straight display path belongs to the original orientation. Let the renderer
    // connect the canonical endpoints when both directions were merged.
    return { ...edge, path: edge.reverseCount ? undefined : edge.path, label: edge.reverseCount ? `→ ${edge.count} · ← ${edge.reverseCount}` : String(edge.count) };
  });
}

export function directoryGroups(scene: GraphScene): SceneGroup[] {
  const groups = new Map<string, string[]>();
  for (const node of scene.nodes) {
    if (node.decorative) continue;
    const slash = node.id.lastIndexOf('/');
    if (slash < 0) continue;
    const parent = node.id.slice(0, slash);
    const list = groups.get(parent) ?? []; list.push(node.id); groups.set(parent, list);
  }
  return [...groups].filter(([, members]) => members.length > 1).map(([label, members]) => ({ id: `directory:${label}`, label, members }));
}

/** Visibility projection is separate from the analysis graph and preserves every original edge ID. */
export function projectScene(scene: GraphScene, groups: SceneGroup[], collapsed: ReadonlySet<string>, focus: ReadonlySet<string> | null): GraphScene {
  const allowed = new Set(scene.nodes.filter(n => !focus || focus.has(n.id)).map(n => n.id));
  if(focus) {
    const decorative=new Set(scene.nodes.filter(n=>n.decorative).map(n=>n.id));
    let changed=true;
    while(changed){changed=false;for(const edge of scene.edges)for(const [id,other] of [[edge.source,edge.target],[edge.target,edge.source]])if(decorative.has(id!)&&!allowed.has(id!)&&allowed.has(other!)){allowed.add(id!);changed=true;}}
    for(const n of scene.nodes)if(n.decorative&&n.relatedIds?.some(id=>allowed.has(id)))allowed.add(n.id);
  }
  // Code regions can nest. Assign a node to its smallest explicit region;
  // a Combo must never claim a member owned by a different Combo.
  const claimed=new Set<string>();
  const activeGroups = [...groups].sort((a,b)=>a.members.length-b.members.length||compare(a.id,b.id)).map(g=>{
    const candidates=[...g.members,...scene.nodes.filter(n=>n.decorative&&n.relatedIds?.length&&n.relatedIds.every(id=>g.members.includes(id))).map(n=>n.id)];
    const members=[...new Set(candidates)].filter(id=>allowed.has(id)&&!claimed.has(id));members.forEach(id=>claimed.add(id));return {...g,members};
  }).filter(g=>g.members.length>0);
  const owner = new Map(activeGroups.flatMap(g => g.members.map(id => [id, g.id] as const)));
  const folded = new Map(activeGroups.filter(g => collapsed.has(g.id)).flatMap(g => g.members.map(id => [id, g.id] as const)));
  const nodes = scene.nodes.filter(n => allowed.has(n.id)).map(n => ({ ...n, group: owner.get(n.id) }));
  const edges: SceneEdge[] = [];
  for (const edge of scene.edges) {
    if (!allowed.has(edge.source) || !allowed.has(edge.target)) continue;
    const source = folded.get(edge.source) ?? edge.source, target = folded.get(edge.target) ?? edge.target;
    if (source === target && (source !== edge.source || target !== edge.target)) continue;
    edges.push({ ...edge, source, target, ...(source !== edge.source || target !== edge.target ? { path: undefined, points: undefined } : {}) });
  }
  const foldedIds = new Set(folded.values());
  const touchesFold = (e:SceneEdge)=>foldedIds.has(e.source)||foldedIds.has(e.target);
  const projected = scene.kind === 'map' ? mergeDisplayEdges(edges, true)
    : [...edges.filter(e=>!touchesFold(e)), ...mergeDisplayEdges(edges.filter(touchesFold),false)];
  return { ...scene, nodes, edges: projected, groups: activeGroups };
}
