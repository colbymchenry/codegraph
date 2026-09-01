<script lang="ts">
  /**
   * One transition on the Screens view — the curve the model chose for it
   * (`trackedCurves`: the Map's cubic on a track of its own for a transition
   * down or up the picture, an arch for one along a row) and, when the model
   * placed one, a pill saying under what condition it happens. A pair with
   * several transitions draws once and counts them; the tooltip and the side
   * panel tell them apart. Dashed when every transition behind it rides a
   * synthesized hop (a helper's return value); accent-dashed when it points
   * back up the layering (Capture → Home).
   *
   * The path is drawn from the model's curve, not from the endpoints Svelte
   * Flow measured, so the line on screen is the line the labels were placed
   * on and the line the pointer is tested against. There is no hit path: the
   * view finds the line nearest the pointer (`nearestEdge`), which in a fan
   * of lines a few pixels apart is the only way to mean one of them.
   *
   * The pill is HTML in Svelte Flow's edge-label layer rather than SVG inside
   * this edge's own group. The layer sits above every edge path, so a pill is
   * never drawn under the next edge's stroke — the fate of a label that lives
   * inside one edge among thirty.
   */
  import { BaseEdge, EdgeLabel, type EdgeProps } from '@xyflow/svelte';
  import type { MapEdgeLayout } from '../../lib/map-model';
  import { pathOf, type Curve, type PillPlacement } from '../../lib/screens-model';

  let { data }: EdgeProps = $props();

  const d = $derived(
    data as unknown as {
      edge: MapEdgeLayout;
      /** The Screens view's edge info, or the Steps view's — only `synthesized` is read. */
      info: { synthesized: boolean };
      curve: Curve;
      /** One of the selected screen's, or under the pointer. */
      hot: boolean;
      /** Hot, but another of the selected screen's edges is the one in focus. */
      soft: boolean;
      /** Under the pointer, or its row in the panel is. */
      focus: boolean;
      dimmed: boolean;
      /** Where the model put the label; null draws none. */
      pill: PillPlacement | null;
      /** The whole condition, when the panel's row is hovered; replaces the pill's words. */
      full: string | null;
      onHover: (edge: MapEdgeLayout | null, event: MouseEvent | null) => void;
    }
  );

  const path = $derived(pathOf(d.curve));
  const classes = $derived(
    `sedge${d.edge.back ? ' back' : ''}${d.info.synthesized ? ' synth' : ''}${d.hot ? ' hot' : ''}${
      d.soft ? ' soft' : ''
    }${d.focus ? ' focus' : ''}${d.dimmed ? ' dimmed' : ''}`
  );
</script>

<BaseEdge {path} class={classes} style={`stroke-width:${Math.min(3, d.edge.width)}px`} />
{#if d.pill !== null}
  <EdgeLabel
    x={d.pill.x}
    y={d.pill.y}
    transparent
    class="spill-anchor"
    onmousemove={(event) => d.onHover(d.edge, event)}
    onmouseleave={() => d.onHover(null, null)}
  >
    <span class="spill" class:hot={d.hot} class:focus={d.focus} class:full={d.full !== null}>
      {d.full ?? d.pill.text}
    </span>
  </EdgeLabel>
{/if}

<style>
  :global(.svelte-flow__edge-path.sedge) {
    stroke: var(--ink);
    stroke-opacity: 0.32;
    fill: none;
  }
  :global(.svelte-flow__edge-path.sedge.synth) {
    stroke-dasharray: 5 3;
  }
  :global(.svelte-flow__edge-path.sedge.back) {
    stroke: var(--accent);
    stroke-opacity: 0.6;
    stroke-dasharray: 4 3;
  }
  :global(.svelte-flow__edge-path.sedge.hot) {
    stroke-opacity: 0.95;
  }
  :global(.svelte-flow__edge-path.sedge.back.hot) {
    stroke-opacity: 0.85;
  }
  /* Another of the selected screen's lines is in focus: this one recedes,
     without going, so the reader can still count them. */
  :global(.svelte-flow__edge-path.sedge.hot.soft) {
    stroke-opacity: 0.38;
  }
  :global(.svelte-flow__edge-path.sedge.focus) {
    stroke-opacity: 1;
  }
  :global(.svelte-flow__edge-path.sedge.dimmed) {
    stroke-opacity: 0.06;
  }
  /* The label layer's own box: no padding of its own, so the pill's
     rectangle is the one the lane arithmetic reserved. */
  :global(.svelte-flow__edge-label.spill-anchor) {
    padding: 0;
    line-height: 0;
    font-size: 0;
  }
  .spill {
    display: inline-block;
    box-sizing: border-box;
    height: 17px;
    padding: 0 5px;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink-2);
    font: 400 10.5px var(--mono);
    line-height: 15px;
    white-space: nowrap;
    cursor: crosshair;
  }
  .spill.hot {
    border-color: var(--ink-3);
    color: var(--ink);
  }
  .spill.focus {
    border-color: var(--ink);
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.18);
  }
  /* The whole condition, for the row under the pointer in the panel: it may
     wrap, and it may cover its neighbours — it is on top, and transient. */
  .spill.full {
    height: auto;
    max-width: 360px;
    padding: 2px 6px;
    line-height: 13px;
    white-space: normal;
    text-align: left;
    overflow-wrap: anywhere;
  }
</style>
