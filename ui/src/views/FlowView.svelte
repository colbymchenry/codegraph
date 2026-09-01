<!--
  The Flow strip (`#/flow`, design spec §3.5): how one symbol reaches another,
  as one card per hop, each opened at the line that makes the next call.

  The path is not computed here and is not computed by the server either — it
  comes from `resolveNamedSymbolFlow`, the search `codegraph_explore` leads its
  answers with. That is deliberate: a viewer that drew a different path from the
  one the MCP tool describes would get the two quoted against each other in a
  review, and one of them would be wrong.

  Svelte Flow draws it, for pan, zoom and fit and nothing else: positions come
  from `buildFlowLayout`, the flow picker is local state, and nothing is
  draggable. Clicking a card opens the Symbol view with the trail set to the
  path so far, so the strip hands the reader off to the view that goes deep.
-->
<script lang="ts">
  import { SvelteFlow, Controls, type Node, type Edge } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';
  import FlowCard from '../components/flow/FlowCard.svelte';
  import FlowLink from '../components/flow/FlowLink.svelte';
  import FlowEndCap from '../components/flow/FlowEndCap.svelte';
  import ExportButtons from '../components/ExportButtons.svelte';
  import { exportFilename, flowSvg } from '../lib/export-svg';
  import { fetchFlow, type WireFlow, type WireFlowPayload } from '../lib/api';
  import { live } from '../lib/live.svelte';
  import { navigate, symbolHref } from '../lib/navigation';
  import { trail, encodeTrail, type TrailHop } from '../lib/trail.svelte';
  import { decodeTrail } from '../lib/trail-codec';
  import { buildFlowLayout, type FlowCardLayout, type FlowLayout } from '../lib/flow-model';
  import { basename } from '../lib/symbol-model';

  interface Props {
    from: string | null;
    to: string | null;
    symbols: string | null;
    /** An encoded trail, when the flow is the reader's own walk. */
    trailParam: string | null;
  }

  let { from, to, symbols, trailParam }: Props = $props();

  let payload = $state<WireFlowPayload | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let picked = $state<string | null>(null);
  /** True when the picker is on "All paths" — the union is drawn as a DAG. */
  let showAll = $state(false);

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
  const START_VIEWPORT = { x: 0, y: 0, zoom: 1 };
  const nodeTypes = { flow: FlowCard, cap: FlowEndCap };
  const edgeTypes = { flow: FlowLink };

  /** The hops the trail form asks for, as `<dir><id>` — the wire's own spelling. */
  const trailHops = $derived<TrailHop[]>(trailParam ? decodeTrail(trailParam) : []);

  $effect(() => {
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
    const keep = picked;
    fetchFlow(spec, controller.signal)
      .then((next) => {
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

  const flows = $derived<WireFlow[]>(payload?.flows ?? []);
  const shown = $derived<WireFlow[]>(
    showAll ? flows : flows.filter((f) => f.id === picked).slice(0, 1)
  );
  const layout = $derived<FlowLayout | null>(
    shown.length === 0 ? null : buildFlowLayout(showAll ? flows : shown, picked)
  );
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

  function buildSvg(scale: number): string {
    if (layout === null) throw new Error('There is no strip to export yet.');
    const hops = activeFlow?.hops.length ?? 0;
    return flowSvg(layout, {
      scale,
      activeFlowId: picked,
      showAll,
      caption: showAll ? exportLabel : `${exportLabel}${hops > 1 ? ` · ${hops} hops` : ''}`,
    });
  }
</script>

<div class="flowview">
  <header class="fhead">
    <h1>Flow</h1>
    {#if flows.length > 0}
      <select
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
          <option value={ALL}>All {flows.length} paths</option>
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
    {#if error !== null}
      <div class="state">
        <h2>The flow could not be built</h2>
        <p>{error}</p>
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
      <SvelteFlow
        {nodes}
        {edges}
        {nodeTypes}
        {edgeTypes}
        initialViewport={START_VIEWPORT}
        fitViewOptions={{ padding: 0.1, maxZoom: 1, minZoom: 0.2 }}
        minZoom={0.2}
        maxZoom={1.4}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        panOnDrag
        proOptions={{ hideAttribution: true }}
      >
        <Controls position="bottom-right" showLock={false} />
      </SvelteFlow>
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
  .flowview {
    display: grid;
    height: 100%;
    min-height: 0;
    grid-template-rows: auto minmax(0, 1fr) auto;
  }

  .fhead {
    display: flex;
    align-items: center;
    padding: 12px 18px;
    border-bottom: 1px solid var(--rule-soft);
    gap: 12px;
  }

  .fhead h1 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
  }

  .fhead select {
    padding: 3px 6px;
    background: var(--paper-2);
    color: var(--ink);
    border: 1px solid var(--rule-soft);
    border-radius: 0;
    font: 12.5px var(--sans);
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
    background: var(--paper);
  }

  /* Svelte Flow paints its own surface and controls; both are re-tokenised so
     the canvas belongs to the paper/ink system. Same treatment as the Map. */
  .fstage :global(.svelte-flow) {
    background: var(--paper);
  }
  .fstage :global(.svelte-flow__handle) {
    width: 1px;
    height: 1px;
    min-width: 0;
    min-height: 0;
    border: 0;
    opacity: 0;
    pointer-events: none;
  }
  .fstage :global(.svelte-flow__node) {
    cursor: default;
  }
  .fstage :global(.svelte-flow__controls) {
    border: 1px solid var(--rule-soft);
    box-shadow: none;
  }
  .fstage :global(.svelte-flow__controls-button) {
    background: var(--paper);
    border: 0;
    border-bottom: 1px solid var(--rule-soft);
    border-radius: 0;
    box-shadow: none;
    fill: var(--ink-2);
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
