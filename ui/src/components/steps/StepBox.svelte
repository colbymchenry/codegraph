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
  import { locale, t } from '../../lib/locale.svelte';

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
    onStart?: (id: string) => void;
  }
  let { info, project, selected, dimmed, size = null, note = '', onSelect, onStart }: Props = $props();
  const step = $derived(info.step);

  // `locale.current` is read here so the kind words re-render when the viewer's
  // language switches (`kindWord` itself is not reactive).
  const kindPhrase = $derived((locale.current, kindWord(step.kind, project, step)));

  const cutNote = $derived.by(() => {
    locale.current;
    switch (step.cut) {
      case 'depth':
        return t('step.boxDepth');
      case 'fan-out':
        return t('step.boxFanout');
      case 'folded':
        return t('step.boxFolded');
      case 'steps':
        return t('step.boxSizeLimit');
      case 'screen':
        return t('step.boxScreen', { kind: kindWord('screen', project, step) });
      case 'component':
        return t('step.boxComponent');
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
  ondblclickcapture={(e) => {
    // The flow canvas zooms on a double-click that reaches its pane; a
    // double-click on a box is a navigation, not a zoom — stop it here,
    // at the target, before it bubbles. The pane's own double-click keeps zooming.
    e.stopPropagation();
    onStart?.(info.id);
  }}
  aria-pressed={selected}
  title={`${info.label} — ${step.anchor ? t('step.wherePictureStarts') : ''}${kindPhrase}. ${info.sub}.${note ? ` ${note}` : ''}${cutNote}${onStart && !step.anchor ? t('step.doubleClickStart') : ''}`}
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
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    box-sizing: border-box;
    padding: 0 9px;
    border: 1px solid var(--ink);
    border-radius: 0;
    background: var(--paper);
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: var(--ink);
    transition: background 90ms linear;
  }
  /* On the rail a box sizes to its words, and wears its padding itself. */
  .snode.rail {
    align-items: flex-start;
    padding: 5px 9px;
    max-width: 100%;
  }
  .snode:hover,
  .snode.sel {
    border-width: 2px;
    padding: 0 8px;
  }
  .snode.rail:hover,
  .snode.rail.sel {
    padding: 4px 8px;
  }
  .snode:hover,
  .snode.sel {
    background: var(--press);
  }
  .snode.dimmed {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .snode.dimmed .sub {
    color: var(--ink-4);
  }
  /* The language changes under the code: a rule where it does. */
  .snode.k-bridge,
  .snode.k-event {
    border-left: 3px solid var(--accent);
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
    border-left-color: var(--accent-line);
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
    border-color: var(--ink-3);
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
    color: var(--accent);
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
