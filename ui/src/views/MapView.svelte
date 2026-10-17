<!-- 架构图采用 Worker 自动布局，允许在当前范围手动排列并展示静态依赖流向。 -->
<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import type { MapEdgeStyle } from '../lib/map-edge-path';
  import type { CompactMapInput } from '../lib/map-compact';
  import { graphStatus } from '../lib/graph-status.svelte';
  import DirectoryBrowser from '../components/graph/DirectoryBrowser.svelte';
  import { getGraphAdapter } from '../lib/adapter';
  import { moduleTarget } from '../lib/map-scope';
  import { readGraphHistory, saveGraphHistory } from '../lib/graph-history';
  import BudgetNotice from '../components/graph/BudgetNotice.svelte';
  import { graphText } from '../lib/graph-copy';
  import DetailPanel from '../components/graph/DetailPanel.svelte';
  import { untrack } from 'svelte';
  import { graphBudget } from '../lib/graph-budget';
  import { buildMapIndex, indexedOneHop, cachedPresentation, mapNodeMeasurements, positionedMapPoints } from '../lib/map-index';
  import { requestLayout } from '../lib/graph-layout';
  import GraphCanvas from '../components/graph/GraphCanvas.svelte';
  import type { RelationshipLayout } from '../lib/relationship-layout';
  import { graphScene } from '../lib/graph-adapters';
  import type { Node, Edge, GraphController } from '../lib/graph-scene';
  import MapSidePanel from '../components/map/MapSidePanel.svelte';
  import { exportFilename } from '../lib/export-svg';
  import { fetchMap, type WireMapPayload } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { mapHref, navigate, fileHref } from '../lib/navigation';
  import {
    type MapEdgeLayout,
    type MapNodeLayout,
    type MapLayout,
  } from '../lib/map-model';

  interface Props {
    root: string | null;
    depth: number;
    tests: boolean;
  }

  let { root, depth, tests }: Props = $props();
  let relationshipLayout = $state<RelationshipLayout>('default');

  let visibleCounts = $state<{nodes:number;edges:number}|null>(null);
  let payload = $state<WireMapPayload | null>(null);
  let retry = $state(0);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);

  /**
   * Fit, but never past readable.
   *
   * The prototype refused to scale a label below ~0.9 and scrolled instead;
   * a pannable canvas can be more generous, but not unboundedly so — a
   * seventy-module repository fitted to a laptop screen is a picture of grey
   * hair, not a map. Below this floor the view opens part-way and the reader
   * pans, which is the honest trade.
   */


  let minWeight = $state(1);
  let debouncedWeight = $state(1);
  let detailsRequested = $state(false);
  const detailScope = $derived(JSON.stringify([root, depth, tests, debouncedWeight]));
  $effect(() => {
    const value = Math.max(1, Math.floor(minWeight || 1));
    const timer = setTimeout(() => debouncedWeight = value, 250);
    return () => clearTimeout(timer);
  });
  $effect(() => { void detailScope; detailsRequested = false; });
  // 范围筛选传给服务端，在预算计算前缩小图；旧宿主可忽略可选字段。
  $effect(() => {
    void retry;
    const wantRoot = root;
    const wantDepth = depth;
    const includeTests = tests;
    const weight = debouncedWeight;
    const details = detailsRequested;
    // Read so the effect re-runs when the index moves: the map IS the graph,
    // and the layering changes with it. The canvas stays on screen while the
    // new aggregation lands (the server answers a cached one in milliseconds
    // when nothing actually changed).
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    error = null;
    fetchMap({ root: wantRoot, depth: wantDepth, includeTests, minWeight: weight, details }, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        payload = next;
        loading = false;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      });
    return () => controller.abort();
  });

  const selectedTarget = $derived.by(() => { const module = selected ? index?.nodeById.get(selected)?.module : null; return module ? moduleTarget(module) : null; });
  let locate = $state<{ id: string } | null>(null);
  let layout = $state<MapLayout | null>(null);
  let positions = $state<Record<string, { x: number; y: number }>>({});
  let flowPlaying = $state(false);
  let edgeStyle = $state<MapEdgeStyle>('curve');
  let fitRequest = $state<object | null>(null);
  let compactRequest = $state.raw<{ layout: MapLayout; direction: string; input: CompactMapInput } | null>(null);
  const manuallyPlaced = $derived(Object.keys(positions).length > 0);
  const budget = $derived(payload ? (payload as WireMapPayload & { budget?: ReturnType<typeof graphBudget> }).budget ?? graphBudget(payload.modules.length, payload.links.length) : null);
  $effect(() => {
    const next = payload; const options = { includeTests: tests, minWeight };
    if (!next || budget?.exceeded) { layout = null; return; }
    return requestLayout<MapLayout>('map', $state.snapshot(next), options, result => untrack(() => { layout = result; const ids = new Set(result.nodes.map(node => node.id)); positions = Object.fromEntries(Object.entries(positions).filter(([id]) => ids.has(id))); }), message => error = message);
  });

  /** Modules one hop from the selection — everything else is dimmed, not hidden. */
  let focusDirection = $state<'in' | 'out' | 'both'>('both');
  let focusOnly = $state(false);
  const index = $derived(layout ? buildMapIndex(layout) : null);
  const neighbours = $derived(indexedOneHop(index, selected, focusDirection));


  function onNodeSelect(id: string): void { selected = id; hovered = null; }
  const nodePresentation = $derived.by(() => {
    void layout;
    return cachedPresentation<MapNodeLayout, Node>((node, flags) => ({
      id: node.id, type: 'module', position: positions[node.id] ?? { x: node.x, y: node.y },
      ...mapNodeMeasurements(node),
      draggable: true, dragHandle: '.mnode', selectable: false, connectable: false,
      data: { layout: node, selected: flags[0] === '1', dimmed: flags[1] === '1', onSelect: onNodeSelect, onMove: moveNode },
    }));
  });
  const edgePresentation = $derived.by(() => {
    const currentIndex = index;
    return cachedPresentation<MapEdgeLayout, Edge>((edge, flags) => ({
      id: edge.id, source: edge.source, target: edge.target,
      sourceHandle: 'out', targetHandle: 'in',
      type: 'module', selectable: false, deletable: false,
      data: { edge: manuallyPlaced ? { ...edge, controlPoints: undefined } : edge, points: positionedMapPoints(currentIndex!, edge, livePositions), hot: flags[0] === '1', flowing: flags[1] === '1', edgeStyle, dimmed: false, onHover: onEdgeHover },
    }));
  });
  let nodes = $state.raw<Node[]>([]);
  // 位置通过双向绑定接收绘图库的拖动更新，不重新运行布局 Worker。
  $effect(() => {
    nodes = !layout ? [] : layout.nodes.map(node => {
      const position = positions[node.id] ?? { x: node.x, y: node.y };
      return nodePresentation(node, `${selected === node.id ? 1 : 0}${neighbours !== null && !neighbours.has(node.id) ? 1 : 0}:${position.x},${position.y}`);
    });
  });
  const livePositions = $derived(new Map(nodes.map(node => [node.id, node.position])));
  function moveNode(id: string, dx: number, dy: number): void {
    const position = livePositions.get(id);
    compactRequest = null;
    if (position) positions = { ...positions, [id]: { x: position.x + dx, y: position.y + dy } };
  }

  const visibleEdges = $derived.by(() => {
    if (!index) return [];
    const candidates = layout?.edges.filter(edge => !edge.thin) ?? [];
    return candidates;
  });
  // 鼠标在同一条边内移动只更新提示位置，不使画布对象失效。
  const hoveredEdgeId = $derived(hovered?.edge.id ?? null);
  const edges = $derived(visibleEdges.map((edge, i) => {
    const points = positionedMapPoints(index!, edge, livePositions);
    const hot = hoveredEdgeId === edge.id;
    return edgePresentation(edge, `${hot ? 1 : 0}${flowPlaying && i < 200 ? 1 : 0}:${edgeStyle}:${points.source.x},${points.source.y},${points.target.x},${points.target.y}`);
  }));
  const selectedFiles = $derived(selected ? index?.nodeById.get(selected)?.module.fileList.items ?? [] : []);

  function compactVisible(): void {
    if (!layout || !selected || !focusOnly) return;
    relationshipLayout = 'default';
    hovered = null;
    compactRequest = { layout, direction: focusDirection, input: {
      selected,
      nodes: nodes.filter(node => neighbours?.has(node.id)).map(node => { const original = index!.nodeById.get(node.id)!; return { id: node.id, width: original.width, height: original.height }; }),
      edges: visibleEdges.filter(edge => neighbours?.has(edge.source) && neighbours.has(edge.target)).map(edge => ({ source: edge.source, target: edge.target })),
    } };
  }
  $effect(() => {
    const request = compactRequest;
    if (!request) return;
    // 切换范围、所选对象或一跳方向后，旧排列不能覆盖新的分析上下文。
    if (request.layout !== layout || request.input.selected !== selected || request.direction !== focusDirection || !focusOnly) { compactRequest = null; return; }
    let active = true;
    const cancel = requestLayout<Record<string, { x: number; y: number }>>('map-compact', request.input, {}, result => untrack(() => {
      if (!active) return;
      positions = { ...positions, ...result };
      compactRequest = null;
      fitRequest = {};
    }), message => { if (active) { error = message; compactRequest = null; } });
    return () => { active = false; cancel(); };
  });

  function onEdgeHover(edge: MapEdgeLayout | null, event: MouseEvent | null): void {
    if (edge === null || event === null || stage === null) {
      hovered = null;
      return;
    }
    const box = stage.getBoundingClientRect();
    hovered = {
      edge,
      // Clamped so the card never runs off the right-hand side of the canvas.
      x: Math.min(event.clientX - box.left + 14, box.width - 330),
      y: event.clientY - box.top + 14,
    };
  }

  function setRoot(next: string): void {
    selected = null;
    navigate(mapHref({ root: next, depth, tests }));
  }

  /**
   * The map as it stands, for a README.
   *
   * Serialised from `layout` — the object the canvas is drawing — so the file
   * carries the same layering, the same hidden thin links and the same
   * selection the reader is looking at. SVG rather than PNG is the point here:
   * a forty-module map is a wide, mostly-empty drawing that scales, and GitHub
   * renders SVG in a README.
   */


  function setTests(next: boolean): void {
    selected = null;
    navigate(mapHref({ root, depth, tests: next }));
  }
  let selectionNotice = $state('');
  $effect(() => {
    const ids = layout?.nodes.map(n => n.id);
    if (ids && selected && !ids.includes(selected)) { selected = null; selectionNotice = graphText('索引或筛选已变化，原选中节点不在当前图中。', 'The index or filters changed; the previous selection is no longer in this graph.'); }
  });
  const stateKey = typeof location === 'undefined' ? '' : location.href;
  const restored = untrack(() => readGraphHistory(stateKey));
  if (restored.selected) selected = restored.selected;
  minWeight = restored.minWeight ?? 1;
  debouncedWeight = restored.minWeight ?? 1;
  focusOnly = restored.focusOnly ?? false;
  focusDirection = restored.focusDirection ?? 'both';
  positions = restored.positions ?? {};
  flowPlaying = restored.flowPlaying ?? false;
  edgeStyle = restored.edgeStyle === undefined || restored.edgeStyle === 'curve' ? 'curve' : 'straight';
  $effect(() => saveGraphHistory(stateKey, { selected, minWeight, focusOnly, focusDirection, positions, flowPlaying, edgeStyle }));

  $effect(() => {
    if (!payload) return;
    return graphStatus.set({ nodes: visibleCounts?.nodes ?? nodes.length, edges: visibleCounts?.edges ?? edges.length, scope: payload.root || graphText('整个项目', 'Whole project'), filter: `${tests ? graphText('包含测试模块', 'Include test modules') : graphText('隐藏测试模块', 'Hide test modules')} · ${graphText('权重', 'Weight')} ≥ ${minWeight}${focusOnly ? ` · ${focusDirection === 'in' ? graphText('上游', 'Incoming') : focusDirection === 'out' ? graphText('下游', 'Outgoing') : graphText('双向', 'Both directions')}` : ''}`, excluded: `${payload.excluded.uncertainEdges} ${graphText('不确定关系已排除', 'uncertain relationships excluded')}`,
      budget: budget?.exceeded ? graphText('超过画布预算，请缩小范围', 'Canvas budget exceeded; narrow scope') : '400 / 2000',
    });
  });
  let graphController = $state.raw<GraphController | null>(null);
  const canvasScene = $derived(graphScene('map', nodes, edges));
  function buildSvg(scale: number): string {
    if (!graphController) throw new Error('Graph is not ready');
    return graphController.exportSvg(scale);
  }
