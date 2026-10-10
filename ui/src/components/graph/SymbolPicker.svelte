<script lang="ts">
  import { dismissDropdown } from '../../lib/dropdown';
  import { graphText } from '../../lib/graph-copy';
  import { fetchSearch } from '../../lib/api';
  import type { WireSearchResult } from '../../lib/wire';
  let { label, value = $bindable('') }: { label: string; value?: string } = $props();
  let query = $state('');
  let results = $state<WireSearchResult[]>([]);
  let error = $state('');
  $effect(() => {
    const q = query.trim();
    if (!q) { results = []; return; }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchSearch(q, { limit: 12 }, controller.signal).then(data => { results = data.results.items; error = ''; }).catch(e => { if (!controller.signal.aborted) error = String(e); });
    }, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  });
</script>
<div class="picker" use:dismissDropdown={() => query = ''}>
  <label>{label}<input aria-label={label} placeholder={value || graphText('搜索符号并选择…', 'Search and select a symbol…')} bind:value={query} /></label>
  {#if value}<span class="chosen" title={value}>{value}</span>{/if}
  {#if query}<div class="results">{#each results as item (item.id)}<button onclick={() => { value = item.id; query = ''; }}>{item.name}<small>{item.file}:{item.line}</small></button>{/each}{#if error}<span role="alert">{error}</span>{/if}</div>{/if}
</div>
<style>
.picker{position:relative;min-width:160px;max-width:260px}label{display:flex;align-items:center;gap:6px;font:14px var(--sans)}input{box-sizing:border-box;min-height:36px;font:14px var(--sans);min-width:0;width:150px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);padding:5px}.chosen{display:block;font:10px var(--mono);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-3);max-width:220px}.results{position:absolute;top:100%;left:0;width:330px;max-height:300px;overflow:auto;background:var(--paper-2);border:1px solid var(--rule);z-index:20}.results button{display:block;text-align:left;width:100%;background:transparent;color:var(--ink);border:0;border-bottom:1px solid var(--rule);padding:8px;cursor:pointer}small{display:block;color:var(--ink-3);overflow-wrap:anywhere}
</style>
