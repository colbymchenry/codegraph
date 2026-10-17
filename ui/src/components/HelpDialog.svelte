<script lang="ts">
  import { onMount } from 'svelte';
  import { i18n } from '../lib/i18n.svelte';
  import { helpViews } from '../lib/help';
  let { onclose, onstart, hasProject }: { onclose: () => void; onstart: () => void; hasProject: boolean } = $props();
  let dialog: HTMLDialogElement;
  onMount(() => {
    const previous = document.activeElement;
    dialog.showModal();
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  });
</script>

<dialog bind:this={dialog} aria-labelledby="help-title" onclose={onclose} onkeydown={event => event.stopPropagation()}>
  <header><div><p class="eyebrow">CODEGRAPH</p><h2 id="help-title">{i18n.t('help.title')}</h2></div><button onclick={onclose}>{i18n.t('wb.close')}</button></header>
  <section class="start"><h3>{i18n.t('help.quickStart')}</h3><p>{i18n.t('help.quickIntro')}</p><button onclick={onstart}>{i18n.t(hasProject ? 'help.reopen' : 'wb.choose')}</button>{#if !hasProject}<p>{i18n.t('help.chooseProject')}</p>{/if}</section>
  <section><h3>{i18n.t('help.chooseView')}</h3>{#each helpViews as item}<article><h4>{i18n.t(item.title)}</h4><p>{i18n.t(item.intro)}</p><details><summary>{i18n.t('help.readGraph')}</summary><p>{i18n.t(item.reading)}</p></details></article>{/each}</section>
  <section><h3>{i18n.t('help.shortcuts')}</h3><dl><div><dt>⌘ / Ctrl + K</dt><dd>{i18n.t('help.searchKey')}</dd></div><div><dt>M / F / E / S / D</dt><dd>{i18n.t('help.viewsKey')}</dd></div><div><dt>[ / Backspace</dt><dd>{i18n.t('help.backKey')}</dd></div><div><dt>Esc</dt><dd>{i18n.t('help.closeKey')}</dd></div></dl><p class="note">{i18n.t('help.keyNote')}</p></section>
</dialog>

<style>
  dialog { width:min(680px,calc(100vw - 32px)); max-height:calc(100dvh - 48px); margin:auto; padding:28px; overflow:auto; color:var(--ink); background:var(--paper); border:1px solid var(--rule); box-shadow:0 20px 70px #0003; }
  dialog::backdrop { background:#0006; } header { display:flex; justify-content:space-between; align-items:center; gap:16px; } h2 { margin:4px 0; font-size:24px; } .eyebrow { margin:0; font-size:11px; letter-spacing:.12em; color:var(--accent); }
  button { min-height:36px; padding:6px 14px; border:1px solid var(--rule); color:var(--ink); background:var(--paper); } button:hover { border-color:var(--accent); }
  section { margin-top:24px; } .start { padding:18px; background:var(--paper-2); border:1px solid var(--rule-faint); } h3 { font-size:16px; margin:0 0 10px; } h4 { font-size:14px; font-weight:500; margin:0; }
  p { color:var(--ink-3); font-size:13px; line-height:1.7; margin:6px 0 12px; } article { border-top:1px solid var(--rule-faint); padding:14px 0; } summary { font-size:13px; color:var(--accent); cursor:pointer; width:fit-content; } details p { margin-top:8px; }
  dl { font-size:13px; margin:0; } dl div { display:grid; grid-template-columns:175px 1fr; gap:12px; padding:8px 0; } dt { font-family:var(--mono); } dd { margin:0; color:var(--ink-3); } .note { font-size:12px; }
  @media(max-width:600px) { dialog { padding:20px; } dl div { grid-template-columns:1fr; gap:4px; } }
</style>
