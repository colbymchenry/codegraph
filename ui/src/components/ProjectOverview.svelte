<script lang="ts">
  import { i18n } from '../lib/i18n.svelte';
  import { project } from '../lib/project.svelte';
  import { mapHref, stepsHref, entryHref, deadHref } from '../lib/navigation';
  import QuickStart from './QuickStart.svelte';
  let { onsearch }: { onsearch: () => void } = $props();
</script>
<section>
  <div class="eyebrow">{i18n.t('wb.overview')}</div><h1>{project.name ?? i18n.t('wb.projectLoading')}</h1>
  {#if project.error}<p role="alert">{project.error}</p>{/if}
  <p>{i18n.t('wb.projectIntro')}</p>
  <QuickStart {onsearch} />
  {#if project.stats}<div class="stats"><article><strong>{project.stats.graph.files.toLocaleString()}</strong><span>{i18n.t('wb.files')}</span></article><article><strong>{project.stats.graph.nodes.toLocaleString()}</strong><span>{i18n.t('wb.nodes')}</span></article><article><strong>{project.stats.graph.edges.toLocaleString()}</strong><span>{i18n.t('wb.edges')}</span></article></div>{/if}
  <div class="entries"><a href={mapHref()}><h2>{i18n.t('wb.map')} →</h2><p>{i18n.t('wb.mapHint')}</p></a><a href={stepsHref()}><h2>{i18n.t('wb.execution')} →</h2><p>{i18n.t('wb.executionHint')}</p></a><a href={entryHref()}><h2>{i18n.t('wb.reading')} →</h2><p>{i18n.t('wb.readingHint')}</p></a><a href={deadHref()}><h2>{i18n.t('wb.dead')} →</h2><p>{i18n.t('wb.deadHint')}</p></a></div>
</section>
<style>
section { padding:40px; height:100%;overflow:auto; } .eyebrow,p,span { color:var(--ink-3); } h1 { font-size:28px;margin:10px 0; } .stats { display:flex;gap:16px;margin:28px 0; } article { flex:1;border:1px solid var(--rule);padding:20px;display:grid;gap:6px; } strong { font-size:28px;font-weight:500; } .entries { display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px; } a { padding:20px;background:var(--paper-2);border:1px solid var(--rule-faint); } a:hover { border-color:var(--accent); } h2 { font-size:16px; } @media(max-width:800px) { section {padding:20px;} .entries {grid-template-columns:1fr;} }
</style>
