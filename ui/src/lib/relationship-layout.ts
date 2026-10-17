import { CircularLayout, ConcentricLayout, D3ForceLayout } from '@antv/layout';
import type { GraphRelation, Point, SceneGroup } from './graph-scene';

export type RelationshipLayout = 'default' | 'force' | 'concentric' | 'circular';
export type LayoutBox = { id: string; width: number; height: number };
export interface RelationshipLayoutInput {
  nodes: LayoutBox[];
  relations: GraphRelation[];
  groups: Pick<SceneGroup, 'id' | 'members'>[];
}
export type LayoutPositions = Record<string, Point>;
const compare = (a: { id: string }, b: { id: string }) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

/** Geometry only: callbacks and Svelte components never cross the Worker boundary. */
export async function layoutRelationships(input: RelationshipLayoutInput, mode: Exclude<RelationshipLayout, 'default'>): Promise<LayoutPositions> {
  const nodes = [...input.nodes].sort(compare);
  const owner = new Map<string, string>();
  const clusters = new Map<string, LayoutBox[]>();
  for (const group of [...input.groups].sort(compare)) {
    const members = nodes.filter(n => group.members.includes(n.id) && !owner.has(n.id));
    if (members.length < 2) continue;
    // Internal IDs cannot collide with a business node or group ID.
    const id = `group:${JSON.stringify(group.id)}`;
    clusters.set(id, members); members.forEach(n => owner.set(n.id, id));
  }
  if (!clusters.size) return place(nodes, input.relations, mode);
  for (const node of nodes) if (!owner.has(node.id)) {
    const id = `node:${JSON.stringify(node.id)}`;
    owner.set(node.id, id); clusters.set(id, [node]);
  }
  if (clusters.size <= 1) return place(nodes, input.relations, mode);
  const interiors = new Map<string, LayoutPositions>();
  const shells: LayoutBox[] = [];
  for (const [id, members] of clusters) {
    if (members.length === 1) {
      interiors.set(id, { [members[0]!.id]: { x: 0, y: 0 } });
      shells.push({ ...members[0]!, id }); continue;
    }
    const positions = await place(members, input.relations, mode);
    interiors.set(id, positions);
    shells.push({ id, width: Math.max(...members.map(n => positions[n.id]!.x + n.width)) + 40,
      height: Math.max(...members.map(n => positions[n.id]!.y + n.height)) + 52 });
  }
  const links = input.relations.flatMap(e => {
    const source = owner.get(e.source), target = owner.get(e.target);
    return source && target && source !== target ? [{ ...e, source, target }] : [];
  });
  const outer = await place(shells, links, mode), result: LayoutPositions = {};
  for (const [id, members] of clusters) for (const n of members) {
    const p = interiors.get(id)![n.id]!;
    result[n.id] = { x: outer[id]!.x + p.x + (members.length > 1 ? 20 : 0), y: outer[id]!.y + p.y + (members.length > 1 ? 32 : 0) };
  }
  return result;
}

async function place(boxes: LayoutBox[], relations: GraphRelation[], mode: Exclude<RelationshipLayout, 'default'>): Promise<LayoutPositions> {
  if (!boxes.length) return {};
  if (boxes.length === 1) return { [boxes[0]!.id]: { x: 48, y: 48 } };
  const nodes = [...boxes].sort(compare), ids = new Set(nodes.map(n => n.id));
  // Parallel relations retain their evidence in the scene, but do not multiply physical springs.
  const links = new Map<string, { id: string; source: string; target: string }>();
  for (const e of relations) if (ids.has(e.source) && ids.has(e.target) && e.source !== e.target) {
    const [source, target] = [e.source, e.target].sort();
    const id = JSON.stringify([source, target]); links.set(id, { id, source: source!, target: target! });
  }
  const diameter = Math.max(...nodes.map(n => Math.hypot(n.width, n.height)));
  const edges = [...links.values()].sort(compare);
  const algorithm = mode === 'circular'
    ? new CircularLayout({ center: [0, 0], radius: (diameter + 64) / (2 * Math.sin(Math.PI / nodes.length)), ordering: null, startAngle: -Math.PI / 2, endAngle: Math.PI * 1.5 })
    : mode === 'concentric'
      ? new ConcentricLayout({ center: [0, 0], nodeSize: diameter, nodeSpacing: 64, preventOverlap: true, sortBy: 'degree', maxLevelDiff: 1 })
      : new D3ForceLayout({ center: { x: 0, y: 0 }, nodeSize: diameter, nodeSpacing: 64,
        preventOverlap: true, collideIterations: 4, linkDistance: diameter + 120, nodeStrength: -1200, alphaDecay: .03 });
  try {
    const running = algorithm.execute({ nodes, edges });
    if (algorithm instanceof D3ForceLayout) {
      // Fixed ticks in our cancellable Worker; let the normal end event settle execute().
      algorithm.stop().tick(240).setAlpha(0);
      algorithm.simulation.restart();
    }
    await running;
    const centers: LayoutPositions = {};
    algorithm.forEachNode(n => { centers[String(n.id)] = { x: n.x, y: n.y }; });
    // Force convergence is approximate. Uniform expansion guarantees readable boxes and
    // routing corridors without changing the relative shape or concentric ring membership.
    let scale = 1;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]!, b = nodes[j]!, p = centers[a.id]!, q = centers[b.id]!;
      const dx = Math.abs(p.x - q.x), dy = Math.abs(p.y - q.y);
      if (!Number.isFinite(dx + dy) || dx + dy < 1e-8) throw new Error('布局未收敛，请恢复布局。 Layout did not converge.');
      scale = Math.max(scale, Math.min((a.width + b.width + 96) / (2 * dx), (a.height + b.height + 96) / (2 * dy)));
    }
    const left = Math.min(...nodes.map(n => centers[n.id]!.x * scale - n.width / 2));
    const top = Math.min(...nodes.map(n => centers[n.id]!.y * scale - n.height / 2));
    return Object.fromEntries(nodes.map(n => [n.id, { x: centers[n.id]!.x * scale - n.width / 2 - left + 48,
      y: centers[n.id]!.y * scale - n.height / 2 - top + 48 }]));
  } finally {
    if (algorithm instanceof D3ForceLayout) algorithm.stop();
    algorithm.destroy();
  }
}
