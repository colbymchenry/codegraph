<!--
  The file's symbols in source order (design spec §3.4).

  Same row geometry as the Symbol view's members outline — `16px | name | 1fr |
  counts` — because they answer the same question at two scales, and a reader
  who has learned one should not have to learn the other. What differs is the
  right column: a file outline prints the LINE number as well as the edge
  counts, since source order is the only ordering here and the line is how a
  row is found in an editor.

  Long files are windowed rather than paged. `worker-configuration.d.ts` in
  this repo's own fixtures holds 1,681 symbols; rendering them all costs about
  a second of layout on every scroll, and paging would hide exactly the thing
  the outline exists to give — one uninterrupted read of the file's shape.
  Rows are a fixed height (pinned in the CSS below, and asserted by the
  `OUTLINE_ROW_HEIGHT` constant) so the window's arithmetic stays exact.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import type { WireNodeRef } from '../../lib/api';
  import {
    OUTLINE_ROW_HEIGHT,
    OUTLINE_VIRTUAL_THRESHOLD,
    type OutlineEntryRow,
  } from '../../lib/file-model';

  interface Props {
    rows: OutlineEntryRow[];
    total: number;
    truncated: boolean;
    /** The scroll container the rows live inside — the view's centre column. */
    scroller: HTMLElement | null;
    /** Index of the keyboard's position, or -1. */
    selected?: number;
    onopen: (node: WireNodeRef) => void;
    onhover?: (index: number) => void;
  }

  let { rows, total, truncated, scroller, selected = -1, onopen, onhover }: Props = $props();

  let listEl = $state<HTMLDivElement | null>(null);
  let scrollTop = $state(0);
  let viewport = $state(0);

  let virtual = $derived(rows.length > OUTLINE_VIRTUAL_THRESHOLD);

  /**
   * The slice to draw, plus the spacer heights that keep the scrollbar honest.
   *
   * The offset is measured against the SCROLLER, not the list, because the
   * header above the outline scrolls with it: `listEl.offsetTop` is where the
   * first row starts inside that coordinate space. An overscan of eight rows
   * covers a fast flick between two measurements.
   */
  let window_ = $derived.by(() => {
    if (!virtual) return { start: 0, end: rows.length, before: 0, after: 0 };
    const top = listEl ? listEl.offsetTop : 0;
    const first = Math.floor((scrollTop - top) / OUTLINE_ROW_HEIGHT) - 8;
    const count = Math.ceil((viewport || 800) / OUTLINE_ROW_HEIGHT) + 16;
    const start = Math.max(0, Math.min(rows.length - 1, first));
    const end = Math.max(start, Math.min(rows.length, start + count));
    return {
      start,
      end,
      before: start * OUTLINE_ROW_HEIGHT,
      after: (rows.length - end) * OUTLINE_ROW_HEIGHT,
    };
  });

  // Keep the row the keyboard just moved to on screen. Rows are a fixed height
  // in both modes, so the arithmetic is the same — and it has to be arithmetic
  // rather than `scrollIntoView`, because a windowed row far outside the drawn
  // slice has no element to scroll to.
  $effect(() => {
    if (selected < 0 || !scroller || !listEl) return;
    const rowTop = listEl.offsetTop + selected * OUTLINE_ROW_HEIGHT;
    const rowBottom = rowTop + OUTLINE_ROW_HEIGHT;
    if (rowTop < scroller.scrollTop) scroller.scrollTop = rowTop - OUTLINE_ROW_HEIGHT;
    else if (rowBottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = rowBottom - scroller.clientHeight + OUTLINE_ROW_HEIGHT;
    }
  });

  $effect(() => {
    const el = scroller;
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

<div class="subh">
  <span>Outline</span>
  <span class="n">in source order</span>
  <span class="n count">{total}</span>
</div>

<div class="outline" bind:this={listEl}>
  {#if window_.before > 0}<div style:height={`${window_.before}px`}></div>{/if}
  {#each rows.slice(window_.start, window_.end) as row, offset (row.entry.id)}
    {@const index = window_.start + offset}
    <button
      type="button"
      class="orow"
      class:dimmed={row.dimmed}
      class:sel={index === selected}
      style:padding-left={`${4 + row.indent * 22}px`}
      onclick={() => onopen(row.entry)}
      onmouseenter={() => onhover?.(index)}
      title={`${row.entry.qualifiedName} — line ${row.entry.line}`}
    >
      <KindGlyph kind={row.entry.kind} />
      <span class="nm">{row.entry.name}</span>
      <span class="sig">{row.entry.signature ?? ''}</span>
      <span class="cnt">
        {row.entry.line}{#if row.entry.fanIn}&nbsp;· ← {row.entry.fanIn}{/if}{#if row.entry.fanOut}&nbsp;·
          → {row.entry.fanOut}{/if}
      </span>
    </button>
  {/each}
  {#if window_.after > 0}<div style:height={`${window_.after}px`}></div>{/if}
</div>

{#if rows.length === 0}
  <div class="note">
    Nothing was extracted from this file — it holds no symbols the graph
    recognises, only top-level code, or a language without an extractor.
  </div>
{/if}

{#if truncated}
  <div class="note">
    Showing {rows.length} of {total} symbols. The rest are in the index; this
    screen caps what it draws.
  </div>
{/if}

<style>
  .subh {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 18px 0 4px;
    font-weight: 600;
    font-size: 13px;
  }

  .subh .n {
    color: var(--ink-3);
    font-weight: 400;
  }

  .subh .count {
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }

  .outline {
    border-top: 1px solid var(--rule);
  }

  /* The height here is load-bearing: the windowing arithmetic above assumes
     every row is exactly OUTLINE_ROW_HEIGHT tall. Any change must move both. */
  .orow {
    display: grid;
    height: 28px;
    box-sizing: border-box;
    grid-template-columns: 16px minmax(160px, auto) 1fr auto;
    width: 100%;
    align-items: center;
    gap: 10px;
    padding: 0 4px;
    border-bottom: 1px solid var(--rule-faint);
    text-align: left;
  }

  .orow:hover,
  .orow.sel {
    background: var(--press);
  }

  .nm {
    overflow: hidden;
    font: 12.5px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .orow.dimmed .nm {
    color: var(--ink-3);
  }

  .sig {
    overflow: hidden;
    color: var(--ink-3);
    font: 11.5px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cnt {
    color: var(--ink-3);
    font: 11px var(--mono);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .note {
    padding: 10px 0;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.5;
  }
</style>
