<script lang="ts">
  /**
   * One dependency link on the Map (design spec §3.6).
   *
   * A cubic that leaves the source's bottom port and arrives at the target's
   * top port through the vertical midpoint, so every edge in a bundle bends the
   * same way and the crossings stay readable. Width is `min(6, 1 + log2(count)
   * x 0.7)`: a link carrying 700 edges must look heavier than one carrying 7
   * without being a hundred times fatter.
   *
   * A second, transparent, 12px-wide copy of the same path is the hit target —
   * a 1px stroke is not something anyone can hover on purpose.
   *
   * Back-edges (a mutual dependency's lighter direction, or a link with nothing
   * declared behind it) are dashed in the accent. They point *up* the layering,
   * which is exactly why they are worth marking rather than straightening out.
   */
  import { BaseEdge, type EdgeProps } from '@xyflow/svelte';
  import type { MapEdgeLayout } from '../../lib/map-model';

  let { sourceX, sourceY, targetX, targetY, data }: EdgeProps = $props();

  const d = $derived(
    data as unknown as {
      edge: MapEdgeLayout;
      hot: boolean;
      dimmed: boolean;
      onHover: (edge: MapEdgeLayout | null, event: MouseEvent | null) => void;
    }
  );

  const path = $derived.by(() => {
    const midY = (sourceY + targetY) / 2;
    return `M${sourceX},${sourceY} C${sourceX},${midY} ${targetX},${midY} ${targetX},${targetY}`;
  });
</script>

<BaseEdge
  {path}
  class={`medge${d.edge.back ? ' back' : ''}${d.hot ? ' hot' : ''}${d.dimmed ? ' dimmed' : ''}`}
  style={`stroke-width:${d.edge.width}px`}
/>
<path
  class="hit"
  d={path}
  role="presentation"
  onmousemove={(event) => d.onHover(d.edge, event)}
  onmouseleave={() => d.onHover(null, null)}
/>

<style>
  :global(.svelte-flow__edge-path.medge) {
    stroke: var(--ink);
    stroke-opacity: 0.28;
    fill: none;
  }
  :global(.svelte-flow__edge-path.medge.hot) {
    stroke-opacity: 0.95;
  }
  :global(.svelte-flow__edge-path.medge.dimmed) {
    stroke-opacity: 0.06;
  }
  :global(.svelte-flow__edge-path.medge.back) {
    stroke: var(--accent);
    stroke-opacity: 0.6;
    stroke-dasharray: 4 3;
  }
  .hit {
    stroke: transparent;
    stroke-width: 12;
    fill: none;
    pointer-events: stroke;
    cursor: crosshair;
  }
</style>
