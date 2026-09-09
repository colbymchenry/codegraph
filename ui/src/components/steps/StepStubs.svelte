<script lang="ts">
  /**
   * What a box leads to, and what reaches it, when the line would be too long
   * to follow — said in words under the box instead of drawn across the canvas
   * ({@link StepStub}).
   *
   * It sits in the gap under its box, takes no pointer of its own, and shows
   * the first few; a box that fires twenty things says so and keeps its size.
   * Clicking the box draws every one of its real lines, so this is the resting
   * summary, never the only way to see them.
   */
  import type { NodeProps } from '@xyflow/svelte';
  import type { StepStub } from '../../lib/steps-model';

  /** The most that are named before the rest become a count. */
  const MAX = 3;

  let { data }: NodeProps = $props();
  const node = $derived(data as unknown as { stubs: StepStub[]; width: number; dimmed: boolean });
  const stubs = $derived(node.stubs);
  const width = $derived(node.width);
  const dimmed = $derived(node.dimmed);

  const shown = $derived(stubs.slice(0, MAX));
  const rest = $derived(stubs.length - shown.length);
  const restTitle = $derived(
    stubs
      .slice(MAX)
      .map((s) => `${s.dir === 'out' ? 'leads to' : 'arrives from'} ${s.label}`)
      .join('\n')
  );
</script>

<div class="stubs" class:dimmed style={`width:${width}px`} aria-hidden="true">
  {#each shown as stub (stub.edge + stub.dir)}
    <span class="stub" title={`${stub.dir === 'out' ? 'Leads to' : 'Arrives from'} ${stub.label} — too far across the picture to draw as a line. Click the box to draw it.`}>
      <span class="arrow">{stub.dir === 'out' ? '→' : '←'}</span>{stub.label}
    </span>
  {/each}
  {#if rest > 0}
    <span class="stub more" title={restTitle}>+{rest} more</span>
  {/if}
</div>

<style>
  .stubs {
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding-top: 3px;
    box-sizing: border-box;
    pointer-events: none;
    font-size: 10.5px;
    line-height: 13px;
    color: var(--ink-3);
  }
  .stubs.dimmed {
    opacity: 0.25;
  }
  .stub {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--mono);
    pointer-events: auto;
  }
  .arrow {
    display: inline-block;
    width: 11px;
    color: var(--ink-4);
  }
  .more {
    color: var(--ink-4);
  }
</style>
