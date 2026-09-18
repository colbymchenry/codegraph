<script lang="ts">
  /**
   * The caption over one region of a screen's picture — the component that
   * owns the boxes under it, set small in the gap above them, with a hairline
   * spanning the region's width so the grouping reads from any zoom. Text
   * only: it takes no pointer, so hovering a line through it still works.
   */
  import type { NodeProps } from '@xyflow/svelte';

  let { data }: NodeProps = $props();
  const caption = $derived(data as unknown as { label: string; width: number });
</script>

<div class="rcap" style={`width:${caption.width}px`}>{caption.label}</div>

<style>
  .rcap {
    box-sizing: border-box;
    padding-bottom: 4px;
    border-bottom: 1px solid var(--rule-soft);
    font: 500 11px/16px var(--mono);
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
    user-select: none;
  }
</style>
