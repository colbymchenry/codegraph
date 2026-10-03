<script lang="ts">
  import { selectDropdown } from '../lib/dropdown';
  import WorkspaceSearch from './WorkspaceSearch.svelte';
  import { workspace } from '../lib/workspace.svelte';
  import { i18n } from '../lib/i18n.svelte';
  import { themePreference } from '../lib/theme-preference.svelte';
  let { project = null, stats = null, onhelp }: {project?:string|null;stats?:string|null;showScreens?:boolean;onhelp?:()=>void} = $props();
  let search: WorkspaceSearch;
  let settings = $state(false);
  function changeTheme(event: Event) { themePreference.setTheme((event.currentTarget as HTMLSelectElement).value as 'auto'|'light'|'dark'); }
  function changeLanguage(event: Event) { i18n.setLocale((event.currentTarget as HTMLSelectElement).value as 'zh-CN'|'en'); }
  export function focusSearch() { search?.focus(); }
</script>
<header>
  <a class="brand" href="#/workspace">CodeGraph <span>{workspace.name}</span></a>
  <WorkspaceSearch bind:this={search} />
  {#if onhelp}<button class="help" onclick={() => { settings = false; onhelp?.(); }} aria-haspopup="dialog">{i18n.t('help.title')}</button>{/if}
  <button class="settings" onclick={() => settings = !settings} aria-expanded={settings}>{i18n.t('wb.settings')}</button>
  {#if settings}<section class="panel" aria-label={i18n.t('wb.settings')}>
    <strong>{project ?? i18n.t('wb.workspaceSettings')}</strong><p>{stats ?? ''}</p>
    <label>{i18n.t('wb.theme')} <select use:selectDropdown value={themePreference.current} onchange={changeTheme}><option value="auto">{i18n.t('wb.auto')}</option><option value="light">{i18n.t('wb.light')}</option><option value="dark">{i18n.t('wb.dark')}</option></select></label>
    <label>{i18n.t('wb.language')} <select use:selectDropdown value={i18n.locale} onchange={changeLanguage}><option value="zh-CN">{i18n.t('language.chinese')}</option><option value="en">{i18n.t('language.english')}</option></select></label>
    <p>{i18n.t('wb.shortcuts')}</p>
    <button onclick={() => settings = false}>{i18n.t('wb.closeSettings')}</button>
  </section>{/if}
</header>
<style>
header { height:64px; display:flex; align-items:center; justify-content:space-between; gap:24px; padding:0 24px; border-bottom:1px solid var(--rule); position:relative; z-index:20; background:var(--paper); }
header > button { flex-shrink:0; }
header > :global(.search) { min-width:0; }
.brand { font-weight:700; white-space:nowrap; } .brand span { font-weight:400; color:var(--ink-3); margin-left:12px; } button,select { min-height:36px; padding:0 12px; border:1px solid var(--rule); background:var(--paper); color:var(--ink); } .panel { position:absolute; right:16px; top:58px; padding:20px; width:340px; background:var(--paper); border:1px solid var(--rule); box-shadow:0 12px 30px #0002; } label { display:flex; justify-content:space-between; align-items:center; margin:12px 0; } p { color:var(--ink-3); } @media(max-width:900px) { .brand span { display:none; } header { gap:12px;padding:0 12px; } }
@media(max-width:600px) { header { gap:8px; padding:0 8px; } header > button { padding:0 8px; font-size:12px; } }
</style>
