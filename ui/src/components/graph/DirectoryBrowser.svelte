<script lang="ts">
  import { fetchBrowse } from '../../lib/api';
  import { fileHref } from '../../lib/navigation';
  import { graphText } from '../../lib/graph-copy';
  import type { WireBrowsePage } from '../../lib/wire';
  import VirtualList from './VirtualList.svelte';
  let { root, onOpen, filesOnly = false }: { root: string; filesOnly?: boolean; onOpen: (root: string) => void } = $props();
  let directories = $state<WireBrowsePage | null>(null);
  let files = $state<WireBrowsePage | null>(null);
  let reload = $state(0);
  let error = $state('');
  let loading = $state(false);
  let active: AbortController | null = null;
  $effect(() => {
    void reload;
    const scope = root;
    const controller = new AbortController(); active = controller;
    directories = null; files = null; error = ''; loading = true;
    Promise.all([fetchBrowse({ root: scope, kind: 'directories', limit: 50 }, controller.signal), fetchBrowse({ root: scope, kind: 'files', limit: 50 }, controller.signal)])
      .then(([dirs, found]) => { if (!controller.signal.aborted) { directories = dirs; files = found; loading = false; } })
      .catch(e => { if (!controller.signal.aborted) { error = String(e); loading = false; } });
    return () => controller.abort();
  });
  async function more(kind: 'directories' | 'files') {
    const page = kind === 'directories' ? directories : files;
    if (!page?.nextCursor || loading) return;
    const controller = active; loading = true; error = '';
    try {
      const next = await fetchBrowse({ root, kind, cursor: page.nextCursor, limit: 50 }, controller?.signal);
      if (controller?.signal.aborted) return;
      const result = next.revision === page.revision ? { ...next, items: [...page.items, ...next.items] } : next;
      if (kind === 'directories') directories = result; else files = result;
    } catch(e) { if (!controller?.signal.aborted) error = String(e); }
    finally { if (!controller?.signal.aborted) loading = false; }
  }
</script>
<div class="browse">
  <h4>{graphText('子目录与直接文件', 'Subdirectories and direct files')}</h4>
  {#if error}<p role="alert">{error}</p><button disabled={loading} onclick={() => reload++}>{graphText('重新加载第一页', 'Reload first page')}</button>{/if}
  {#if !filesOnly && directories?.items.length}<VirtualList items={directories.items}>{#snippet row(item)}<button onclick={() => onOpen(item.path)}>▸ {item.path}</button>{/snippet}</VirtualList>{/if}
  {#if !filesOnly && directories?.nextCursor}<button disabled={loading} onclick={() => more('directories')}>{graphText('加载更多目录', 'Load more directories')}</button>{/if}
  {#if files?.items.length}<VirtualList items={files.items}>{#snippet row(item)}<a href={fileHref(item.path)}>{item.path}</a>{/snippet}</VirtualList>{/if}
  {#if files?.nextCursor}<button disabled={loading} onclick={() => more('files')}>{graphText('加载更多文件', 'Load more files')}</button>{/if}
  {#if loading}<p role="status">{graphText('加载中…', 'Loading…')}</p>{/if}
  {#if !loading && !error && !directories?.items.length && !files?.items.length}<p>{graphText('该目录没有已索引文件。', 'No indexed files in this directory.')}</p>{/if}
</div>
<style>h4{font:600 12px var(--sans)}button,a{font:12px var(--mono);color:var(--ink);background:transparent;border:0;cursor:pointer;display:block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:5px 0}a{text-decoration:none}button:hover,a:hover{text-decoration:underline}p{font:12px var(--sans);color:var(--ink-3)}</style>
