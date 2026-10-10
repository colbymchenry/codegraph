<script lang="ts">
  import { graphText } from '../../lib/graph-copy';
  import { onMount, onDestroy } from 'svelte';
  import { readGraphHistory, saveGraphHistory } from '../../lib/graph-history';
  import type { Snippet } from 'svelte';
  let { children }: { children: Snippet } = $props();
  let body = $state<HTMLDivElement>();
  onMount(() => {
    const key = location.href;
    if (body) body.scrollTop = readGraphHistory(key).scroll ?? 0;
    return () => saveGraphHistory(key, { scroll: body?.scrollTop ?? 0 });
  });
  let open = $state(true);
  let width = $state(360);
  let stopResize = () => {};
  onDestroy(() => stopResize());
  function resize(event: PointerEvent) {
    stopResize();
    const start = event.clientX; const initial = width;
    const move = (e: PointerEvent) => width = Math.max(300, Math.min(480, initial + start - e.clientX));
    const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); window.removeEventListener('pointercancel', end); };
    stopResize = end;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  }
</script>
<div class="panel" class:closed={!open} style={`--detail-width:${width}px`}>
  <button class="toggle" aria-expanded={open} onclick={() => open = !open}>{open ? graphText('收起详情 ›', 'Hide details ›') : graphText('‹ 详情', '‹ Details')}</button>
  {#if open}<button class="resize" aria-label={graphText('调整详情宽度', 'Resize details')}  onpointerdown={resize} onkeydown={(e) => { if(e.key === 'ArrowLeft') width = Math.min(480,width+20); if(e.key === 'ArrowRight') width=Math.max(300,width-20); }}></button><div class="body" bind:this={body}>{@render children()}</div>{/if}
</div>
<style>
.panel{position:relative;width:var(--detail-width);min-height:0;background:var(--paper-2);border-left:1px solid var(--rule);padding-top:44px}.closed{width:38px}.toggle{position:absolute;right:4px;top:5px;white-space:nowrap;min-height:36px;font:14px var(--sans);color:var(--ink);background:var(--paper);border:1px solid var(--rule);padding:4px;z-index:9}.closed .toggle{writing-mode:vertical-rl;top:8px}.resize{border:0;background:transparent;padding:0;position:absolute;left:-3px;top:0;bottom:0;width:7px;cursor:col-resize;z-index:9}.body{height:100%;overflow:auto}.body :global(aside){height:auto;min-height:100%;box-sizing:border-box;width:100%}@media(max-width:1024px){.panel{position:absolute;right:0;top:0;bottom:0;z-index:10;box-shadow:-6px 0 24px #0002}.closed{bottom:auto;height:85px}}
</style>
