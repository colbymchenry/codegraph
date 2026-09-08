<!--
  The File view: imported by | outline in source order | imports
  (design spec §3.4, task CG-46).

  A file is the one unit of the graph that has no body worth printing and no
  single caller — so the screen is three lists rather than the Symbol view's
  code-and-rails. The middle column is the file's shape; the two rails are what
  a change to it would reach, in both directions.

  The counts on the rails come from `getFileDependencies` / `getFileDependents`
  — every cross-file edge, not just resolved import statements. See
  `lib/file-model.ts` for why that distinction is the whole point of the rails.

  The whole file's source, with the same gutter ports and an arc diagram for the
  calls that stay inside it, is the other reading of this screen — `?src=1`,
  `FileCodeView.svelte` (CG-52). The tabs in the header switch between them.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import FileOutline from '../components/file/FileOutline.svelte';
  import FileRail from '../components/file/FileRail.svelte';
  import FileModeTabs from '../components/file/FileModeTabs.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import DriftBanner from '../components/DriftBanner.svelte';
  import { ApiFailure, fetchFile, type WireFilePayload, type WireNodeRef } from '../lib/api';
  import {
    basename,
    buildFileOutline,
    buildFileRail,
    fileMetaLine,
  } from '../lib/file-model';
  import { fileHref, navigate } from '../lib/navigation';
  import { liveRefresh } from '../lib/live.svelte';
  import { plural } from '../lib/symbol-model';
  import { walkTo } from '../lib/walk';

  interface Props {
    path: string;
    line: number | null;
  }

  let { path, line }: Props = $props();

  /* --------------------------------------------------------------- data -- */

  let payload = $state<WireFilePayload | null>(null);
  let failure = $state<ApiFailure | null>(null);
  let loading = $state(true);
  let centerEl = $state<HTMLElement | null>(null);
  /** The `?hl=` this screen has already landed on — see the effect at the end. */
  let landed: string | null = null;

  $effect(() => {
    const wanted = path;
    const controller = new AbortController();
    untrack(() => load(wanted, controller.signal));
    return () => controller.abort();
  });

  /** Aborts a live-triggered reload when the screen moves on without it. */
  let liveController: AbortController | null = null;

  // The index moved, or this file changed on disk (the drift banner). Refetch
  // in place — the outline is where the reader's eye is.
  liveRefresh(
    () => payload?.file.path ?? path,
    () => {
      const wanted = path;
      liveController?.abort();
      liveController = new AbortController();
      void load(wanted, liveController.signal, true);
    }
  );

  /**
   * @param quiet a live refresh rather than a navigation: keep the outline on
   *   screen (and the reader's selection in it) until the new payload lands.
   */
  async function load(file: string, signal: AbortSignal, quiet = false): Promise<void> {
    if (!quiet) {
      loading = true;
      failure = null;
      payload = null;
      pane = 'outline';
      index = -1;
      // Leaving and coming back to the same `?hl=` URL must land again; the
      // guard below only exists to stop a re-render re-selecting.
      landed = null;
    }
    try {
      const next = await fetchFile(file, signal);
      if (signal.aborted) return;
      payload = next;
      failure = null;
    } catch (cause) {
      if (signal.aborted) return;
      failure =
        cause instanceof ApiFailure
          ? cause
          : new ApiFailure(0, 'error', cause instanceof Error ? cause.message : String(cause), null);
    } finally {
      if (!signal.aborted) loading = false;
    }
  }

  /* ------------------------------------------------------------- models -- */

  let outline = $derived(payload ? buildFileOutline(payload) : []);

  let importedBy = $derived(
    payload ? buildFileRail(payload.dependents, payload.importedBy.items) : null
  );

  let imports = $derived(
    payload
      ? buildFileRail(payload.dependencies, payload.imports.items, payload.unresolvedImports)
      : null
  );

  /* ------------------------------------------------------------ movement -- */

  /**
   * Opening a symbol from a file is a `start` hop: nothing on this screen was
   * stepped through to reach it, so claiming a direction would draw an arrow
   * in the trail that describes no call.
   */
  function open(node: WireNodeRef | { id: string; name: string; kind: string }): void {
    walkTo({ id: node.id, name: node.name, kind: node.kind }, 'start');
  }

  /** Open the file AS a symbol — the only way to read its top-level code. */
  function openFileNode(): void {
    const file = payload?.file;
    if (!file?.id) return;
    walkTo({ id: file.id, name: basename(file.path), kind: 'file' }, 'start');
  }

  /* ------------------------------------------------------------ keyboard -- */

  type Pane = 'left' | 'outline' | 'right';
  const PANES: Pane[] = ['left', 'outline', 'right'];

  let pane = $state<Pane>('outline');
  let index = $state(-1);

  function paneLength(which: Pane): number {
    if (which === 'left') return importedBy?.rows.length ?? 0;
    if (which === 'right') return imports?.rows.length ?? 0;
    return outline.length;
  }

  function follow(): void {
    if (index < 0) return;
    if (pane === 'outline') {
      const row = outline[index];
      if (row) open(row.entry);
      return;
    }
    const rail = pane === 'left' ? importedBy : imports;
    const row = rail?.rows[index];
    if (row) navigate(fileHref(row.path));
  }

  function switchPane(delta: number): void {
    const at = PANES.indexOf(pane);
    const next = PANES[Math.max(0, Math.min(PANES.length - 1, at + delta))];
    if (!next || next === pane) return;
    // Skip an empty rail rather than parking the selection somewhere invisible.
    if (paneLength(next) === 0) return;
    pane = next;
    index = 0;
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement)
    ) {
      return;
    }
    if (!payload) return;

    switch (event.key) {
      case 'ArrowLeft':
        switchPane(-1);
        break;
      case 'ArrowRight':
        switchPane(1);
        break;
      case 'ArrowDown':
      case 'j':
        index = Math.max(0, Math.min(paneLength(pane) - 1, index + 1));
        break;
      case 'ArrowUp':
      case 'k':
        index = Math.max(0, index - 1);
        break;
      case 'Enter':
        event.preventDefault();
        follow();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (pane !== 'outline') {
      // The outline scrolls itself (it is windowed); the rails need a nudge.
      void tick().then(() => {
        const scope = document.querySelector(
          pane === 'left' ? '[data-pane="left"]' : '[data-pane="right"]'
        );
        scope?.querySelectorAll('.filerow')[index]?.scrollIntoView({ block: 'nearest' });
      });
    }
  }

  /* --------------------------------------------------- arriving at a line -- */

  // `#/file/<path>?hl=<line>` lands on the symbol that owns the line. The
  // outline is the only thing on this screen with line numbers, so the honest
  // reading of "this file, at line 900" is "this file, at the symbol there".
  $effect(() => {
    const key = line === null ? null : `${path}:${line}`;
    if (!key || !payload || landed === key || outline.length === 0) return;
    // The LAST containing row, not the first: rows are in source order, so a
    // symbol's descendants follow it, and the deepest one that still holds the
    // line is the specific answer. Landing on the enclosing class instead
    // would point at every line in the file equally.
    let at = -1;
    outline.forEach((row, i) => {
      if (row.entry.line <= line! && line! <= row.entry.endLine) at = i;
    });
    landed = key;
    if (at < 0) return;
    pane = 'outline';
    index = at;
  });
