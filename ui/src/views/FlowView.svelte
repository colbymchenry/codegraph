<!--
  The Flow strip (`#/flow`, design spec §3.5): how one symbol reaches another,
  as one card per hop, each opened at the line that makes the next call.

  The path is not computed here and is not computed by the server either — it
  comes from `resolveNamedSymbolFlow`, the search `codegraph_explore` leads its
  answers with. That is deliberate: a viewer that drew a different path from the
  one the MCP tool describes would get the two quoted against each other in a
  review, and one of them would be wrong.

  G6 draws it, for pan, zoom and fit and nothing else: positions come
  from `buildFlowLayout`, the flow picker is local state, and nothing is
  draggable. Clicking a card opens the Symbol view with the trail set to the
  path so far, so the strip hands the reader off to the view that goes deep.
-->
<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { graphStatus } from '../lib/graph-status.svelte';
  import { readGraphHistory, saveGraphHistory } from '../lib/graph-history';
  import BudgetNotice from '../components/graph/BudgetNotice.svelte';
  import { graphText } from '../lib/graph-copy';
  import SymbolPicker from '../components/graph/SymbolPicker.svelte';
  import { untrack } from 'svelte';
  import { graphBudget } from '../lib/graph-budget';
  import { requestLayout } from '../lib/graph-layout';
  import GraphCanvas from '../components/graph/GraphCanvas.svelte';
  import { graphScene } from '../lib/graph-adapters';
  import type { Node, Edge, GraphController } from '../lib/graph-scene';
  import FlowCard from '../components/flow/FlowCard.svelte';
  import FlowEndCap from '../components/flow/FlowEndCap.svelte';
  import ExportButtons from '../components/ExportButtons.svelte';
  import { exportFilename } from '../lib/export-svg';
  import { fetchFlow, type WireFlow, type WireFlowPayload } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { navigate, symbolHref, flowHref } from '../lib/navigation';
  import { trail, encodeTrail, type TrailHop } from '../lib/trail.svelte';
  import { decodeTrail } from '../lib/trail-codec';
  import { type FlowCardLayout, type FlowLayout } from '../lib/flow-model';
  import { basename } from '../lib/symbol-model';

  interface Props {
    from: string | null;
    to: string | null;
    symbols: string | null;
    /** An encoded trail, when the flow is the reader's own walk. */
    trailParam: string | null;
  }

  let { from, to, symbols, trailParam }: Props = $props();

  let visibleCounts = $state<{nodes:number;edges:number}|null>(null);
  let payload = $state<WireFlowPayload | null>(null);
  let retry = $state(0);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let picked = $state<string | null>(null);
  /** True when the picker is on "All paths" — the union is drawn as a DAG. */
  let showAll = $state(false);

  let fromChoice = $state('');
  let toChoice = $state('');
  $effect(() => { fromChoice = from ?? ''; toChoice = to ?? ''; });

  const ALL = 'all-paths';

  /**
   * The strip opens at 1:1, top left — it never fits itself to the window.
   *
   * Fitting an eight-hop flow into a laptop's width lands at about 0.38 zoom,
   * which is a picture of eight grey rectangles: the source inside them is the
   * answer, and source you cannot read is not an answer. So the reader arrives
   * at the first card, full size, and pans. The Controls' fit button is still
   * there for anyone who wants the shape rather than the code.
   */

  /** The hops the trail form asks for, as `<dir><id>` — the wire's own spelling. */
  const trailHops = $derived<TrailHop[]>(trailParam ? decodeTrail(trailParam) : []);

  $effect(() => {
    void retry;
    const spec = trailParam
      ? { trail: trailHops.map((h) => `${h.dir === 'start' ? 's' : h.dir === 'up' ? 'u' : 'd'}${h.id}`) }
      : symbols
        ? { symbols }
        : { from: from ?? '', to: to ?? '' };
    if (!trailParam && !symbols && !(from && to)) {
      payload = null;
      loading = false;
      error = null;
      return;
    }
    // Re-run when the index moves: a path is a walk over edges that a sync can
    // add, remove or re-route, and a strip drawn from the previous graph would
    // disagree with `codegraph_explore` about the same question.
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    error = null;
    const keep = untrack(() => picked);
    fetchFlow(spec, controller.signal)
      .then((next) => {
        if (controller.signal.aborted) return;
        payload = next;
        // A refresh keeps the reader's chosen path when it survived the sync.
        picked = next.flows.some((f) => f.id === keep) ? keep : (next.flows[0]?.id ?? null);
        loading = false;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        error = err instanceof Error ? err.message : String(err);
        loading = false;
      });
    return () => controller.abort();
  });

  const flows = $derived<WireFlow[]>((payload?.flows ?? []).slice(0, 4));
  const shown = $derived<WireFlow[]>(
    showAll ? flows : flows.filter((f) => f.id === picked).slice(0, 1)
  );
  let layout = $state<FlowLayout | null>(null);
  let layoutPending = $state(false);
  const localBudget = $derived(graphBudget(new Set(shown.flatMap(f => f.hops.map(h => h.node.id))).size + shown.reduce((n,f) => n + (f.boundary ? 1 : 0), 0), shown.reduce((n,f) => n + f.hops.length, 0)));
  const budget = $derived((payload as (typeof payload & { budget?: { nodes: number; edges: number; exceeded: boolean } }))?.budget ?? localBudget);
  $effect(() => {
    const next = shown; const options = { picked };
    if (!next.length || budget.exceeded) { layout = null; layoutPending = false; return; }
    layoutPending = true;
    return requestLayout<FlowLayout>('flow', $state.snapshot(next), options, result => { layout = result; layoutPending = false; }, message => { error = message; layoutPending = false; });
  });
  const activeFlow = $derived(flows.find((f) => f.id === picked) ?? flows[0] ?? null);

  const nodes = $derived.by<Node[]>(() => {
    if (layout === null) return [];
    const caps: Node[] = layout.endCaps.map((cap) => ({
      id: cap.id,
      type: 'cap',
      position: { x: cap.x, y: cap.y },
      draggable: false,
      selectable: false,
      connectable: false,
      data: {
        cap,
        dimmed: showAll && picked !== null && !cap.flows.includes(picked),
        onOpen: openNode,
      },
    }));
    // Caps first, so a card that overlaps one paints on top of it.
    return [
      ...caps,
      ...layout.cards.map((card) => ({
        id: card.id,
        type: 'flow',
        position: { x: card.x, y: card.y },
        draggable: false,
        selectable: false,
        connectable: false,
        data: {
          // The accent border marks the picked path, and only means something
          // when there is more than one on screen. A single flow whose every
          // card is accented has said nothing.
          card,
          current: showAll && card.step >= 0,
          dimmed: showAll && card.step < 0,
          onOpen: openCard,
          onFollow: followCard,
        },
      })),
    ];
  });

  const edges = $derived.by<Edge[]>(() => {
    if (layout === null) return [];
    return layout.links.map((link) => ({
      id: link.id,
      source: link.source,
      target: link.target,
      sourceHandle: 'out',
      targetHandle: 'in',
      type: 'flow',
      selectable: false,
      deletable: false,
      data: { link, dimmed: showAll && picked !== null && !link.flows.includes(picked) },
    }));
  });

  /**
   * Open a card in the Symbol view with the trail set to the path so far.
   *
   * The prefix, not the whole flow: the reader is standing at that hop, and a
   * trail that ran on past them would claim a walk they had not taken.
   */
  function openCard(card: FlowCardLayout): void {
    const hops = activeFlow?.hops ?? [];
    const at = hops.findIndex((hop) => hop.node.id === card.id);
    const prefix = at >= 0 ? hops.slice(0, at + 1) : [];
    trail.clear();
    prefix.forEach((hop, index) =>
      trail.push({
        id: hop.node.id,
        name: hop.node.name,
        kind: hop.node.kind,
        dir: index === 0 ? 'start' : hop.edge?.upward ? 'up' : 'down',
      })
    );
    if (prefix.length === 0) {
      trail.push({ id: card.id, name: card.hop.node.name, kind: card.hop.node.kind, dir: 'start' });
    }
    navigate(
      symbolHref(card.id, {
        trail: encodeTrail(trail.hops),
        ...(card.hop.callRef ? { line: card.hop.callRef.line } : {}),
      })
    );
  }

  /**
   * A row on the end cap: a candidate runtime target, or a continuation the
   * search refused to follow.
   *
   * It opens as a fresh start rather than as another hop, because neither is a
   * call the graph recorded — pushing one onto the trail would draw a step
   * nobody took. That is the whole reason the cap exists.
   */
  function openNode(nodeId: string): void {
    trail.clear();
    navigate(symbolHref(nodeId));
  }

  /** The accent link inside a card: step to the symbol it names. */
  function followCard(card: FlowCardLayout): void {
    const target = card.hop.callRef?.targetId;
    if (!target) return;
    const next = layout?.cards.find((c) => c.id === target);
    if (next) openCard(next);
  }

  function note(p: WireFlowPayload): string {
    if (p.query.kind === 'trail') {
      return 'Your trail, read as a flow: each card is opened at the line that carried you to the next one.';
    }
    if (p.flows.some((f) => f.partial)) {
      return 'No static path connects them. The card is where the looking stopped — a call whose target is chosen at runtime — and the cap names the form, the key and who could be on the other side.';
    }
    if (p.query.kind === 'directed') {
      return 'Every card is a call the graph recorded. A dashed link is a hop no one can see in the source — a callback, an interface, a re-render — and it names where it was wired.';
    }
    return 'The longest call path among the symbols you named, the same one codegraph_explore leads with.';
  }

  /**
   * The strip as it stands, for a PR comment or a README.
   *
   * Built from `layout` — the same object the canvas is drawing — so the image
   * cannot say something the screen does not. The caption names the path,
   * because an image pasted into a review has lost the header that did.
   */
  const exportLabel = $derived(
    showAll && flows.length > 1
      ? `all ${flows.length} paths`
      : (activeFlow?.label ?? 'flow')
  );


  const stateKey = typeof location === 'undefined' ? '' : location.href;
  const restored = untrack(() => readGraphHistory(stateKey));
  picked = restored.picked ?? null;
  showAll = restored.showAll ?? false;
  $effect(() => saveGraphHistory(stateKey, { picked, showAll }));
  $effect(() => {
    if (!payload) return;
    return graphStatus.set({ nodes: visibleCounts?.nodes ?? nodes.length, edges: visibleCounts?.edges ?? edges.length, scope: exportLabel, filter: showAll ? graphText('所有已返回路径，最多4条', 'All returned paths, at most 4') : graphText('单条路径', 'Single path'), excluded: payload.unresolved?.length ? `${payload.unresolved.length} ${graphText('未解析符号', 'unresolved symbols')}` : undefined,
      budget: budget?.exceeded ? graphText('超过画布预算，请缩小范围', 'Canvas budget exceeded; narrow scope') : '400 / 2000',
    });
  });
  let graphController = $state.raw<GraphController | null>(null);
  const canvasScene = $derived(graphScene('flow', nodes, edges, { flow: FlowCard, cap: FlowEndCap }, undefined,
    shown.map(flow => ({ id: 'path:' + flow.id, label: flow.label, members: flow.hops.map(h => h.node.id).filter(id => shown.filter(f => f.hops.some(h => h.node.id === id)).length === 1) })).filter(g => g.members.length > 1)));
  function buildSvg(scale: number): string {
    if (!graphController) throw new Error('Graph is not ready');
    return graphController.exportSvg(scale);
  }
