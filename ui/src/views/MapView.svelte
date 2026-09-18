<!--
  The Map (`#/map`, design spec §3.6): the repository at module granularity,
  layered so dependencies point down.

  Svelte Flow draws it — custom node, custom edge, hidden handles as ports —
  but none of Svelte Flow's editing machinery is in play: positions come from
  `buildMapLayout`, selection is a local string, and nothing here is draggable.
  What the library provides is pan, zoom and fit; what it must not provide is
  a layout, because a map you cannot recognise between two visits is not a map.

  Root and depth ride in the hash, so a link to "src/vs at depth 2" reopens the
  same picture. Selection does not: it is a question you ask of the map, not a
  place you were.
-->
<script lang="ts">
  import { SvelteFlow, Controls, ViewportPortal, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import ModuleNode from '../components/map/ModuleNode.svelte';
  import ModuleEdge from '../components/map/ModuleEdge.svelte';
  import MapSidePanel from '../components/map/MapSidePanel.svelte';
  import MapKey from '../components/map/MapKey.svelte';
  import { exportFilename, mapSvg } from '../lib/export-svg';
  import { fetchMap, type WireMapPayload } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { mapHref, navigate } from '../lib/navigation';
  import {
    focusMapPayload,
    type MapFocusDirection,
    type MapFocusGrouping,
  } from '../lib/map-focus';
  import {
    buildMapLayout,
    isEdgeVisible,
    type MapEdgeLayout,
    type MapLayout,
  } from '../lib/map-model';

  interface Props {
    root: string | null;
    /** `null` = nobody has chosen; the answer picks a grouping for this repo. */
    depth: number | null;
    tests: boolean;
    focus?: string | null;
    direction?: MapFocusDirection | null;
    focusGrouping?: MapFocusGrouping | null;
    focusError?: string | null;
  }

  let {
    root,
    depth,
    tests,
    focus = null,
    direction = null,
    focusGrouping = null,
    focusError = null,
  }: Props = $props();

  let payload = $state<WireMapPayload | null>(null);
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
  const FIT = { fitViewOptions: { padding: 0.12, maxZoom: 1, minZoom: 0.45 } };

  // The key stays open until the reader closes it; the choice survives a reload
  // but is per browser — a preference, not a fact about the project. Same
  // storage shape as the Screens and Steps keys.
  const LEGEND_KEY = 'codegraph-ui:map-legend';
  let legendOpen = $state(readLegendOpen());
  let focusedLegendOpen = $state(false);
  function readLegendOpen(): boolean {
    try {
      return localStorage.getItem(LEGEND_KEY) !== 'closed';
    } catch {
      return true;
    }
  }
  $effect(() => {
    try {
      localStorage.setItem(LEGEND_KEY, legendOpen ? 'open' : 'closed');
    } catch {
      // Storage refused (private mode): the key simply reopens next time.
    }
  });

  const nodeTypes = { module: ModuleNode };
  const edgeTypes = { module: ModuleEdge };
  const legendIsOpen = $derived(focus === null ? legendOpen : focusedLegendOpen);

  $effect(() => {
    root;
    depth;
    tests;
    focus;
    direction;
    focusError;
    selected = null;
    hovered = null;
  });

  $effect(() => {
    const wantRoot = root;
    const wantDepth = depth;
    const wantFocus = focus;
    const wantDirection = direction;
    const wantFocusGrouping = focusGrouping;
    const wantTests = tests;
    // Read so the effect re-runs when the index moves: the map IS the graph,
    // and the layering changes with it. The canvas stays on screen while the
    // new aggregation lands (the server answers a cached one in milliseconds
    // when nothing actually changed).
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    error = focusError;
    if (focusError !== null) {
      loading = false;
      return () => controller.abort();
    }
    const mapRequest =
      wantFocus === null
        ? { root: wantRoot, depth: wantDepth ?? undefined, context: 'scope' as const }
        : wantFocusGrouping === null
          ? null
          : {
              root: wantFocusGrouping.root,
              depth: wantFocusGrouping.depth,
              context: 'repository' as const,
            };
    if (mapRequest === null) {
      error = 'This focus link is incomplete or invalid. Clear focus to return to the folder map.';
      loading = false;
      return () => controller.abort();
    }
    fetchMap(mapRequest, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        payload = next;
        if (
          wantFocus !== null &&
          (
            wantDirection === null ||
            next.context !== 'repository' ||
            !next.modules.some((module) => module.id === wantFocus && (wantTests || !module.test))
          )
        ) {
          error = next.context !== 'repository'
            ? 'This map data source cannot focus across the repository. Clear focus to return to the folder map.'
            : 'This focused module is no longer in the indexed graph. Clear focus to return to the folder map.';
        }
        loading = false;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      });
    return () => controller.abort();
  });

  const focusedPayload = $derived(
    payload === null || focus === null || direction === null
      ? payload
      : focusMapPayload(payload, focus, direction, tests)
  );
  const displayPayload = $derived(focusedPayload ?? payload);
  const layoutKey = $derived(
    `${payload?.root ?? ''}\u0000${payload?.depth ?? ''}\u0000${tests}\u0000${focus ?? ''}\u0000${direction ?? ''}`
  );
  const layout = $derived<MapLayout | null>(
    displayPayload === null ? null : buildMapLayout(displayPayload, { includeTests: tests })
  );

  /** Modules one hop from the selection — everything else is dimmed, not hidden. */
  const neighbours = $derived.by(() => {
    if (layout === null || selected === null) return null;
    const set = new Set<string>([selected]);
    for (const edge of layout.edges) {
      if (edge.source === selected) set.add(edge.target);
      if (edge.target === selected) set.add(edge.source);
    }
    return set;
  });

  const nodes = $derived.by<Node[]>(() => {
    if (layout === null || loading) return [];
    return layout.nodes.map((node) => ({
      id: node.id,
      type: 'module',
      position: { x: node.x, y: node.y },
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        layout: node,
        selected: selected === node.id,
        dimmed: neighbours !== null && !neighbours.has(node.id),
        onSelect: (id: string) => {
          selected = selected === id ? null : id;
          hovered = null;
        },
      },
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (layout === null) return [];
    return layout.edges
      .filter((edge) => isEdgeVisible(edge, selected))
      .map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: 'module',
        selectable: false,
        deletable: false,
        data: {
          edge,
          hot: hovered?.edge.id === edge.id || (selected !== null && !edge.back),
          dimmed: false,
          onHover: onEdgeHover,
        },
      }));
  });

  const selectedFiles = $derived(
    selected === null || displayPayload === null
      ? []
      : (displayPayload.modules.find((m) => m.id === selected)?.fileList.items ?? [])
  );

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
    // Deliberately dropping the depth: how finely to cut `ios` is a different
    // question from how finely to cut the whole project, and carrying the old
    // answer over is how a reader lands on a one-box map.
    navigate(mapHref({ root: next, tests }));
  }

  /** `null` hands the grouping back to the answering side. */
  function setDepth(next: number | null): void {
    selected = null;
    navigate(mapHref({ root, depth: next, tests }));
  }

  function startFocus(id: string): void {
    selected = null;
    hovered = null;
    const grouping = focusGrouping ?? (payload === null ? null : { root: payload.root, depth: payload.depth });
    if (grouping === null) return;
    navigate(mapHref({ root, depth, tests, focus: id, direction: 'depends-on', focusGrouping: grouping }));
  }

  function setFocusDirection(next: MapFocusDirection): void {
    if (focus === null) return;
    selected = null;
    hovered = null;
    navigate(mapHref({ root, depth, tests, focus, direction: next, focusGrouping }));
  }

  function clearFocus(): void {
    selected = null;
    hovered = null;
    navigate(mapHref({ root, depth, tests }));
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
  function buildSvg(scale: number): string {
    if (layout === null) throw new Error('There is no map to export yet.');
    const root = payload?.root ?? '';
    return mapSvg(layout, {
      scale,
      selected,
      caption: `${root || 'the project'} · ${layout.nodes.length} modules${selected ? ` · ${selected} selected` : ''}`,
    });
  }

  function setTests(next: boolean): void {
    selected = null;
    hovered = null;
    navigate(mapHref({ root, depth, tests: next, focus, direction, focusGrouping }));
  }

</script>

<div class="mapview">
  <div class="mapstage" bind:this={stage}>
    {#if error !== null}
      <div class="state">
        <h2>The map could not be built</h2>
        <p>{error}</p>
        {#if focus !== null || focusError !== null}
          <button class="clearfocus" onclick={clearFocus}>Clear focus</button>
        {/if}
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
      {#key layoutKey}
        <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        {edgeTypes}
        fitView
        {...FIT}
        minZoom={0.2}
        maxZoom={1.6}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        onpaneclick={() => {
          selected = null;
          hovered = null;
        }}
        >
        <!-- The layer rules ride INSIDE the viewport, so they pan and zoom
             with the boxes they explain. A layer line drawn on the frame
             would sit next to the wrong row the moment anyone scrolled. -->
        <ViewportPortal target="back">
          {#each layout.layers as row (row.index)}
            <div
              class="layerline"
              style={`transform:translate(0px,${row.y}px);width:${layout.width}px`}
            ></div>
            {#if row.label !== null}
              <!-- Above the top row, below the bottom one: both sit in the
                   clear band outside the drawing rather than under the edge
                   bundles, which is where a label stops being readable. -->
              <div
                class="layerlbl"
                style={`transform:translate(8px,${row.index === 0 ? row.y + 40 : row.y - 36}px)`}
              >
                {row.label}
              </div>
            {/if}
          {/each}
        </ViewportPortal>
        <Controls position="bottom-right" showLock={false} />
        </SvelteFlow>
      {/key}

      <!-- The key, on the picture it explains. -->
      <MapKey
        minWeight={layout.minWeight}
        thinCount={layout.edges.filter((e) => e.thin && !e.back).length}
        declaredBasis={layout.basis.kind === 'declared'}
        open={legendIsOpen}
        onToggle={(next) => {
          if (focus === null) legendOpen = next;
          else focusedLegendOpen = next;
        }}
      />

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

  {#if error === null && !loading && payload !== null && layout !== null}
    <MapSidePanel
      payload={displayPayload ?? payload}
      {layout}
      {selected}
      includeTests={tests}
      files={selectedFiles}
      buildSvg={buildSvg}
      exportName={exportFilename('map', payload.root ?? '')}
      onToggleTests={setTests}
      onSelectRoot={setRoot}
      chosenDepth={depth}
      onSelectDepth={setDepth}
      onSelect={(id) => (selected = id)}
      focus={focus === null || direction === null ? null : { id: focus, direction }}
      onFocus={startFocus}
      onSelectFocusDirection={setFocusDirection}
      onClearFocus={clearFocus}
      restoredRoot={root}
      restoredDepth={depth}
    />
  {/if}
</div>

<style>
  .mapview {
    display: grid;
    grid-template-columns: minmax(600px, 1fr) 320px;
    height: 100%;
    min-height: 0;
  }
  .mapstage {
    position: relative;
    overflow: hidden;
    background: var(--paper);
  }
  .clearfocus {
    border: 1px solid var(--rule-soft);
    border-radius: 0;
    background: var(--paper);
    color: var(--ink-2);
    cursor: pointer;
    font: 12px var(--sans);
    padding: 4px 6px;
  }
  /* Svelte Flow paints its own surface and its own controls; both are
     re-tokenised so the canvas belongs to the paper/ink system rather than
     arriving with the library's blue-grey defaults. */
  .mapstage :global(.svelte-flow) {
    background: var(--paper);
  }
  .mapstage :global(.svelte-flow__handle) {
    opacity: 0;
    width: 1px;
    height: 1px;
    min-width: 0;
    min-height: 0;
    border: 0;
    pointer-events: none;
  }
  .mapstage :global(.svelte-flow__controls-button) {
    background: var(--paper);
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    border-radius: 0;
    box-shadow: none;
    fill: var(--ink-2);
  }
  .mapstage :global(.svelte-flow__controls) {
    box-shadow: none;
    border: 1px solid var(--rule-soft);
  }
  .mapstage :global(.svelte-flow__node) {
    cursor: default;
  }

  .layerline {
    position: absolute;
    top: 0;
    left: 0;
    height: 1px;
    background: var(--rule-faint);
    pointer-events: none;
  }
  .layerlbl {
    position: absolute;
    top: 0;
    left: 0;
    font: 12px var(--sans);
    color: var(--ink-3);
    white-space: nowrap;
    pointer-events: none;
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
    border: 1px solid var(--ink);
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
      grid-template-columns: 1fr 260px;
    }
  }
</style>
