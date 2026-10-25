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
  import { locale, t } from '../../lib/locale.svelte';

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

  // `locale.current` is read here so the kind words re-render when the viewer's
  // language switches (`kindWord` itself is not reactive).
  const screenKind = $derived((locale.current, kindWord('screen', project)));
</script>

<div class="legend" class:open class:flow>
  <button class="legend-h" onclick={() => onToggle(!open)} aria-expanded={open}>
    {t('scr.key')} <span class="dim">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="legend-body">
      <div class="lrow">
        <span class="k-box k-anchor mono"><span class="mark">●</span>start</span>
        <span
          >{order
            ? t('step.keyWhereStartsOrder')
            : regions
              ? t('step.keyWhereStartsScreen', { kind: screenKind })
              : t('step.keyWhereStartsTree')}</span
        >
      </div>
      {#if regions && !order}
        <div class="lrow">
          <span class="k-cap mono">Name</span>
          <span
            >{t('step.keyRegionBefore')}{t('step.keyRegion', { kind: screenKind })}{t('step.keyRegionAfter')}</span
          >
        </div>
        <div class="lrow">
          <span class="k-label">no line</span>
          <span>{t('step.keyNoLine', { kind: screenKind })}</span>
        </div>
      {/if}
      {#if !order}
        <div class="lrow">
          <span class="k-label mono">→ name</span>
          <span>{t('step.keyStub')}</span>
        </div>
      {/if}
      {#if project === 'api'}
        <div class="lrow">
          <span class="k-box mono">POST /x</span>
          <span>{t('step.keyEndpoint')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>{t('step.keyCrossTier')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>{t('step.keyDataCall')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">db</span>
          <span>{t('step.keyEffectApi')}</span>
        </div>
      {:else if project === 'web'}
        <div class="lrow">
          <span class="k-box mono">/path</span>
          <span>{t('step.keyPage')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>{t('step.keyCrossServer')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>{t('step.keyStoreAction')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">api</span>
          <span>{t('step.keyEffectWeb')}</span>
        </div>
      {:else}
        <div class="lrow">
          <span class="k-box mono">/path</span>
          <span>{t('step.keyScreen')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-cross mono">⇢ fn</span>
          <span>{t('step.keyCrossNative')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-store mono">set</span>
          <span>{t('step.keyStoreAction')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-effect mono">api</span>
          <span>{t('step.keyEffectApp')}</span>
        </div>
      {/if}
      {#if order}
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
          <span>{t('step.keyAndThen')}</span>
        </div>
        <div class="lrow">
          <span class="k-box k-fork mono">x?</span>
          <span>{t('step.keyFork')}</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">WHEN x</span>
          <span>{t('step.keyGuard')}</span>
        </div>
        <div class="lrow">
          <span class="k-label">via x</span>
          <span>{t('step.keyVia')}</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
          <span>{t('step.keySynth')}</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">name …</span>
          <span>{t('step.keyNotEntered', { kind: screenKind })}</span>
        </div>
      {:else}
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
          <span>{t('step.keyLeadsTo')}</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-synth" /></svg>
          <span>{t('step.keySynth')}</span>
        </div>
        <div class="lrow">
          <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-back" /></svg>
          <span>{t('step.keyBack')}</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">x? · yes</span>
          <span>{t('step.keyDecisionInside')}</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">→ …x</span>
          <span>{t('step.keyCondition')}</span>
        </div>
        <div class="lrow">
          <span class="k-label mono">name …</span>
          <span>{t('step.keyNotEntered', { kind: screenKind })}</span>
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
