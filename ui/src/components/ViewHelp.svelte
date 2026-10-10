<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { helpViews } from '../lib/help';
  let { view }: { view: string } = $props();
  let content = $derived(helpViews.find(item => item.view === view));
</script>

{#if content}
  <section class="view-help" aria-label={i18n.t('help.viewHelp')}>
    <p><strong>{i18n.t(content.title)}</strong> {i18n.t(content.intro)}</p>
    {#key view}
      <details><summary>{i18n.t('help.readGraph')}</summary><p>{i18n.t(content.reading)}</p></details>
    {/key}
  </section>
{/if}

<style>
  .view-help { flex-shrink:0; padding:10px 20px; border-bottom:1px solid var(--rule); background:var(--paper-2); font-size:13px; max-height:30vh; overflow:auto; }
  p { margin:0; color:var(--ink-3); line-height:1.6; } strong { color:var(--ink); margin-right:10px; font-weight:500; }
  details { margin-top:4px; } summary { cursor:pointer; color:var(--accent); width:fit-content; } details p { margin-top:8px; max-width:100ch; }
</style>
