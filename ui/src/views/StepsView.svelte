<!--
  The Steps view (`#/steps?anchor=…`): what happens from here. One box per
  step — a screen, a handler, a call into native code, a native event landing
  back in JS, a store action, a call that leaves the index — an arrow for
  every way one leads to the next, and on each arrow the condition under
  which it happens, with the plumbing between two steps folded into the arrow
  and listed in the panel.

  Everything drawn comes from `/api/steps`: the anchor's forward walk through
  calls, renders, handler bindings and navigations, classified as it goes, and
  branch guards read from the source. The canvas is the Screens view's
  machinery with a different node universe (see `steps-model.ts`); the side
  panel is where the sentences are, and where a step becomes the next anchor
  or a Flow strip between two steps.
-->
<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { graphStatus } from '../lib/graph-status.svelte';
  import SymbolPicker from '../components/graph/SymbolPicker.svelte';
  import { readGraphHistory, saveGraphHistory } from '../lib/graph-history';
  import VirtualList from '../components/graph/VirtualList.svelte';
  import BudgetNotice from '../components/graph/BudgetNotice.svelte';
  import { graphText } from '../lib/graph-copy';
  import DetailPanel from '../components/graph/DetailPanel.svelte';
  import { untrack } from 'svelte';
  import { programBudget } from '../lib/graph-budget';
  import { requestLayout } from '../lib/graph-layout';
  import GraphCanvas from '../components/graph/GraphCanvas.svelte';
  import { graphScene } from '../lib/graph-adapters';
  import type { Node, Edge } from '../lib/graph-scene';
  import StepsKey from '../components/steps/StepsKey.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import {
    canDrawSteps,
    fetchRoutes,
    fetchScreens,
    fetchSteps,
    type WireRoute,
    type WireScreen,
    type WireStepLink,
    type WireStepsPayload,
  } from '../lib/api';
  import { i18n } from '../lib/i18n.svelte';
  import { live } from '../lib/live.svelte';
  import { fileHref, flowHref, navigate, stepsHref, symbolHref } from '../lib/navigation';
  import type { MapEdgeLayout } from '../lib/map-model';
  import { hoverPill, placeLabels } from '../lib/screens-model';
  import { commonTokens, conditionTokens, restTokens, scenarios, whenWords, type WordToken } from '../lib/conditions';
  import {
    kindWord,
    kindWords,
    selectionReach,
    stepNeighbourhood,
    stepPairId,
    stepViaText,
    triggerWords,
    type StepsModel,
  } from '../lib/steps-model';


  interface Props {
    anchor: string | null;
    symbol: string | null;
    depth: number | null;
    /** Enter the screens the walk reaches, instead of drawing them as boundaries. */
    through: boolean;
    /**
     * Which reading the URL asked for — the code's `order` or the `tree` of
     * what the anchor sets in motion. Null takes the answer's own default: the
     * order for a handler or an endpoint, the tree for a screen.
     */
    reading: 'order' | 'tree' | null;
  }
  let { anchor, symbol, depth, through, reading }: Props = $props();

  let visibleCounts = $state<{nodes:number;edges:number}|null>(null);
  let payload = $state<WireStepsPayload | null>(null);
  let anchorChoice = $state('');
  let retry = $state(0);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  /** The panel row under the pointer: its edge on the canvas, and the one link it names. */
  let panelHot = $state<{ edge: string; link: WireStepLink } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);

  /** The chooser's lists, when the view opens without an anchor: the screens of an app, else the endpoints of an API. */
  let screens = $state<WireScreen[] | null>(null);
  let routes = $state<WireRoute[] | null>(null);

  /** What the chooser offers: null while reading. */
  const chooser = $derived.by<'screens' | 'routes' | 'none' | null>(() => {
    if (screens === null) return null;
    if (screens.length > 0) return 'screens';
    if (routes === null) return null;
    return routes.length > 0 ? 'routes' : 'none';
  });

  /** Endpoints by the file they are registered in — the router file is how a reader groups them — biggest first, in registration order within. */
  function routeGroups(list: WireRoute[]): Array<{ file: string; entries: WireRoute[] }> {
    const byFile = new Map<string, WireRoute[]>();
    for (const r of list) {
      const group = byFile.get(r.routeFile) ?? [];
      group.push(r);
      byFile.set(r.routeFile, group);
    }
    return [...byFile]
      .map(([file, entries]) => ({ file, entries: [...entries].sort((a, b) => a.routeLine - b.routeLine) }))
      .sort((a, b) => b.entries.length - a.entries.length || a.file.localeCompare(b.file));
  }

  const LEGEND_KEY = 'codegraph-ui:steps-legend';
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


  /** Start the picture at a step — the panel's *Start here →*. False for a step with no symbol, or the anchor. */
  function startHere(id: string): boolean {
    const step = model?.nodes.get(id)?.step;
    if (!step || !step.node || step.anchor) return false;
    navigate(stepsHref({ anchor: step.node.id }));
    return true;
  }
  const DEPTHS = [4, 6, 8, 10, 12];

  const asked = $derived(anchor !== null || symbol !== null);
  const supported = canDrawSteps();

  $effect(() => {
    void retry;
    void live.indexTick;
    const request =
      anchor !== null
        ? { anchor, depth: depth ?? undefined, through }
        : symbol !== null
          ? { symbol, depth: depth ?? undefined, through }
          : null;
    const controller = new AbortController();
    hovered = null;
    panelHot = null;
    if (request === null) {
      payload = null;
      loading = false;
      error = null;
      fetchScreens(controller.signal)
        .then(async (next) => {
          if (controller.signal.aborted) return;
          screens = next.routed ? next.screens : [];
          // No screens: an API's endpoints are its places to start from.
          if (next.routed) {
            routes = [];
            return;
          }
          const found = await fetchRoutes({ limit: 300 }, controller.signal);
          if (controller.signal.aborted) return;
          routes = found.routed ? found.entries : [];
        })
        .catch(() => {
          if (controller.signal.aborted) return;
          screens = screens ?? [];
          routes = routes ?? [];
        });
      return () => controller.abort();
    }
    loading = true;
    error = null;
    fetchSteps(request, controller.signal)
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

  /**
   * Which reading is on screen. The URL wins; otherwise the answer's own
   * default — the code's order for a handler, an endpoint or any function, the
   * tree for a screen, where handlers fire on events and have nothing to order.
   */
  const readAs = $derived<'order' | 'tree'>(reading ?? payload?.defaultView ?? 'tree');

  /**
   * The picture. Both readings are the same canvas over the same boxes; what
   * differs is the graph — in the code's order a line means "and then" and the
   * rows are how much has already happened, in the tree it means "leads to" and
   * the rows are distance from the anchor.
   */
  let computedModel = $state<StepsModel | null>(null);
  const model = $derived(computedModel);
  const localBudget = $derived(payload ? programBudget(payload.steps.length, payload.links.length, readAs === 'order' ? payload.program?.root : undefined) : null);
  const budget = $derived((payload as (typeof payload & { budget?: { nodes: number; edges: number; exceeded: boolean } }))?.budget ?? localBudget);
  $effect(() => {
    const next = payload; const options = { readAs };
    if (!next || budget?.exceeded) { computedModel = null; return; }
    return requestLayout<StepsModel>('steps', $state.snapshot(next), options, result => computedModel = result, message => error = message);
  });

  /** The order can be asked for and have nothing to read: the view then says so. */
  const orderReadable = $derived(payload?.program != null);

  /**
   * The fit. A picture of a few boxes is centred — and the key, bottom left,
   * would sit on its second row; it is fitted to the right of the key instead.
   * A picture of many boxes is fitted to the whole stage, as the Screens view's
   * — and a picture laid out by region may fit far out: the regions and their
   * captions are the overview, and the reader zooms into one, where a 0.4
   * floor on a big screen's picture opened on a window torn out of its middle.
   *
   * Declared AFTER the model it reads: `$derived` is lazy, so the forward
   * reference ran, but it is a forward reference all the same and the checker
   * was right to say so. The per-side padding keeps its literal types (`as
   * const`), because the canvas types a side as `` `${number}px` `` — widened
   * to `string` it silently fails to typecheck against the very option it is
   * written for.
   */


  /** The selection with the decision points it touches — what the edge filter and the dimming reason over. */
  const reach = $derived(model === null || selected === null ? null : selectionReach(model, selected));
  const neighbours = $derived.by(() => {
    if (model === null || reach === null) return null;
    const set = new Set<string>(reach);
    for (const edge of model.layout.edges) {
      if (reach.has(edge.source)) set.add(edge.target);
      if (reach.has(edge.target)) set.add(edge.source);
    }
    return set;
  });

  /**
   * Which lines are labelled before anything is selected. In the code's order
   * that is all of them — there the conditions ARE the picture. In the tree it
   * is the arms of a decision and nothing else: a `yes` and a `no` leaving one
   * box are the one thing a reader cannot work out from the shape, and drawing
   * every condition at rest is the unreadable picture the tree exists to avoid.
   */
  const atRestLabels = $derived.by<boolean | ReadonlySet<string>>(() => {
    if (readAs === 'order') return true;
    if (model === null) return false;
    return new Set([...model.edges.values()].filter((e) => e.arm !== undefined).map((e) => e.id));
  });
  const pills = $derived(model === null ? null : placeLabels(model, selected, atRestLabels));
  const focusId = $derived(hovered?.edge.id ?? panelHot?.edge ?? null);
  const focusPill = $derived.by(() => {
    if (model === null || focusId === null || pills?.pills.has(focusId)) return null;
    const full = panelHot?.edge === focusId ? fullText(panelHot.link) : undefined;
    return hoverPill(model, focusId, selected, full, pills ?? undefined);
  });

  const nodes = $derived.by<Node[]>(() => {
    if (model === null) return [];
    // A screen's picture carries a caption over each region — text in the gap
    // above the region's first line, taking no pointer.
    const captions: Node[] = (model.regions ?? []).map((zone) => ({
      id: `region:${zone.id}`,
      type: 'region',
      position: { x: zone.x, y: zone.y - 32 },
      draggable: false,
      selectable: false,
      connectable: false,
      data: { label: zone.label, width: zone.width,relatedIds:model.layout.nodes.filter(n=>n.x>=zone.x&&n.x<zone.x+zone.width&&n.y>=zone.y&&n.y<zone.y+zone.height).map(n=>n.id) },
    }));
    // A decision made inside a box, said once under it; each line out of that
    // box says only which way it is.
    for (const d of model.decisions) {
      const owner = d.id.slice(0, d.id.indexOf(' '));
      captions.push({
        id: `decision:${d.id}`,
        type: 'decision',
        position: { x: d.x, y: d.y },
        draggable: false,
        selectable: false,
        connectable: false,
        data: { label: d.label, width: d.width, owner,dimmed: neighbours !== null && !neighbours.has(owner) },
      });
    }
    return captions.concat(model.layout.nodes.map((node) => {
      // A decision's point: not a step — no selection, no panel; the box asks
      // and the lines out answer.
      const fork = model.forks?.get(node.id);
      if (fork) {
        return {
          id: node.id,
          type: 'fork',
          position: { x: node.x, y: node.y },
          draggable: false,
          selectable: false,
          connectable: false,
          data: { layout: node, fork, dimmed: neighbours !== null && !neighbours.has(node.id) },
        };
      }
      return {
        id: node.id,
        type: 'step',
        position: { x: node.x, y: node.y },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          layout: node,
          info: model.nodes.get(node.id)!,
          project: payload?.project ?? 'app',
          selected: selected === node.id,
          dimmed: neighbours !== null && !neighbours.has(node.id),
          onSelect: (id: string) => {
            selected = id;
            hovered = null;
            panelHot = null;
          },
        },
      };
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (model === null) return [];
    const focus = focusId;
    return model.layout.edges

      .map((edge) => {
        const touches =
          reach !== null && (reach.has(edge.source) || reach.has(edge.target));
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
  const lists = $derived(selected === null || payload === null ? null : stepNeighbourhood(payload, selected));
  const hoveredInfo = $derived(hovered === null || model === null ? null : (model.edges.get(hovered.edge.id) ?? null));

  /** The same picture with one setting changed: the anchor as the URL asked for it, the rest kept. */
  function rewrite(changes: { depth?: number; through?: boolean; view?: 'order' | 'tree' }): string {
    return stepsHref({
      anchor: anchor ?? undefined,
      symbol: anchor === null ? (symbol ?? undefined) : undefined,
      depth: changes.depth ?? depth ?? undefined,
      through: changes.through ?? through,
      // The reading travels in the URL once it has been chosen, so a link to
      // "the login endpoint in the code's order" reopens as that.
      view: changes.view ?? reading ?? undefined,
    });
  }

  function onEdgeHover(edge: MapEdgeLayout | null, event: MouseEvent | null): void {
    if (edge === null || event === null || stage === null) {
      hovered = null;
      return;
    }
    const box = stage.getBoundingClientRect();
    hovered = {
      edge,
      x: Math.min(event.clientX - box.left + 14, box.width - 420),
      y: event.clientY - box.top + 14,
    };
  }





  function onRowHover(link: WireStepLink | null): void {
    const edge = link === null ? null : stepPairId(link);
    panelHot = link === null || edge === null ? null : { edge, link };
  }

  /** The words a panel row puts on its line: the arrow, and the whole condition. */
  function fullText(link: WireStepLink): string {
    const arriving = selected !== null && link.to === selected && link.from !== selected;
    return `${arriving ? '←' : '→'} ${whenWords(link.when) || 'always'}`;
  }

  function rowHot(link: WireStepLink): boolean {
    if (panelHot !== null) return panelHot.link.id === link.id;
    return hovered !== null && stepPairId(link) === hovered.edge.id;
  }

  function nameOf(id: string): string {
    return model?.nodes.get(id)?.label ?? model?.forks?.get(id)?.label ?? id;
  }

  /** A Flow strip between the two symbols of a link, when both are symbols. */
  function stripHref(link: WireStepLink): string | null {
    const from = payload?.steps.find((s) => s.id === link.from)?.node;
    const to = payload?.steps.find((s) => s.id === link.to)?.node;
    if (!from || !to) return null;
    return flowHref({ from: from.name, to: to.name });
  }

  /** The symbol a site's line belongs to: the last folded symbol, else the step's own. */
  function siteHref(link: WireStepLink, site: { file: string; line: number }, fallback: string | null): string | null {
    const last = link.via[link.via.length - 1];
    const id = last?.id ?? fallback;
    return id === null ? null : symbolHref(id, { line: site.line });
  }

  function basename(file: string): string {
    return file.slice(file.lastIndexOf('/') + 1);
  }

  /** `SecureStore.setItemAsync('userEmail', values.email)` — the site, with what it passes when that could be read. */
  function siteWords(site: { text: string; args?: string }): string {
    return site.args === undefined ? site.text : `${site.text}(${site.args})`;
  }
  let selectionNotice = $state('');
  $effect(() => {
    const ids = model ? [...model.nodes.keys()] : null;
    if (ids && selected && !ids.includes(selected)) { selected = null; selectionNotice = graphText('索引或筛选已变化，原选中节点不在当前图中。', 'The index or filters changed; the previous selection is no longer in this graph.'); }
  });
  const stateKey = typeof location === 'undefined' ? '' : location.href;
  const restored = untrack(() => readGraphHistory(stateKey));
  if (restored.selected) selected = restored.selected;
  $effect(() => saveGraphHistory(stateKey, { selected }));

  $effect(() => {
    if (!payload) return;
    return graphStatus.set({ nodes: visibleCounts?.nodes ?? nodes.length, edges: visibleCounts?.edges ?? edges.length, scope: payload.anchor.name, filter: `${readAs} · ${graphText('深度', 'Depth')} ${depth ?? payload.depth} · through=${through}`, excluded: payload.truncated?.hubs ? `${payload.truncated.hubs} ${graphText('高扇出边界', 'fan-out boundaries')}` : undefined,
      budget: budget?.exceeded ? graphText('超过画布预算，请缩小范围', 'Canvas budget exceeded; narrow scope') : '400 / 2000',
    });
  });
  const canvasScene = $derived(graphScene('steps', nodes, edges, {},
    payload?.links.map(link => ({ id: link.id, source: link.from, target: link.to })),
    (model?.regions ?? []).map(zone => ({ id: 'zone:' + zone.id, label: zone.label,
      members: nodes.filter(n => n.position.x >= zone.x && n.position.x < zone.x + zone.width && n.position.y >= zone.y && n.position.y < zone.y + zone.height).map(n => n.id) }))));
</script>

{#snippet words(tokens: WordToken[])}
  {#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b>{:else}{t.text}{/if}{/each}
{/snippet}

<div class="graph-shell">
{#if selectionNotice}<div role="status">{selectionNotice}</div>{/if}
<div class="scopebar" role="toolbar" aria-label={graphText('步骤图范围', 'Steps scope')}>
  <SymbolPicker label={graphText('更换起点', 'Change anchor')} bind:value={anchorChoice} />
  <button disabled={!anchorChoice} onclick={() => navigate(stepsHref({ anchor: anchorChoice, depth: depth ?? undefined, through, view: readAs }))}>{graphText('应用起点', 'Use anchor')}</button>
  <span>{graphText('固定起点：', 'Fixed anchor: ')}{payload?.anchor.name ?? symbol ?? anchor ?? graphText('请选择起点', 'Choose an anchor')}</span>
  <label>{graphText('深度', 'Depth')} <select use:selectDropdown value={depth ?? payload?.depth ?? 6} onchange={e => navigate(rewrite({ depth: Number(e.currentTarget.value) }))}>{#each DEPTHS as d}<option value={d}>{d}</option>{/each}</select></label>
  <label>{graphText('阅读', 'Reading')} <select use:selectDropdown value={readAs} onchange={e => navigate(rewrite({ view: e.currentTarget.value as 'order' | 'tree' }))}><option value="order">{graphText('代码顺序', 'Code order')}</option><option value="tree">{graphText('影响树', 'Impact tree')}</option></select></label>
  <label><input type="checkbox" checked={through} onchange={e => navigate(rewrite({ through: e.currentTarget.checked }))} />{graphText('穿过页面边界', 'Continue through screens')}</label>
  <button disabled={!selected} onclick={() => selected && startHere(selected)}>{graphText('以选中节点为起点', 'Start from selection')}</button>
</div>
<div class="steps">
  <div class="stage" bind:this={stage} role="presentation" onmouseleave={() => (hovered = null)}>
    {#if error && model}<div class="retry-banner" role="alert">{error} <button onclick={() => retry++}>{graphText('重试', 'Retry')}</button></div>{/if}
    {#if !supported}
      <div class="state">
        <h2>{i18n.t('steps.cannotDraw')}</h2>
        <p>{i18n.t('steps.cannotDrawDetail')}</p>
      </div>
    {:else if !asked}
      <div class="state chooser">
        <h2>{i18n.t('steps.fromWhere')}</h2>
        {#if chooser === 'routes'}
          <p>
            {i18n.t('steps.pickEndpoint')} <i>{i18n.t('steps.whatHappensHere')}</i>.
          </p>
        {:else}
          <p>
            {i18n.t('steps.pickScreen')} <i>{i18n.t('steps.whatHappensHere')}</i>.
          </p>
        {/if}
        {#if chooser === null}
          <p class="dim">{screens === null ? i18n.t('steps.readingScreens') : i18n.t('steps.readingEndpoints')}</p>
        {:else if chooser === 'none'}
          <p class="dim">
            {i18n.t('steps.noTargets')} <i>{i18n.t('steps.whatHappensHere')}</i>,
            or link here directly with <span class="mono">#/steps?symbol=&lt;name&gt;</span>.
          </p>
        {:else if chooser === 'screens' && screens !== null}
          <div class="chooser-list">
            {#each [...screens].sort((a, b) => b.outgoing + b.incoming - (a.outgoing + a.incoming) || a.path.localeCompare(b.path)) as screen (screen.id)}
              <a class="pick mono" href={stepsHref({ anchor: screen.id })}
                >{screen.path} <span class="dim sans">{screen.component?.name ?? basename(screen.file)}</span></a
              >
            {/each}
          </div>
        {:else if routes !== null}
          {#each routeGroups(routes) as group (group.file)}
            <div class="group-h"><span class="mono">{group.file}</span><span class="dim">{group.entries.length}</span></div>
            <div class="chooser-list">
              {#each group.entries as route (route.routeId)}
                <a class="pick mono" href={stepsHref({ anchor: route.routeId })}
                  >{route.url} <span class="dim sans">{route.handler}</span></a
                >
              {/each}
            </div>
          {/each}
        {/if}
      </div>
    {:else if budget?.exceeded}
      <BudgetNotice nodes={budget.nodes} edges={budget.edges} />
    {:else if error !== null && model === null}
      <div class="state">
        <h2>The steps could not be read</h2>
        <p>{error}</p><button onclick={() => retry++}>{graphText('重试', 'Retry')}</button>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Walking from the anchor…</p></div>
    {:else if model !== null && payload !== null && readAs === 'order' && !orderReadable}
      <div class="state">
        <h2>This has no body to read in order</h2>
        <p>
          Nothing the picture holds is written inside this symbol — a screen renders handlers that fire on
          events, and they have no order between them. Read it as what it sets in motion instead.
        </p>
        <p><a class="pick" href={rewrite({ view: 'tree' })}>What it sets in motion →</a></p>
      </div>
    {:else if model !== null && payload !== null}
      <GraphCanvas scene={canvasScene} onVisibleChange={counts=>visibleCounts=counts} {selected}
        onSelect={id => { selected = id; hovered = null; panelHot = null; }} />


      {#if hovered !== null && hoveredInfo !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{nameOf(hoveredInfo.from)}</b> → {nameOf(hoveredInfo.to)}</div>
          {#each hoveredInfo.links.slice(0, 5) as link (link.id)}
            <div class="tiprow">
              {#if link.trigger}<span class="fires"><b class="kw">FIRES FROM</b> {triggerWords(link.trigger)} <span class="dim">in {link.trigger.in}</span></span>{/if}
              {#if link.via.length > 0}<span class="via">via {stepViaText(link)}</span>{/if}
              {#if link.within}<span class="dim">inside {link.within}(…)</span>{/if}
              {#if link.sites.length > 1}<span class="dim">{link.sites.length} ways</span>{/if}
              <span class="when">{@render words(conditionTokens(link.when))}</span>
              {#if link.label}<span class="dim">{link.label}</span>{/if}
              {#if link.sites[0]}<span class="mono">{#if link.sites[0].status}<b class="status">{link.sites[0].status}</b> · {/if}{siteWords(link.sites[0])}</span>{/if}
            </div>
          {/each}
          {#if hoveredInfo.links.length > 5}<div class="dim">+{hoveredInfo.links.length - 5} more</div>{/if}
        </div>
      {/if}
    {/if}

    {#if payload !== null && model !== null && (readAs === 'tree' || orderReadable)}
      <StepsKey
        project={payload.project}
        order={readAs === 'order'}
        regions={model.regions !== null}
        flow={false}
        open={legendOpen}
        onToggle={(next) => (legendOpen = next)}
      />
    {/if}
  </div>

  {#if payload !== null && model !== null}
    <DetailPanel><aside class="side">
      {#if selectedInfo !== null && lists !== null}
        <div class="head">
          <div>
            <div class="mono big">{selectedInfo.label}</div>
            <div class="sub dim">{kindWord(selectedInfo.step.kind, payload.project, selectedInfo.step)}{#if selectedInfo.step.anchor} · where the picture starts{/if}</div>
            {#if selectedInfo.step.trigger}
              <div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(selectedInfo.step.trigger)} <span class="dim">in {selectedInfo.step.trigger.in}</span></div>
            {/if}
            {#if selectedInfo.step.screen?.component}
              <a class="sub" href={symbolHref(selectedInfo.step.screen.component.id)}>
                <KindGlyph kind={selectedInfo.step.screen.component.kind} />
                {selectedInfo.step.screen.component.name}
              </a>
            {:else if selectedInfo.step.node && selectedInfo.step.kind !== 'screen'}
              <a class="sub" href={symbolHref(selectedInfo.step.node.id)}>
                <KindGlyph kind={selectedInfo.step.node.kind} />
                {selectedInfo.step.node.name}
              </a>
            {/if}
            {#if selectedInfo.step.effect}
              <a class="sub" href={symbolHref(selectedInfo.step.effect.by.id, { line: selectedInfo.step.effect.line })}>
                <KindGlyph kind={selectedInfo.step.effect.by.kind} />
                {selectedInfo.step.effect.by.name} · line {selectedInfo.step.effect.line}
              </a>
            {/if}
            {#if selectedInfo.step.node}
              <a class="sub dim" href={fileHref(selectedInfo.step.node.file)}>{selectedInfo.step.node.file}</a>
            {/if}
            {#if selectedInfo.step.node && !selectedInfo.step.anchor}
              <a class="sub act" href={stepsHref({ anchor: selectedInfo.step.node.id })}>Start here →</a>
            {/if}
          </div>
          <button class="clear" onclick={() => (selected = null)}>clear</button>
        </div>
        {#if selectedInfo.step.cut === 'screen'}
          <p class="dim note">Another {kindWord('screen', payload.project, selectedInfo.step)} — a chapter of its own. Start here to see what happens on it, or continue through {kindWords('screen', payload.project)[1]} from the summary.</p>
        {:else if selectedInfo.step.cut === 'component'}
          <p class="dim note">The event lands in a component of another screen — a picture of its own. Start here to see it, or continue through screens from the summary.</p>
        {:else if selectedInfo.step.cut !== null}
          <p class="dim note">
            The walk was cut at this step ({selectedInfo.step.cut === 'depth'
              ? 'the picture’s depth'
              : selectedInfo.step.cut === 'fan-out'
                ? 'more calls than the walk follows from one node'
                : selectedInfo.step.cut === 'folded'
                  ? 'as much plumbing as it folds from one step'
                  : 'the picture’s size'}). Start here to see on.
          </p>
        {/if}
        {#if selectedInfo.step.effect && selectedInfo.step.effect.apis.length > 1}
          <p class="dim note mono">{selectedInfo.step.effect.apis.join(' · ')}</p>
        {/if}
        {#if selectedInfo.step.effect?.category === 'response'}
          <p class="dim note">{selectedInfo.step.effect.statuses?.length ? 'One way the endpoint answers — each row below is a site that sends it, with the condition it answers under; its other outcomes are the boxes beside it.' : 'Replies whose status the code does not spell out — each row below is one, with the condition it answers under.'}</p>
        {/if}
        {#if selectedInfo.step.events && selectedInfo.step.events.length > 1}
          <p class="dim note mono">⇠ {selectedInfo.step.events.join(' · ')}</p>
        {/if}
        {#if pills !== null && pills.hidden > 0}
          <p class="dim note">
            {pills.hidden} condition{pills.hidden === 1 ? '' : 's'} not drawn on the picture for want of
            room — hover a row below to see {pills.hidden === 1 ? 'it' : 'each'} on its line.
          </p>
        {/if}

        <h4>Arrives from <span class="dim">{lists.arrivesFrom.length}</span></h4>
        {#if lists.arrivesFrom.length === 0}
          <p class="dim">{selectedInfo.step.anchor ? 'The anchor — the picture starts here.' : 'Nothing in the picture leads here.'}</p>
        {/if}
        <VirtualList items={lists.arrivesFrom} rowHeight={100}>{#snippet row(link)}
            {@const sc = scenarios(link.sites)}
            {@const fallback = payload?.steps.find((s) => s.id === link.from)?.node?.id ?? null}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.from)}>{nameOf(link.from)}</button>
            {#if link.trigger}<div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(link.trigger)} <span class="dim">in {link.trigger.in}</span></div>{/if}
            {#if link.via.length > 0}<div class="via">via {stepViaText(link)}</div>{/if}
            {#if link.within}<div class="via dim">inside {link.within}(…)</div>{/if}
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if row.site.trigger && triggerWords(row.site.trigger) !== (link.trigger ? triggerWords(link.trigger) : '')}
                  <div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(row.site.trigger)}</div>
                {/if}
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>Open as a flow →</a>{/if}
          </div>
        {/snippet}</VirtualList>

        <h4>Leads to <span class="dim">{lists.leadsTo.length}</span></h4>
        {#if lists.leadsTo.length === 0}
          <p class="dim">
            {selectedInfo.step.kind === 'effect'
              ? 'Outside the index: the graph cannot follow it further.'
              : selectedInfo.step.cut === 'screen' || selectedInfo.step.cut === 'component'
                ? 'Not entered — a boundary. Start here for its own picture, or continue through from the summary.'
                : 'Nothing the walk follows leaves this step.'}
          </p>
        {/if}
        <VirtualList items={lists.leadsTo} rowHeight={100}>{#snippet row(link)}
            {@const sc = scenarios(link.sites)}
            {@const fallback = selectedInfo.step.screen?.component?.id ?? selectedInfo.step.node?.id ?? null}
          <div
            class="row"
            class:hot={rowHot(link)}
            role="presentation"
            onmouseenter={() => onRowHover(link)}
            onmouseleave={() => onRowHover(null)}
            onfocusin={() => onRowHover(link)}
            onfocusout={() => onRowHover(null)}
          >
            <button class="peer mono" onclick={() => (selected = link.to)}>{nameOf(link.to)}</button>
            {#if link.trigger}<div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(link.trigger)} <span class="dim">in {link.trigger.in}</span></div>{/if}
            {#if link.via.length > 0}<div class="via">via {stepViaText(link)}</div>{/if}
            {#if link.within}<div class="via dim">inside {link.within}(…)</div>{/if}
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{sc.rows.length} ways</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if row.site.trigger && triggerWords(row.site.trigger) !== (link.trigger ? triggerWords(link.trigger) : '')}
                  <div class="fires"><b class="kw">FIRES FROM</b> {triggerWords(row.site.trigger)}</div>
                {/if}
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>Open as a flow →</a>{/if}
          </div>
        {/snippet}</VirtualList>
      {:else}
        <div class="head">
          <div>
            <div class="big">What happens from <span class="mono">{payload.anchor.name}</span></div>
            <a class="sub" href={symbolHref(payload.anchor.id)}>
              <KindGlyph kind={payload.anchor.kind} />
              {payload.anchor.qualifiedName}
            </a>
            <a class="sub dim" href={fileHref(payload.anchor.file)}>{payload.anchor.file}</a>
          </div>
        </div>
        {#if payload.ambiguous.length > 0}
          <p class="dim note">
            {payload.ambiguous.length} other symbol{payload.ambiguous.length === 1 ? '' : 's'} share this name:
            {#each payload.ambiguous as other, i (other.id)}
              {#if i > 0},{/if}
              <a href={stepsHref({ anchor: other.id })}>{other.kind} in {basename(other.file)}</a>
            {/each}
          </p>
        {/if}
        <p class="counts">
          {#each ['screen', 'trigger', 'bridge', 'event', 'store', 'effect'] as const as kind (kind)}
            {#if model.counts[kind] > 0}
              {@const words = kindWords(kind, payload.project)}
              <span><b>{model.counts[kind]}</b> {model.counts[kind] === 1 ? words[0] : words[1]}</span>
            {/if}
          {/each}
        </p>
        {#if payload.steps.length === 1 && payload.truncated.steps === 0 && payload.truncated.hubs === 0}
          <!-- A lone anchor is an answer, not an empty canvas: say what the walk looked for. -->
          <p>
            Nothing this sets in motion is a step the picture draws — no reply, database, queue, network or
            other {kindWord('screen', payload.project)} within {payload.depth} calls. Calls between plain functions
            fold into the lines between steps, so a helper that only computes is drawn alone.
            {#if payload.anchor}<a href={symbolHref(payload.anchor.id)}>Its callers and callees →</a>{/if}
          </p>
        {/if}
        {#if readAs === 'order'}
          <p class="dim">
            <span class="mark">●</span> The anchor is at the top, and each row down is what happens next: a line
            means <b>and then</b>. Where the code forks both ways, a small box asks the condition once and each
            line out of it answers — <span class="mono">yes</span>, <span class="mono">no</span>, a case; a lone
            guard rides its line as <span class="mono">WHEN</span>. A call written inside another call's arguments
            happens first — the token is signed before the reply that carries it — and an arm that answers,
            returns or throws simply has nothing leaving it. Click a step for its sites and the whole condition; a
            step is the next anchor.
          </p>
        {:else}
          <p class="dim">
            <span class="mark">●</span> The anchor is at the top; each row down is one more step away from
            it. Click a step and each of its links is labelled at the far end of its line with the last
            condition checked before it happens; hover the line, or its row here, for the whole chain and the
            plumbing it travels through. A step is the next anchor, and any link opens as a Flow strip.
          </p>
        {/if}
        {#if payload.truncated.steps > 0 || payload.truncated.hubs > 0 || payload.truncated.chrome > 0}
          <p class="dim">
            Not drawn:
            {#if payload.truncated.steps > 0}<b>{payload.truncated.steps}</b> step{payload.truncated.steps === 1 ? '' : 's'} past the picture’s size limit;{/if}
            {#if payload.truncated.hubs > 0}<b>{payload.truncated.hubs}</b> walk{payload.truncated.hubs === 1 ? '' : 's'} that reached a hub;{/if}
            {#if payload.truncated.chrome > 0}<b>{payload.truncated.chrome}</b> into shared chrome.{/if}
          </p>
        {/if}
        <h4>Most connected</h4>
        {#each [...payload.steps].sort((a, b) => (model.layout.nodes.find((n) => n.id === b.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === b.id)?.ports.bottom.length ?? 0) - ((model.layout.nodes.find((n) => n.id === a.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === a.id)?.ports.bottom.length ?? 0))).slice(0, 8) as step (step.id)}
          <button class="peer mono" onclick={() => (selected = step.id)}>{model.nodes.get(step.id)?.label ?? step.label} <span class="dim sans">{kindWord(step.kind, payload.project, step)}</span></button>
        {/each}
      {/if}
    </aside></DetailPanel>
  {/if}
</div>

</div>

<style>
  .retry-banner{position:absolute;top:60px;left:12px;right:12px;z-index:12;background:var(--paper-2);border:1px solid var(--rule);padding:10px;font:12px var(--sans)}
  .graph-shell{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden}
  .scopebar{flex:none}
  .scopebar{display:flex;align-items:center;flex-wrap:wrap;gap:12px;padding:10px 16px;border-bottom:1px solid var(--rule);background:var(--paper-2);font:14px var(--sans)}
  .scopebar label{display:flex;align-items:center;gap:5px}.scopebar select,.scopebar button{min-height:36px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);font:inherit;padding:4px}

  .steps {
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
  .chooser {
    max-width: 720px;
    overflow: auto;
    height: 100%;
    box-sizing: border-box;
  }
  .chooser-list {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0;
    margin-top: 12px;
    border-top: 1px solid var(--rule-soft);
  }
  /* A router file heading over its endpoints; the list under it keeps its own top rule. */
  .group-h {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 12px;
    margin-top: 18px;
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .group-h + .chooser-list {
    margin-top: 6px;
  }
  .pick {
    display: block;
    padding: 7px 8px;
    border-bottom: 1px solid var(--rule-soft);
    color: var(--ink);
    text-decoration: none;
    font-size: 12.5px;
  }
  .pick:hover {
    background: var(--press);
  }
  .tip {
    position: absolute;
    z-index: 5;
    width: 400px;
    padding: 8px 10px;
    border: 1px solid var(--route-main);
    background: var(--paper-2);
    box-shadow: inset 3px 0 0 var(--route-main);
    font-size: 12px;
    pointer-events: none;
    /* A call with its arguments is one long token: it wraps inside the box. */
    overflow-wrap: anywhere;
  }
  .tip .mono,
  .tip .when,
  .tip .via,
  .tip .fires {
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
    /* An effect's label is a call with its arguments — one long token. */
    overflow-wrap: anywhere;
  }
  .sub {
    display: flex;
    align-items: center;
    gap: 5px;
    margin-top: 3px;
    color: var(--ink-2);
    text-decoration: none;
  }
  a.sub:hover {
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
  .counts {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 12px;
    color: var(--ink-2);
  }
  h4 {
    margin: 16px 0 6px;
    font: 600 12.5px var(--sans);
  }
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
  /* The chain a hop travels through — the answer to "where on the screen": read, not dim. */
  .via {
    color: var(--ink-2);
    font: 400 11.5px var(--mono);
    margin-top: 2px;
  }
  .via.dim {
    color: var(--ink-3);
    font-size: 11px;
  }
  .fires {
    color: var(--ink);
    font: 400 11.5px var(--mono);
    margin-top: 2px;
  }
  .ways {
    font: 500 11px var(--sans);
    margin-top: 6px;
  }
  /* One scenario per row under a link: its own tail of conditions, then its site. */
  .scenario.many {
    margin: 4px 0 0 8px;
    padding-left: 8px;
    border-left: 1px solid var(--rule-soft);
  }
  .site {
    display: block;
    font: 400 11px var(--mono);
    margin-top: 2px;
    color: var(--ink-2);
    text-decoration: none;
    overflow-wrap: anywhere;
  }
  /* A response's status code leads its row: the number is the fact. */
  .status {
    color: var(--ink);
    font-weight: 600;
  }
  a.site:hover {
    text-decoration: underline;
  }
  .mono {
    font-family: var(--mono);
  }
  .sans {
    font-family: var(--sans);
  }
  .dim {
    color: var(--ink-3);
  }
  .mark {
    color: var(--route-main);
  }
</style>
