<!--
  The Screens view (`#/screens`): the app as its user meets it — one box per
  screen, an arrow for every way of getting from one to another, and on each
  arrow the condition under which it happens.

  Everything drawn comes from `/api/screens`: routes the framework resolver
  found, `navigates` edges the extractor bound, attribution back through the
  render/call chain to the screen a transition starts on, and branch guards
  read from the source. The canvas is the Map's machinery with different
  words (see `screens-model.ts`); the side panel is where the sentences are.

  At rest the picture is boxes and lines. Selecting a screen labels its
  transitions — each pill at the FAR end of its line, beside the other screen,
  in a lane the model chose so that no two overlap — and lists them in the
  panel; the panel and the picture point at each other, so a row under the
  pointer lights its line and prints its whole condition on it. On the canvas
  the pointer means the line NEAREST it, not the one drawn last under it.
-->
<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { graphStatus } from '../lib/graph-status.svelte';
  import DirectoryBrowser from '../components/graph/DirectoryBrowser.svelte';
  import { getGraphAdapter } from '../lib/adapter';
  import { readGraphHistory, saveGraphHistory } from '../lib/graph-history';
  import VirtualList from '../components/graph/VirtualList.svelte';
  import BudgetNotice from '../components/graph/BudgetNotice.svelte';
  import { graphText } from '../lib/graph-copy';
  import DetailPanel from '../components/graph/DetailPanel.svelte';
  import { untrack } from 'svelte';
  import { graphBudget } from '../lib/graph-budget';
  import { requestLayout } from '../lib/graph-layout';
  import GraphCanvas from '../components/graph/GraphCanvas.svelte';
  import { graphScene } from '../lib/graph-adapters';
  import type { Node, Edge } from '../lib/graph-scene';
  import KindGlyph from '../components/KindGlyph.svelte';
  import { fetchScreens, type WireScreensPayload, type WireScreenLink } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { symbolHref, fileHref, navigate, stepsHref, mapHref } from '../lib/navigation';
  import type { MapEdgeLayout } from '../lib/map-model';
  import { commonTokens, conditionTokens, restTokens, scenarios, whenWords, type WordToken } from '../lib/conditions';
  import {
    hoverPill,
    neighbourhood,
    pairId,
    placeLabels,
    viaText,
    type ScreensModel,
  } from '../lib/screens-model';

  let visibleCounts = $state<{nodes:number;edges:number}|null>(null);
  let payload = $state<WireScreensPayload | null>(null);
  let retry = $state(0);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  /** The panel row under the pointer: its edge on the canvas, and the one transition it names. */
  let panelHot = $state<{ edge: string; link: WireScreenLink } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);
  /** G6's pan and zoom, for turning a pointer position into a point on the canvas. */
  /** How close, in screen pixels, the pointer must be to a line to mean it. */

  // The key stays open until the reader closes it; the choice survives a
  // reload but is per browser — a preference, not a fact about the project.
  const LEGEND_KEY = 'codegraph-ui:screens-legend';
  let legendOpen = $state(readLegendOpen());
  function readLegendOpen(): boolean {
    try {
      return localStorage.getItem(LEGEND_KEY) === 'open';
    } catch {
      return false;
    }
  }
  $effect(() => {
    try {
      localStorage.setItem(LEGEND_KEY, legendOpen ? 'open' : 'closed');
    } catch {
      // Storage refused (private mode): the key simply reopens next time.
    }
  });


  $effect(() => {
    void retry;
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    error = null;
    fetchScreens(controller.signal)
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

  let scope = $state('');
  const scopedPayload = $derived.by(() => {
    if (!payload || !scope) return payload;
    const links = payload.links.filter(link => link.from === scope || link.to === scope);
    const ids = new Set([scope, ...links.flatMap(link => [link.from, link.to])]);
    return { ...payload, screens: payload.screens.filter(n => ids.has(n.id)), origins: payload.origins.filter(n => ids.has(n.id)), links };
  });
  let computedModel = $state<ScreensModel | null>(null);
  const model = $derived(computedModel);
  const localBudget = $derived(scopedPayload ? graphBudget(scopedPayload.screens.length + scopedPayload.origins.length, scopedPayload.links.length) : null);
  const budget = $derived((payload as (typeof payload & { budget?: { nodes: number; edges: number; exceeded: boolean } }))?.budget ?? localBudget);
  $effect(() => {
    const next = scopedPayload;
    if (!next || !next.routed || budget?.exceeded) { computedModel = null; return; }
    return requestLayout<ScreensModel>('screens', $state.snapshot(next), {}, result => computedModel = result, message => error = message);
  });

  const neighbours = $derived.by(() => {
    if (model === null || selected === null) return null;
    const set = new Set<string>([selected]);
    for (const edge of model.layout.edges) {
      if (edge.source === selected) set.add(edge.target);
      if (edge.target === selected) set.add(edge.source);
    }
    return set;
  });

  // The labels move with the selection and with nothing else: hovering a
  // line or a row must not reflow the pills the reader is looking at.
  const pills = $derived(model === null ? null : placeLabels(model, selected));
  /** The edge in focus: under the pointer on the canvas, or its row in the panel. */
  const focusId = $derived(hovered?.edge.id ?? panelHot?.edge ?? null);
  /** A pill for the focused edge when the selection gave it none. */
  const focusPill = $derived.by(() => {
    if (model === null || focusId === null || pills?.pills.has(focusId)) return null;
    const full = panelHot?.edge === focusId ? fullText(panelHot.link) : undefined;
    return hoverPill(model, focusId, selected, full, pills ?? undefined);
  });

  const nodes = $derived.by<Node[]>(() => {
    if (model === null) return [];
    return model.layout.nodes.map((node) => ({
      id: node.id,
      type: 'screen',
      position: { x: node.x, y: node.y },
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        layout: node,
        info: model.nodes.get(node.id)!,
        selected: selected === node.id,
        dimmed: neighbours !== null && !neighbours.has(node.id),
        onSelect: (id: string) => {
          selected = id;
          hovered = null;
          panelHot = null;
        },
      },
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (model === null) return [];
    const focus = focusId;
    return model.layout.edges

      .map((edge) => {
        const touches = selected !== null && (edge.source === selected || edge.target === selected);
        const isFocus = focus === edge.id;
        const hot = isFocus || touches;
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle,
          targetHandle: edge.targetHandle,
          type: 'screen',
          selectable: false,
          deletable: false,
          // The line in focus, and its pill, over the others; the selected
          // screen's over the rest.
          zIndex: isFocus ? 3 : hot ? 2 : 1,
          data: {
            edge,
            info: model.edges.get(edge.id)!,
            curve: model.curves.get(edge.id)!,
            hot,
            soft: hot && focus !== null && !isFocus,
            focus: isFocus,
            dimmed: selected !== null && !touches,
            pill: pills?.pills.get(edge.id) ?? (isFocus ? focusPill : null),
            full: panelHot?.edge === edge.id ? fullText(panelHot.link) : null,
            onHover: onEdgeHover,
          },
        };
      });
  });

  const selectedInfo = $derived(selected === null || model === null ? null : (model.nodes.get(selected) ?? null));
  const lists = $derived(
    selected === null || payload === null ? null : neighbourhood(payload, selected)
  );
  const hoveredInfo = $derived(hovered === null || model === null ? null : (model.edges.get(hovered.edge.id) ?? null));


  function onEdgeHover(edge: MapEdgeLayout | null, event: MouseEvent | null): void {
    if (edge === null || event === null || stage === null) {
      hovered = null;
      return;
    }
    const box = stage.getBoundingClientRect();
    hovered = {
      edge,
      x: Math.min(event.clientX - box.left + 14, box.width - 360),
      y: event.clientY - box.top + 14,
    };
  }

  /**
   * The pointer on the canvas means the line nearest it. A pill speaks for
   * its own line; over a box, the key or the tooltip there is no line.
   */


  /** The transform G6 applied, for the moment before the binding has a value. */


  /** The row under the pointer: light its line, and say the whole condition on it. */
  function onRowHover(link: WireScreenLink | null): void {
    const edge = link === null ? null : pairId(link);
    panelHot = link === null || edge === null ? null : { edge, link };
  }

  /** The words a panel row puts on its line: the arrow, and the whole condition. */
  function fullText(link: WireScreenLink): string {
    const arriving = selected !== null && link.to === selected && link.from !== selected;
    return `${arriving ? '←' : '→'} ${whenWords(link.when) || 'always'}`;
  }

  function rowHot(link: WireScreenLink): boolean {
    if (panelHot !== null) return panelHot.link.id === link.id;
    return hovered !== null && pairId(link) === hovered.edge.id;
  }

  function nameOf(id: string): string {
    return model?.nodes.get(id)?.label ?? id;
  }

  /** The row the panel prints for one transition, seen from `side`. */
  function sentence(link: WireScreenLink, side: 'from' | 'to'): string {
    const other = side === 'from' ? nameOf(link.from) : nameOf(link.to);
    return other;
  }
  let selectionNotice = $state('');
  $effect(() => {
    const ids = model ? [...model.nodes.keys()] : null;
    if (ids && selected && !ids.includes(selected)) { selected = null; selectionNotice = graphText('索引或筛选已变化，原选中节点不在当前图中。', 'The index or filters changed; the previous selection is no longer in this graph.'); }
  });
  const stateKey = typeof location === 'undefined' ? '' : location.href;
  const restored = untrack(() => readGraphHistory(stateKey));
  if (restored.selected) selected = restored.selected;
  scope = restored.scope ?? '';
  $effect(() => saveGraphHistory(stateKey, { selected, scope }));

  $effect(() => {
    if (!payload) return;
    return graphStatus.set({ nodes: visibleCounts?.nodes ?? nodes.length, edges: visibleCounts?.edges ?? edges.length, scope: scope || graphText('所有页面', 'All screens'), filter: scope ? graphText('一跳范围', 'One-hop scope') : undefined, excluded: payload.dropped ? `${payload.dropped} ${graphText('未归属导航', 'unattributed transitions')}` : undefined,
      budget: budget?.exceeded ? graphText('超过画布预算，请缩小范围', 'Canvas budget exceeded; narrow scope') : '400 / 2000',
    });
  });
  const canvasScene = $derived(graphScene('screens', nodes, edges, {}, scopedPayload?.links.map(link=>({id:link.id,source:link.from,target:link.to})),
    model ? [...new Set([...model.nodes.values()].flatMap(n => n.screen?.file ? [n.screen.file] : []))].map(file => ({ id: 'page:' + file, label: file, members: [...model.nodes.values()].filter(n => n.screen?.file === file).map(n => n.id) })).filter(g => g.members.length > 1) : []));
</script>

{#snippet words(tokens: WordToken[])}
  {#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b>{:else}{t.text}{/if}{/each}
{/snippet}

<div class="graph-shell">
{#if selectionNotice}<div role="status">{selectionNotice}</div>{/if}
<div class="scopebar" role="toolbar" aria-label={graphText('页面图范围', 'Screens scope')}>
  <label>{graphText('范围', 'Scope')} <select use:selectDropdown bind:value={scope}><option value="">{graphText('所有页面', 'All screens')}</option>{#each payload?.screens ?? [] as screen (screen.id)}<option value={screen.id}>{screen.path}</option>{/each}</select></label>
  <button disabled={!selected} onclick={() => scope = selected ?? ''}>{graphText('聚焦选中一跳', 'Focus one hop')}</button>
  <button disabled={!scope} onclick={() => scope = ''}>{graphText('重置范围', 'Reset scope')}</button>
  <button disabled={!selected} onclick={() => selected && navigate(stepsHref({ anchor: selected }))}>{graphText('查看此处步骤', 'Read steps from here')}</button>
</div>
<div class="screens">
  <div class="stage" bind:this={stage} role="presentation" onmouseleave={() => (hovered = null)}>
    {#if error && model}<div class="retry-banner" role="alert">{error} <button onclick={() => retry++}>{graphText('重试', 'Retry')}</button></div>{/if}
    {#if budget?.exceeded}
      <div class="budget-scope"><BudgetNotice nodes={budget.nodes} edges={budget.edges} />
        {#if getGraphAdapter().browse}<p>{graphText('从目录或文件继续分析；选择目录将打开对应架构图。', 'Continue through directories or files; choosing a directory opens its architecture map.')}</p><DirectoryBrowser root="" onOpen={(root) => navigate(mapHref({ root, depth: 1, tests: false }))} />{/if}
      </div>
    {:else if error !== null && model === null}
      <div class="state">
        <h2>The screens could not be read</h2>
        <p>{error}</p><button onclick={() => retry++}>{graphText('重试', 'Retry')}</button>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Reading screens and transitions…</p></div>
    {:else if payload !== null && !payload.routed}
      <div class="state">
        <h2>No screen navigation in this graph</h2>
        <p>
          This view draws the routes a UI framework binds to components and the navigation calls
          that reach them. The index has {payload.screens.length === 0 ? 'no routes' : 'routes'} but no
          navigation between them — it is not an app with screens, or its router is one CodeGraph
          does not read yet.
        </p>
      </div>
    {:else if model !== null}
      <GraphCanvas scene={canvasScene} onVisibleChange={counts=>visibleCounts=counts} {selected}
        onSelect={id => { selected = id; hovered = null; panelHot = null; }} />

      <!-- The key, on the picture it explains. Each row draws the actual
           stroke or box, not a word for it — a reader matches shapes, not
           descriptions. Collapsible, remembered per browser. -->
      <div class="legend" class:open={legendOpen}>
        <button class="legend-h" onclick={() => (legendOpen = !legendOpen)} aria-expanded={legendOpen}>
          Key <span class="dim">{legendOpen ? '▾' : '▸'}</span>
        </button>
        {#if legendOpen}
          <div class="legend-body">
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
              <span>Transition — the destination is written at the call</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
              <span>Destination inferred from a helper's return value</span>
            </div>
            <div class="lrow">
              <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
              <span>{graphText('箭头表示真实跳转方向；在分析菜单中定位循环', 'Arrows show the real transition direction; cycles are identified in Analyze')}</span>
            </div>
            <div class="lrow">
              <span class="k-label mono">→ …x</span>
              <span>
                The last condition checked before the transition, beside the screen at the other end of
                the selected screen's line; ← when it arrives there. None = always
              </span>
            </div>
            <div class="lrow">
              <span class="k-box mono">/path</span>
              <span>A screen — its path and the component that renders it</span>
            </div>
            <div class="lrow">
              <span class="k-box k-entry mono"><span class="mark">●</span>/</span>
              <span>{graphText('入口页面；分层布局中每向下一层就多一次跳转', 'Entry screen; in the hierarchical layout each layer is one more transition away')}</span>
            </div>
            <div class="lrow">
              <span class="k-box k-origin mono">fn()</span>
              <span>Not a screen: shared chrome, or a trigger no screen reaches — a row above what it opens</span>
            </div>
            <div class="lrow">
              <span class="k-box k-unreached mono">/path</span>
              <span>Nothing reaches it from the entry (bottom band)</span>
            </div>
          </div>
        {/if}
      </div>

      {#if hovered !== null && hoveredInfo !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{nameOf(hoveredInfo.from)}</b> → {nameOf(hoveredInfo.to)}</div>
          {#each hoveredInfo.links.slice(0, 5) as link (link.id)}
            <div class="tiprow">
              {#if link.sites.length > 1}<span class="dim">{link.sites.length} ways</span>{/if}
              <span class="when">{@render words(conditionTokens(link.when))}</span>
              {#if link.via.length > 0}<span class="mono dim">via {viaText(link)}</span>{/if}
            </div>
          {/each}
          {#if hoveredInfo.links.length > 5}<div class="dim">+{hoveredInfo.links.length - 5} more</div>{/if}
        </div>
      {/if}
    {/if}
  </div>

  {#if payload !== null && model !== null}
    <DetailPanel><aside class="side">
      {#if selectedInfo !== null && lists !== null}
        <div class="head">
          <div>
            <div class="mono big">{selectedInfo.label}</div>
            {#if selectedInfo.screen?.component}
              <a class="sub" href={symbolHref(selectedInfo.screen.component.id)}>
                <KindGlyph kind={selectedInfo.screen.component.kind} />
                {selectedInfo.screen.component.name}
              </a>
            {:else if selectedInfo.origin}
              <span class="sub dim">navigates from outside any screen</span>
            {/if}
            {#if selectedInfo.screen}
              <a class="sub dim" href={fileHref(selectedInfo.screen.file)}>{selectedInfo.screen.file}</a>
            {/if}
            <a class="sub act" href={stepsHref({ anchor: selectedInfo.id })}>What happens here →</a>
          </div>
          <button class="clear" onclick={() => (selected = null)}>clear</button>
        </div>
        {#if pills !== null && pills.hidden > 0}
          <p class="dim note">
            {pills.hidden} condition{pills.hidden === 1 ? '' : 's'} not drawn on the picture for want of
            room — hover a row below to see {pills.hidden === 1 ? 'it' : 'each'} on its line.
          </p>
        {/if}

        <h4>Opens from <span class="dim">{lists.opensFrom.length}</span></h4>
        {#if lists.opensFrom.length === 0}
          <p class="dim">
            {selectedInfo.entry ? 'The entry screen — the app starts here.' : 'Nothing in the graph navigates here.'}
          </p>
        {/if}
        <VirtualList items={lists.opensFrom} rowHeight={100}>{#snippet row(link)}
            {@const sc = scenarios(link.sites)}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.from)}>{sentence(link, 'from')}</button>
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.via.length > 0}<div class="via">via {viaText(link)}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                <a class="site dim" href={symbolHref(link.via[link.via.length - 1]?.id ?? selectedInfo.id, { line: row.site.line })}
                  >{row.site.method} {row.site.href} · {row.site.file.slice(row.site.file.lastIndexOf('/') + 1)}:{row.site.line}</a
                >
              </div>
            {/each}
          </div>
        {/snippet}</VirtualList>

        <h4>Goes to <span class="dim">{lists.goesTo.length}</span></h4>
        {#if lists.goesTo.length === 0}<p class="dim">No navigation leaves this screen.</p>{/if}
        <VirtualList items={lists.goesTo} rowHeight={100}>{#snippet row(link)}
            {@const sc = scenarios(link.sites)}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.to)}>{sentence(link, 'to')}</button>
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.via.length > 0}<div class="via">via {viaText(link)}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                <a
                  class="site dim"
                  href={symbolHref(link.via[link.via.length - 1]?.id ?? selectedInfo.screen?.component?.id ?? selectedInfo.id, { line: row.site.line })}
                  >{row.site.method} {row.site.href} · {row.site.file.slice(row.site.file.lastIndexOf('/') + 1)}:{row.site.line}</a
                >
              </div>
            {/each}
          </div>
        {/snippet}</VirtualList>
      {:else}
        <div class="head"><div class="big">Screens</div></div>
        <p>
          <b>{payload.screens.length}</b> screens · <b>{payload.links.length}</b> transitions{#if payload.origins.length > 0}
            · <b>{payload.origins.length}</b> triggered outside a screen{/if}.
        </p>
        <p class="dim">
          <span class="mark">●</span> {graphText('默认从入口页面逐层展示跳转，也可切换力导向、同心圆或环形。选中页面查看相邻关系，悬停连线或详情行查看条件及调用来源。', 'The default layout layers transitions from entry screens; force-directed, concentric and circular layouts are also available. Select a screen for adjacent relationships; hover an edge or detail row for conditions and call origins.')}
        </p>
        <p class="dim">
          {graphText('实线表示直接跳转，虚线表示经返回值等方式推导的关系。箭头保留跳转方向，循环由真实有向关系计算。虚线节点表示共享入口、未到达页面或页面边界。', 'Solid edges represent direct transitions; dashed edges represent synthesized relationships. Arrows retain navigation direction; cycles are computed from real directed relationships. Dashed nodes indicate shared origins, unreached screens or boundaries.')}
        </p>
        {#if model.unreached > 0}
          <p class="dim">
            <b>{model.unreached}</b> screen{model.unreached === 1 ? '' : 's'} in the band at the bottom: no
            transition in the graph reaches {model.unreached === 1 ? 'it' : 'them'} from the entry — opened
            by something the graph cannot see (a layout's initial route, a deep link), or unused.
          </p>
        {/if}
        {#if payload.dropped > 0}
          <p class="dim">{payload.dropped} navigation{payload.dropped === 1 ? '' : 's'} could not be attributed: the walk back to a screen hit a hub.</p>
        {/if}
        <h4>Most connected</h4>
        {#each [...payload.screens].sort((a, b) => b.incoming + b.outgoing - (a.incoming + a.outgoing)).slice(0, 8) as screen (screen.id)}
          <button class="peer mono" onclick={() => (selected = screen.id)}
            >{screen.path} <span class="dim">←{screen.incoming} →{screen.outgoing}</span></button
          >
        {/each}
      {/if}
    </aside></DetailPanel>
  {/if}
</div>

</div>

<style>
  .budget-scope{height:100%;overflow:auto;padding:0 24px;max-width:700px}.budget-scope p{font:14px/1.6 var(--sans);color:var(--ink-2)}
  .retry-banner{position:absolute;top:60px;left:12px;right:12px;z-index:12;background:var(--paper-2);border:1px solid var(--rule);padding:10px;font:12px var(--sans)}
  .graph-shell{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
  .scopebar{flex:none}
  .scopebar{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:10px 16px;border-bottom:1px solid var(--rule);background:var(--paper-2);font:14px var(--sans)}.scopebar select,.scopebar button{min-height:36px;border:1px solid var(--rule);color:var(--ink);background:var(--paper);padding:4px;font:inherit}

  .screens {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    position: relative;
    height: auto;
    flex: 1;
    min-height: 0;
  }
  .stage {
    position: relative;
    overflow: hidden;
    background-color: var(--paper);
    background-image:
      linear-gradient(var(--route-grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--route-grid) 1px, transparent 1px);
    background-size: 24px 24px;
  }
  .state {
    padding: 48px 40px;
    max-width: 560px;
  }
  .state h2 {
    font: 600 20px var(--sans);
    margin: 0 0 8px;
  }
  .legend {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 4;
    max-width: 380px;
    border: 1px solid var(--route-branch);
    background: var(--paper-2);
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .legend-h {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 5px 10px;
    text-align: left;
    color: var(--ink);
    font: 600 12px var(--sans);
    cursor: pointer;
  }
  .legend-body {
    padding: 2px 10px 8px;
    border-top: 1px solid var(--rule-soft);
  }
  .lrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 0;
  }
  .lrow > :first-child {
    flex: 0 0 44px;
    display: inline-flex;
    justify-content: center;
  }
  .k-line {
    stroke: var(--route-branch);
    stroke-opacity: 0.8;
    stroke-width: 1.5;
    fill: none;
  }
  .k-line.k-synth {
    stroke-dasharray: 5 3;
  }
  .k-label {
    font-size: 10.5px;
    color: var(--ink-3);
  }
  .k-box {
    box-sizing: border-box;
    padding: 1px 5px;
    border: 1px solid var(--route-branch);
    font-size: 10.5px;
    color: var(--ink);
    line-height: 14px;
  }
  .k-box.k-origin {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .k-box.k-unreached {
    border-color: var(--ink-4);
    color: var(--ink-2);
  }
  .k-entry .mark {
    font-size: 8px;
    margin-right: 3px;
    vertical-align: 1px;
  }

  .tip {
    position: absolute;
    z-index: 5;
    width: 340px;
    padding: 8px 10px;
    border: 1px solid var(--route-main);
    background: var(--paper-2);
    box-shadow: inset 3px 0 0 var(--route-main);
    font-size: 12px;
    pointer-events: none;
    /* A long via chain or condition wraps inside the box. */
    overflow-wrap: anywhere;
  }
  .tiprow {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--rule-soft);
  }
  .side {
    border-left: 1px solid var(--route-branch);
    padding: 14px 16px;
    overflow: auto;
    font-size: 12.5px;
    background: var(--paper-2);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--route-branch) 28%, transparent);
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 8px;
    margin-bottom: 10px;
  }
  .big {
    font-size: 15px;
    font-weight: 600;
    padding-left: 8px;
    border-left: 3px solid var(--route-main);
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--ink-2);
    text-decoration: none;
  }
  .sub:hover {
    text-decoration: underline;
  }
  .act {
    color: var(--accent-ink);
  }
  .clear {
    border: 1px solid var(--rule);
    background: transparent;
    color: var(--ink-2);
    font: inherit;
    font-size: 11.5px;
    padding: 1px 7px;
    cursor: pointer;
  }
  .note {
    margin: 0 0 6px;
  }
  h4 {
    margin: 16px 0 6px;
    font: 600 12.5px var(--sans);
  }
  /* A row is also a pointer at its line: hovering it lights the line and
     prints the whole condition on it, and the line under the pointer on the
     canvas tints its row here. Bled to the panel's edges so the tint reads
     as a row, not a box inside one. */
  .row {
    padding: 7px 8px;
    margin: 0 -8px;
    border-top: 1px solid var(--rule-soft);
    transition: background 150ms ease, box-shadow 150ms ease;
  }
  .row.hot {
    background: var(--route-band);
    box-shadow: inset 3px 0 0 var(--route-main);
  }
  .peer {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 2px 0;
    text-align: left;
    color: var(--ink);
    font: 500 12.5px var(--mono);
    cursor: pointer;
  }
  .peer:hover {
    text-decoration: underline;
  }
  .when {
    color: var(--ink);
    font: 400 11.5px var(--mono);
    margin-top: 2px;
  }
  /* The joins we add — WHEN, AND, OR, NOT — a little bolder than the code between them. */
  .kw {
    font-weight: 600;
  }
  /* The chain a transition travels through — the answer to "where on the screen": read, not dim. */
  .via {
    color: var(--ink-2);
    font: 400 11.5px var(--mono);
    margin-top: 2px;
  }
  .ways {
    font: 500 11px var(--sans);
    margin-top: 6px;
  }
  /* One scenario per row under a transition: its own tail of conditions, then its site. */
  .scenario.many {
    margin: 4px 0 0 8px;
    padding-left: 8px;
    border-left: 1px solid var(--rule-soft);
  }
  .site {
    display: block;
    font: 400 11px var(--mono);
    margin-top: 2px;
    text-decoration: none;
  }
  .site:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: var(--mono);
  }
  .dim {
    color: var(--ink-3);
  }
  .mark {
    color: var(--route-main);
  }
</style>
