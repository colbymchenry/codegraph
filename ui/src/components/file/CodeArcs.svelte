<!--
  The intra-file call arcs — the left margin of the whole-file view
  (design spec §3.4, task CG-52).

  One arc per call whose callee is defined in this same file, drawn from the
  calling line to the definition line. This is the one place in the app where a
  "graph of the file" is legible, and the reason is that it is not a graph
  drawing: the nodes were placed by whoever wrote the file, in source order, and
  an arc only has to say which two lines are joined.

  Every arc gets a second, invisible, ten-pixel-wide path on top of it. A 1px
  hairline is not a click target, and the whole point of the picture is that you
  can grab one and go to the other end.
-->
<script lang="ts">
  import { hot } from '../../lib/focus.svelte';
  import { ARC_COLUMN, type FileArc } from '../../lib/filecode-model';

  interface Props {
    /** Already filtered and windowed by the view. */
    arcs: FileArc[];
    /** Height of the scrolling document — the SVG spans all of it. */
    height: number;
    /** The line under the pointer, so an arc leaving or landing on it lights. */
    hoverLine: number | null;
    onfollow: (arc: FileArc) => void;
  }

  let { arcs, height, hoverLine, onfollow }: Props = $props();

  /**
   * Accent is for the POINTER, never for the filter.
   *
   * On a crowded file the view has already narrowed the set to the focused
   * symbol's arcs; colouring those as well would light every line on screen and
   * say nothing. The spec's rule is the one that carries information: an arc
   * goes accent when its line or its callee is under the pointer.
   */
  function isLit(arc: FileArc): boolean {
    return hot.is(arc.targetId) || arc.fromLine === hoverLine || arc.toLine === hoverLine;
  }

  function label(arc: FileArc): string {
    const direction = arc.toLine < arc.fromLine ? 'above' : 'below';
    return `line ${arc.fromLine} calls ${arc.targetName}, defined ${direction} at line ${arc.toLine}`;
  }
</script>

<svg
  class="arcs"
  width={ARC_COLUMN}
  {height}
  viewBox={`0 0 ${ARC_COLUMN} ${height}`}
  focusable="false"
  aria-hidden="true"
>
  {#each arcs as arc (arc.key)}
    <path
      class="arc"
      class:lit={isLit(arc)}
      class:uncertain={arc.uncertain}
      class:heur={arc.synthesized}
      d={arc.d}
    />
    <!-- Not in the tab order, and the SVG is aria-hidden: every arc's callee is
         also a focusable rail row and a focusable call-site link in the body, so
         the picture is a redundant affordance rather than the only one. -->
    <path
      class="hit"
      d={arc.d}
      role="button"
      tabindex="-1"
      onclick={() => onfollow(arc)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onfollow(arc);
        }
      }}
      onmouseenter={() => hot.set(arc.targetId)}
      onmouseleave={() => hot.clear(arc.targetId)}
    >
      <title>{label(arc)}</title>
    </path>
  {/each}
</svg>

<style>
  .arcs {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
  }

  .arc {
    fill: none;
    stroke: var(--ink-4);
    stroke-width: 1;
    pointer-events: none;
  }

  .arc.uncertain {
    stroke-dasharray: 2 3;
  }

  /* Synthesized rather than parsed — dynamic dispatch the parser cannot see.
     Same dash the Symbol view's connectors use for the same claim. */
  .arc.heur {
    stroke: var(--ink-3);
    stroke-dasharray: 6 3;
  }

  .arc.lit {
    stroke: var(--accent);
    stroke-width: 1.5;
  }

  /* The hairline is not a click target; this is. */
  .hit {
    fill: none;
    stroke: transparent;
    stroke-width: 10;
    cursor: pointer;
  }
</style>
