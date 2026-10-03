<script lang="ts">
  /**
   * One step's box — the same box on the canvas and on the rail.
   *
   * It is the Screens view's screen box with a kind: a screen is drawn exactly
   * as there; a handler is a plain box; a native call or a native event carries
   * an accent rule on its left, where the language changes under the code — and
   * so does an endpoint the code crosses to (`⇢ POST /api/users`) or a job, an
   * event, a message arriving; a store action sits on `--paper-2`; a call that
   * leaves the index is dashed, a place the graph cannot follow into. The
   * anchor carries the entry mark. A step the walk was cut at ends its name
   * with an ellipsis, and its tooltip says which cap.
   *
   * A click selects the step; a double-click starts the picture there (the
   * panel's *Start here →*). On the canvas the box is sized by the layout; on
   * the rail it sizes to its own words.
   */
  import type { MapNodeLayout } from '../../lib/map-model';
  import { kindWord, type ProjectKind, type StepNodeInfo } from '../../lib/steps-model';

  interface Props {
    info: StepNodeInfo;
    project: ProjectKind;
    selected: boolean;
    dimmed: boolean;
    /** The canvas sizes its boxes; the rail lets them size to content. */
    size?: Pick<MapNodeLayout, 'width' | 'height'> | null;
    /** Said before the tooltip's own words — the rail says where the call is written. */
    note?: string;
    onSelect: (id: string) => void;
    /** Re-anchor the picture on this step — a double-click; absent for a step with no symbol. */
  }
  let { info, project, selected, dimmed, size = null, note = '', onSelect }: Props = $props();
  const step = $derived(info.step);

  const cutNote = $derived.by(() => {
    switch (step.cut) {
      case 'depth':
        return ' More happens past the depth of this picture — start here to see it.';
      case 'fan-out':
        return ' It reaches more than the walk follows from one node.';
      case 'folded':
        return ' The walk folded as much plumbing as it allows from one step.';
      case 'steps':
        return ' The picture reached its size limit here.';
      case 'screen':
        return ` Another ${kindWord('screen', project, step)} — a chapter of its own. Start here to see what happens on it.`;
      case 'component':
        return ' The event lands in a component of another screen — a picture of its own. Start here to see it.';
      default:
        return '';
    }
  });
</script>

<button
  class={`snode k-${step.kind}`}
  class:sel={selected}
  class:dimmed
  class:anchor={step.anchor}
  class:rail={size === null}
  style={size === null ? undefined : `width:${size.width}px;height:${size.height}px`}
  onclick={() => onSelect(info.id)}
  aria-pressed={selected}
  title={`${info.label} — ${step.anchor ? 'where this picture starts; ' : ''}${kindWord(step.kind, project, step)}. ${info.sub}.${note ? ` ${note}` : ''}${cutNote}`}
>
  <span class="name"
    >{#if step.anchor}<span class="mark" aria-hidden="true">●</span>{/if}{info.label}{#if step.cut !== null}<span
        class="more"
        aria-hidden="true"> …</span
      >{/if}</span
  >
  <span class="sub">{info.sub}</span>
</button>

<style>
  .snode {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    box-sizing: border-box;
    padding: 0 9px;
    border: 1px solid var(--rule-soft);
    border-radius: 0;
    background: var(--paper);
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: var(--ink);
    box-shadow: inset 3px 0 0 var(--route-branch);
    transition: background 150ms ease, border-color 150ms ease, box-shadow 150ms ease, color 150ms ease;
  }
  .snode::before {
    content: '';
    position: absolute;
    left: -5px;
    top: 50%;
    width: 8px;
    height: 8px;
    border: 2px solid var(--route-branch);
    border-radius: 50% !important;
    background: var(--paper);
    transform: translateY(-50%);
    transition: border-color 150ms ease, background 150ms ease;
  }
  /* On the rail a box sizes to its words, and wears its padding itself. */
  .snode.rail {
    align-items: flex-start;
    padding: 5px 9px;
    max-width: 100%;
  }
  .snode:hover,
  .snode.sel {
    border-color: var(--route-main);
    box-shadow: inset 3px 0 0 var(--route-main), 0 0 0 1px var(--route-main);
  }
  .snode.rail:hover,
  .snode.rail.sel {
    padding: 5px 9px;
  }
  .snode:hover,
  .snode.sel {
    background: var(--route-band);
  }
  .snode:hover::before,
  .snode.sel::before,
  .snode.anchor::before {
    border-color: var(--route-main);
    background: var(--route-main);
  }
  .snode.dimmed {
    border-color: var(--rule-faint);
    color: var(--ink-4);
    box-shadow: inset 3px 0 0 var(--route-muted);
  }
  .snode.dimmed::before {
    border-color: var(--route-muted);
  }
  .snode.dimmed .sub {
    color: var(--ink-4);
  }
  /* The language changes under the code: a rule where it does. */
  .snode.k-bridge,
  .snode.k-event {
    border-left: 3px solid var(--route-main);
    padding-left: 7px;
  }
  .snode.k-bridge:hover,
  .snode.k-bridge.sel,
  .snode.k-event:hover,
  .snode.k-event.sel {
    border-left-width: 3px;
    padding-left: 7px;
  }
  .snode.k-bridge.dimmed,
  .snode.k-event.dimmed {
    border-left-color: var(--route-muted);
  }
  .snode.k-store {
    background: var(--paper-2);
  }
  .snode.k-store:hover,
  .snode.k-store.sel {
    background: var(--press);
  }
  /* Outside the index: a place the graph cannot follow into. */
  .snode.k-effect {
    border-style: dashed;
    border-color: var(--route-muted);
    box-shadow: none;
  }
  .snode.k-effect:hover,
  .snode.k-effect.sel {
    border-color: var(--route-main);
    box-shadow: inset 3px 0 0 var(--route-main), 0 0 0 1px var(--route-main);
  }
  .snode:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .name {
    font: 500 13px var(--mono);
    line-height: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .mark {
    color: var(--route-main);
    margin-right: 5px;
    font-size: 9px;
    vertical-align: 1px;
  }
  .more {
    color: var(--ink-3);
  }
  .sub {
    font: 400 11px var(--sans);
    line-height: 13px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
</style>
