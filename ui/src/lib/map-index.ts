import { isEdgeVisible, portPoint, type MapEdgeLayout, type MapLayout } from './map-model';

/** 只在布局变化时建立，选择与悬停复用同一份图索引。 */
export function buildMapIndex(layout: Pick<MapLayout, 'nodes' | 'edges'>) {
  const nodeById = new Map(layout.nodes.map(node => [node.id, node]));
  const edgePoints = new Map<string, { source: { x: number; y: number }; target: { x: number; y: number } }>();
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const incident = new Map<string, MapEdgeLayout[]>();
  for (const edge of layout.edges) {
    edgePoints.set(edge.id, { source: portPoint(nodeById.get(edge.source)!, edge.id, 'source'), target: portPoint(nodeById.get(edge.target)!, edge.id, 'target') });
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target); outgoing.set(edge.source, targets);
    const sources = incoming.get(edge.target) ?? [];
    sources.push(edge.source); incoming.set(edge.target, sources);
    const from = incident.get(edge.source) ?? [];
    from.push(edge); incident.set(edge.source, from);
    if (edge.target !== edge.source) {
      const to = incident.get(edge.target) ?? [];
      to.push(edge); incident.set(edge.target, to);
    }
  }
  return { nodeById, edgePoints, incoming, outgoing, incident, atRest: layout.edges.filter(edge => isEdgeVisible(edge, null)) };
}
export function indexedOneHop(index: ReturnType<typeof buildMapIndex> | null, selected: string | null, direction: 'in' | 'out' | 'both'): Set<string> | null {
  if (!index || selected === null) return null;
  return new Set([selected, ...(direction === 'out' ? [] : index.incoming.get(selected) ?? []), ...(direction === 'in' ? [] : index.outgoing.get(selected) ?? [])]);
}

/** 同一布局项与展示标记未变时保留对象引用，使画布跳过无关节点和边。 */
export function cachedPresentation<T, V>(build: (source: T, flags: string) => V) {
  const cache = new Map<T, { flags: string; value: V }>();
  return (source: T, flags: string): V => {
    const previous = cache.get(source);
    if (previous?.flags === flags) return previous.value;
    const value = build(source, flags);
    cache.set(source, { flags, value });
    return value;
  };
}

/** 固定尺寸模块的已知几何；坐标匹配 1px Handle 的居中位移。 */
export function mapNodeMeasurements(node: { width: number; height: number }) {
  return {
    measured: { width: node.width, height: node.height },
    handles: [
      { id: 'in', type: 'target', position: 'top', x: node.width / 2 - .5, y: -.5, width: 1, height: 1 },
      { id: 'out', type: 'source', position: 'bottom', x: node.width / 2 - .5, y: node.height - .5, width: 1, height: 1 },
    ],
  };
}

export type MapPositions = ReadonlyMap<string, { x: number; y: number }>;
/** 拖动只平移布局端口，保留每条关系原有的扇出和源/目标方向。 */
export function positionedMapPoints(index: ReturnType<typeof buildMapIndex>, edge: MapEdgeLayout, positions: MapPositions) {
  const points = index.edgePoints.get(edge.id)!;
  const move = (id: string, point: { x: number; y: number }) => {
    const original = index.nodeById.get(id)!; const position = positions.get(id);
    return position ? { x: point.x + position.x - original.x, y: point.y + position.y - original.y } : point;
  };
  return { source: move(edge.source, points.source), target: move(edge.target, points.target) };
}

/** 导出使用当前节点位置；手动排列后不再显示自动分层线。 */
export function positionedMapLayout(layout: MapLayout, positions: MapPositions): MapLayout {
  let moved = false;
  const nodes = layout.nodes.map(node => {
    const position = positions.get(node.id);
    if (!position || (position.x === node.x && position.y === node.y)) return node;
    moved = true;
    return { ...node, ...position };
  });
  return moved ? { ...layout, nodes, layers: [] } : layout;
}
