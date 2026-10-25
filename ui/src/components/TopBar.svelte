<script lang="ts">
  import { router, mapHref, flowHref, entryHref, screensHref, stepsHref, deadHref, symbolHref } from '../lib/router.svelte';
  import { trail } from '../lib/trail.svelte';
  import SearchPalette from './SearchPalette.svelte';
  import { live } from '../lib/live.svelte';
  import { locale, t, type LocaleCode } from '../lib/locale.svelte';

  interface Props {
    /** Indexed project name, e.g. "codegraph/". Null until stats load. */
    project?: string | null;
    /** "13,060 symbols · 46,004 edges · 593 files indexed". Null until loaded. */
    stats?: string | null;
    /** The project's graph holds screen navigation: show the Screens tab and land on it. */
    showScreens?: boolean;
  }

  let { project = null, stats = null, showScreens = false }: Props = $props();

  let search: SearchPalette | null = $state(null);

  let view = $derived(router.route.view);

  // The Symbol tab returns you to where you were reading, not to a blank
  // view: the current symbol if you are on one, else the trail's last hop —
  // and failing both, the tab's own empty screen. NOT `#/`: the landing page
  // renders the Screens tab on any project that has screens, so that fallback
  // sent a reader who clicked Symbol to somebody else's view.
  let symbolTabHref = $derived.by(() => {
    const route = router.route;
    if (route.view === 'symbol' && route.id !== null) return symbolHref(route.id);
    const current = trail.current;
    return symbolHref(current ? current.id : null);
  });

  /** What `/` and Cmd-K reach — the palette owns its own keyboard. */
  export function focusSearch(): void {
    search?.focus();
  }

  /**
   * Why this page has stopped updating itself, when it has.
   *
   * The whole point of the live channel is that the screen keeps up with the
   * project; a screen that has silently stopped keeping up is worse than one
   * that never claimed to. So both ways it can end say so, in the one place
   * that is on every view.
   */
  let liveNote = $derived.by(() => {
    if (live.degraded !== null) {
      return {
        text: t('live.off'),
        title: t('live.degradedTitle', { reason: live.degraded }),
      };
    }
    if (live.stopped) {
      return {
        text: t('live.notLive'),
        title: t('live.lostTitle'),
      };
    }
    return null;
  });
</script>

<header class="topbar">
  <a class="brand" href="#/" aria-label={t('brand.homeAria')}>
    <span class="brand-mark" aria-hidden="true"></span>
    <span class="brand-name">CodeGraph</span>
    <span class="brand-sub">ui</span>
  </a>

  <nav class="views" aria-label={t('nav.viewsAria')}>
    {#if showScreens}<a href={screensHref()} class:active={view === 'screens' || view === 'home'}>{t('nav.screens')}</a>{/if}
    <a href={stepsHref()} class:active={view === 'steps'}>{t('nav.steps')}</a>
    <a href={entryHref()} class:active={view === 'entry'}>{t('nav.entry')}</a>
    <a href={mapHref()} class:active={view === 'map'}>{t('nav.map')}</a>
    <a href={symbolTabHref} class:active={view === 'symbol' || (view === 'home' && !showScreens)}>{t('nav.symbol')}</a>
    <a href={flowHref()} class:active={view === 'flow'}>{t('nav.flow')}</a>
    <a href={deadHref()} class:active={view === 'dead'}>{t('nav.dead')}</a>
  </nav>

  <SearchPalette bind:this={search} />

  <div class="project" title={t('topbar.indexedTitle')}>
    {#if liveNote}<span class="offline" title={liveNote.title}>{liveNote.text}</span>{/if}
    {#if project}<span class="mono">{project}</span>{/if}
    {#if stats}<span class="dim">{stats}</span>{/if}
    <label class="locale" title={locale.current === 'en' ? '中文' : 'English'}>
      <span class="sr-only">{t('nav.viewsAria')}</span>
      <select bind:value={locale.current} onchange={(e) => locale.set(e.currentTarget.value as LocaleCode)}>
        <option value="en">English</option>
        <option value="zh-CN">中文</option>
      </select>
    </label>
  </div>
</header>

<style>
  .topbar {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 22px;
    padding: 0 18px;
    background: var(--paper);
    border-bottom: 1px solid var(--rule);
    position: relative;
    z-index: 30;
  }

  .brand {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .brand-mark {
    display: inline-block;
    width: 10px;
    height: 10px;
    align-self: center;
    border: 1.5px solid var(--ink);
    background: var(--paper);
  }

  .brand-name {
    font-weight: 600;
    font-size: 14px;
    letter-spacing: -0.01em;
  }

  .brand-sub {
    color: var(--ink-3);
    font-size: 12px;
  }

  .views {
    display: flex;
    gap: 2px;
  }

  .views a {
    padding: 5px 10px;
    color: var(--ink-2);
    border-bottom: 2px solid transparent;
  }

  .views a:hover {
    color: var(--ink);
  }

  .views a.active {
    color: var(--ink);
    border-bottom-color: var(--ink);
  }

  .project {
    color: var(--ink-2);
    font-size: 12px;
    white-space: nowrap;
  }

  .offline {
    padding: 2px 6px;
    margin-right: 8px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .locale select {
    margin-left: 10px;
    padding: 1px 4px;
    border: 1px solid var(--rule);
    background: var(--paper);
    color: var(--ink-2);
    font-size: 12px;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
    border: 0;
  }

  /* Below ~1000px the stats are the first thing worth losing — but not the
     note that the page has stopped updating itself. */
  @media (max-width: 1000px) {
    .project .mono,
    .project .dim {
      display: none;
    }
  }
</style>
