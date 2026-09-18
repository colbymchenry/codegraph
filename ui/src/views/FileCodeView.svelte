<!--
  The whole-file view: the file's own source, top to bottom, with the graph
  drawn into its margins (design spec §3.4, task CG-52).

  Four columns, all scrolling as one document because all four are readings of
  the same line numbers:

      outline rail | arcs | source with gutter ports | callee rail
        (≥ 1400px)   56px                              320px

  The arc column is the piece that only works here. A call whose callee lives in
  the same file is a relationship between two LINES, and lines already have
  positions — the author put them there. So the intra-file call graph can be
  drawn without a layout algorithm, without physics, and without moving a single
  symbol from where the reader expects it.

  **Everything is placed arithmetically.** One line is 20px, `lineTop(n)` is its
  offset, and the arcs, the ports, the rail rows and the connectors all derive
  from that. Nothing measures the DOM except the x of two column edges. That is
  what makes a 6 820-line file scroll: ninety-odd line elements exist at a time,
  and the ones the reader has not reached yet still show their port and their
  place while the text pages in behind them. See `lib/filecode-model.ts`.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import CodeArcs from '../components/file/CodeArcs.svelte';
  import Connectors from '../components/symbol/Connectors.svelte';
  import FileCodeBlock from '../components/file/FileCodeBlock.svelte';
  import FileCodeOutline from '../components/file/FileCodeOutline.svelte';
  import FileCodeRail from '../components/file/FileCodeRail.svelte';
  import FileModeTabs from '../components/file/FileModeTabs.svelte';
  import KindGlyph from '../components/KindGlyph.svelte';
  import DriftBanner from '../components/DriftBanner.svelte';
  import {
    ApiFailure,
    fetchFileCode,
    fetchSource,
    type WireFileCodePayload,
    type WireNodeRef,
  } from '../lib/api';
  import { tokensByLine, type Token } from '../lib/highlight';
  import { hot } from '../lib/focus.svelte';
  import { basename, formatBytes, type OutlineEntryRow } from '../lib/file-model';
  import {
    ARC_CROWD_LIMIT,
    arcSummary,
    arcsInRange,
    buildFileArcs,
    buildFileCallRows,
    buildFileRefs,
    documentHeight,
    lineAtOffset,
    lineCentre,
    lineTop,
    ownerAt,
    pageFor,
    pagesForRange,
    railHeight,
    rowsInRange,
    visibleArcs,
    visibleLines,
    type FileArc,
    type FileCallRow,
  } from '../lib/filecode-model';
  import { liveRefresh } from '../lib/live.svelte';
  import { plural, synthesizedBy, type Connector, type LineRef } from '../lib/symbol-model';
  import { walkTo } from '../lib/walk';

  interface Props {
    path: string;
    line: number | null;
  }

  let { path, line }: Props = $props();

  /* ---------------------------------------------------------------- data -- */

  let payload = $state<WireFileCodePayload | null>(null);
  let failure = $state<ApiFailure | null>(null);
  let loading = $state(true);

  /**
   * Classified source by file line, filled in a page at a time.
   *
   * A plain Map behind a `$state` box: pages arrive a dozen times over a whole
   * file, so replacing the map on each one costs nothing measurable and keeps
   * the reads inside the code block's `$derived` honest.
   */
  let tokens = $state(new Map<number, Token[]>());
  let loadedPages = new Set<number>();
  let inflightPages = new Set<number>();
  let pageError = $state<string | null>(null);
  /** Aborts every page still in flight when the screen moves to another file. */
  let pageController: AbortController | null = null;

  $effect(() => {
    const wanted = path;
    const controller = new AbortController();
    untrack(() => load(wanted, controller.signal));
    return () => controller.abort();
  });

  /** Aborts a live-triggered reload when the screen moves on without it. */
  let liveController: AbortController | null = null;

  // The index moved, or this file changed on disk. Both change what is drawn in
  // the margins AND what the source says, so both drop every cached page — but
  // the scroll position stays, because the reader has not moved.
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
   * @param quiet a live refresh rather than a navigation: the pages are still
   *   thrown away (the file changed — that is the whole point) but the scroll
   *   position, the landing and the header stay put.
   */
  async function load(file: string, signal: AbortSignal, quiet = false): Promise<void> {
    if (!quiet) {
      loading = true;
      failure = null;
      payload = null;
      landed = null;
      hoverLine = null;
      hoverFocus = null;
      highlight = null;
      if (stageEl) stageEl.scrollTop = 0;
    }
    tokens = new Map();
    loadedPages = new Set();
    inflightPages = new Set();
    pageError = null;
    pageController?.abort();
    pageController = new AbortController();
    try {
      const next = await fetchFileCode(file, signal);
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

  /**
   * Fetch one page of source and merge its tokens in.
   *
   * The request reaches back {@link PAGE_LEAD_IN} lines and the lead-in is
   * thrown away: a page starting inside a block comment cannot tell that it is,
   * and would render the prose as code. See `filecode-model.ts`.
   */
  async function loadPage(index: number): Promise<void> {
    const file = payload?.file;
    if (!file || file.totalLines === null) return;
    if (loadedPages.has(index) || inflightPages.has(index)) return;
    inflightPages.add(index);
    const page = pageFor(index, file.totalLines);
    const signal = pageController?.signal;
    try {
      // A drifted file is paged as its CURRENT bytes: the numbering the pages
      // use is the file's own, and every graph-derived marking over it is off
      // (see `driftMode` below). Showing nothing would be honest and useless —
      // the source itself is still exactly readable.
      const slice = await fetchSource(
        file.path,
        page.requestFrom,
        page.to,
        signal,
        payload?.drift ? 'current' : undefined
      );
      // A different file (or a reload) landed while this was in flight.
      if (signal?.aborted || payload?.file.path !== file.path) return;
      if (!slice.lines) {
        pageError = slice.reason ?? 'Source is not available for this file.';
        return;
      }
      const from = slice.from ?? page.requestFrom;
      const decoded = tokensByLine(slice.lines, from, slice.highlight);
      const next = new Map(tokens);
      for (const [n, value] of decoded) if (n >= page.from) next.set(n, value);
      tokens = next;
      loadedPages.add(index);
    } catch (cause) {
      if (signal?.aborted) return;
      pageError = cause instanceof Error ? cause.message : String(cause);
    } finally {
      inflightPages.delete(index);
    }
  }

  /* -------------------------------------------------------------- models -- */

  /**
   * The file has changed on disk since it was indexed.
   *
   * Everything in this screen's margins — the arcs, the gutter ports, the rail
   * rows, the outline's line numbers — is a line number the graph recorded, and
   * the file no longer has those lines. So in this mode the margins go away and
   * the source stays: current bytes are correct by construction, and a call arc
   * drawn between two lines that have moved is the one thing here that could be
   * confidently wrong. Parity with `codegraph_node`, which serves a drifted
   * file whole and current rather than slicing it (issue #1474).
   */
  let driftMode = $derived(payload?.drift === true);

  let totalLines = $derived(payload?.file.totalLines ?? 0);
  let refs = $derived(
    payload && !driftMode ? buildFileRefs(payload) : new Map<number, LineRef[]>()
  );
  let rows = $derived(payload && !driftMode ? buildFileCallRows(payload) : []);
  let arcs = $derived(payload && !driftMode ? buildFileArcs(payload, rows) : []);
  let crowded = $derived(arcs.length > ARC_CROWD_LIMIT);

  let outlineRows = $derived<OutlineEntryRow[]>(
    driftMode
      ? []
      : (payload?.outline.items ?? []).map((entry) => ({
          entry,
          indent: Math.min(entry.depth, 3),
          dimmed: QUIET_KINDS.has(entry.kind),
        }))
  );

  const QUIET_KINDS = new Set(['property', 'field', 'enum_member', 'variable', 'constant']);

  /** Lines a definition starts on → its name, so the name is bold in the body. */
  let defNames = $derived.by(() => {
    const map = new Map<number, string>();
    if (driftMode) return map;
    for (const entry of payload?.outline.items ?? []) {
      if (!map.has(entry.line)) map.set(entry.line, entry.name);
    }
    return map;
  });

  /** Every symbol this file's calls reach, by id — what a call-site link opens. */
  let targets = $derived.by(() => {
    const map = new Map<string, WireNodeRef>();
    for (const row of rows) map.set(row.call.relation.node.id, row.call.relation.node);
    return map;
  });

  /* -------------------------------------------------------------- scroll -- */

  let stageEl = $state<HTMLElement | null>(null);
  let codeEl = $state<HTMLElement | null>(null);
  let railEl = $state<HTMLElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);
  /** x of the code column's right edge and the rail's left, for the hairlines. */
  let columns = $state({ x0: 0, x1: 0, width: 0 });

  $effect(() => {
    const el = stageEl;
    if (!el) return;
    const read = (): void => {
      scrollTop = el.scrollTop;
      viewport = el.clientHeight;
    };
    const measure = (): void => {
      read();
      const code = codeEl;
      const rail = railEl;
      if (!code || !rail) return;
      columns = {
        x0: code.offsetLeft + code.offsetWidth - 10,
        x1: rail.offsetLeft + 14,
        width: el.scrollWidth,
      };
    };
    measure();
    el.addEventListener('scroll', read, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      observer.disconnect();
    };
  });

  let visible = $derived(visibleLines(scrollTop, viewport, totalLines));

  // Whatever is on screen has to have its source. The pages are fetched here
  // rather than inside the block so a fast scroll past a page does not leave a
  // request for it half-applied to a screen that has moved on.
  $effect(() => {
    if (!payload) return;
    const wanted = pagesForRange(visible.first, visible.last, totalLines);
    untrack(() => {
      for (const index of wanted) void loadPage(index);
    });
  });

  /* --------------------------------------------------------------- focus -- */

  let hoverLine = $state<number | null>(null);
  /** Set by a rail row: its row names a caller the code lines cannot. */
  let hoverFocus = $state<string | null>(null);
  let highlight = $state<number | null>(null);

  /** The symbol the reader is inside, from the scroll position. */
  let currentId = $derived(
    ownerAt(payload?.outline.items ?? [], lineAtOffset(scrollTop + 8, totalLines))
  );

  /**
   * The symbol whose arcs are drawn once there are too many to draw all of them.
   *
   * Pointer first, scroll position last. There is deliberately no *pinned*
   * symbol: clicking an arc scrolls to its callee, so the callee becomes the
   * symbol the reader is inside and its arcs follow from that. A pin would be a
   * second, invisible piece of state answering the same question — and would go
   * stale the moment the reader scrolled somewhere else.
   */
  let focusId = $derived.by(() => {
    if (hoverFocus !== null) return hoverFocus;
    const outline = payload?.outline.items ?? [];
    if (hoverLine !== null) return ownerAt(outline, hoverLine);
    return currentId;
  });

  /* ------------------------------------------------------------- drawing -- */

  let shownArcs = $derived(visibleArcs(arcs, focusId, crowded));
  let windowArcs = $derived(arcsInRange(shownArcs, visible.first, visible.last));

  let windowRows = $derived(
    rowsInRange(rows, scrollTop - viewport, scrollTop + viewport * 2)
  );

  /**
   * One hairline per call site, from the gutter port to its rail row.
   *
   * Both coordinates are the document's, so they hold at any scroll position —
   * and only the rows on screen are drawn, which is what keeps eight hundred
   * call sites from being eight hundred paths.
   */
  let connectors = $derived.by<Connector[]>(() => {
    const { x0, x1 } = columns;
    if (x1 <= x0) return [];
    const cx = (x0 + x1) / 2;
    const out: Connector[] = [];
    for (const row of windowRows) {
      const ry = row.top + 17;
      const via = synthesizedBy(row.call.relation);
      for (const callLine of row.lines) {
        const ly = lineCentre(callLine);
        out.push({
          d: `M${x0},${ly} C${cx},${ly} ${cx},${ry} ${x1},${ry}`,
          targetId: row.call.relation.node.id,
          uncertain: row.call.relation.uncertain,
          heuristic: via !== null,
          origin: false,
        });
      }
    }
    return out;
  });

  let docHeight = $derived(Math.max(documentHeight(totalLines), railHeight(rows)));

  /* ------------------------------------------------------------ movement -- */

  /** Scroll a line into the upper third, where a reader looks for it. */
  function goToLine(target: number): void {
    const el = stageEl;
    if (!el) return;
    el.scrollTop = Math.max(0, lineTop(target) - el.clientHeight / 3);
    highlight = target;
  }

  /**
   * Clicking an arc focuses its callee: the source moves to the definition and
   * the callee lights everywhere it appears — its rail row, its call sites,
   * its other arcs. The call line the reader came from stays the thing that put
   * it on screen, which is why the pin is the TARGET and not the owner.
   */
  function followArc(arc: FileArc): void {
    hot.set(arc.targetId);
    goToLine(arc.toLine);
  }

  /** A call site in the body, or a rail row: open the callee as a symbol. */
  function openNode(node: WireNodeRef): void {
    // Same file, same screen — jump rather than leave.
    if (node.file === payload?.file.path) {
      hot.set(node.id);
      goToLine(node.line);
      return;
    }
    walkTo({ id: node.id, name: node.name, kind: node.kind }, 'start');
  }

  function followRef(ref: LineRef): void {
    const node = ref.targetId ? targets.get(ref.targetId) : undefined;
    if (node) openNode(node);
  }

  /** A rail row names the CALLER, which is the symbol its arcs belong to. */
  function onhoverRow(row: FileCallRow | null): void {
    hoverFocus = row ? row.ownerId : null;
  }

  /* --------------------------------------------------- arriving at a line -- */

  let landed: string | null = null;
  $effect(() => {
    const key = line === null ? null : `${path}:${line}`;
    if (!key || !payload || landed === key || !stageEl || totalLines === 0) return;
    landed = key;
    goToLine(line as number);
  });
</script>

{#if failure}
  <div class="scroll">
    <div class="emptystate">
      <h2>{failure.code === 'not-found' ? 'Not in the index' : 'Could not load this file'}</h2>
      <p class="mono">{path}</p>
      <p>{failure.message}</p>
      {#if failure.guidance}<p class="dim">{failure.guidance}</p>{/if}
    </div>
  </div>
{:else if loading || !payload}
  <div class="scroll">
    <div class="emptystate"><p class="dim">Loading…</p></div>
  </div>
{:else}
  <div class="codeview" class:wide={outlineRows.length > 0}>
    {#if outlineRows.length > 0}
      <aside class="nav">
        <FileCodeOutline
          rows={outlineRows}
          total={payload.outline.total}
          truncated={payload.outline.truncated}
          {currentId}
          ongo={(at, id) => {
            hot.set(id);
            goToLine(at);
          }}
        />
      </aside>
    {/if}

    <section class="main">
      <header class="band">
        <div class="card-h">
          <KindGlyph kind="file" />
          <h1>{basename(payload.file.path)}</h1>
          <span class="kindword">
            {payload.file.language} · {formatBytes(payload.file.size)} ·
            {payload.file.totalLines === null
              ? 'length unknown'
              : plural(payload.file.totalLines, 'line')} ·
            {plural(payload.outline.total, 'symbol')}
          </span>
          <span class="loc">{payload.file.path}</span>
          <div class="spacer"></div>
          <FileModeTabs path={payload.file.path} {line} source={true} />
        </div>

        <div class="toolbar" class:hidden={driftMode}>
          <span class="arcnote">
            {arcSummary(payload.intraFileCalls)}{#if crowded}{' '}<span class="dim"
                >— showing the ones the symbol under the pointer takes part in</span
              >{/if}
          </span>
          <span
            class="railnote"
            title="One row per pair: a symbol in this file, and a symbol it reaches."
          >
            Calls <span class="n">{payload.calls.total}</span>{#if payload.calls.truncated}<span
                class="dim"> · showing {payload.calls.shown}</span
              >{/if}{#if payload.outside.total > 0}{' '}<span class="dim"
                >· {plural(payload.outside.total, 'reference')} outside the index</span
              >{/if}
          </span>
        </div>

        {#if payload.drift}
          <div class="banner">
            <DriftBanner file={payload.file.path}>
              indexed line ranges may be shifted; showing the file's current source, with the
              call arcs, ports and rail switched off — they are drawn from lines this file no
              longer has. The next sync picks it up.
            </DriftBanner>
          </div>
        {:else if payload.file.totalLines === null}
          <div class="banner">
            <DriftBanner file={payload.file.path}>
              {payload.reason ?? 'it could not be read from disk.'}
            </DriftBanner>
          </div>
        {:else if pageError}
          <div class="note">{pageError}</div>
        {/if}
      </header>

      {#if payload.file.totalLines !== null}
        <div
          class="stage"
          bind:this={stageEl}
          onmouseleave={() => {
            hoverLine = null;
          }}
          role="presentation"
        >
          <div class="stage-inner" style:height={`${docHeight}px`}>
            <div class="arccol">
              {#if !driftMode}
                <CodeArcs arcs={windowArcs} height={docHeight} {hoverLine} onfollow={followArc} />
              {/if}
            </div>

            <div class="codecol" bind:this={codeEl}>
              <FileCodeBlock
                first={visible.first}
                last={visible.last}
                tokensFor={(n) => tokens.get(n) ?? null}
                {refs}
                {defNames}
                {highlight}
                onfollow={followRef}
                onhoverline={(n) => {
                  hoverLine = n;
                }}
              />
            </div>

            <aside class="rail" bind:this={railEl} aria-label="Calls">
              {#if !driftMode}
                <FileCodeRail
                  rows={windowRows}
                  focalFile={payload.file.path}
                  {focusId}
                  onopen={openNode}
                  onhover={onhoverRow}
                />
              {/if}
            </aside>

            <Connectors {connectors} width={columns.width} height={docHeight} />
          </div>
        </div>
      {/if}
    </section>
  </div>
{/if}

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .codeview {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    min-height: 0;
  }

  /* The navigation rail is a luxury, not the screen: below 1400px the code and
     its two margins take the whole width rather than all three squeezing. */
  @media (min-width: 1400px) {
    .codeview.wide {
      grid-template-columns: 240px minmax(0, 1fr);
    }
  }

  .nav {
    display: none;
    min-height: 0;
  }

  @media (min-width: 1400px) {
    .codeview.wide .nav {
      display: block;
    }
  }

  .main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-width: 0;
    min-height: 0;
  }

  /* Outside the scroller on purpose: a header inside it would put every line at
     `headerHeight + (n - 1) * 20`, and the header's height is a measurement. */
  .band {
    padding: 14px 22px 8px;
    border-bottom: 1px solid var(--rule);
    background: var(--paper);
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

  .toolbar {
    display: flex;
    justify-content: space-between;
    gap: 16px;
    margin-top: 8px;
    color: var(--ink-2);
    font-size: 11.5px;
  }

  .railnote .n {
    color: var(--ink-3);
  }

  .arcnote,
  .railnote {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .banner {
    margin-top: 10px;
  }

  .note {
    margin-top: 10px;
    color: var(--ink-3);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .toolbar.hidden {
    display: none;
  }

  .stage {
    position: relative;
    min-height: 0;
    overflow: auto;
  }

  /* The positioning context every arithmetic coordinate is expressed in: line
     tops, arc endpoints, rail rows and the connector overlay share this origin. */
  .stage-inner {
    position: relative;
    display: grid;
    grid-template-columns: 56px minmax(420px, 1fr) 320px;
    min-width: 100%;
  }

  .arccol {
    position: relative;
    border-right: 1px solid var(--rule-faint);
  }

  .codecol {
    position: relative;
    min-width: 0;
    padding-left: 4px;
  }

  .rail {
    position: relative;
    border-left: 1px solid var(--rule-faint);
  }

  @media (max-width: 1100px) {
    .stage-inner {
      grid-template-columns: 56px minmax(320px, 1fr) 260px;
    }
  }
</style>
