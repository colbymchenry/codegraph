<!--
  The hairlines from a gutter port to its callee row (design spec §3.2).

  One curve per CALL SITE, not per row: a helper called from three lines gets
  three connectors into one row, which is the honest drawing — the row is the
  symbol, the curves are the calls.

  Line style carries the claim. Solid means the resolver matched it; dashed
  `2 3` means it is a name-only guess; dashed `6 3` in a lighter ink means the
  edge was synthesized rather than parsed (dynamic dispatch), so the reader can
  see at a glance which parts of the picture the parser actually saw.
-->
<script lang="ts">
  import { hot } from '../../lib/focus.svelte';
  import type { Connector } from '../../lib/symbol-model';

  interface Props {
    connectors: Connector[];
    width: number;
    height: number;
  }

  let { connectors, width, height }: Props = $props();
</script>

<svg
  class="overlay"
  {width}
  {height}
  viewBox={`0 0 ${width} ${height}`}
  aria-hidden="true"
  focusable="false"
>
  {#each connectors as connector, i (`${connector.targetId}:${i}`)}
    <path
      d={connector.d}
      class:uncertain={connector.uncertain}
      class:heur={connector.heuristic}
      class:origin={connector.origin}
      class:hot={hot.is(connector.targetId)}
    />
  {/each}
</svg>

<style>
  .overlay {
    position: absolute;
    inset: 0;
    overflow: visible;
    pointer-events: none;
  }

  path {
    fill: none;
    stroke: var(--ink-4);
    stroke-width: 1;
  }

  path.uncertain {
    stroke-dasharray: 2 3;
  }

  path.heur {
    stroke: var(--ink-3);
    stroke-dasharray: 6 3;
  }

  path.origin {
    stroke: var(--accent);
  }

  path.hot {
    stroke: var(--accent);
    stroke-width: 1.5;
  }
</style>
