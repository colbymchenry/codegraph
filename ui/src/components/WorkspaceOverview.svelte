<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { workspace } from '../lib/workspace.svelte';
</script>
<section class="overview">
  <div class="eyebrow">WORKSPACE</div><h1>{workspace.name}</h1><p>{i18n.t('wb.intro')}</p>
  <button data-workspace-retry disabled={workspace.loading} onclick={() => workspace.reload()}>{i18n.t(workspace.loading ? 'wb.reloading' : 'wb.retryWorkspace')}</button>
  {#if workspace.error}<p role="alert">{workspace.error}</p>{/if}
  <div class="projects">{#each workspace.projects as item}
    <article><div class="status">{item.available ? i18n.t('wb.available') : i18n.t('wb.unavailable')}</div><h2>{item.name}</h2>
      {#if item.stats}<p>{i18n.t('wb.counts', { files: item.stats.graph.files.toLocaleString(), nodes: item.stats.graph.nodes.toLocaleString() })}</p>{/if}
      {#if item.available}<a href={workspace.href(item.id)}>{i18n.t('wb.enter')}</a>{:else}<p role="status">{item.error ?? i18n.t('wb.indexUnavailable')}</p>{/if}
    </article>
  {/each}</div>
</section>
<style>
button { min-height:36px; padding:0 12px; border:1px solid var(--rule); background:var(--paper);color:var(--ink); } button:disabled { opacity:.6;cursor:default; }
.overview { height:100%; overflow:auto; padding:40px; background:var(--paper); } .eyebrow { font-size:12px; color:var(--ink-3); letter-spacing:.1em; } h1 { font-size:28px; margin:10px 0; } p { color:var(--ink-3); } .projects { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px;margin-top:32px; } article { border:1px solid var(--rule); padding:24px; background:var(--paper-2); } h2 { font-size:18px; }.status { color:var(--ink-3); font-size:12px; } a { display:inline-flex; min-height:36px;align-items:center;color:var(--accent); }
</style>
