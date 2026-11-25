<script lang="ts">
  /**
   * A decision made INSIDE a box, said under it — the tree reading's answer to
   * a fork.
   *
   * In the code's order a fork sits BETWEEN steps and draws as a point of its
   * own ({@link ForkPoint}). In the tree the decision is written inside a box
   * and its arms leave that box, so the box is the decision: the condition
   * goes here, once, under it, and each line out says only which way it is.
   * Text only, taking no pointer, so hovering a line through it still works.
   */
  import type { NodeProps } from '@xyflow/svelte';
  import { joinTokens, whenTokens } from '../../lib/conditions';

  let { data }: NodeProps = $props();
  const caption = $derived(data as unknown as { label: string; width: number; dimmed: boolean });
  // The label arrives already worded and asking; the tokens are re-read here
  // only so the joins we add (NOT, AND, OR) set a little bolder, as they do
  // everywhere else conditions are shown.
  const tokens = $derived(whenTokens(caption.label.replace(/\?$/, '')));
  const plain = $derived(tokens.length === 0 || joinTokens(tokens) !== caption.label.replace(/\?$/, ''));
</script>

<div class="dcap" class:dimmed={caption.dimmed} style={`width:${caption.width}px`} title={caption.label}>
  {#if plain}{caption.label}{:else}{#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw">{t.text}</b
      >{:else}{t.text}{/if}{/each}?{/if}
</div>

<style>
  .dcap {
    box-sizing: border-box;
    font: 400 10.5px/14px var(--mono);
    color: var(--ink-2);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: center;
    pointer-events: none;
    user-select: none;
  }
  .dcap.dimmed {
    color: var(--ink-4);
  }
  .kw {
    font-weight: 600;
  }
</style>
