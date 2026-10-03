import { Graph, BaseEdge, Cubic, ExtensionCategory, register, type GraphData, type NodeData, type EdgeData } from '@antv/g6';
import { mount, unmount } from 'svelte';
import type { GraphController, GraphScene, GraphSnapshot, SceneNode, Viewport } from './graph-scene';
import { snapshotSvg } from './graph-snapshot';

/** Extensions capture the actual routed path for export, rather than redrawing old model curves. */
class RoutedEdge extends Cubic {
  private routeKey = '';
  private routePath: any;
  protected getKeyPath(attributes: any): any {
    const endpoints = this.getEndpoints(attributes);
    const key = JSON.stringify([attributes.routeEpoch, attributes.straight, endpoints]);
    if (key !== this.routeKey) {
      this.routePath = attributes.straight ? [['M', ...endpoints[0]], ['L', ...endpoints[1]]] : super.getKeyPath(attributes);
      this.routeKey = key;
    }
    attributes.capturePath?.(this.routePath); return this.routePath;
  }
  protected getLoopPath(attributes:any):any {const path=super.getLoopPath(attributes);attributes.capturePath?.(path);return path;}
  protected getLabelStyle(attributes:any):any {const style=super.getLabelStyle(attributes);if(style)attributes.captureLabel?.(style);return style;}
}
class SemanticEdge extends BaseEdge {
  protected getKeyPath(attributes: any): any {
    const path = attributes.scenePath ?? []; attributes.capturePath?.(path); return path;
  }
  protected getLoopPath(attributes:any):any {const path=attributes.scenePath?.length?attributes.scenePath:super.getLoopPath(attributes);attributes.capturePath?.(path);return path;}
  protected getLabelStyle(attributes:any):any {const style=super.getLabelStyle(attributes);if(style)attributes.captureLabel?.(style);return style;}
}
register(ExtensionCategory.EDGE, 'codegraph-routed', RoutedEdge);
register(ExtensionCategory.EDGE, 'codegraph-semantic', SemanticEdge);

export function parseScenePath(path: string): any[] {
  return (path.match(/[MLCQZ][^MLCQZ]*/gi) ?? []).map(part => [part[0]!, ...(part.slice(1).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number)]);
}
interface RuntimeEvents {
  select(id: string | null): void; move(id: string, x: number, y: number): void;
  viewport(view: Viewport): void; error(message: string): void;
}
interface HtmlMount { element: HTMLElement; instance: Record<string, any>; props: Record<string, any>; component: unknown }

export class G6Runtime implements GraphController {
  private graph: Graph;
  private scene: GraphScene = { kind: 'map', nodes: [], edges: [], relations: [], groups: [] };
  private displayedScene: GraphScene = this.scene;
  private mounts = new Map<string, HtmlMount>();
  private paths = new Map<string, string>();
  private labelPoints = new Map<string,{x:number;y:number}>();
  private closed = false;
  private renderCount = 0;
  private cancelRoutes?: () => void;
  private geometry = '';
  private initial = true;
  private rendered = false;
  private generation = 0;
  private tail: Promise<void> = Promise.resolve();
  private colors: Record<string, string> = {};
  private collapsed = new Set<string>();
  private hovered: string | null = null;
  private hoveredNode: string | null = null;
  private highlighted = new Set<string>();
  private states = new Map<string, string>();
  private edgeLabels = new Map<string,string>();
  private observer: ResizeObserver;
  private themeObserver: MutationObserver;
  private media = matchMedia('(prefers-color-scheme: dark)');
  private motion = matchMedia('(prefers-reduced-motion: reduce)');
  private timer: ReturnType<typeof setInterval> | undefined;
  private playing = false;
  private dashOffset = 0;
  private themeChanged = () => {
    const previous = JSON.stringify(this.colors); this.readTheme();
    if (previous !== JSON.stringify(this.colors)) {
      const options=this.graph.getOptions();
      this.graph.setNode({...options.node,state:{selected:{stroke:this.colors.accent,lineWidth:2.5,halo:true,haloLineWidth:6,haloStroke:this.colors.accent,haloOpacity:.2},active:{stroke:this.colors.accent,lineWidth:2.5},dimmed:{opacity:.25}}});
      this.graph.setEdge({...options.edge,state:{active:{stroke:this.colors.accent,lineWidth:2.5,opacity:1,label:true},dimmed:{opacity:.12}}});
      this.geometry = ''; void this.update(this.scene, this.collapsed, this.highlighted);
    }
  };

