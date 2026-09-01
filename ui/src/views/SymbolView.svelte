<!--
  The Symbol view: callers | verbatim source with gutter ports | line-anchored
  callee rail (design spec §3.2, task CG-44).

  The geometry is the point of the screen, and it is the one thing that cannot
  be derived from the payload: where a callee row belongs depends on where its
  call-site line ended up, which depends on the font, the window width, whether
  a fold is open. So this component measures — after every render, on every
  resize — and hands the rail and the overlay their coordinates. Everything
  else it does is plumbing around that.

  Two scroll containers, deliberately. The left rail scrolls alone; the centre
  and the right rail scroll together inside the stage, because a callee row
  that drifts away from its line is worse than no rail at all.
-->
<script lang="ts">
  import { tick, untrack } from 'svelte';
  import CalleeRail from '../components/symbol/CalleeRail.svelte';
  import CallersRail from '../components/symbol/CallersRail.svelte';
  import Connectors from '../components/symbol/Connectors.svelte';
  import BlastStrip from '../components/symbol/BlastStrip.svelte';
  import MembersOutline from '../components/symbol/MembersOutline.svelte';
  import TypeHierarchy from '../components/symbol/TypeHierarchy.svelte';
  import SourceBlock from '../components/symbol/SourceBlock.svelte';
  import SymbolHeader from '../components/symbol/SymbolHeader.svelte';
  import DriftBanner from '../components/DriftBanner.svelte';
  import {
    ApiFailure,
    fetchFile,
    fetchSource,
    fetchSymbol,
    type WireNodeDetail,
    type WireNodeRef,
    type WireSource,
    type WireSymbolPayload,
  } from '../lib/api';
  import { tokensByLine, type Token } from '../lib/highlight';
  import { hot, railFocus } from '../lib/focus.svelte';
  import { project } from '../lib/project.svelte';
  import {
    buildCalleeRail,
    buildCallerRail,
    buildCodeBlock,
    buildOutline,
    graphCallLines,
    refsByLine,
    showsBody,
    synthesizedBy,
    type Connector,
    type LineRef,
  } from '../lib/symbol-model';
  import { encodeTrail, trail } from '../lib/trail.svelte';
  import { liveRefresh } from '../lib/live.svelte';
  import { fileHref, navigate, symbolHref } from '../lib/navigation';
  import { arrivedFrom, walkTo } from '../lib/walk';

  interface Props {
    id: string;
    line: number | null;
  }

  let { id, line }: Props = $props();

  /* ------------------------------------------------------------ geometry -- */

  /** Row height and the gap between two rows pushed apart — spec §3.2. */
  const ROW_HEIGHT = 34;
  const ROW_GAP = 6;
  /** Fallback for the sticky rail header before it has been measured. */
  const RAIL_HEADER_FALLBACK = 38;

  /**
   * How much of a DRIFTED file this screen will show in place of the body.
   *
   * When the file has moved on, the symbol's indexed range names nothing, so
   * the only correct source to show is the whole current file — the same call
   * `codegraph_node` makes (issue #1474), for the same reason: current bytes
   * are right by construction, a slice of them is a guess. Past this length
   * that stops being a symbol view and becomes a file view badly done, so the
   * banner points at the real one instead.
   */
  const DRIFT_INLINE_MAX_LINES = 400;

  /** One shared empty map, so the drift path does not allocate per render. */
  const EMPTY_REFS: Map<number, LineRef[]> = new Map();

  /* --------------------------------------------------------------- state -- */

  let payload = $state<WireSymbolPayload | null>(null);
  let source = $state<WireSource | null>(null);
  let failure = $state<ApiFailure | null>(null);
  let loading = $state(true);

  let innerEl = $state<HTMLDivElement | null>(null);
  let centerEl = $state<HTMLElement | null>(null);
  let railEl = $state<HTMLElement | null>(null);
  let leftRailEl = $state<HTMLElement | null>(null);

  let tops = $state<number[]>([]);
  let foldTop = $state(0);
  let noteTop = $state(0);
  let stageMinHeight = $state(0);
  let connectors = $state<Connector[]>([]);
  let overlay = $state({ width: 0, height: 0 });
  /**
   * The rail has been measured at least once for the symbol on screen.
   *
   * Until it has, a row has no place to be: drawing it at `top: 0` would stack
   * every row at the head of the rail for a frame, and drawing it at the
   * PREVIOUS symbol's coordinates would be worse. It stays hidden instead.
   */
  let placed = $state(false);

  /* ---------------------------------------------------------------- data -- */

  $effect(() => {
    const wanted = id;
    const controller = new AbortController();
    untrack(() => load(wanted, controller.signal));
    return () => controller.abort();
  });

  /** Aborts a live-triggered reload when the screen moves on without it. */
  let liveController: AbortController | null = null;

  // The graph moved, or the file on screen changed on disk. Either way what is
  // drawn is out of date; refetch it in place rather than blanking the screen.
  liveRefresh(
    () => payload?.node.file ?? null,
    () => {
      const wanted = id;
      liveController?.abort();
      liveController = new AbortController();
      void load(wanted, liveController.signal, true);
    }
  );

  /**
   * @param quiet a live refresh rather than a navigation: keep what is on
   *   screen until the new payload lands, so a sync does not blink the view.
   */
  async function load(nodeId: string, signal: AbortSignal, quiet = false): Promise<void> {
    if (!quiet) {
      loading = true;
      failure = null;
      payload = null;
      source = null;
      railFocus.reset();
      hot.set(null);
      placed = false;
    }
    void project.ensure();

    let node: WireSymbolPayload;
    try {
      node = await fetchSymbol(nodeId, signal);
    } catch (cause) {
      if (signal.aborted) return;
      // A node's id contains its start line, so a sync that moved this symbol
      // down two lines answers 404 for an id that was valid a second ago. On a
      // live refresh — and only there, because only there do we still hold the
      // symbol's name — find it again in its file rather than telling the
      // reader their screen no longer exists.
      if (quiet && asFailure(cause).code === 'not-found' && payload !== null) {
        const moved = await refind(payload.node, signal);
        if (signal.aborted) return;
        if (moved !== null) {
          trail.rename(nodeId, moved);
          navigate(symbolHref(moved.id, { trail: encodeTrail(trail.hops) }), { replace: true });
          return;
        }
      }
      failure = asFailure(cause);
      loading = false;
      return;
    }
    if (signal.aborted) return;
    payload = node;
    failure = null;
    loading = false;
    trail.resolve(nodeId, { name: node.node.name, kind: node.node.kind });

    // The body is only fetched when it will be drawn: a 2,000-line file node
    // shows its outline, and asking for 2,000 lines to throw them away is the
    // difference between a screen that settles at once and one that does not.
    if (!showsBody(node.node.kind, node.node.lines)) {
      source = null;
      return;
    }
    try {
      // A drifted file is asked for WHOLE and CURRENT — its indexed range is
      // the one thing about it that is certainly wrong — and the answer comes
      // back flagged `showing: 'current'`, which is what switches every
      // line-anchored marking below off.
      const slice = node.drift
        ? await fetchSource(node.node.file, 1, 0, signal, 'current')
        : await fetchSource(node.node.file, node.node.line, node.node.endLine, signal);
      if (!signal.aborted) source = slice;
    } catch {
      // No slice: the header, the rails and the blast strip are all still
      // true, so the screen loses the body and says so rather than erroring.
      if (!signal.aborted) source = null;
    }
  }

  /**
   * The same symbol after a sync renumbered its file.
   *
   * The file's outline is the exact answer — every symbol in that file with its
   * new id — so this is one request and no ranking. Same name and kind is the
   * match; when a file holds several (overloads), the one that moved least is
   * the one the reader was on.
   */
  async function refind(previous: WireNodeDetail, signal: AbortSignal): Promise<WireNodeRef | null> {
    try {
      const file = await fetchFile(previous.file, signal);
      const candidates = file.outline.items.filter(
        (entry) => entry.name === previous.name && entry.kind === previous.kind
      );
      if (candidates.length === 0) return null;
      return candidates.reduce((best, entry) =>
        Math.abs(entry.line - previous.line) < Math.abs(best.line - previous.line) ? entry : best
      );
    } catch {
      return null;
    }
  }

  function asFailure(cause: unknown): ApiFailure {
    if (cause instanceof ApiFailure) return cause;
    return new ApiFailure(0, 'error', cause instanceof Error ? cause.message : String(cause), null);
  }

  /* -------------------------------------------------------------- models -- */

  let callers = $derived(payload ? buildCallerRail(payload) : null);
  let callees = $derived(payload ? buildCalleeRail(payload) : null);
  let refs = $derived(payload ? refsByLine(payload) : new Map<number, LineRef[]>());
  let outline = $derived(payload ? buildOutline(payload) : []);

  let wantsBody = $derived(payload ? showsBody(payload.node.kind, payload.node.lines) : false);

  /**
   * The body on screen is the file's CURRENT source, not this symbol's.
   *
   * Everything the graph knows is anchored to line numbers the file no longer
   * has, so in this mode the ports, the call-site links, the definition-name
   * weight and the `?line=` highlight are all switched off together. Leaving
   * any one of them on would put a marking from the previous version of the
   * file over a line of the new one — a lie that looks exactly like the truth.
   */
  let showingCurrent = $derived(source?.showing === 'current');

  /** A drifted file too long to stand in for the body; the banner links out. */
  let driftTooLong = $derived(
    payload?.drift === true &&
      (source === null || (source.totalLines ?? 0) > DRIFT_INLINE_MAX_LINES)
  );

  let codeBlock = $derived.by(() => {
    if (!payload || !source?.lines) return null;
    if (showingCurrent) {
      if (driftTooLong) return null;
      return buildCodeBlock(source.from ?? 1, source.lines, []);
    }
    const from = source.from ?? payload.node.line;
    return buildCodeBlock(from, source.lines, graphCallLines(payload));
  });

  /**
   * Classified source by file line, from `/api/source`.
   *
   * Keyed by real file line rather than by window offset, because a windowed
   * body renumbers nothing: the gaps are holes in the same numbering, and the
   * code block looks a line up by the number it prints in the gutter.
   */
  let codeTokens = $derived.by(() => {
    if (!source?.lines) return new Map<number, Token[]>();
    return tokensByLine(source.lines, source.from ?? 1, source.highlight);
  });

  let origin = $derived(arrivedFrom());
  let originLeft = $derived(origin?.rail === 'left' ? origin.id : null);
  let originRight = $derived(origin?.rail === 'right' ? origin.id : null);

  let emptyCalleeReason = $derived.by(() => {
    if (!payload) return '';
    if (!wantsBody) {
      return `A ${payload.node.kind.replace(/_/g, ' ')} makes no calls itself — its members do. Open one from the outline.`;
    }
    return 'This symbol makes no resolved calls — a leaf.';
  });

  /* ------------------------------------------------------------ movement -- */

  /**
   * Follow a call. No line is carried across: the call-site line belongs to the
   * symbol being left, and the destination opens at its own definition.
   */
  function stepDown(node: WireNodeRef): void {
    walkTo(node, 'down');
  }

  /** Go to a caller, landing on the line that makes the call when one is named. */
  function stepUp(node: WireNodeRef, at?: number): void {
    walkTo(node, 'up', at);
  }

  /** A jump that is neither up nor down: a breadcrumb, a chip, a member. */
  function open(node: WireNodeRef): void {
    walkTo(node, 'start');
  }

  function followRef(ref: LineRef): void {
    if (!ref.targetId) return;
    const target = payload?.outgoing.items.find((r) => r.node.id === ref.targetId)?.node
      ?? payload?.typesUsed.find((r) => r.node.id === ref.targetId)?.node;
    if (target) walkTo(target, 'down');
  }

  /* ------------------------------------------------------------ keyboard -- */

  function leftRows(): WireNodeRef[] {
    return (callers?.groups ?? []).flatMap((group) => group.rows.map((row) => row.relation.node));
  }

  function rightRows(): WireNodeRef[] {
    return (callees?.rows ?? []).map((row) => row.relation.node);
  }

  function activeRows(): WireNodeRef[] {
    return railFocus.rail === 'left' ? leftRows() : rightRows();
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
        railFocus.switchTo('left');
        break;
      case 'ArrowRight':
        railFocus.switchTo('right');
        break;
      case 'ArrowDown':
      case 'j':
        railFocus.step(1, activeRows().length);
        break;
      case 'ArrowUp':
      case 'k':
        railFocus.step(-1, activeRows().length);
        break;
      case 'Enter': {
        const node = activeRows()[railFocus.index];
        if (node) {
          event.preventDefault();
          if (railFocus.rail === 'left') stepUp(node);
          else stepDown(node);
        }
        return;
      }
      default:
        return;
    }
    event.preventDefault();
    // Keep the selection on screen; the rails are the only thing that scrolls
    // out from under the keyboard.
    void tick().then(() => {
      const scope = railFocus.rail === 'left' ? leftRailEl : railEl;
      // Rows are the only focusable buttons in a rail, and they render in the
      // same order the keyboard walks them.
      scope?.querySelectorAll('[role="button"]')[railFocus.index]?.scrollIntoView({
        block: 'nearest',
      });
    });
  }

  /* ----------------------------------------------------------- measuring -- */

  /**
   * Place every callee row beside its call site, then draw the connectors.
   *
   * Rows are laid out in source order and never allowed to overlap: a row wants
   * to sit at the centre of its first call-site line, but takes
   * `previous + height + gap` when that would collide. Order beats exactness —
   * a rail whose rows jump around relative to the body stops being a reading of
   * the code — and the connector still runs to the line, so the displacement is
   * visible rather than silent.
   */
  function relayout(): void {
    const inner = innerEl;
    const center = centerEl;
    const rail = railEl;
    const rows = callees?.rows ?? [];
    if (!inner || !center || !rail) return;

    const headerHeight =
      rail.querySelector<HTMLElement>('[data-rail-header]')?.offsetHeight ?? RAIL_HEADER_FALLBACK;

    // A drifted file's body is the CURRENT source under CURRENT numbering, and
    // the rail's anchors are the numbers the index recorded. A line that
    // happens to exist in both is a coincidence, not a call site — so in that
    // mode nothing is anchored: the rows stack in source order and no
    // connector is drawn. The rail is still true about WHAT this symbol calls;
    // it has stopped being true about WHERE, and says so by not pointing.
    const anchored = !showingCurrent;

    const lineCentre = (n: number): number | null => {
      if (!anchored) return null;
      const el = center.querySelector<HTMLElement>(`[data-line="${n}"]`);
      return el ? el.offsetTop + el.offsetHeight / 2 : null;
    };

    let y = headerHeight + 14;
    const nextTops: number[] = [];
    const rowCentres: Array<number | null> = [];
    for (const row of rows) {
      const centre = row.anchor !== null ? lineCentre(row.anchor) : null;
      const wanted = centre !== null ? centre - ROW_HEIGHT / 2 : y;
      y = Math.max(wanted, y);
      nextTops.push(y);
      rowCentres.push(y + ROW_HEIGHT / 2);
      y += ROW_HEIGHT + ROW_GAP;
    }

    const nextFoldTop = y + 8;
    if ((callees?.uncertain.length ?? 0) > 0) {
      const fold = rail.querySelector<HTMLElement>('[data-rail-fold]');
      y = nextFoldTop + (fold?.offsetHeight ?? 30);
    }
    const nextNoteTop = y + 14;

    tops = nextTops;
    foldTop = nextFoldTop;
    noteTop = nextNoteTop;
    stageMinHeight = Math.max(center.offsetHeight, nextNoteTop + 60);

    // Connectors: one per call site, from the centre column's right edge to the
    // row's own centre. Both coordinate systems are the stage's, so the port
    // and the row agree even when the stage is scrolled.
    const x0 = center.offsetLeft + center.offsetWidth - 10;
    const x1 = rail.offsetLeft + 14;
    const cx = (x0 + x1) / 2;
    const next: Connector[] = [];
    rows.forEach((row, index) => {
      const ry = rowCentres[index];
      if (ry == null) return;
      const via = synthesizedBy(row.relation);
      for (const callLine of row.lines) {
        const ly = lineCentre(callLine);
        if (ly === null) continue;
        next.push({
          d: `M${x0},${ly} C${cx},${ly} ${cx},${ry} ${x1},${ry}`,
          targetId: row.relation.node.id,
          uncertain: row.relation.uncertain,
          heuristic: via !== null,
          origin: row.relation.node.id === originRight,
        });
      }
    });
    connectors = next;
    overlay = { width: inner.scrollWidth, height: Math.max(inner.offsetHeight, stageMinHeight) };
    placed = true;
  }

  let scheduled = false;
  function scheduleRelayout(): void {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      relayout();
    });
  }

  // Re-measure whenever what is drawn changes. The dependencies are the INPUTS
  // (the models and the block); the outputs it writes are read untracked inside
  // relayout(), so this cannot feed itself.
  $effect(() => {
    void codeBlock;
    void callees;
    void outline;
    void payload;
    void tick().then(scheduleRelayout);
  });

  // Layout is a function of pixels, not of data: a resized window, a loaded
  // font and an opened fold all move the lines without changing the payload.
  $effect(() => {
    const inner = innerEl;
    const center = centerEl;
    const rail = railEl;
    if (!inner || !center || !rail) return;
    const observer = new ResizeObserver(scheduleRelayout);
    observer.observe(inner);
    observer.observe(center);
    observer.observe(rail);
    // Opening a fold moves the rail's contents without resizing any box the
    // observer watches — the folds are absolutely positioned. `toggle` does not
    // bubble, so it is caught on the way down.
    inner.addEventListener('toggle', scheduleRelayout, true);
    void document.fonts?.ready.then(scheduleRelayout);
    return () => {
      observer.disconnect();
      inner.removeEventListener('toggle', scheduleRelayout, true);
    };
  });

  // Scroll the highlighted call site into view once, when it first appears —
  // and not again, so a later resize does not yank the reader back to it.
  let scrolledTo: string | null = null;
  $effect(() => {
    const key = line === null ? null : `${id}:${line}`;
    const center = centerEl;
    if (!key || !center || !codeBlock || scrolledTo === key) return;
    const el = center.querySelector(`[data-line="${line}"]`);
    if (!el) return;
    scrolledTo = key;
    el.scrollIntoView({ block: 'center' });
  });
