<script lang="ts" generics="T">
  import type { Snippet } from 'svelte';
  let { items, row, rowHeight = 36, height = 360 }: { items: T[]; row: Snippet<[T]>; rowHeight?: number; height?: number } = $props();
  let top = $state(0);
  let measured = $state<Record<number, number>>({});
  const virtual = $derived(items.length > 100);
  const offsets = $derived.by(() => {
    const values = [0];
    for (let i = 0; i < items.length; i++) values.push(values[i]! + (measured[i] ?? rowHeight));
    return values;
  });
  const start = $derived(virtual ? Math.max(0, Math.min(items.length - 1, offsets.findIndex(y => y >= top)) - 4) : 0);
  const end = $derived.by(() => { const at = offsets.findIndex(y => y >= top + height); return virtual && at >= 0 ? Math.min(items.length, Math.max(start + 8, at + 4)) : items.length; });
  function measure(node: HTMLElement, index: number) {
    if (typeof ResizeObserver === 'undefined') return {};
    const observer = new ResizeObserver(() => {
      const actual = node.getBoundingClientRect().height;
      if (actual && measured[index] !== actual) measured[index] = actual;
    });
    observer.observe(node);
    return { destroy: () => observer.disconnect() };
  }
</script>
<div class="list" style:max-height={`${height}px`} onscroll={e => top = e.currentTarget.scrollTop}>
  <div style:height={`${offsets[start] ?? 0}px`}></div>
  {#each items.slice(start, end) as item, i (start + i)}<div use:measure={start + i} style:min-height={`${rowHeight}px`}>{@render row(item)}</div>{/each}
  <div style:height={`${(offsets[items.length] ?? 0) - (offsets[end] ?? 0)}px`}></div>
</div>
<style>.list{overflow:auto;overflow-anchor:none}</style>
