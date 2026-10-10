export interface CompactMapInput {
  nodes: { id: string; width: number; height: number }[];
  edges: { source: string; target: string }[];
  selected: string;
}

/** 聚焦节点按上游、双向、下游分组排近；使用实际尺寸，避免沿用全图中的巨大空白。 */
export function compactMapPositions({ nodes, edges, selected }: CompactMapInput): Record<string, { x: number; y: number }> {
  const anchor = nodes.find(node => node.id === selected);
  if (!anchor) throw new Error('选中节点已不在当前范围，请重新选择。');
  const incoming = new Set(edges.filter(edge => edge.target === selected).map(edge => edge.source));
  const outgoing = new Set(edges.filter(edge => edge.source === selected).map(edge => edge.target));
  const others = nodes.filter(node => node.id !== selected).sort((a, b) => a.id.localeCompare(b.id));
  const before = others.filter(node => incoming.has(node.id) && !outgoing.has(node.id));
  const mutual = others.filter(node => incoming.has(node.id) && outgoing.has(node.id));
  const after = others.filter(node => !incoming.has(node.id));
  const cellWidth = Math.max(...nodes.map(node => node.width)) + 64;
  const cellHeight = Math.max(...nodes.map(node => node.height)) + 64;
  const positions: Record<string, { x: number; y: number }> = Object.create(null);
  const rows = Math.max(1, Math.ceil(Math.sqrt(Math.max(before.length,after.length))));
  const beforeColumns = Math.max(1,Math.ceil(before.length/rows));
  const anchorX=40+beforeColumns*cellWidth;
  positions[anchor.id]={x:anchorX,y:60+(rows-1)*cellHeight/2};
  for (const [group,startX] of [[before,40],[after,anchorX+cellWidth]] as const) {
    for (let i = 0; i < group.length; i++) {
      const node=group[i]!;
      positions[node.id]={x:startX+Math.floor(i/rows)*cellWidth,y:60+i%rows*cellHeight};
    }
  }
  // Mutual neighbours occupy a separate block below the current module.
  const columns=Math.max(1,Math.ceil(Math.sqrt(mutual.length)));
  mutual.forEach((node,i)=>positions[node.id]={x:anchorX+(i%columns)*cellWidth,y:60+rows*cellHeight+48+Math.floor(i/columns)*cellHeight});
  return positions;
}