  constructor(private container: HTMLElement, private events: RuntimeEvents, private initialViewport?: Viewport, private fitInitially = true) {
    this.readTheme();
    this.graph = new Graph({ container, width: Math.max(1, container.clientWidth), height: Math.max(1, container.clientHeight),
      animation: false, padding: [90, 36, 50, 36], zoomRange: [.005, 3],
      node: { type: datum => datum.data?.html ? 'html' : 'rect',
        state: { selected: { stroke: this.colors.accent, lineWidth: 2.5,halo:true,haloLineWidth:6,haloStroke:this.colors.accent,haloOpacity:.2 }, active: { stroke: this.colors.accent, lineWidth: 2.5 }, dimmed: { opacity: .25 } } },
      edge: { type: datum => datum.data?.semantic ? 'codegraph-semantic' : 'codegraph-routed',
        state: { active: { stroke: this.colors.accent, lineWidth: 2.5, opacity: 1, label: true }, dimmed: { opacity: .12 } } },
      combo: { type: 'rect', style: { padding: [32, 20, 20, 20], radius: 6, collapsedSize: [200, 48], labelPlacement: 'top', collapsedMarker: false } },
      behaviors: ['drag-canvas', 'zoom-canvas', { type: 'drag-element', animation: false, shadow: true,
        enable: (event: any) => !!this.scene.nodes.find(n => n.id === event.target.id)?.draggable,
        onFinish: (ids: string[]) => { for (const id of ids) { const n = this.scene.nodes.find(n => n.id === id); if (n) { const [x = 0, y = 0] = this.graph.getElementPosition(id); this.events.move(id, x - n.width / 2, y - n.height / 2); } } } }],
    });
    this.graph.on('node:click', (event: any) => this.select(String(event.target.id)));
    this.graph.on('canvas:click', () => this.select(null));
    this.graph.on('node:pointerenter', (event: any) => {
      const id = String(event.target.id);
      if (this.scene.nodes.find(n => n.id === id)?.decorative) return;
      this.hoveredNode = id; this.enqueueStates();
    });
    this.graph.on('node:pointerleave', () => { this.hoveredNode = null; this.enqueueStates(); });
    this.graph.on('edge:pointermove', (event: any) => {
      const id = String(event.target.id), edge = this.scene.edges.find(e => e.id === id);
      if (this.hovered !== id) { this.hovered = id; this.enqueueStates(); }
      const native = event.nativeEvent ?? event.originalEvent;
      if (edge?.onHover && native) edge.onHover(native);
    });
    this.graph.on('edge:pointerleave', () => {
      this.scene.edges.find(e => e.id === this.hovered)?.onHover?.(null); this.hovered = null; this.enqueueStates();
    });
    this.graph.on('aftertransform', () => { if (!this.closed && this.rendered) {this.container.dataset.graphZoom=String(this.graph.getZoom());this.events.viewport(this.viewport());} });
    this.observer = new ResizeObserver(() => { if (!this.closed) this.graph.setSize(Math.max(1, container.clientWidth), Math.max(1, container.clientHeight)); });
    this.observer.observe(container);
    this.themeObserver = new MutationObserver(this.themeChanged);
    for (let element: HTMLElement | null = container; element; element = element.parentElement) this.themeObserver.observe(element, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
    this.media.addEventListener('change', this.themeChanged);
  }
  private readTheme() {
    const css = getComputedStyle(this.container);
    const value = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    this.colors = { paper: value('--paper', '#fff'), ink: value('--ink', '#172b3b'), sub: value('--ink-2', '#526475'),
      line: value('--node-border', '#71849a'), edge: value('--route-branch', '#466783'), accent: value('--route-main', '#ad6500'), group: value('--paper-2', '#f4f7fa') };
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(async () => { if (!this.closed) await work(); }).catch(error => { if (!this.closed) { console.error('G6 render failed', error); this.events.error(String(error)); } });
    return this.tail;
  }
  async update(scene: GraphScene, collapsed: ReadonlySet<string>, highlighted: ReadonlySet<string>): Promise<void> {
    this.cancelRoutes?.();
    const generation = ++this.generation;
    this.scene = scene; this.collapsed = new Set(collapsed); this.highlighted = new Set(highlighted);
    const geometry = JSON.stringify([scene.nodes.map(n => [n.id, n.x, n.y, n.width, n.height, n.label, n.sub, n.group, n.dashed,n.cyclic]),
      scene.edges.map(e => [e.id, e.source, e.target, e.path, e.points, e.reverseCount,e.straight]), scene.groups, [...collapsed]]);
    return this.enqueue(async () => {
      if (generation !== this.generation) return;
      if (geometry !== this.geometry) {
        const started = performance.now(); this.paths.clear(); this.labelPoints.clear(); this.states.clear(); this.edgeLabels.clear();
        const ids = new Set(scene.nodes.map(n => n.id));
        for (const [id, entry] of this.mounts) if (!ids.has(id)) { void unmount(entry.instance); this.mounts.delete(id); }
        const data = this.data(scene);
        this.graph.setData(data);
        await this.graph.render();
        if (this.closed) return;
        this.displayedScene=scene;
        if (generation !== this.generation) return;
        this.rendered = true;
        this.geometry = geometry;
        this.container.dataset.graphRenderMs = String(Math.round(performance.now() - started));
        this.container.dataset.graphRenderCount = String(++this.renderCount);
        this.container.dataset.graphNodes = String(scene.nodes.length);
        this.container.dataset.graphEdges = String(scene.edges.length);
        this.container.dataset.graphWidth=String(Math.max(0,...scene.nodes.map(n=>n.x+n.width))-Math.min(0,...scene.nodes.map(n=>n.x)));
        this.container.dataset.graphHeight=String(Math.max(0,...scene.nodes.map(n=>n.y+n.height))-Math.min(0,...scene.nodes.map(n=>n.y)));
        if (this.initial) {
          this.initial = false;
          if (this.initialViewport) { await this.graph.zoomTo(this.initialViewport.zoom, false); await this.graph.translateTo([this.initialViewport.x, this.initialViewport.y], false); }
          else if (this.fitInitially) await this.fit();
        }
      }
      this.updateHtml(scene);
      await this.applyStates(); this.animate(scene.edges.some(e => e.flowing));
      this.displayedScene=scene;this.events.error('');
    });
  }
  private html(node: SceneNode): HTMLElement {
    let entry = this.mounts.get(node.id);
    if (!entry || entry.component !== node.component) {
      if (entry) void unmount(entry.instance);
      const element = document.createElement('div'); element.style.pointerEvents = 'auto';
      const props = node.props!;
      const instance = mount(node.component!, { target: element, props });
      entry = { element, instance, props, component: node.component }; this.mounts.set(node.id, entry);
    }
    return entry.element;
  }
  private updateHtml(scene: GraphScene) {
    for (const node of scene.nodes) {
      const entry = this.mounts.get(node.id);
      if (entry) {
        entry.element.dataset.graphCycle=String(!!node.cyclic);
        entry.element.style.opacity = node.dimmed ? '.35' : '1';
        entry.element.style.outline = node.selected || this.highlighted.has(node.id) ? `2px solid ${this.colors.accent}` : '';
        // Re-mount only when card content/callback data changed; native selection is independent.
        if (entry.props.data !== node.props?.data) {
          void unmount(entry.instance);
          entry.props = node.props!; entry.instance = mount(node.component!, { target: entry.element, props: entry.props });
        }
      }
    }
  }
  private data(scene: GraphScene): GraphData {
    const nodes: NodeData[] = scene.nodes.map(n => ({ id: n.id, combo: n.group, data: { kind: n.kind, html: !!n.component }, style: {
      x: n.x + n.width / 2, y: n.y + n.height / 2, size: [n.width, n.height], radius: 4,
      fill: ['region', 'decision'].includes(n.kind) ? 'transparent' : this.colors.paper,
      stroke: ['region', 'decision'].includes(n.kind) ? 'transparent' : this.colors.line,
      lineWidth: 1.8, lineDash: n.dashed ? [5, 3] : [],
      labelText: `${n.entry ? '● ' : ''}${n.cyclic?'↻ ':''}${n.label}${n.sub ? `\n${n.sub}` : ''}`, labelPlacement: 'center',
      labelFontFamily: 'monospace', labelFontSize: n.kind === 'fork' ? 10 : 12, labelLineHeight: 16,
      labelFill: this.colors.ink, labelWordWrap: false,
      ...(n.component ? { innerHTML: this.html(n), dx: -n.width / 2, dy: -n.height / 2 } : {}),
    } }));
    const edges: EdgeData[] = scene.edges.map(e => ({ id: e.id, source: e.source, target: e.target, data: { semantic: !!e.path }, style: {
      stroke: this.colors.edge, lineWidth: e.width, opacity: .65,
      label: !!e.alwaysLabel, labelText: e.label, labelFill: this.colors.sub, labelFontSize: 11, labelLineHeight: 13,
      labelBackground: true, labelBackgroundFill: this.colors.paper, labelAutoRotate:false,
      lineDash: e.dashPattern ?? (e.dashed ? [5, 3] : []), endArrow: e.arrow !== false, startArrow: !!e.reverseCount,
      endArrowSize: 7, startArrowSize: 7, radius: 6,
      curvePosition: [0.3, 0.7], curveOffset: [32, 32],
      routeEpoch: this.generation, straight: e.straight,
      controlPoints: [], scenePath: e.path ? parseScenePath(e.path) : [],
      capturePath: (path: any[]) => this.paths.set(e.id, path.map(command => command.join(' ')).join(' ')),
      captureLabel: (style:any) => {const t=style.transform?.find((p:any[])=>p[0]==='translate');this.labelPoints.set(e.id,{x:t?.[1]??style.x??0,y:t?.[2]??style.y??0});},
    } }));
    return { nodes, edges, combos: scene.groups.map(g => ({ id: g.id, data: {}, style: {
      collapsed: this.collapsed.has(g.id), labelText: `${g.label} · ${g.members.length}`, labelFill: this.colors.sub,
      padding: this.collapsed.has(g.id) ? 0 : [32,20,20,20], labelPlacement: this.collapsed.has(g.id) ? 'center' : 'top',
      fill: this.colors.group, fillOpacity: .35, stroke: this.colors.line, lineDash: [3, 3],
    } })) };
  }
  private async applyStates() {
    const changes: Record<string, string[]> = {};
    const labels:Partial<EdgeData>[]=[];
    const relatedNodes = new Set<string>();
    const relatedEdges = new Set<string>();
    if (this.hoveredNode) relatedNodes.add(this.hoveredNode);
    for (const edge of this.scene.edges) {
      if (edge.id === this.hovered || (this.hoveredNode && (edge.source === this.hoveredNode || edge.target === this.hoveredNode))) {
        relatedEdges.add(edge.id); relatedNodes.add(edge.source); relatedNodes.add(edge.target);
      }
    }
    const hovering = relatedNodes.size > 0;
    for (const n of this.scene.nodes) {
      const next = n.selected ? ['selected'] : this.highlighted.has(n.id) || relatedNodes.has(n.id) ? ['active'] : n.dimmed || (hovering && !n.decorative) ? ['dimmed'] : [];
      if (this.states.get(n.id) !== next.join()) { this.states.set(n.id, next.join()); changes[n.id] = next; }
      const html = this.mounts.get(n.id)?.element;
      if (html) {
        html.style.opacity = next.includes('dimmed') ? '.25' : '1';
        html.style.outline = next.includes('selected') || next.includes('active') ? `2.5px solid ${this.colors.accent}` : '';
        html.style.boxShadow = n.id === this.hoveredNode ? `0 0 0 5px ${this.colors.accent}33` : '';
      }
    }
    for (const e of this.scene.edges) {
      const labelKey=JSON.stringify([e.label,e.alwaysLabel,e.dashed,e.dashPattern]);
      if(this.edgeLabels.get(e.id)!==labelKey){this.edgeLabels.set(e.id,labelKey);labels.push({id:e.id,style:{labelText:e.label,label:!!e.alwaysLabel,lineDash:e.dashPattern??(e.dashed?[5,3]:[])}});}
      const active = e.hot || relatedEdges.has(e.id) || e.originalIds.some(id => this.highlighted.has(id));
      const next = active ? ['active'] : e.dimmed || hovering ? ['dimmed'] : [];
      if (this.states.get(e.id) !== next.join()) { this.states.set(e.id, next.join()); changes[e.id] = next; }
    }
    if(labels.length){this.graph.updateEdgeData(labels);await this.graph.draw();}
    if (Object.keys(changes).length) await this.graph.setElementState(changes, false);
  }
  private enqueueStates() { void this.enqueue(() => this.applyStates()); }
  settled() { return this.tail; }
  private animate(playing: boolean) {
    playing &&= !this.motion.matches;
    if (this.playing === playing) return;
    this.playing = playing;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (playing) this.timer = setInterval(() => {
      if (this.closed || this.motion.matches) { this.animate(false); return; }
      this.dashOffset -= 2;
      this.graph.updateEdgeData(this.displayedScene.edges.filter(e => e.flowing).slice(0, 200).map(e => ({ id: e.id, style: { lineDash: [2, 10], lineDashOffset: this.dashOffset } })));
      void this.enqueue(() => this.graph.draw());
    }, 100);
    else {
      this.graph.updateEdgeData(this.scene.edges.map(e => ({ id: e.id, style: { lineDash: e.dashPattern ?? (e.dashed ? [5, 3] : []), lineDashOffset: 0 } })));
      void this.enqueue(() => this.graph.draw());
    }
  }
  async fit() { if (!this.closed && this.rendered) { await this.graph.fitView({ when: 'always' }, false); if (this.graph.getZoom() > 1) await this.graph.zoomTo(1, false); } }
  async focus(ids: string[]) { if (!this.closed && this.rendered && ids.length) await this.graph.focusElement(ids, false); }
  async zoom(value: number) { if (!this.closed && this.rendered) await this.graph.zoomTo(Math.max(.005, Math.min(3, value)), false); }
  viewport(): Viewport { if(!this.rendered) return this.initialViewport ?? {x:0,y:0,zoom:1}; const p = this.graph.getViewportByCanvas([0, 0]); return { x: p[0], y: p[1], zoom: this.graph.getZoom() }; }
  select(id: string | null) { const node = this.scene.nodes.find(n => n.id === id); if(node?.decorative)return;node?.onSelect?.(node.id); this.events.select(id); }
  async collapse(id: string, collapsed: boolean) { if (collapsed) this.collapsed.add(id); else this.collapsed.delete(id); await this.update(this.scene, this.collapsed, this.highlighted); }
  setMinimap(enabled: boolean) { this.graph.setPlugins(enabled ? [{ type: 'minimap', key: 'minimap', position: 'right-bottom', size: [180, 110] }] : []); }
  snapshot(): GraphSnapshot {
    const scene=this.displayedScene;
    const hidden = new Set(scene.groups.filter(g => this.collapsed.has(g.id)).flatMap(g => g.members));
    const nodes:SceneNode[] = scene.nodes.filter(n => !hidden.has(n.id)).map(n => {
      const [x = 0, y = 0] = this.graph.getElementPosition(n.id); return { ...n, selected:n.selected||this.highlighted.has(n.id), x: x - n.width / 2, y: y - n.height / 2 };
    });
    for (const group of scene.groups.filter(g => this.collapsed.has(g.id))) {
      const [x = 0, y = 0] = this.graph.getElementPosition(group.id);
      nodes.push({ id: group.id, x: x - 100, y: y - 24, width: 200, height: 48, label: group.label, sub: `${group.members.length}`, kind: 'group' });
    }
    const boundsOf=(id:string)=>{const b=this.graph.getElementRenderBounds(id);return {x:b.min[0],y:b.min[1],width:b.max[0]-b.min[0],height:b.max[1]-b.min[1]};};
    const boxes=[...nodes.map(n=>boundsOf(n.id)),...scene.edges.map(e=>boundsOf(e.id)),...scene.groups.map(g=>boundsOf(g.id))];
    const x=Math.min(0,...boxes.map(b=>b.x)),y=Math.min(0,...boxes.map(b=>b.y));
    return { nodes, bounds:{x,y,width:Math.max(0,...boxes.map(b=>b.x+b.width))-x,height:Math.max(0,...boxes.map(b=>b.y+b.height))-y},
      groups: scene.groups.filter(g=>!this.collapsed.has(g.id)).map(g=>({...g,bounds:boundsOf(g.id)})), edges: scene.edges.map(e => ({ ...e, labelPoint:this.labelPoints.get(e.id),hot: e.hot || this.hovered === e.id || e.originalIds.some(id => this.highlighted.has(id)), path: this.paths.get(e.id) ?? e.path })) };
  }
  exportSvg(scale: number) { return snapshotSvg(this.snapshot(), scale); }
  destroy() {
    if (this.closed) return;
    this.closed = true; ++this.generation; this.observer.disconnect(); this.themeObserver.disconnect(); this.media.removeEventListener('change', this.themeChanged);
    this.cancelRoutes?.();
    if (this.timer) clearInterval(this.timer);
    for (const entry of this.mounts.values()) void unmount(entry.instance);
    this.mounts.clear(); this.graph.destroy();
  }
}
