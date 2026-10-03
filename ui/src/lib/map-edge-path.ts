export type MapEdgeStyle = 'curve' | 'straight';

/** 两种线型共用原始端口，坐标精度与 SVG 导出保持一致。 */
export function mapEdgePath(
  points: { source: { x: number; y: number }; target: { x: number; y: number } },
  style: MapEdgeStyle = 'curve'
): string {
  const round = (value: number) => Math.round(value * 10) / 10;
  const sx = round(points.source.x), sy = round(points.source.y);
  const tx = round(points.target.x), ty = round(points.target.y);
  const midY = round((points.source.y + points.target.y) / 2);
  if (style === 'straight') return `M${sx},${sy} L${tx},${ty}`;
  return `M${sx},${sy} C${sx},${midY} ${tx},${midY} ${tx},${ty}`;
}
