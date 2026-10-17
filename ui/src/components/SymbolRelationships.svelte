<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { fetchNeighbors, type WireNeighborPage } from '../lib/api';
  import { getGraphAdapter } from '../lib/adapter';
  import { fileHref, symbolHref } from '../lib/navigation';
  import { i18n } from '../lib/i18n.svelte';
  import { liveRefresh } from '../lib/live.svelte';
  let { id, file }: { id: string; file: string } = $props();
  const supported = typeof getGraphAdapter().neighbors === 'function';
  let open = $state(false);
  let direction = $state<'in' | 'out'>('in');
  let cursor = $state<string | null>(null);
  let page = $state<WireNeighborPage | null>(null);
  let failure = $state('');
  let loading = $state(false);
  let reload = $state(0);
  let pageNumber = $state(1);
  let previousId: string | null = null;
  $effect.pre(() => {
    if (id !== previousId) { previousId = id; cursor = null; pageNumber = 1; page = null; }
  });
  liveRefresh(() => file, () => reset());
  function sourceFile(item: WireNeighborPage['items'][number]) {
    return item.edge.line === undefined || direction === 'in' ? item.node.file : file;
  }
  function reset() { cursor = null; pageNumber = 1; reload++; }
  function changeDirection(event: Event) {
    direction = (event.currentTarget as HTMLSelectElement).value as 'in' | 'out'; reset();
  }
  $effect(() => {
    const nodeId = id; const side = direction; const after = cursor; void reload;
    if (!open || !supported) return;
    const controller = new AbortController();
    page = null; failure = ''; loading = true;
    void fetchNeighbors({ id: nodeId, direction: side, limit: 50, cursor: after ?? undefined }, controller.signal)
      .then(answer => { if (!controller.signal.aborted) page = answer; })
      .catch(cause => { if (!controller.signal.aborted) failure = cause instanceof Error ? cause.message : String(cause); })
      .finally(() => { if (!controller.signal.aborted) loading = false; });
    return () => controller.abort();
  });
</script>
{#if supported}
  <section class="relationships">
    <button data-open aria-expanded={open} onclick={() => open = !open}>{i18n.t('wb.allRelations')} {open ? '▴' : '▾'}</button>
    {#if open}
      <div class="controls"><label>{i18n.t('wb.direction')} <select use:selectDropdown value={direction} onchange={changeDirection}><option value="in">{i18n.t('wb.incoming')}</option><option value="out">{i18n.t('wb.outgoing')}</option></select></label><span>{i18n.t('wb.relationPage', { page: pageNumber })}</span></div>
      {#if loading}<p role="status">{i18n.t('wb.searching')}</p>
      {:else if failure}<p role="alert">{failure}</p><button data-retry onclick={reset}>{i18n.t('wb.reloadRelations')}</button>
      {:else if page}
        <div class="rows">
          {#each page.items as item, index (`${page.revision}:${pageNumber}:${index}`)}
            <div class="row" data-relationship>
              <a href={symbolHref(item.node.id)}>{item.node.name}</a><span>{item.edge.kind}</span>
              <a data-site class="site" href={fileHref(sourceFile(item), { source: true, line: item.edge.line ?? item.node.line })}>{sourceFile(item)}:{item.edge.line ?? item.node.line}{item.edge.col !== undefined ? `:${item.edge.col}` : ''}</a>
            </div>
          {/each}
        </div>
        {#if !page.items.length}<p>{i18n.t('wb.noRelations')}</p>{/if}
        <div class="controls"><button disabled={pageNumber === 1} onclick={reset}>{i18n.t('wb.firstPage')}</button><button data-next disabled={!page.nextCursor} onclick={() => { cursor = page!.nextCursor; pageNumber++; }}>{i18n.t('wb.nextPage')}</button></div>
      {/if}
    {/if}
  </section>
{/if}
<style>
  .relationships { margin:16px 0; border-top:1px solid var(--rule); padding:12px 0; }
  button,select { min-height:36px; padding:0 10px; border:1px solid var(--rule); color:var(--ink); background:var(--paper); font:inherit; }
  button:disabled { opacity:.5; cursor:default; } .controls { display:flex;align-items:center;justify-content:space-between;gap:12px;margin:12px 0; }
  .rows { max-height:360px;overflow:auto; } .row { display:grid;grid-template-columns:minmax(0,1fr) auto;gap:4px 12px;padding:8px;border-bottom:1px solid var(--rule-faint); }
  .row a { overflow-wrap:anywhere; } .site { grid-column:1/-1;font:12px var(--mono);color:var(--ink-3); } span { color:var(--ink-3);font-size:12px; }
</style>
