import type { Component } from 'svelte';

export interface Point { x: number; y: number }
export interface Viewport extends Point { zoom: number }
/** View adapters retain domain objects and callbacks; G6 never escapes the canvas boundary. */
export interface Node {
  id: string; type?: string; position: Point;
  data: Record<string, any>;
  draggable?: boolean; selectable?: boolean; connectable?: boolean; dragHandle?: string;
  measured?: { width: number; height: number }; handles?: unknown[];
}
export interface Edge {
  id: string; source: string; target: string; data: Record<string, any>;
  type?: string; sourceHandle?: string; targetHandle?: string;
  selectable?: boolean; deletable?: boolean; zIndex?: number;
}
export interface GraphRelation {
  id: string; source: string; target: string; count?: number;
}
export interface SceneNode extends Point {
  id: string; label: string; sub: string; width: number; height: number;
  kind: string; selected?: boolean; dimmed?: boolean; dashed?: boolean;
  entry?: boolean; decorative?: boolean; draggable?: boolean;
  cyclic?: boolean;
  relatedIds?: string[];
  component?: Component<any>; props?: Record<string, any>;
  group?: string; onSelect?: (id: string) => void;
}
export interface SceneEdge extends GraphRelation {
  label: string; alwaysLabel?: boolean; dashed?: boolean; arrow?: boolean;
  dashPattern?: number[];
  width: number; hot?: boolean; dimmed?: boolean; flowing?: boolean;
  path?: string; points?: [number, number][]; reverseCount?: number;
  straight?: boolean;
  labelPoint?: Point;
  originalIds: string[];
  onHover?: (event: MouseEvent | null) => void;
}
export interface SceneGroup { id: string; label: string; members: string[]; bounds?: Point & {width:number;height:number} }
export interface GraphScene {
  kind: 'map' | 'flow' | 'screens' | 'steps';
  nodes: SceneNode[]; edges: SceneEdge[];
  /** Real directed relationships, before cosmetic merging/folding. */
  relations: GraphRelation[]; groups: SceneGroup[];
}
export interface GraphSnapshot { nodes: SceneNode[]; edges: SceneEdge[]; groups: SceneGroup[]; bounds?: Point & {width:number;height:number} }
export interface GraphController {
  fit(): Promise<void>; focus(ids: string[]): Promise<void>;
  zoom(value: number): Promise<void>; viewport(): Viewport;
  select(id: string | null): void; collapse(id: string, collapsed: boolean): Promise<void>;
  snapshot(): GraphSnapshot; exportSvg(scale: number): string;
}
