/**
 * Payload embedded in `.codegraph/visual.html` for the D3 force layout.
 */

export interface VisualNode {
  id: string;
  name: string;
  kind: string;
  /** Full file path — shown on hover. */
  path: string;
}

export interface VisualLink {
  source: string;
  target: string;
  kind: string;
}

export interface VisualGraph {
  nodes: VisualNode[];
  links: VisualLink[];
}

/** File-level graph embedded in the visual HTML. */
export type VisualPayload = VisualGraph;

/** Max distinct cross-file links kept in the visual export. */
export const FILE_LINK_CAP = 10000;
