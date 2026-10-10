<script lang="ts">
  import { selectDropdown } from './lib/dropdown';
  import { untrack, onDestroy } from 'svelte';
  import WorkspaceOverview from './components/WorkspaceOverview.svelte';
  import { graphStatus } from './lib/graph-status.svelte';
  import { workspace } from './lib/workspace.svelte';
  import { createProjectNavigation } from './lib/navigation';
  import TopBar from './components/TopBar.svelte';
  import TrailBar from './components/TrailBar.svelte';
  import ProjectOverview from './components/ProjectOverview.svelte';
  import HelpDialog from './components/HelpDialog.svelte';
  import ViewHelp from './components/ViewHelp.svelte';
  import { guide } from './lib/guide.svelte';
  import SymbolView from './views/SymbolView.svelte';
  import FileView from './views/FileView.svelte';
  import FileCodeView from './views/FileCodeView.svelte';
  import MapView from './views/MapView.svelte';
  import ScreensView from './views/ScreensView.svelte';
  import StepsView from './views/StepsView.svelte';
  import FlowView from './views/FlowView.svelte';
  import EntryView from './views/EntryView.svelte';
  import DeadCodeView from './views/DeadCodeView.svelte';
  import NotFoundView from './views/NotFoundView.svelte';
  import Toast from './components/Toast.svelte';
  import {
    router,
    navigate,
    back,
    mapHref,
    flowHref,
    entryHref,
    screensHref,
    deadHref,
  } from './lib/router.svelte';
  import { palette } from './lib/palette.svelte';
  import { trail, resolveTrailNames } from './lib/trail.svelte';
  import { trails } from './lib/trails.svelte';
  import { project } from './lib/project.svelte';
  import { live } from './lib/live.svelte';
  import { toast } from './lib/toast.svelte';
  import { i18n, localize } from './lib/i18n.svelte';

  $effect(() => { void workspace.ensure(); });
  onDestroy(() => workspace.activate(null));
  let selectedId = $derived(router.route.view === 'workspace' ? null : router.location.projectId ?? workspace.projects[0]?.id ?? null);
  let selectedProject = $derived(workspace.projects.find(item => item.id === selectedId));
  let collapsed = $state(false);
  let projectHome = $derived(selectedId ? `#/p/${encodeURIComponent(selectedId)}/` : '#/workspace');
  $effect.pre(() => {
    if (!workspace.ready) return;
    const id = selectedProject?.available ? selectedId : null;
    untrack(() => workspace.activate(id));
  });
  $effect(() => {
    const id = selectedId;
    const raw = router.location.raw;
    if (id && router.route.view !== 'workspace') untrack(() => workspace.remember(id, `#${raw}`));
  });

  // The index moving is the one thing worth a note — the screen under it has
  // already refetched by the time this shows. `/api/stats` is re-read for the
  // same reason: the top bar's counts came from the graph that just changed.
  let seenIndexTick = live.indexTick;
  let seenProjectId: string | null = null;
  $effect(() => {
    const tick = live.indexTick;
    const activeId = workspace.activeId;
    untrack(() => {
      if (activeId !== seenProjectId) { seenProjectId = activeId; seenIndexTick = tick; return; }
      if (tick === seenIndexTick) return;
      seenIndexTick = tick;
      if (!workspace.activeId) return;
      void project.reload();
      // The entry points describe the index, and they are fetched once and
      // kept — so without this the resting palette, the empty screen and the
      // entry-points panel would all keep describing the graph as it was.
      void palette.reloadEntries();
      // Saved trails are re-resolved by the server against the index that just
      // moved, so their decay lines are stale the moment it does — a hop that
      // was "gone" a minute ago may be back, and vice versa.
      void trails.reload();
      toast.show(i18n.t('toast.indexUpdated'));
    });
  });

  let topbar: TopBar | null = $state(null);
  let helpOpen = $state(false);

  function startGuide() {
    guide.setDismissed(false);
    helpOpen = false;
    navigate(selectedProject?.available ? projectHome : '#/workspace');
  }

  let route = $derived(router.route);

  // An app with screens opens on them. The Symbol tab's empty state is for a
  // library, where there is nothing to draw until a name is typed; a project
  // whose graph holds screen navigation has a picture worth landing on.
  let hasScreens = $derived((project.stats?.graph.edgesByKind.navigates ?? 0) > 0);

  // Keep the in-memory trail and the `t` param in step. untrack() because the
  // body writes the same store it would otherwise read itself into a loop.
  $effect(() => {
    if (!workspace.activeId) return;
    const current = router.route;
    const encoded = router.params.get('t');
    untrack(() => {
      trail.hydrate(encoded);
      if (current.view === 'symbol' && trail.current?.id !== current.id) {
        trail.push({ id: current.id });
      }
    });
  });

  // Hops restored from a URL carry ids and nothing else; one batched request
  // turns the bar back into names. Runs after every trail change, and does
  // nothing when every hop already has one.
  $effect(() => {
    if (!workspace.activeId) return;
    void trail.hops.length;
    void resolveTrailNames();
  });

  function isTypingTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    return (
      target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement
    );
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.defaultPrevented || helpOpen) return;

    // Cmd/Ctrl+K reaches the search box even from inside another field.
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      topbar?.focusSearch();
      return;
    }

    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (isTypingTarget(event.target)) return;

    switch (event.key) {
      case '/':
        event.preventDefault();
        topbar?.focusSearch();
        break;
      case 'm':
        event.preventDefault();
        navigate(mapHref());
        break;
      case 'f':
        event.preventDefault();
        navigate(flowHref());
        break;
      case 'e':
        event.preventDefault();
        navigate(entryHref());
        break;
      case 's':
        event.preventDefault();
        navigate(screensHref());
        break;
      case 'd':
        event.preventDefault();
        navigate(deadHref());
        break;
      case 'Backspace':
      case '[':
        event.preventDefault();
        back();
        break;
    }
  }
