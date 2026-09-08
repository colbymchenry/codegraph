<script lang="ts">
  /**
   * The Steps view's key.
   *
   * The same rows for both readings, worded for the one on screen: the kinds of
   * box are the same either way, and only the last rows differ — the canvas
   * explains its lines and pills, the rail its forks and terminals. On the
   * canvas it floats over the picture, bottom left; on the rail it is the last
   * thing in the document, because a rail scrolls and an overlay would sit on
   * top of the code it is explaining.
   */
  import { kindWord, type ProjectKind } from '../../lib/steps-model';

  interface Props {
    project: ProjectKind;
    /** The reading on screen: the rail's rows, or the canvas's. */
    order: boolean;
    /** A screen's picture, laid out by region rather than by distance. */
    regions?: boolean;
    /** In the flow of a scrolling rail rather than floating over a canvas. */
    flow: boolean;
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { project, order, regions = false, flow, open, onToggle }: Props = $props();
</script>

<div class="legend" class:open class:flow>
  <button class="legend-h" onclick={() => onToggle(!open)} aria-expanded={open}>
    Key <span class="dim">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="legend-body">
      <div class="lrow">
        <span class="k-box k-anchor mono"><span class="mark">●</span>start</span>
        <span
          >{order
            ? 'Where the picture starts; below it, what it does in the code’s own order'
            : regions
              ? 'Where the picture starts; below it, the parts of the ' + kindWord('screen', project) + ', each with what happens there'
              : 'Where the picture starts; each row down is one more step away'}</span
        >
      </div>
      {#if regions && !order}
        <div class="lrow">
          <span class="k-cap mono">Name</span>
          <span
            >A region — the component that owns the boxes under its rule, a box above what it sets in motion. One line from
            the start into each region stands in for the {kindWord('screen', project)}'s whole fan-out; every other line
            draws where it leads</span
          >
        </div>
        <div class="lrow">
          <span class="k-label">no line</span>
          <span
            >A box nothing points at is the region's own doing — run on render or mount, or from a binding written inline.
            Select it and its line from the {kindWord('screen', project)} lights, with what fires it</span
          >
        </div>
      {/if}
      {#if project === 'api'}
        <div class="lrow">
          <span class="k-box mono">POST /x</span>
          <span>An endpoint — its verb and path — or a handler: a function a request, a job, an event or a schedule fires; its line says which</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>The code crosses a tier: a call into another service or a job put on a queue (⇢), or a job, an event, a message arriving (⇠)</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>A data call — a function in a store or state file</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">db</span>
          <span>A call that leaves the index: the database, the response, a queue, email, payments, a cache, auth, the network</span>
        </div>
      {:else if project === 'web'}
        <div class="lrow">
          <span class="k-box mono">/path</span>
          <span>A page, an endpoint, or a handler — a function an event, a request or a page load fires; its line says which</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>The code crosses to the server (⇢ a request, a server action) or comes back from it (⇠ a push, a stream)</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>A store action — a function in a store file</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">api</span>
          <span>A call that leaves the index: the network, the database, the response, storage, a queue, email</span>
        </div>
      {:else}
        <div class="lrow">
          <span class="k-box mono">/path</span>
          <span>A screen, or a handler — a function fired from a tap, an option, a listener; its line says the event</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>The code crosses into native (⇢ a bridge call) or comes back from it (⇠ an event)</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>A store action — a function in a store file</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">api</span>
          <span>A call that leaves the index: the network, storage, the device, telemetry</span>
        </div>
      {/if}
      {#if order}
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
          <span>And then — the step at the other end happens after this one; the plumbing between them is folded into the line</span>
        </div>
        <div class="lrow">
          <span class="k-box k-fork mono">x?</span>
          <span>A decision both of whose ways are drawn: the box asks the condition once and each line out answers — <span class="mono">yes</span>, <span class="mono">no</span>, a case. An arm that answers or leaves ends there</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">WHEN x</span>
          <span>A lone guard — an early exit, an <span class="mono">if</span> with one drawn side: what has to hold for the step at the other end. No label = it happens either way</span>
        </div>
        <div class="lrow">
          <span class="k-label">via x</span>
          <span>Written inside a helper drawn where it is called; <span class="mono">later</span> runs after this returns, <span class="mono">together</span> starts at once, <span class="mono">for each</span> repeats</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
          <span>Established by a synthesized hop (an event channel, a callback, a helper's return value)</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">name …</span>
          <span>Not entered: another {kindWord('screen', project)} (a chapter of its own), or a cap the walk hit — start there to see on</span>
        </div>
      {:else}
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
          <span>Leads to — the plumbing between the two is folded into the line</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
          <span>Established by a synthesized hop (an event channel, a callback, a helper's return value)</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-back" /></svg>
          <span>Goes back up the picture — leaves the top of its box, arrives at the bottom of the other</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">x? · yes</span>
          <span
            >A decision made inside a box, both of whose ways are drawn: the condition is said once under the box and
            each line out of it answers — <span class="mono">yes</span>, <span class="mono">no</span>, a case. These are
            the only lines labelled before you select anything</span
          >
        </div>
        <div class="lrow">
          <span class="k-label mono">→ …x</span>
          <span>The last condition checked before the step, beside the box at the other end of the selected step's line; ← when it arrives there. None = always</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">name …</span>
          <span>Not entered: another screen (a chapter of its own), or a cap the walk hit — start there to see on</span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
.legend {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 4;
  max-width: 400px;
  border: 1px solid var(--rule);
  background: var(--paper);
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
  stroke: var(--ink);
  stroke-opacity: 0.6;
  stroke-width: 1.5;
  fill: none;
}
.k-line.k-synth {
  stroke-dasharray: 5 3;
}
.k-line.k-back {
  stroke: var(--accent);
  stroke-opacity: 0.8;
  stroke-dasharray: 4 3;
}
.k-label {
  font-size: 10.5px;
  color: var(--ink-3);
}
.k-cap {
  font-size: 10.5px;
  color: var(--ink-3);
  border-bottom: 1px solid var(--rule-soft);
  padding-bottom: 2px;
}
.k-box {
  box-sizing: border-box;
  padding: 1px 5px;
  border: 1px solid var(--ink);
  font-size: 10.5px;
  color: var(--ink);
  line-height: 14px;
}
.k-box.k-cross {
  border-left: 3px solid var(--accent);
}
.k-box.k-store {
  background: var(--paper-2);
}
.k-box.k-effect {
  border-style: dashed;
  border-color: var(--ink-3);
}
/* The decision's point draws quieter than a step, on the canvas and here. */
.k-box.k-fork {
  border-color: var(--ink-2);
}
.k-anchor .mark {
  font-size: 8px;
  margin-right: 3px;
  vertical-align: 1px;
}
  /* On the rail the key is the document's last block, not an overlay. */
  .legend.flow {
    position: static;
    margin: 28px 0 0;
    max-width: 520px;
  }
</style>
