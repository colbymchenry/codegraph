export interface GraphHistory {
  recentNodes?: { id: string; label: string }[];
  relationshipLayout?: import('./relationship-layout').RelationshipLayout;
  layoutPositions?: Partial<Record<import('./relationship-layout').RelationshipLayout, Record<string, {x: number; y: number}>>>;
  collapsedGroups?: string[];
  grouping?: 'directory' | 'cycles';
  analysisDirection?: 'in' | 'out' | 'both';
  analysisFocus?: boolean;
  selected?: string | null;
  viewport?: { x: number; y: number; zoom: number };
  scroll?: number;
  picked?: string | null;
  showAll?: boolean;
  minWeight?: number;
  focusOnly?: boolean;
  focusDirection?: 'in' | 'out' | 'both';
  scope?: string;
  /** 只保留当前有界画布的手动位置，不保存图谱数据。 */
  positions?: Record<string, { x: number; y: number }>;
  flowPlaying?: boolean;
  edgeStyle?: import('./map-edge-path').MapEdgeStyle;
}
const states = new Map<string, GraphHistory>();
export function readGraphHistory(key: string): GraphHistory {
  return states.get(key) ?? {};
}
export function saveGraphHistory(key: string, patch: GraphHistory): void {
  states.set(key, { ...states.get(key), ...patch });
  // 历史仅保留轻量状态，避免长期会话无限增长。
  if (states.size > 100) states.delete(states.keys().next().value!);
}