</script>

<svelte:window {onkeydown} />

<TopBar bind:this={topbar} project={project.name} stats={project.summary} showScreens={hasScreens} onhelp={() => helpOpen = true} />
{#if helpOpen}<HelpDialog onclose={() => helpOpen = false} onstart={startGuide} hasProject={!!selectedProject?.available} />{/if}
<div class="workbench" class:collapsed>
  <aside aria-label={i18n.t('wb.nav')}>
    <button class="collapse" onclick={() => collapsed = !collapsed} aria-label={i18n.t('wb.collapse')} aria-expanded={!collapsed}>☰ <span>{i18n.t('wb.nav')}</span></button>
    <a class="nav-item" href="#/workspace" title={i18n.t('wb.workspace')}><b>◫</b><span>{i18n.t('wb.workspace')}</span></a>
    <div class="project-select"><select use:selectDropdown aria-label={i18n.t('wb.switch')} value={selectedId ?? ''} onchange={(event) => navigate(workspace.href(event.currentTarget.value))}><option value="" disabled>{i18n.t('wb.choose')}</option>{#each workspace.projects as item}<option value={item.id} disabled={!item.available}>{item.name}{item.available ? '' : i18n.t('wb.unavailableSuffix')}</option>{/each}</select></div>
    {#if selectedId}
      <a class="nav-item" class:active={route.view === 'home'} href={projectHome} title={i18n.t('wb.overview')}><b>⌂</b><span>{i18n.t('wb.overview')}</span></a>
      <a class="nav-item" class:active={route.view === 'map'} href={workspace.href(selectedId, 'map')} title={i18n.t('wb.map')}><b>◇</b><span>{i18n.t('wb.map')}</span></a>
      <a class="nav-item" class:active={['steps','flow','screens','entry'].includes(route.view)} href={workspace.href(selectedId, 'execution')} title={i18n.t('wb.execution')}><b>⇢</b><span>{i18n.t('wb.execution')}</span></a>
      <div class="subnav"><a href={workspace.href(selectedId, 'steps')}>{i18n.t('wb.steps')}</a><a href={workspace.href(selectedId, 'flow')}>{i18n.t('wb.flow')}</a><a href={workspace.href(selectedId, 'screens')}>{i18n.t('wb.screens')}</a><a href={createProjectNavigation(selectedId).entryHref()}>{i18n.t('wb.entries')}</a></div>
      <a class="nav-item" class:active={['symbol','file'].includes(route.view)} href={trail.current ? createProjectNavigation(selectedId).symbolHref(trail.current.id) : createProjectNavigation(selectedId).entryHref()} title={i18n.t('wb.reading')}><b>⌘</b><span>{i18n.t('wb.reading')}</span></a>
      <a class="nav-item" class:active={route.view === 'dead'} href={createProjectNavigation(selectedId).deadHref()} title={i18n.t('wb.dead')}><b>⊘</b><span>{i18n.t('wb.dead')}</span></a>
    {/if}
  </aside>
  <div class="reader">
  {#key workspace.activeId}
  {#if !workspace.ready}<div class="loading">{i18n.t('wb.loading')}</div>
  {:else if route.view === 'workspace'}<WorkspaceOverview />
  {:else if !selectedProject?.available}<div class="loading" role="alert">{workspace.error ?? selectedProject?.error ?? i18n.t('wb.missing')} <button data-workspace-retry disabled={workspace.loading} onclick={() => workspace.reload()}>{i18n.t(workspace.loading ? 'wb.reloading' : 'wb.retryWorkspace')}</button> <a href="#/workspace">{i18n.t('wb.back')}</a></div>
  {:else}
<TrailBar />
<ViewHelp view={route.view} />
<main use:localize>
  {#key router.location.raw}
  {#if route.view === 'symbol'}
    <SymbolView id={route.id} line={route.line} />
  {:else if route.view === 'file' && route.source}
    <FileCodeView path={route.path} line={route.line} />
  {:else if route.view === 'file'}
    <FileView path={route.path} line={route.line} />
  {:else if route.view === 'map'}
    <MapView root={route.root} depth={route.depth} tests={route.tests} />
  {:else if route.view === 'flow'}
    <FlowView
      from={route.from}
      to={route.to}
      symbols={route.symbols}
      trailParam={route.trail}
    />
  {:else if route.view === 'entry'}
    <EntryView project={project.name} />
  {:else if route.view === 'screens'}
    <ScreensView />
  {:else if route.view === 'steps'}
    <StepsView anchor={route.anchor} symbol={route.symbol} depth={route.depth} through={route.through} reading={route.reading} />
  {:else if route.view === 'dead'}
    <DeadCodeView exported={route.exported} />
  {:else if route.view === 'unknown'}
    <NotFoundView path={route.path} />
  {:else}
    <ProjectOverview onsearch={() => topbar?.focusSearch()} />
  {/if}
  {/key}
</main>
  {/if}
  {/key}
  </div>
</div>
<footer class="statusbar" aria-label={i18n.t('wb.statusBar')}>
  <span>{selectedProject?.name ?? workspace.name}</span>
  <span>{i18n.t('wb.currentView')}: {i18n.t(route.view === 'workspace' ? 'wb.workspace' : route.view === 'map' ? 'wb.map' : route.view === 'steps' ? 'wb.steps' : route.view === 'screens' ? 'wb.screens' : route.view === 'flow' ? 'wb.flow' : route.view === 'dead' ? 'wb.dead' : route.view === 'entry' ? 'wb.entries' : ['symbol','file'].includes(route.view) ? 'wb.reading' : 'wb.overview')}</span>
  {#if selectedId}<span>{i18n.t(selectedProject?.available ? 'wb.available' : 'wb.unavailable')}</span>{/if}
  {#if live.lastIndex?.at}<span>{i18n.t('wb.indexUpdatedAt', { time: new Date(live.lastIndex.at).toLocaleTimeString(i18n.locale) })}</span>{/if}
  {#if graphStatus.current}
    <span>{i18n.t('wb.displayCounts', { nodes: graphStatus.current.nodes.toLocaleString(), edges: graphStatus.current.edges.toLocaleString() })}</span>
    {#if graphStatus.current.scope}<span>{i18n.t('wb.graphScope')}: {graphStatus.current.scope}</span>{/if}
    {#if graphStatus.current.filter}<span>{i18n.t('wb.graphFilter')}: {graphStatus.current.filter}</span>{/if}
    {#if graphStatus.current.excluded}<span>{i18n.t('wb.graphExcluded')}: {graphStatus.current.excluded}</span>{/if}
    {#if graphStatus.current.budget}<span>{i18n.t('wb.graphBudget')}: {graphStatus.current.budget}</span>{/if}
  {:else if project.stats}
    <span>{i18n.t('wb.indexCounts', { nodes: project.stats.graph.nodes.toLocaleString(), edges: project.stats.graph.edges.toLocaleString(), files: project.stats.graph.files.toLocaleString() })}</span>
  {/if}
</footer>
<Toast />

<style>
  /* The shell grid lives on #app (index.html's mount host) in app.css —
     Svelte's scoped styles cannot reach an element this component does not
     render. Only <main>, which it does render, is styled here. */
  .statusbar { display:flex; flex-wrap:wrap; align-items:center; gap:4px 16px; min-height:32px; padding:6px 16px; border-top:1px solid var(--rule); background:var(--paper-2);color:var(--ink-3);font-size:12px; }
  .statusbar span { overflow-wrap:anywhere; }
  .loading button { min-height:36px;padding:0 12px;margin:0 12px;border:1px solid var(--rule); }
  .workbench { min-height:0; display:grid; grid-template-columns:220px minmax(0,1fr); }
  aside { min-height:0; overflow:auto; border-right:1px solid var(--rule); background:var(--paper-2); padding:16px 12px; }
  .collapse { display:flex;gap:14px;align-items:center;height:36px;padding:0 12px;margin-bottom:16px; width:100%;color:var(--ink-3); }
  .nav-item { display:flex;align-items:center;gap:12px;min-height:40px;padding:0 12px;margin:3px 0; }
  .nav-item b { width:18px; text-align:center; font-weight:400; } .active { background:var(--accent-wash);color:var(--accent); }
  .nav-item:hover { background:var(--paper); } .project-select { margin:16px 0; } select { width:100%;min-height:36px;background:var(--paper);border:1px solid var(--rule);color:var(--ink);padding:0 8px; }
  .subnav { display:grid;padding-left:42px;font-size:13px; } .subnav a { min-height:32px;display:flex;align-items:center;color:var(--ink-3); }
  .reader { min-width:0;min-height:0;display:flex;flex-direction:column; } .reader > :global(*) { min-height:0; } .loading { padding:40px; }
  .collapsed { grid-template-columns:64px minmax(0,1fr); } .collapsed aside { padding:16px 4px; } .collapsed .nav-item span,.collapsed .collapse span,.collapsed .subnav,.collapsed .project-select { display:none; }
  @media(max-width:1279px) { .workbench { grid-template-columns:64px minmax(0,1fr); } aside { padding:16px 4px; } .nav-item span,.collapse span,.subnav,.project-select { display:none; } }
  main {
    flex:1;
    /* min-height:0 lets the row shrink so the view, not the page, scrolls. */
    min-height: 0;
    overflow: hidden;
  }
</style>
