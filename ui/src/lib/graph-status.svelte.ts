/** 仅记录当前画布的轻量状态，不保存图数据。 */
export interface GraphStatus {
  nodes: number;
  edges: number;
  scope?: string;
  filter?: string;
  excluded?: string;
  budget?: string;
}
let current = $state<GraphStatus | null>(null);
let owner = 0;
export const graphStatus = {
  get current() { return current; },
  /** 返回仅能清理本次状态的函数，避免旧画布销毁时清空新画布。 */
  set(value: GraphStatus): () => void {
    const mine = ++owner;
    current = value;
    return () => { if (mine === owner) current = null; };
  },
  resetProject() { owner++; current = null; },
};
