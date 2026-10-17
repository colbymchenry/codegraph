<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { i18n } from '../lib/i18n.svelte';
  import { workspace, type WorkspaceResult } from '../lib/workspace.svelte';
  import { createProjectNavigation } from '../lib/navigation';
  let query = $state('');
  let scope = $state('');
  let open = $state(false);
  let results = $state<WorkspaceResult[]>([]);
  let loading = $state(false);
  let error = $state('');
  let incomplete = $state('');
  let limited = $state(false);
  let input: HTMLInputElement;
  let panel = $state<HTMLElement>();
  function searchKeys(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault(); open = true;
    queueMicrotask(() => { const links = panel?.querySelectorAll<HTMLAnchorElement>('a'); links?.[event.key === 'ArrowDown' ? 0 : links.length - 1]?.focus(); });
  }
  function resultKeys(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const links = [...panel!.querySelectorAll<HTMLAnchorElement>('a')];
    const index = links.indexOf(event.target as HTMLAnchorElement);
    if (index < 0) return;
    event.preventDefault(); links[Math.max(0, Math.min(links.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }
  let scroll = 0;
  function restoreScroll(node: HTMLElement) { queueMicrotask(() => { node.scrollTop = scroll; }); }
  export function focus() { open = true; input?.focus(); }
  $effect(() => {
    const q = query.trim(); const project = scope;
    results = []; error = ''; incomplete = ''; limited = false;
    if (!q) { loading = false; return; }
    const controller = new AbortController();
    scroll = 0;
    loading = true;
    const timer = setTimeout(async () => {
      try {
        const answer = await workspace.search(q, project, controller.signal);
        if (controller.signal.aborted) return;
        results = answer.results; limited = answer.limited;
        incomplete = answer.incomplete.map(item => `${item.projectId}: ${item.reason}`).join(' · ');
      } catch (cause) { if (!controller.signal.aborted) error = String(cause); }
      finally { if (!controller.signal.aborted) loading = false; }
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  });
</script>
<svelte:window onpopstate={() => { if (query) open = true; }} onkeydown={(event) => { if (event.key === 'Escape') open = false; else if (open && panel?.contains(event.target as Node)) resultKeys(event); }} />
<div class="search">
  <input bind:this={input} bind:value={query} onkeydown={searchKeys} onfocus={() => open = true} aria-label={i18n.t('wb.search')} placeholder={i18n.t('wb.searchPlaceholder')} />
  {#if open}
    <section bind:this={panel} class="results" use:restoreScroll onscroll={(event) => { scroll = event.currentTarget.scrollTop; }} aria-label={i18n.t('wb.results')}>
      <div class="filters"><select use:selectDropdown bind:value={scope} aria-label={i18n.t('wb.scope')}><option value="">{i18n.t('wb.all')}</option>{#each workspace.projects as item}<option value={item.id}>{item.name}</option>{/each}</select><button onclick={() => open = false}>{i18n.t('wb.close')}</button></div>
      <p class="hint">{i18n.t('wb.filters')}</p>
      {#if loading}<p>{i18n.t('wb.searching')}</p>{:else if error}<p role="alert">{error}</p>{:else if query && !results.length}<p>{i18n.t('wb.noResults')}</p>{:else if !query}<p>{i18n.t('wb.searchHint')}</p>{/if}
      {#each results as result (`${result.projectId}:${result.node.id}`)}
        <a href={result.node.kind === 'file' ? createProjectNavigation(result.projectId).fileHref(result.node.file) : createProjectNavigation(result.projectId).symbolHref(result.node.id)} onclick={() => open = false}>
          <strong>{result.node.name}</strong><span>{result.projectName} · {result.node.kind}</span><small>{result.node.file}</small>
        </a>
      {/each}
      {#if incomplete}<p role="status">{i18n.t('wb.incomplete', { reasons: incomplete })}</p>{/if}
      {#if limited}<p>{i18n.t('wb.limited')}</p>{/if}
    </section>
  {/if}
</div>
<style>
  .search { position: relative; width: min(560px, 48vw); }
  input { width: 100%; height: 36px; padding: 0 12px; background: var(--paper-2); border: 1px solid var(--rule); color: var(--ink); font: inherit; }
  .results { position: absolute; top: 43px; left: 0; right: 0; max-height: 70vh; overflow: auto; z-index: 100; background: var(--paper); border: 1px solid var(--rule); box-shadow: 0 12px 30px #0002; padding: 12px; }
  .filters { display:flex; justify-content:space-between; } select { min-height:36px; background:var(--paper); color:var(--ink); border:1px solid var(--rule); } p { color:var(--ink-3); } a { display:grid; padding:10px 8px; border-top:1px solid var(--rule-faint); } a:hover { background:var(--paper-2); } span,small { color:var(--ink-3); font-size:12px; overflow-wrap:anywhere; }
</style>
