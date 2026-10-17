import type { Component } from 'svelte';
import type { Edge, GraphRelation, GraphScene, Node, SceneEdge, SceneGroup, SceneNode } from './graph-scene';
import { pathOf } from './screens-model';
import { graphText } from './graph-copy';

/** Convert existing semantic view models, without importing a rendering engine. */
export function graphScene(kind: GraphScene['kind'], nodes: Node[], edges: Edge[], components: Record<string, Component<any>> = {}, relations?: GraphRelation[], groups: SceneGroup[] = []): GraphScene {
  const sceneNodes: SceneNode[] = nodes.filter(node=>node.type!=='region'||!groups.length).map(node => {
    const d = node.data, layout = d.layout ?? d.card ?? d.cap;
    const info = d.info;
    const label = d.card?.hop.node.name ?? info?.label ?? d.fork?.label ?? d.label ?? (node.type==='cap' ? graphText('静态路径终止位置','Where the graph stops') : layout?.module?.label) ?? node.id;
    const sub = node.type==='fork' ? '' : info?.sub ?? (layout?.module ? `${layout.module.symbols} ${graphText('个符号', 'symbols')} · ${layout.module.files} ${graphText('文件', 'files')}` : '');
    return {
      id: node.id, ...node.position, width: layout?.width ?? d.width ?? 180, height: layout?.height ?? 24,
      label: String(label), sub, kind: node.type ?? 'node', selected: d.selected ?? d.current,
      dimmed: d.dimmed, dashed: !!(info?.origin || info?.unreached || info?.step?.cut),
      entry: info?.entry ?? info?.step?.anchor, decorative: ['region', 'decision', 'fork', 'cap'].includes(node.type ?? ''),
      relatedIds:d.relatedIds ?? (d.cap?.anchorId ? [d.cap.anchorId] : d.owner ? [d.owner] : undefined),
      draggable: node.draggable, component: components[node.type ?? ''], props: { data: d },
      onSelect: d.onSelect,
    };
  });
  const byId = new Map(sceneNodes.map(n => [n.id, n]));
  const sceneEdges: SceneEdge[] = edges.map(edge => {
    const d = edge.data, link = d.link;
    const source = byId.get(edge.source), target = byId.get(edge.target);
    let path = kind === 'steps' && d.curve ? pathOf(d.curve) : undefined;
    if (kind === 'map' && d.edgeStyle === 'straight' && source && target) path = `M${source.x + source.width},${source.y + source.height / 2} L${target.x},${target.y + target.height / 2}`;
    if (kind === 'flow' && source && target) {
      const sx = source.x + source.width, sy = source.y + source.height / 2;
      const tx = target.x, ty = target.y + target.height / 2, mx = (sx + tx) / 2;
      path = Math.abs(sy - ty) < .5 ? `M${sx},${sy} L${tx},${ty}` : `M${sx},${sy} C${mx},${sy} ${mx},${ty} ${tx},${ty}`;
    }
    return {
      id: edge.id, source: edge.source, target: edge.target,
      originalIds: relations ? relations.filter(r=>r.source===edge.source&&r.target===edge.target).map(r=>r.id) : [edge.id],
      count: d.edge?.link?.count ?? 1, width: Math.min(2, d.edge?.width ?? 1.5),
      label: link ? [...link.labelLines, link.lineLabel].filter(Boolean).join('\n') : d.full ?? d.pill?.text ?? d.info?.label ?? '',
      alwaysLabel: kind === 'flow' || (kind === 'steps' && !!d.pill),
      dashed: !!(link?.dash || d.info?.synthesized), arrow: !link?.cap,
      dashPattern:link?.dash ? String(link.dash).split(/[ ,]+/).map(Number) : undefined,
      hot: !!(d.focus || d.hot), dimmed: d.dimmed, flowing: d.flowing,
      path, points: d.edge?.controlPoints, straight: kind === 'map' && d.edgeStyle === 'straight',
      onHover: d.onHover ? event => d.onHover(event ? d.edge : null, event) : undefined,
    };
  });
  const real = relations ?? edges.flatMap(edge => {
    const link = edge.data.link;
    if (link?.cap) return [];
    return [{ id: edge.id, source: link?.edge?.upward ? edge.target : edge.source,
      target: link?.edge?.upward ? edge.source : edge.target, count: edge.data.edge?.link?.count ?? 1 }];
  });
  return { kind, nodes: sceneNodes, edges: sceneEdges, relations: real, groups };
}
