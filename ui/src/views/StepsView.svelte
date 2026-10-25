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
  import { SvelteFlow, Controls, type Node, type Edge, type Viewport } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import StepNode from '../components/steps/StepNode.svelte';
  import StepStubs from '../components/steps/StepStubs.svelte';
  import ForkPoint from '../components/steps/ForkPoint.svelte';
  import DecisionCaption from '../components/steps/DecisionCaption.svelte';
  import RegionCaption from '../components/steps/RegionCaption.svelte';
  import StepsKey from '../components/steps/StepsKey.svelte';
  import ScreenEdge from '../components/screens/ScreenEdge.svelte';
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
  import { live } from '../lib/live.svelte';
  import { fileHref, flowHref, navigate, stepsHref, symbolHref } from '../lib/navigation';
  import type { MapEdgeLayout } from '../lib/map-model';
  import { hoverPill, nearestEdge, placeLabels } from '../lib/screens-model';
  import { commonTokens, conditionTokens, restTokens, scenarios, whenWords, type WordToken } from '../lib/conditions';
  import {
    buildStepsModel,
    kindWord,
    kindWords,
    selectionReach,
    stepEdgeVisible,
    stepNeighbourhood,
    stepPairId,
    stepViaText,
    triggerWords,
    type StepsModel,
  } from '../lib/steps-model';
  import { buildOrderModel } from '../lib/program-model';
  import { t } from '../lib/locale.svelte';

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

  let payload = $state<WireStepsPayload | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let selected = $state<string | null>(null);
  let hovered = $state<{ edge: MapEdgeLayout; x: number; y: number } | null>(null);
  /** The panel row under the pointer: its edge on the canvas, and the one link it names. */
  let panelHot = $state<{ edge: string; link: WireStepLink } | null>(null);
  let stage = $state<HTMLDivElement | null>(null);
  let viewport = $state<Viewport | undefined>(undefined);
  const HOVER_REACH = 10;

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

  const nodeTypes = { step: StepNode, region: RegionCaption, fork: ForkPoint, decision: DecisionCaption, stubs: StepStubs };

  /** Two clicks on one box closer than this are a double-click. */
  const DOUBLE_CLICK_MS = 400;
  let lastClick: { id: string; at: number } | null = null;
  /** Start the picture at a step — the panel's *Start here →*. False for a step with no symbol, or the anchor. */
  function startHere(id: string): boolean {
    const step = model?.nodes.get(id)?.step;
    if (!step || !step.node || step.anchor) return false;
    navigate(stepsHref({ anchor: step.node.id }));
    return true;
  }
  const edgeTypes = { screen: ScreenEdge };
  const DEPTHS = [4, 6, 8, 10, 12];

  const asked = $derived(anchor !== null || symbol !== null);
  const supported = canDrawSteps();

  $effect(() => {
    void live.indexTick;
    const request =
      anchor !== null
        ? { anchor, depth: depth ?? undefined, through }
        : symbol !== null
          ? { symbol, depth: depth ?? undefined, through }
          : null;
    const controller = new AbortController();
    selected = null;
    hovered = null;
    panelHot = null;
    if (request === null) {
      payload = null;
      loading = false;
      error = null;
      fetchScreens(controller.signal)
        .then(async (next) => {
          screens = next.routed ? next.screens : [];
          // No screens: an API's endpoints are its places to start from.
          if (next.routed) {
            routes = [];
            return;
          }
          const found = await fetchRoutes({ limit: 300 }, controller.signal);
          routes = found.routed ? found.entries : [];
        })
        .catch(() => {
          screens = screens ?? [];
          routes = routes ?? [];
        });
      return () => controller.abort();
    }
    loading = true;
    error = null;
    fetchSteps(request, controller.signal)
      .then((next) => {
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
  const model = $derived<StepsModel | null>(
    payload === null ? null : (readAs === 'order' ? buildOrderModel(payload) : null) ?? buildStepsModel(payload)
  );
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
  const fitOptions = $derived(
    model !== null && model.layout.nodes.length <= 24 && legendOpen
      ? { padding: { left: '440px', top: '32px', right: '32px', bottom: '32px' } as const, maxZoom: 1, minZoom: 0.4 }
      : { padding: 0.1, maxZoom: 1, minZoom: model !== null && model.regions !== null ? 0.2 : 0.4 }
  );

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
      data: { label: zone.label, width: zone.width },
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
        data: { label: d.label, width: d.width, dimmed: neighbours !== null && !neighbours.has(owner) },
      });
    }
    // A box's far links, said in words in the gap under it. Not while it is
    // selected: then every one of its real lines is drawn, and the words would
    // be saying a second time what the reader can now see.
    for (const node of model.layout.nodes) {
      const list = model.stubs.get(node.id);
      if (list === undefined || list.length === 0 || selected === node.id) continue;
      captions.push({
        id: `stubs:${node.id}`,
        type: 'stubs',
        position: { x: node.x, y: node.y + node.height },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          stubs: list,
          width: node.width,
          dimmed: neighbours !== null && !neighbours.has(node.id),
        },
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
            // Two clicks on the same box within a beat are a double-click:
            // the picture starts there. Read here rather than off the DOM's
            // `dblclick`, which the flow canvas does not always pass on.
            const now = performance.now();
            if (lastClick !== null && lastClick.id === id && now - lastClick.at < DOUBLE_CLICK_MS) {
              lastClick = null;
              if (startHere(id)) return;
            }
            lastClick = { id, at: now };
            selected = selected === id ? null : id;
            hovered = null;
            panelHot = null;
          },
          // Double-click: the picture starts here — an endpoint or another
          // screen drawn as a boundary opens as its own chapter. An effect has
          // no symbol to start from.
          ...(model.nodes.get(node.id)?.step.node && !model.nodes.get(node.id)?.step.anchor ? { onStart: startHere } : {}),
        },
      };
    }));
  });

  const edges = $derived.by<Edge[]>(() => {
    if (model === null) return [];
    const focus = focusId;
    return model.layout.edges
      .filter((edge) => stepEdgeVisible(model, edge, selected, reach ?? undefined))
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
  const edgeById = $derived(
    model === null ? new Map<string, MapEdgeLayout>() : new Map(model.layout.edges.map((e) => [e.id, e]))
  );
  const visibleIds = $derived(new Set(edges.map((e) => e.id)));

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

  function onStageMove(event: MouseEvent): void {
    if (model === null || stage === null) return;
    const target = event.target as Element | null;
    if (target?.closest('.spill')) return;
    if (target?.closest('.snode, .legend, .tip, .svelte-flow__controls')) {
      hovered = null;
      return;
    }
    const view = viewport ?? readViewport();
    if (!view) return;
    const box = stage.getBoundingClientRect();
    const point = {
      x: (event.clientX - box.left - view.x) / view.zoom,
      y: (event.clientY - box.top - view.y) / view.zoom,
    };
    const hit = nearestEdge(model, point, visibleIds, HOVER_REACH / view.zoom);
    const edge = hit === null ? undefined : edgeById.get(hit.id);
    if (!edge) {
      hovered = null;
      return;
    }
    hovered = {
      edge,
      x: Math.min(event.clientX - box.left + 14, box.width - 420),
      y: event.clientY - box.top + 14,
    };
  }

  function readViewport(): Viewport | null {
    const el = stage?.querySelector<HTMLElement>('.svelte-flow__viewport');
    const m = el?.style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/);
    return m ? { x: Number(m[1]), y: Number(m[2]), zoom: Number(m[3]) } : null;
  }

  function onRowHover(link: WireStepLink | null): void {
    const edge = link === null ? null : stepPairId(link);
    panelHot = link === null || edge === null ? null : { edge, link };
  }

  /** The words a panel row puts on its line: the arrow, and the whole condition. */
  function fullText(link: WireStepLink): string {
    const arriving = selected !== null && link.to === selected && link.from !== selected;
    return `${arriving ? '←' : '→'} ${whenWords(link.when) || t('scr.whenAlways')}`;
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
</script>

{#snippet words(tokens: WordToken[])}
  {#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b>{:else}{t.text}{/if}{/each}
{/snippet}

<div class="steps">
  <div class="stage" bind:this={stage} role="presentation" onmousemove={onStageMove} onmouseleave={() => (hovered = null)}>
    {#if !supported}
      <div class="state">
        <h2>{t('step.cannotDraw')}</h2>
        <p>{t('step.notWired')}</p>
      </div>
    {:else if !asked}
      <div class="state chooser">
        <h2>{t('step.whatFromWhere')}</h2>
        {#if chooser === 'routes'}
          <p>
            {t('step.pickEndpointBefore')}
            <i>{t('step.whatHere')}</i>.
          </p>
        {:else}
          <p>
            {t('step.pickScreenBefore')}
            <i>{t('step.whatHere')}</i>.
          </p>
        {/if}
        {#if chooser === null}
          <p class="dim">{screens === null ? t('step.readingScreens') : t('step.readingEndpoints')}</p>
        {:else if chooser === 'none'}
          <p class="dim">
            {t('step.noEndpointsBefore')}
            <i>{t('step.whatHere')}</i>
            {t('step.noEndpointsAfter')}
            <span class="mono">#/steps?symbol=&lt;name&gt;</span>.
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
    {:else if error !== null}
      <div class="state">
        <h2>{t('step.buildError')}</h2>
        <p>{error}</p>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">{t('step.walking')}</p></div>
    {:else if model !== null && payload !== null && readAs === 'order' && !orderReadable}
      <div class="state">
        <h2>{t('step.noOrderTitle')}</h2>
        <p>{t('step.noOrderBody')}</p>
        <p><a class="pick" href={rewrite({ view: 'tree' })}>{t('step.whatItSets')}</a></p>
      </div>
    {:else if model !== null && payload !== null}
      <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        {edgeTypes}
        fitView
        fitViewOptions={fitOptions}
        bind:viewport
        minZoom={0.2}
        maxZoom={3}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
        onpaneclick={() => {
          selected = null;
          hovered = null;
          panelHot = null;
        }}
      >
        <Controls position="bottom-right" showLock={false} />
      </SvelteFlow>


      {#if hovered !== null && hoveredInfo !== null}
        <div class="tip" style={`left:${hovered.x}px;top:${hovered.y}px`}>
          <div class="mono"><b>{nameOf(hoveredInfo.from)}</b> → {nameOf(hoveredInfo.to)}</div>
          {#each hoveredInfo.links.slice(0, 5) as link (link.id)}
            <div class="tiprow">
              {#if link.trigger}<span class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(link.trigger)} <span class="dim">{t('step.in')} {link.trigger.in}</span></span>{/if}
              {#if link.via.length > 0}<span class="via">{t('step.via', { via: stepViaText(link) })}</span>{/if}
              {#if link.within}<span class="dim">{t('step.inside', { name: link.within })}</span>{/if}
              {#if link.sites.length > 1}<span class="dim">{t('step.ways', { n: link.sites.length })}</span>{/if}
              <span class="when">{@render words(conditionTokens(link.when))}</span>
              {#if link.label}<span class="dim">{link.label}</span>{/if}
              {#if link.sites[0]}<span class="mono">{#if link.sites[0].status}<b class="status">{link.sites[0].status}</b> · {/if}{siteWords(link.sites[0])}</span>{/if}
            </div>
          {/each}
          {#if hoveredInfo.links.length > 5}<div class="dim">{t('step.more', { n: hoveredInfo.links.length - 5 })}</div>{/if}
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
    <aside class="side">
      {#if selectedInfo !== null && lists !== null}
        <div class="head">
          <div>
            <div class="mono big">{selectedInfo.label}</div>
            <div class="sub dim">{kindWord(selectedInfo.step.kind, payload.project, selectedInfo.step)}{#if selectedInfo.step.anchor} {t('step.whereStarts')}{/if}</div>
            {#if selectedInfo.step.trigger}
              <div class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(selectedInfo.step.trigger)} <span class="dim">{t('step.in')} {selectedInfo.step.trigger.in}</span></div>
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
                {selectedInfo.step.effect.by.name} · {t('step.line')} {selectedInfo.step.effect.line}
              </a>
            {/if}
            {#if selectedInfo.step.node}
              <a class="sub dim" href={fileHref(selectedInfo.step.node.file)}>{selectedInfo.step.node.file}</a>
            {/if}
            {#if selectedInfo.step.node && !selectedInfo.step.anchor}
              <a class="sub act" href={stepsHref({ anchor: selectedInfo.step.node.id })}>{t('step.startHere')}</a>
            {/if}
          </div>
          <button class="clear" onclick={() => (selected = null)}>{t('step.clear')}</button>
        </div>
        {#if selectedInfo.step.cut === 'screen'}
          <p class="dim note">{t('step.cutScreen', { kind: kindWord('screen', payload.project, selectedInfo.step), kids: kindWords('screen', payload.project)[1] })}</p>
        {:else if selectedInfo.step.cut === 'component'}
          <p class="dim note">{t('step.cutComponent')}</p>
        {:else if selectedInfo.step.cut !== null}
          <p class="dim note">
            {t('step.cutGeneric', { reason: selectedInfo.step.cut === 'depth'
              ? t('step.cutDepth')
              : selectedInfo.step.cut === 'fan-out'
                ? t('step.cutFanout')
                : selectedInfo.step.cut === 'folded'
                  ? t('step.cutFolded')
                  : t('step.cutSize') })}
          </p>
        {/if}
        {#if selectedInfo.step.effect && selectedInfo.step.effect.apis.length > 1}
          <p class="dim note mono">{selectedInfo.step.effect.apis.join(' · ')}</p>
        {/if}
        {#if selectedInfo.step.effect?.category === 'response'}
          <p class="dim note">{selectedInfo.step.effect.statuses?.length ? t('step.responseStated') : t('step.responseUnstated')}</p>
        {/if}
        {#if selectedInfo.step.events && selectedInfo.step.events.length > 1}
          <p class="dim note mono">⇠ {selectedInfo.step.events.join(' · ')}</p>
        {/if}
        {#if pills !== null && pills.hidden > 0}
          <p class="dim note">
            {t('step.hiddenConditions', {
              n: pills.hidden,
              s: pills.hidden === 1 ? '' : 's',
              each: pills.hidden === 1 ? t('scr.hiddenIt') : t('scr.hiddenEach'),
            })}
          </p>
        {/if}

        <h4>{t('step.arrivesFrom')} <span class="dim">{lists.arrivesFrom.length}</span></h4>
        {#if lists.arrivesFrom.length === 0}
          <p class="dim">{selectedInfo.step.anchor ? t('step.anchorStarts') : t('step.nothingLeads')}</p>
        {/if}
        {#each lists.arrivesFrom as link (link.id)}
            {@const sc = scenarios(link.sites)}
            {@const fallback = payload.steps.find((s) => s.id === link.from)?.node?.id ?? null}
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
            {#if link.trigger}<div class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(link.trigger)} <span class="dim">{t('step.in')} {link.trigger.in}</span></div>{/if}
            {#if link.via.length > 0}<div class="via">{t('step.via', { via: stepViaText(link) })}</div>{/if}
            {#if link.within}<div class="via dim">{t('step.inside', { name: link.within })}</div>{/if}
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{t('step.ways', { n: sc.rows.length })}</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if row.site.trigger && triggerWords(row.site.trigger) !== (link.trigger ? triggerWords(link.trigger) : '')}
                  <div class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(row.site.trigger)}</div>
                {/if}
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>{t('step.openFlow')}</a>{/if}
          </div>
        {/each}

        <h4>{t('step.leadsTo')} <span class="dim">{lists.leadsTo.length}</span></h4>
        {#if lists.leadsTo.length === 0}
          <p class="dim">
            {selectedInfo.step.kind === 'effect'
              ? t('step.outsideIndex')
              : selectedInfo.step.cut === 'screen' || selectedInfo.step.cut === 'component'
                ? t('step.notEntered')
                : t('step.nothingFollows')}
          </p>
        {/if}
        {#each lists.leadsTo as link (link.id)}
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
            {#if link.trigger}<div class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(link.trigger)} <span class="dim">{t('step.in')} {link.trigger.in}</span></div>{/if}
            {#if link.via.length > 0}<div class="via">{t('step.via', { via: stepViaText(link) })}</div>{/if}
            {#if link.within}<div class="via dim">{t('step.inside', { name: link.within })}</div>{/if}
            {#if sc.common.length > 0}<div class="when">{@render words(commonTokens(sc.common))}</div>{/if}
            {#if link.label}<div class="via dim">{link.label}</div>{/if}
            {#if sc.rows.length > 1}<div class="ways dim">{t('step.ways', { n: sc.rows.length })}</div>{/if}
            {#each sc.rows as row (row.site.file + row.site.line)}
              {@const href = siteHref(link, row.site, fallback)}
              <div class="scenario" class:many={sc.rows.length > 1}>
                {#if row.site.trigger && triggerWords(row.site.trigger) !== (link.trigger ? triggerWords(link.trigger) : '')}
                  <div class="fires"><b class="kw">{t('step.firesFrom')}</b> {triggerWords(row.site.trigger)}</div>
                {/if}
                {#if sc.rows.length > 1}<div class="when">{@render words(restTokens(row.rest, sc.common.length > 0))}</div>{/if}
                {#if href}
                  <a class="site" {href}>{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></a>
                {:else}
                  <span class="site">{#if row.site.status}<b class="status">{row.site.status}</b> · {/if}{siteWords(row.site)} <span class="dim">· {basename(row.site.file)}:{row.site.line}</span></span>
                {/if}
              </div>
            {/each}
            {#if stripHref(link)}<a class="site act" href={stripHref(link)}>{t('step.openFlow')}</a>{/if}
          </div>
        {/each}
      {:else}
        <div class="head">
          <div>
            <div class="big">{t('step.whatHappensFrom', { name: payload.anchor.name })}</div>
            <a class="sub" href={symbolHref(payload.anchor.id)}>
              <KindGlyph kind={payload.anchor.kind} />
              {payload.anchor.qualifiedName}
            </a>
            <a class="sub dim" href={fileHref(payload.anchor.file)}>{payload.anchor.file}</a>
          </div>
        </div>
        {#if payload.ambiguous.length > 0}
          <p class="dim note">
            {t('step.ambiguousShare', { n: payload.ambiguous.length, s: payload.ambiguous.length === 1 ? '' : 's' })}
            {#each payload.ambiguous as other, i (other.id)}
              {#if i > 0},{/if}
              <a href={stepsHref({ anchor: other.id })}>{other.kind} {t('step.in')} {basename(other.file)}</a>
            {/each}
          </p>
        {/if}
        <p class="reading">
          {t('step.readAs')}
          <a class="tab" class:on={readAs === 'order'} href={rewrite({ view: 'order' })}>{t('step.inOrder')}</a>
          <a class="tab" class:on={readAs === 'tree'} href={rewrite({ view: 'tree' })}>{t('step.whatSetInMotion')}</a>
        </p>
        <p>
          {t('step.stepsLinks', { n: payload.steps.length, m: payload.links.length })}
          <select
            class="depth"
            value={String(payload.depth)}
            onchange={(e) => navigate(rewrite({ depth: Number((e.currentTarget as HTMLSelectElement).value) }))}
          >
            {#each DEPTHS as d (d)}
              <option value={String(d)}>{d}</option>
            {/each}
            {#if !DEPTHS.includes(payload.depth)}<option value={String(payload.depth)}>{payload.depth}</option>{/if}
          </select>
        </p>
        <p>
          <label class="opt">
            <input type="checkbox" checked={payload.through} onchange={(e) => navigate(rewrite({ through: (e.currentTarget as HTMLInputElement).checked }))} />
            {t('step.continueThrough', { kids: kindWords('screen', payload.project)[1] })}
          </label>
          <span class="dim">{t('step.otherwiseBoundary', { kind: kindWord('screen', payload.project) })}</span>
        </p>
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
            {t('step.loneAnchor', { depth: payload.depth, kind: kindWord('screen', payload.project) })}
            {#if payload.anchor}<a href={symbolHref(payload.anchor.id)}>{t('step.callersCallees')}</a>{/if}
          </p>
        {/if}
        {#if readAs === 'order'}
          <p class="dim">
            <span class="mark">●</span> {t('step.orderExplain')}
          </p>
        {:else}
          <p class="dim">
            <span class="mark">●</span> {t('step.treeExplain')}
          </p>
        {/if}
        {#if payload.truncated.steps > 0 || payload.truncated.hubs > 0 || payload.truncated.chrome > 0}
          <p class="dim">
            {t('step.notDrawn')}
            {#if payload.truncated.steps > 0} <b>{payload.truncated.steps}</b> {t('step.notDrawnSteps', { s: payload.truncated.steps === 1 ? '' : 's' })}{/if}
            {#if payload.truncated.hubs > 0} <b>{payload.truncated.hubs}</b> {t('step.notDrawnHubs', { s: payload.truncated.hubs === 1 ? '' : 's' })}{/if}
            {#if payload.truncated.chrome > 0} <b>{payload.truncated.chrome}</b> {t('step.notDrawnChrome')}{/if}
          </p>
        {/if}
        <h4>{t('step.mostConnected')}</h4>
        {#each [...payload.steps].sort((a, b) => (model.layout.nodes.find((n) => n.id === b.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === b.id)?.ports.bottom.length ?? 0) - ((model.layout.nodes.find((n) => n.id === a.id)?.ports.top.length ?? 0) + (model.layout.nodes.find((n) => n.id === a.id)?.ports.bottom.length ?? 0))).slice(0, 8) as step (step.id)}
          <button class="peer mono" onclick={() => (selected = step.id)}>{model.nodes.get(step.id)?.label ?? step.label} <span class="dim sans">{kindWord(step.kind, payload.project, step)}</span></button>
        {/each}
      {/if}
    </aside>
  {/if}
</div>

<style>
  .steps {
    display: grid;
    grid-template-columns: minmax(600px, 1fr) 340px;
    height: 100%;
    min-height: 0;
  }
  .stage {
    position: relative;
    overflow: hidden;
    background: var(--paper);
  }
  .stage :global(.svelte-flow) {
    background: var(--paper);
  }
  .stage :global(.svelte-flow__handle) {
    opacity: 0;
    width: 1px;
    height: 1px;
    min-width: 0;
    min-height: 0;
    border: 0;
    pointer-events: none;
  }
  .stage :global(.svelte-flow__edge-labels) {
    pointer-events: none;
  }
  .stage :global(.svelte-flow__controls-button) {
    background: var(--paper);
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    border-radius: 0;
    color: var(--ink-2);
  }
  .stage :global(.svelte-flow__controls-button svg) {
    fill: var(--ink-2);
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
    border: 1px solid var(--ink);
    background: var(--paper);
    box-shadow: 0 4px 14px rgba(0, 0, 0, 0.18);
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
    border-left: 1px solid var(--rule);
    padding: 14px 16px;
    overflow: auto;
    font-size: 12.5px;
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
    color: var(--accent);
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
  .opt {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    cursor: pointer;
  }
  .opt input {
    margin: 0;
    accent-color: var(--accent);
  }
  .reading {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--ink-3);
  }
  .tab {
    color: var(--ink-2);
    text-decoration: none;
    border-bottom: 1px solid var(--rule-soft);
    padding-bottom: 1px;
  }
  .tab:hover {
    color: var(--ink);
    border-bottom-color: var(--ink-3);
  }
  .tab.on {
    color: var(--ink);
    font-weight: 600;
    border-bottom-color: var(--accent);
  }
  .depth {
    font: inherit;
    font-size: 12px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink);
    padding: 0 4px;
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
    transition: background 90ms linear;
  }
  .row.hot {
    background: var(--press);
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
    color: var(--accent);
  }
</style>
