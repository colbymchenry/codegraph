<script lang="ts">
  /**
   * The results panel under the search box (design spec §3.7).
   *
   * It renders whatever `palette.view` is: the entry points when the box is
   * empty, the ranked kind groups when it is not. The keyboard lives in
   * `TopBar` (the keys are pressed in the input, not here) and arrives as the
   * `selected` index; this component's only job beyond drawing is keeping that
   * row in view when the selection moves past the panel's edge.
   */
  import PaletteRows from './PaletteRows.svelte';
  import { palette } from '../lib/palette.svelte';
  import type { PaletteItem } from '../lib/search-model';

  interface Props {
    onpick: (item: PaletteItem) => void;
  }

  let { onpick }: Props = $props();

  let panel: HTMLDivElement | null = $state(null);
  let view = $derived(palette.view);

  $effect(() => {
    const index = palette.selected;
    if (!panel) return;
    const row = panel.querySelector(`[data-palette-row="${index}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  });
</script>

<div class="panel" bind:this={panel} id="palette-panel" role="listbox" aria-label="Search results">
  {#if view.hint}
    <p class="hint">{view.hint}</p>
  {/if}

  <PaletteRows
    palette={view}
    selected={palette.selected}
    rowRole="option"
    {onpick}
    onhover={(index) => palette.select(index)}
  />

  {#if palette.failure}
    <p class="note">{palette.failure}</p>
  {:else if palette.pending && view.items.length === 0}
    <p class="note">Searching…</p>
  {:else if view.empty}
    <p class="note">{view.empty}</p>
  {/if}
</div>

<style>
  .panel {
    position: absolute;
    z-index: 40;
    top: 32px;
    right: 0;
    left: 0;
    max-height: 420px;
    overflow: auto;
    background: var(--paper);
    border: 1px solid var(--ink);
  }

  .hint {
    margin: 0;
    padding: 8px 10px;
    border-bottom: 1px solid var(--rule-faint);
    background: var(--paper-2);
    color: var(--ink-2);
    font-size: 12px;
  }

  .note {
    margin: 0;
    padding: 8px 10px;
    color: var(--ink-3);
    font-size: 12px;
  }
</style>