</script>

<svelte:window {onkeydown} />

{#if failure}
  <div class="scroll">
    <div class="emptystate">
      <h2>{failure.code === 'not-found' ? 'No such symbol' : 'Could not load this symbol'}</h2>
      <p>{failure.message}</p>
      {#if failure.guidance}<p class="dim">{failure.guidance}</p>{/if}
    </div>
  </div>
{:else if loading || !payload || !callers || !callees}
  <div class="scroll">
    <div class="emptystate"><p class="dim">Loading…</p></div>
  </div>
{:else}
  <div class="focus">
    <aside class="rail-left" bind:this={leftRailEl} aria-label="Called by">
      <CallersRail
        model={callers}
        originId={originLeft}
        exported={payload.node.exported === true}
        onstepUp={stepUp}
      />
    </aside>

    <div class="stage">
      <div class="stage-inner" bind:this={innerEl} style:min-height={`${stageMinHeight}px`}>
        <Connectors {connectors} width={overlay.width} height={overlay.height} />

        <section class="center" bind:this={centerEl}>
          <SymbolHeader {payload} onopen={open} relationChips={!payload.hierarchy} />

          {#if payload.drift}
            <div class="banner">
              <DriftBanner file={payload.node.file}>
                {#if driftTooLong}
                  indexed line ranges may be shifted, and the file is too long to stand in for
                  this symbol's body here —
                  <a href={fileHref(payload.node.file, { source: true })}>open its current source</a>.
                  The next sync picks it up.
                {:else}
                  indexed line ranges may be shifted; showing the file's current source. The next
                  sync picks it up.
                {/if}
              </DriftBanner>
            </div>
          {/if}

          {#if payload.hierarchy}
            <TypeHierarchy hierarchy={payload.hierarchy} focus={payload.node} onopen={open} />
          {/if}

          {#if codeBlock}
            <SourceBlock
              block={codeBlock}
              tokens={codeTokens}
              refs={showingCurrent ? EMPTY_REFS : refs}
              defLine={showingCurrent ? -1 : payload.node.line}
              defName={showingCurrent ? '' : payload.node.name}
              highlight={showingCurrent ? null : line}
              onfollow={followRef}
            />
          {:else if payload.drift}
            <!-- The banner above is the whole answer for this file. -->
          {:else if !wantsBody}
            <!-- The outline below IS the body for a container this size. -->
          {:else if source}
            <div class="note">{source.reason ?? 'Source is not available for this symbol.'}</div>
          {/if}

          {#if outline.length > 0}
            <MembersOutline
              rows={outline}
              total={payload.members.total}
              truncated={payload.members.truncated}
              onopen={open}
            />
          {/if}

          {#if payload.blast}
            <BlastStrip
              blast={payload.blast}
              scale={project.stats?.blastScale ?? null}
              testCalls={callers.tests.calls}
              testFiles={callers.tests.files.length}
            />
          {/if}
        </section>

        <aside class="rail-right" bind:this={railEl} aria-label="Calls">
          <CalleeRail
            model={callees}
            {tops}
            {foldTop}
            {noteTop}
            {placed}
            focalFile={payload.node.file}
            originId={originRight}
            emptyReason={emptyCalleeReason}
            onstepDown={stepDown}
          />
        </aside>
      </div>
    </div>
  </div>
{/if}

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .focus {
    display: grid;
    grid-template-columns: 300px minmax(520px, 1fr);
    height: 100%;
    min-height: 0;
  }

  .rail-left {
    overflow: auto;
    border-right: 1px solid var(--rule-soft);
    background: var(--paper);
  }

  .stage {
    position: relative;
    overflow: auto;
  }

  /* The positioning context every measured coordinate is expressed in: line
     offsets, rail row tops and the SVG overlay all share this origin. */
  .stage-inner {
    position: relative;
    display: grid;
    grid-template-columns: minmax(480px, 1fr) 320px;
    min-height: 100%;
  }

  .center {
    min-width: 0;
    padding: 18px 22px 40px;
  }

  .rail-right {
    position: relative;
    border-left: 1px solid var(--rule-faint);
  }

  .banner {
    margin: 16px 0 4px;
  }

  .note {
    padding: 12px 0;
    color: var(--ink-3);
    font-size: 12px;
  }

  @media (max-width: 1100px) {
    .focus {
      grid-template-columns: 240px minmax(360px, 1fr);
    }

    .stage-inner {
      grid-template-columns: minmax(360px, 1fr) 260px;
    }
  }
</style>
