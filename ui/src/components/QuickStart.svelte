<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import { i18n } from '../lib/i18n.svelte';
  import { guide } from '../lib/guide.svelte';
  import { palette } from '../lib/palette.svelte';
  import { entryHref, stepsHref, symbolHref } from '../lib/navigation';
  let { onsearch }: { onsearch: () => void } = $props();
  let selected = $state('');
  let candidates = $derived.by(() => {
    const entries = palette.entries;
    if (!entries) return [];
    const routes = entries.routes.items.items.flatMap(item => item.handlerId ? [{ id:item.handlerId, name:`${item.url} · ${item.handler}`, file:item.file }] : []);
    const hubs = entries.hubs.items.filter(item => ['function', 'method', 'constructor'].includes(item.kind)).map(item => ({ id:item.id, name:item.name, file:item.file }));
    return [...new Map([...routes, ...hubs].map(item => [item.id, item])).values()];
  });
  let example = $derived(candidates.find(item => item.id === selected) ?? candidates[0]);
  $effect(() => { if (!guide.dismissed) void palette.ensureEntries(); });
</script>

{#if !guide.dismissed}
  <section class="quick-start" aria-label={i18n.t('help.quickStart')}>
    <div class="heading"><h2>{i18n.t('help.quickStart')}</h2><button onclick={() => guide.setDismissed(true)}>{i18n.t('help.dismiss')}</button></div>
    <p>{i18n.t('help.quickIntro')}</p>
    {#if example}
      <label>{i18n.t('help.example')} <select use:selectDropdown value={example.id} onchange={event => selected = event.currentTarget.value}>{#each candidates as item}<option value={item.id}>{item.name} — {item.file}</option>{/each}</select></label>
    {:else}
      <p role="status">{i18n.t(palette.entriesSettled ? 'help.noExample' : 'help.loadingExample')}</p>
    {/if}
    <ol>
      <li><a href={entryHref()}><span>01</span><strong>{i18n.t('help.startEntry')} →</strong><p>{i18n.t('help.entryStep')}</p></a></li>
      <li><a href={stepsHref(example ? { anchor:example.id } : {})}><span>02</span><strong>{i18n.t('help.startSteps')} →</strong><p>{i18n.t('help.stepsStep')}</p></a></li>
      <li>{#if example}<a href={symbolHref(example.id)}><span>03</span><strong>{i18n.t('help.startSource')} →</strong><p>{i18n.t('help.sourceStep')}</p></a>{:else}<button class="search-step" onclick={onsearch}><span>03</span><strong>{i18n.t('help.searchSource')} →</strong><p>{i18n.t('help.sourceStep')}</p></button>{/if}</li>
    </ol>
    <p class="note">{i18n.t('help.reopenNote')}</p>
  </section>
{/if}

<style>
  .quick-start { padding:24px; margin:24px 0; border:1px solid var(--rule); border-left:3px solid var(--accent); background:var(--paper-2); }
  .heading { display:flex; justify-content:space-between; align-items:center; gap:16px; } h2 { font-size:18px; margin:0; } p { color:var(--ink-3); line-height:1.6; margin:8px 0; }
  button,select { border:1px solid var(--rule); background:var(--paper); color:var(--ink); min-height:36px; padding:6px 12px; } .heading button { flex-shrink:0; }
  label { display:flex; gap:12px; align-items:center; font-size:13px; margin:16px 0; } select { min-width:0; flex:1; max-width:680px; }
  ol { display:grid; grid-template-columns:repeat(3,minmax(0,1fr)); padding:0; margin:20px 0 12px; gap:12px; list-style:none; }
  li { min-width:0; } li a,.search-step { display:block; width:100%; height:100%; padding:16px; border:1px solid var(--rule-faint); background:var(--paper); text-align:left; }
  li a:hover,.search-step:hover { border-color:var(--accent); } li span { display:block; color:var(--accent); font-size:12px; margin-bottom:10px; } strong { font-weight:500; font-size:14px; } li p,.note { font-size:12px; }
  @media(max-width:800px) { .quick-start { padding:16px; } ol { grid-template-columns:1fr; } label { align-items:stretch; flex-direction:column; } }
</style>
