<script lang="ts">
  import { untrack } from 'svelte';
  import TopBar from './components/TopBar.svelte';
  import TrailBar from './components/TrailBar.svelte';
  import HomeView from './views/HomeView.svelte';
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

  // One `/api/stats` for the whole app: the top bar's counts and the Symbol
  // view's blast-radius denominator come out of the same payload.
  $effect(() => {
    void project.ensure();
  });

  // The live channel: one connection for the page, opened once. Every screen
  // reads its counters; nothing polls.
  $effect(() => {
    live.start();
  });

  // The index moving is the one thing worth a note — the screen under it has
  // already refetched by the time this shows. `/api/stats` is re-read for the
  // same reason: the top bar's counts came from the graph that just changed.
  let seenIndexTick = live.indexTick;
  $effect(() => {
    const tick = live.indexTick;
    untrack(() => {
      if (tick === seenIndexTick) return;
      seenIndexTick = tick;
      void project.reload();
      // The entry points describe the index, and they are fetched once and
      // kept — so without this the resting palette, the empty screen and the
      // entry-points panel would all keep describing the graph as it was.
      void palette.reloadEntries();
      // Saved trails are re-resolved by the server against the index that just
      // moved, so their decay lines are stale the moment it does — a hop that
      // was "gone" a minute ago may be back, and vice versa.
      void trails.reload();
      toast.show('Index updated · reloaded');
    });
  });

  let topbar: TopBar | null = $state(null);

  let route = $derived(router.route);

  // An app with screens opens on them. The Symbol tab's empty state is for a
  // library, where there is nothing to draw until a name is typed; a project
  // whose graph holds screen navigation has a picture worth landing on.
  let hasScreens = $derived((project.stats?.graph.edgesByKind.navigates ?? 0) > 0);

  // Keep the in-memory trail and the `t` param in step. untrack() because the
  // body writes the same store it would otherwise read itself into a loop.
  $effect(() => {
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
    if (event.defaultPrevented) return;

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

<TopBar bind:this={topbar} project={project.name} stats={project.summary} showScreens={hasScreens} />
<TrailBar />
<main>
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
  {:else if route.view === 'screens' || (route.view === 'home' && hasScreens)}
    <ScreensView />
  {:else if route.view === 'steps'}
    <StepsView anchor={route.anchor} symbol={route.symbol} depth={route.depth} through={route.through} reading={route.reading} />
  {:else if route.view === 'dead'}
    <DeadCodeView exported={route.exported} />
  {:else if route.view === 'unknown'}
    <NotFoundView path={route.path} />
  {:else}
    <HomeView project={project.name} />
  {/if}
</main>
<Toast />

<style>
  /* The shell grid lives on #app (index.html's mount host) in app.css —
     Svelte's scoped styles cannot reach an element this component does not
     render. Only <main>, which it does render, is styled here. */
  main {
    /* min-height:0 lets the row shrink so the view, not the page, scrolls. */
    min-height: 0;
    overflow: hidden;
  }
</style>