</script>

<div class="graph-shell">
{#if selectionNotice}<div role="status">{selectionNotice}</div>{/if}
<div class="scopebar" role="toolbar" aria-label={graphText('架构图范围', 'Architecture scope')}>
  <label>{graphText('目录', 'Root')} <select use:selectDropdown value={root ?? ''} onchange={e => setRoot(e.currentTarget.value)}><option value="">{graphText('整个项目', 'Whole project')}</option>{#each payload?.roots ?? [] as option (option.root)}<option value={option.root}>{option.label}</option>{/each}</select></label>
  <label>{graphText('深度', 'Depth')} <select use:selectDropdown value={depth} onchange={e => navigate(mapHref({ root, depth: Number(e.currentTarget.value), tests }))}>{#each [1,2,3,4] as d}<option value={d}>{d}</option>{/each}</select></label>
  <label><input type="checkbox" checked={tests} onchange={e => setTests(e.currentTarget.checked)} />{graphText('包含测试', 'Include tests')}</label>
  <label>{graphText('最小权重', 'Min weight')} <input type="number" min="1" max="10000" bind:value={minWeight} /></label>
  {#if selectedTarget?.kind === 'file'}<a href={fileHref(selectedTarget.path)}>{graphText('打开门面文件', 'Open facade file')}</a>{:else}<button disabled={selectedTarget?.kind !== 'directory'} onclick={() => selectedTarget?.kind === 'directory' && setRoot(selectedTarget.path)}>{graphText('下钻选中目录', 'Drill into selection')}</button>{/if}
  <label>{graphText('一跳方向', 'One-hop direction')} <select use:selectDropdown bind:value={focusDirection}><option value="both">{graphText('双向', 'Both')}</option><option value="in">{graphText('上游', 'Incoming')}</option><option value="out">{graphText('下游', 'Outgoing')}</option></select></label>
  <label><input type="checkbox" bind:checked={focusOnly} />{graphText('只看聚焦', 'Focus only')}</label>
  <label>{graphText('连线', 'Edges')} <select use:selectDropdown aria-label={graphText('连线样式', 'Edge style')} bind:value={edgeStyle}><option value="curve">{graphText('曲线', 'Curve')}</option><option value="straight">{graphText('直线', 'Straight')}</option></select></label>
  <button disabled={!focusOnly || !selected || !layout || !!compactRequest} title={graphText('选中节点并开启只看聚焦后，重新排列当前可见节点，缩短长距离连线。', 'Select a node and enable Focus only to arrange visible nodes closer together.')} onclick={compactVisible}>{compactRequest ? graphText('排列中…', 'Arranging…') : graphText('紧凑排列', 'Compact layout')}</button>
  <button disabled={!layout} aria-pressed={flowPlaying} onclick={() => flowPlaying = !flowPlaying}>{flowPlaying ? graphText('暂停流向', 'Pause flow') : graphText('播放流向', 'Play flow')}</button>
  <button disabled={!manuallyPlaced && relationshipLayout === 'default'} onclick={() => { compactRequest = null; positions = {}; relationshipLayout = 'default'; fitRequest = {}; }}>{graphText('恢复自动布局', 'Reset layout')}</button>
</div>
<p class="compact-note">{graphText('拖动节点整理链路；Alt + 方向键微调。箭头 A → B 表示 A 调用或依赖 B，动画不代表运行时数据。', 'Drag nodes to arrange links; use Alt + arrow keys to nudge. A → B means A calls or depends on B; animation does not represent runtime data.')} {manuallyPlaced ? graphText('当前为手动排列。', 'Manually arranged.') : graphText('当前为自动布局。', 'Automatic layout.')}{#if flowPlaying && visibleEdges.length > 200} {graphText('仅播放前 200 条关系；选中节点可聚焦局部流向。', 'Playing the first 200 relationships; select a node to focus the flow.')}{/if}</p>
<div class="mapview">
  <div class="mapstage" bind:this={stage}>
    {#if error && layout}<div class="retry-banner" role="alert">{error} <button onclick={() => retry++}>{graphText('重试', 'Retry')}</button></div>{/if}
    {#if budget?.exceeded}
      <div class="budget-scope"><BudgetNotice nodes={budget.nodes} edges={budget.edges} edgesExact={(budget as { edgesExact?: boolean }).edgesExact ?? true} />
        {#if getGraphAdapter().browse}<DirectoryBrowser root={payload?.root ?? root ?? ''} onOpen={setRoot} />{/if}</div>
    {:else if error !== null && layout === null}
      <div class="state">
        <h2>The map could not be built</h2>
        <p>{error}</p><button onclick={() => retry++}>{graphText('重试', 'Retry')}</button>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Aggregating the graph by module…</p></div>
    {:else if layout !== null && layout.nodes.length === 0}
      <div class="state">
        <h2>Nothing to draw here</h2>
        <p>
          No indexed files sit under this root{tests
            ? ''
            : ', or every module under it is test code'}. Pick another root on the right.
        </p>
      </div>
    {:else if layout !== null}
      <GraphCanvas scene={canvasScene} onVisibleChange={counts=>visibleCounts=counts} {selected} {locate} {fitRequest} bind:controller={graphController} bind:direction={focusDirection} bind:focusOnly bind:layoutMode={relationshipLayout}
        onReset={()=>{compactRequest=null;positions={};}}
        onSelect={id => { selected = id; hovered = null; }}
        onMove={(id, x, y) => { compactRequest = null; positions = { ...positions, [id]: { x, y } }; }} />

      {#if hovered !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{hovered.edge.source}</b> → {hovered.edge.target}</div>
          <div class="row2">
            <span>{hovered.edge.link.count} edges</span>
            <span
              >{hovered.edge.link.byKind.map((k) => `${k.kind} ${k.count}`).join(' · ')}</span
            >
          </div>
          {#if hovered.edge.link.declared !== hovered.edge.link.count}
            <div class="row2 dim">
              <span>{hovered.edge.link.declared} through an import or a declared type</span>
            </div>
          {/if}
          {#each hovered.edge.link.topPairs as pair (pair.from + pair.to)}
            <div class="row2 mono">
              <span>{pair.from} → {pair.to}</span><span>{pair.count}</span>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>

  {#if payload !== null && layout !== null}
    <DetailPanel><MapSidePanel
      {payload}
      {layout}
      {selected}
      includeTests={tests}
      {detailsRequested}
      detailsLoading={loading}
      detailsFailed={error !== null}
      onLoadDetails={() => { detailsRequested = true; retry++; }}
      files={selectedFiles}
      buildSvg={buildSvg}
      exportName={exportFilename('map', payload.root ?? '')}
      onToggleTests={setTests}
      onSelectRoot={setRoot}
      onSelect={(id) => { selected = id; if (id) locate = { id }; }}
    /></DetailPanel>
  {/if}
</div>

</div>

<style>
  .compact-note{flex:none;margin:0;padding:6px 16px;font:13px var(--sans);color:var(--ink-2);border-bottom:1px solid var(--rule)}
  .retry-banner{position:absolute;top:60px;left:12px;right:12px;z-index:12;background:var(--paper-2);border:1px solid var(--rule);padding:10px;font:12px var(--sans)}
  .budget-scope{height:100%;overflow:auto;padding:0 24px;max-width:700px}
  .graph-shell{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
  .scopebar{flex:none}
  .scopebar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:10px 16px;border-bottom:1px solid var(--rule);background:var(--paper-2);font:14px var(--sans)}
  .scopebar label{display:flex;align-items:center;gap:5px}.scopebar select,.scopebar button,.scopebar input[type="number"]{min-height:36px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);font:inherit;padding:4px}.scopebar input[type="number"]{width:65px}

  .mapview {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    position: relative;
    height: auto;
    flex: 1;
    min-height: 0;
  }
  .mapstage {
    position: relative;
    overflow: hidden;
    background-color: var(--paper);
    background-image:
      linear-gradient(var(--route-grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--route-grid) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .state {
    padding: 40px;
    max-width: 46ch;
  }
  .state h2 {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
  }
  .state p {
    margin: 0;
    color: var(--ink-2);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .dim {
    color: var(--ink-3);
  }

  .tip {
    position: absolute;
    z-index: 6;
    max-width: 320px;
    background: var(--paper);
    border: 1px solid var(--route-main);
    box-shadow: inset 3px 0 0 var(--route-main);
    padding: 8px 10px;
    font-size: 12px;
    color: var(--ink-2);
    pointer-events: none;
  }
  .tip .mono {
    font: 12px var(--mono);
    color: var(--ink-2);
    margin-bottom: 4px;
  }
  .tip .mono b {
    color: var(--ink);
    font-weight: 600;
  }
  .tip .row2 {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    padding: 1px 0;
  }
  .tip .row2.mono {
    font: 11.5px var(--mono);
  }
  .tip .row2.dim {
    color: var(--ink-3);
  }

  @media (max-width: 1100px) {
    .mapview {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