</script>

<svelte:window {onkeydown} />

{#if failure}
  <div class="scroll">
    <div class="emptystate">
      <h2>{failure.code === 'not-found' ? 'Not in the index' : 'Could not load this file'}</h2>
      <p class="mono">{path}</p>
      <p>{failure.message}</p>
      {#if failure.guidance}<p class="dim">{failure.guidance}</p>{/if}
    </div>
  </div>
{:else if loading || !payload || !imports || !importedBy}
  <div class="scroll">
    <div class="emptystate"><p class="dim">Loading…</p></div>
  </div>
{:else}
  <div class="fileview">
    <div class="pane" data-pane="left">
      <FileRail
        title="Imported by"
        model={importedBy}
        side="left"
        selected={pane === 'left' ? index : -1}
        onhover={(i) => {
          pane = 'left';
          index = i;
        }}
        emptyNote="Nothing in the index reaches into this file. It is either an entry point, or nothing depends on it yet."
      />
    </div>

    <section class="center" bind:this={centerEl}>
      <div class="card-h">
        <KindGlyph kind="file" />
        <!-- Generated code recedes wherever it appears (design spec §2.6). -->
        <h1 class:gen={payload.file.generated}>{basename(payload.file.path)}</h1>
        <span class="kindword">{fileMetaLine(payload)}</span>
        <span class="loc">{payload.file.path}</span>
        <div class="spacer"></div>
        <FileModeTabs path={payload.file.path} {line} source={false} />
      </div>

      <div class="badges">
        {#if payload.topLevel.calls > 0}
          <span class="badge">
            Runs {plural(payload.topLevel.calls, 'call')} at the top level —
            <button type="button" class="linkish" onclick={openFileNode}>
              see what it calls
            </button>
          </span>
        {/if}
        {#if payload.file.generated}
          <span class="badge">generated</span>
        {/if}
        {#if payload.file.errors.length > 0}
          <span class="badge warn">
            {plural(payload.file.errors.length, 'extraction error')} — the outline may be
            incomplete
          </span>
        {/if}
      </div>

      {#if payload.drift}
        <div class="banner">
          <DriftBanner file={payload.file.path}>
            indexed line ranges may be shifted, so the outline below is the shape the file had
            when it was indexed —
            <a href={fileHref(payload.file.path, { source: true })}>read its current source</a>.
            The next sync picks it up.
          </DriftBanner>
        </div>
      {/if}

      <FileOutline
        rows={outline}
        total={payload.outline.total}
        truncated={payload.outline.truncated}
        scroller={centerEl}
        selected={pane === 'outline' ? index : -1}
        onopen={open}
        onhover={(i) => {
          pane = 'outline';
          index = i;
        }}
      />
    </section>

    <div class="pane" data-pane="right">
      <FileRail
        title="Imports"
        model={imports}
        side="right"
        selected={pane === 'right' ? index : -1}
        onhover={(i) => {
          pane = 'right';
          index = i;
        }}
        emptyNote="This file reaches nothing else in the index — it depends on nothing the graph holds."
      />
    </div>
  </div>
{/if}

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .fileview {
    display: grid;
    grid-template-columns: 300px minmax(480px, 1fr) 300px;
    height: 100%;
    min-height: 0;
  }

  .pane {
    min-width: 0;
    overflow: hidden;
  }

  .center {
    min-width: 0;
    overflow: auto;
    padding: 18px 22px 40px;
  }

  .card-h {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 12px;
  }

  .card-h h1 {
    margin: 0;
    font: 600 20px/1.2 var(--mono);
    letter-spacing: -0.01em;
  }

  .card-h h1.gen {
    color: var(--ink-4);
  }

  .spacer {
    flex: 1 1 auto;
  }

  .kindword {
    color: var(--ink-3);
    font-size: 12.5px;
  }

  .loc {
    color: var(--ink-2);
    font: 11.5px var(--mono);
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .badges:not(:empty) {
    margin-top: 10px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink-2);
    font-size: 11.5px;
  }

  .badge.warn {
    border-color: var(--amber);
    background: var(--amber-soft);
    color: var(--amber);
  }

  .linkish {
    color: var(--accent);
    font: inherit;
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }

  .banner {
    margin-top: 12px;
  }

  @media (max-width: 1100px) {
    .fileview {
      grid-template-columns: 220px minmax(360px, 1fr) 220px;
    }
  }
</style>
