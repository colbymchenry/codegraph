<!--
  The sticky navigation rail beside the whole-file source (design spec §3.4,
  task CG-52). Shown when there is room for it — under 1400px the view drops it
  rather than squeezing the code.

  The same rows as the File view's outline, at navigation weight: a click
  scrolls the source to that definition rather than leaving the file. Rows are a
  fixed height and the list is windowed above a threshold, for the same reason
  the outline view's is — this repo's own fixtures hold a 1 681-symbol `.d.ts`.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { OUTLINE_VIRTUAL_THRESHOLD, type OutlineEntryRow } from '../../lib/file-model';
  import { NAV_ROW_HEIGHT } from '../../lib/filecode-model';

  interface Props {
    rows: OutlineEntryRow[];
    total: number;
    truncated: boolean;
    /** Id of the symbol the reader is inside, from the scroll position. */
    currentId: string | null;
    ongo: (line: number, id: string) => void;
  }

  let { rows, total, truncated, currentId, ongo }: Props = $props();

  let listEl = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);

  let virtual = $derived(rows.length > OUTLINE_VIRTUAL_THRESHOLD);

  let window_ = $derived.by(() => {
    if (!virtual) return { start: 0, end: rows.length, before: 0, after: 0 };
    const first = Math.floor(scrollTop / NAV_ROW_HEIGHT) - 8;
    const count = Math.ceil((viewport || 800) / NAV_ROW_HEIGHT) + 16;
    const start = Math.max(0, Math.min(rows.length - 1, first));
    const end = Math.max(start, Math.min(rows.length, start + count));
    return {
      start,
      end,
      before: start * NAV_ROW_HEIGHT,
      after: (rows.length - end) * NAV_ROW_HEIGHT,
    };
  });

  // Follow the reader down the file: when the source scrolls into another
  // symbol, bring its row into the rail rather than making them find it.
  $effect(() => {
    const id = currentId;
    const el = listEl;
    if (!id || !el) return;
    const at = rows.findIndex((row) => row.entry.id === id);
    if (at < 0) return;
    const top = at * NAV_ROW_HEIGHT;
    const scroller = el.parentElement;
    if (!scroller) return;
    if (top < scroller.scrollTop) scroller.scrollTop = top - NAV_ROW_HEIGHT * 2;
    else if (top + NAV_ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = top + NAV_ROW_HEIGHT * 3 - scroller.clientHeight;
    }
  });

  $effect(() => {
    const el = listEl?.parentElement;
    if (!el) return;
    const read = () => {
      scrollTop = el.scrollTop;
      viewport = el.clientHeight;
    };
    read();
    el.addEventListener('scroll', read, { passive: true });
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', read);
      observer.disconnect();
    };
  });
</script>

<div class="navrail">
  <div class="navh">
    <span>Outline</span>
    <span class="dim">{total}</span>
  </div>
  <div class="navlist">
    <div bind:this={listEl}>
      {#if window_.before > 0}<div style:height={`${window_.before}px`}></div>{/if}
      {#each rows.slice(window_.start, window_.end) as row (row.entry.id)}
        <button
          type="button"
          class="nrow"
          class:dimmed={row.dimmed}
          class:current={row.entry.id === currentId}
          style:padding-left={`${6 + row.indent * 14}px`}
          title={`${row.entry.qualifiedName} — line ${row.entry.line}`}
          onclick={() => ongo(row.entry.line, row.entry.id)}
        >
          <KindGlyph kind={row.entry.kind} />
          <span class="nm">{row.entry.name}</span>
          <span class="ln">{row.entry.line}</span>
        </button>
      {/each}
      {#if window_.after > 0}<div style:height={`${window_.after}px`}></div>{/if}
    </div>
  </div>
  {#if truncated}
    <div class="note">Showing {rows.length} of {total} symbols.</div>
  {/if}
</div>

<style>
  .navrail {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    height: 100%;
    border-right: 1px solid var(--rule-soft);
    background: var(--paper);
  }

  .navh {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 12px 12px 8px;
    border-bottom: 1px solid var(--rule-soft);
    font-weight: 600;
    font-size: 13px;
  }

  .navlist {
    min-height: 0;
    overflow: auto;
  }

  /* Fixed height — the windowing above assumes it (NAV_ROW_HEIGHT). */
  .nrow {
    display: grid;
    height: 24px;
    box-sizing: border-box;
    grid-template-columns: 14px minmax(0, 1fr) auto;
    width: 100%;
    align-items: center;
    gap: 7px;
    padding-right: 8px;
    text-align: left;
  }

  .nrow:hover {
    background: var(--press);
  }

  .nrow.current {
    background: var(--accent-soft);
  }

  .nm {
    overflow: hidden;
    font: 12px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nrow.dimmed .nm {
    color: var(--ink-3);
  }

  .ln {
    color: var(--ink-4);
    font: 10.5px var(--mono);
    font-variant-numeric: tabular-nums;
  }

  .note {
    padding: 8px 12px;
    border-top: 1px solid var(--rule-faint);
    color: var(--ink-3);
    font-size: 11px;
  }
</style>
