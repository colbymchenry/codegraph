<!--
  The connector between two cards (design spec §3.5): an 86px hairline with a
  filled arrowhead, labelled with the edge and the line it was recorded at.

  The line style is the honesty in the picture. A solid line is a call the
  resolver read out of the source; `2 3` is a name-only match under 0.6
  confidence; `5 3` is a synthesized dynamic-dispatch bridge, and its label
  names the mechanism and the site it was wired at — a hop nobody can see in the
  source has to say where it came from.

  Straight, not curved: two cards on the same row sit at the same height, and a
  bezier between them would be a decorative wobble. The path bends only when a
  branch puts them on different rows.

  The link into an end cap is the exception with no edge behind it: `2 4` dots,
  no arrowhead, labelled "end of static path". An arrow would point at a
  continuation, and the whole point of the cap is that there isn't one.
-->
<script lang="ts">
  import { BaseEdge, type EdgeProps } from '@xyflow/svelte';
  import type { FlowLinkLayout } from '../../lib/flow-model';

  let { sourceX, sourceY, targetX, targetY, data }: EdgeProps = $props();

  const d = $derived(data as unknown as { link: FlowLinkLayout; dimmed: boolean });

  const path = $derived.by(() => {
    if (Math.abs(sourceY - targetY) < 0.5) return `M${sourceX},${sourceY} L${targetX},${targetY}`;
    const midX = (sourceX + targetX) / 2;
    return `M${sourceX},${sourceY} C${midX},${sourceY} ${midX},${targetY} ${targetX},${targetY}`;
  });

  /** The spec's `76,3 84,7 76,11` arrowhead, placed at the target's port. */
  const head = $derived(
    `${targetX - 10},${targetY - 4} ${targetX - 2},${targetY} ${targetX - 10},${targetY + 4}`
  );

  const labelX = $derived((sourceX + targetX) / 2);
  const labelY = $derived((sourceY + targetY) / 2);
  const dashStyle = $derived(d.link.dash ? `stroke-dasharray:${d.link.dash}` : '');
  /** Stacked upwards from the line, so the last clause sits nearest it. */
  const above = $derived(d.link.labelLines);
</script>

<BaseEdge {path} class={`flink${d.dimmed ? ' dimmed' : ''}`} style={dashStyle} />
{#if !d.link.cap}
  <polygon class={`fhead${d.dimmed ? ' dimmed' : ''}`} points={head} />
{/if}
<g class={`flabel${d.dimmed ? ' dimmed' : ''}`}>
  <title>{d.link.label}{d.link.lineLabel ? ` (${d.link.lineLabel})` : ''}</title>
  {#each above as line, i (i)}
    <text x={labelX} y={labelY - 8 - (above.length - 1 - i) * 13} text-anchor="middle">{line}</text>
  {/each}
  {#if d.link.lineLabel}
    <text x={labelX} y={labelY + 17} text-anchor="middle">{d.link.lineLabel}</text>
  {/if}
</g>

<style>
  :global(.svelte-flow__edge-path.flink) {
    stroke: var(--ink-3);
    stroke-width: 1px;
    fill: none;
  }
  :global(.svelte-flow__edge-path.flink.dimmed) {
    stroke-opacity: 0.25;
  }
  .fhead {
    fill: var(--ink-3);
  }
  .fhead.dimmed {
    fill-opacity: 0.25;
  }
  .flabel text {
    fill: var(--ink-3);
    font: 11px var(--mono);
  }
  .flabel.dimmed text {
    fill-opacity: 0.25;
  }
</style>