</script>

<div class="flowview">
  <header class="fhead">
    <h1>Flow</h1>
    <SymbolPicker label={graphText('起点', 'From')} bind:value={fromChoice} />
    <button aria-label={graphText('交换起终点', 'Swap endpoints')} onclick={() => { const old = fromChoice; fromChoice = toChoice; toChoice = old; }}>⇄</button>
    <SymbolPicker label={graphText('终点', 'To')} bind:value={toChoice} />
    <button disabled={!fromChoice || !toChoice} onclick={() => navigate(flowHref({ from: fromChoice, to: toChoice }))}>{graphText('查找路径', 'Find paths')}</button>
    {#if flows.length > 0}
      <select use:selectDropdown
        aria-label="Which path to draw"
        value={showAll ? ALL : (picked ?? '')}
        onchange={(event) => {
          const value = (event.currentTarget as HTMLSelectElement).value;
          showAll = value === ALL;
          if (!showAll) picked = value;
        }}
      >
        {#each flows as flow (flow.id)}
          <option value={flow.id}
            >{flow.label}{flow.hops.length > 1 ? ` · ${flow.hops.length} hops` : ''}</option
          >
        {/each}
        {#if flows.length > 1}
          <option value={ALL}>{graphText('所有已返回路径', 'All returned paths')} ({flows.length}/4)</option>
        {/if}
      </select>
    {/if}
    {#if payload}
      <p class="note">{note(payload)}</p>
    {/if}
    {#if layout !== null}
      <ExportButtons build={buildSvg} filename={exportFilename('flow', exportLabel)} />
    {/if}
  </header>

  <div class="fstage">
    {#if error && layout}<div class="retry-banner" role="alert">{error} <button onclick={() => retry++}>{graphText('重试', 'Retry')}</button></div>{/if}
    {#if budget?.exceeded}
      <BudgetNotice nodes={budget.nodes} edges={budget.edges} />
    {:else if error !== null && layout === null}
      <div class="state">
        <h2>The flow could not be built</h2>
        <p>{error}</p><button onclick={() => retry++}>{graphText('重试', 'Retry')}</button>
      </div>
    {:else if loading && payload === null}
      <div class="state"><p class="dim">Following the calls…</p></div>
    {:else if payload === null}
      <div class="state">
        <h2>Nothing to follow yet</h2>
        <p>
          Ask for a path in the search box — “how does execute reach getFile”, or
          <span class="mono">execute -&gt; getFile</span> — or walk a trail and read it as a flow.
        </p>
      </div>
    {:else if layoutPending && layout === null}
      <div class="state" role="status"><p>{graphText('正在布局已找到的路径…', 'Laying out the returned paths…')}</p></div>
    {:else if layout === null}
      <div class="state">
        <h2>No path between them</h2>
        <p>{payload.reason}</p>
        {#if payload.query.from && payload.query.to}
          <p class="dim">
            Asked: <span class="mono">{payload.query.from}</span> to
            <span class="mono">{payload.query.to}</span>.
          </p>
        {/if}
      </div>
    {:else}
      <GraphCanvas scene={canvasScene} onVisibleChange={counts=>visibleCounts=counts} bind:controller={graphController} fitInitially={false} />
    {/if}
  </div>

  {#if payload && (payload.reason !== null || payload.ambiguous.length > 0 || payload.unresolved.length > 0) && layout !== null}
    <footer class="fnote">
      {#if payload.reason !== null}
        <p>{payload.reason}</p>
      {/if}
      {#each payload.ambiguous as amb (amb.token)}
        <p>
          <span class="mono">{amb.token}</span> names {amb.others.length + 1} definitions.
          {#if amb.chosen}
            This path runs through the one in
            <span class="mono">{basename(amb.chosen.file)}:{amb.chosen.line}</span>.
          {:else}
            None of them are on this path.
          {/if}
        </p>
      {/each}
      {#each payload.unresolved as token (token)}
        <p><span class="mono">{token}</span> names nothing in this index.</p>
      {/each}
    </footer>
  {/if}
</div>

<style>
  .retry-banner{position:absolute;top:60px;left:12px;right:12px;z-index:12;background:var(--paper-2);border:1px solid var(--rule);padding:10px;font:12px var(--sans)}
  .flowview {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  .fhead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    padding: 12px 18px;
    border-bottom: 1px solid var(--route-branch);
    gap: 12px;
    background: var(--paper-2);
  }

  .fhead h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    padding-left: 8px;
    border-left: 3px solid var(--route-main);
  }

  .fhead select, .fhead button {
    min-height: 36px;
    padding: 3px 6px;
    background: var(--paper-2);
    color: var(--ink);
    border: 1px solid var(--route-branch);
    border-radius: 0;
    font: 14px var(--sans);
  }

  .note {
    max-width: 78ch;
    margin: 0;
    color: var(--ink-3);
    font-size: 12px;
  }

  .fstage {
    position: relative;
    overflow: hidden;
    background-color: var(--paper);
    background-image:
      linear-gradient(var(--route-grid) 1px, transparent 1px),
      linear-gradient(90deg, var(--route-grid) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .state {
    max-width: 52ch;
    padding: 40px;
  }
  .state h2 {
    margin: 0 0 8px;
    font-size: 15px;
    font-weight: 600;
  }
  .state p {
    margin: 0 0 8px;
    color: var(--ink-2);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .dim {
    color: var(--ink-3);
  }
  .mono {
    font-family: var(--mono);
  }

  .fnote {
    padding: 8px 18px;
    border-top: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink-2);
    font-size: 12px;
  }
  .fnote p {
    margin: 0 0 2px;
  }
</style>
