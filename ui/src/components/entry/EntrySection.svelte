<!--
  One section of the entry-points panel — routes, executable files, tests, hubs.

  The file-group + row shapes are the Symbol view's caller rail (design spec
  §3.2, `.filegroup` / `.row`), reused rather than re-invented: they are the
  repo's established "a list of code, grouped by where it lives", and a second
  visual language for the same idea is how a small app starts looking like two.

  Every row does two things. Clicking it opens the code — a handler, a file, a
  hub. The `Flow ›` chip beside it arms a flow FROM that symbol, which the panel
  then completes with a second name. Rows that name no callable symbol carry no
  chip: `/api/flow` searches by name, and a file has none the path finder can
  look up.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { fileHref } from '../../lib/navigation';
  import type { EntryRow, EntrySection } from '../../lib/entry-model';

  interface Props {
    section: EntrySection;
    /** The row currently armed as a flow's start, by row id. */
    armed: string | null;
    onopen: (row: EntryRow) => void;
    onflow: (row: EntryRow) => void;
  }

  let { section, armed, onopen, onflow }: Props = $props();
</script>

<section class="sec" aria-labelledby={`entry-${section.id}`}>
  <div class="sec-h">
    <h3 id={`entry-${section.id}`}>{section.title}</h3>
    <span class="meta">{section.meta}</span>
  </div>
  <p class="note">{section.note}</p>

  {#each section.groups as group (group.path)}
    <div class="filegroup">
      <div class="fpath">
        {#if group.file}
          <a href={fileHref(group.file)} title={group.file}>{group.path}</a>
        {:else}
          <span title={group.path}>{group.path}</span>
        {/if}
        <b>{group.rows.length}</b>
      </div>
      {#each group.rows as row (row.id)}
        <div class="row" class:armed={armed === row.id} class:stub={!row.target}>
          <KindGlyph kind={row.kind} />
          <div class="body">
            <div class="line">
              {#if row.target}
                <button
                  type="button"
                  class="nm"
                  title={row.title}
                  data-entry-row={row.id}
                  onclick={() => onopen(row)}
                >
                  {#if row.method}<span class="verb">{row.method}</span>{/if}{row.name}
                </button>
              {:else}
                <span class="nm plain" title={row.title}>
                  {#if row.method}<span class="verb">{row.method}</span>{/if}{row.name}
                </span>
              {/if}
              {#if row.flowFrom}
                {@const label =
                  armed === null ? 'Flow ›' : armed === row.id ? 'Cancel' : '→ here'}
                <button
                  type="button"
                  class="chip"
                  title={armed === null
                    ? `Start a flow from ${row.flowFrom}`
                    : armed === row.id
                      ? 'Stop drawing a flow from here'
                      : `Draw the path that ends at ${row.flowFrom}`}
                  data-entry-flow={row.id}
                  onclick={() => onflow(row)}>{label}</button
                >
              {/if}
            </div>
            <div class="meta">{row.meta}</div>
          </div>
        </div>
      {/each}
    </div>
  {/each}

  {#if section.shown < section.total}
    <p class="note dim">
      Showing {section.shown} of {section.floor ? 'at least ' : ''}{section.total} — the rest are in
      the index, not on this list.
    </p>
  {/if}
</section>

<style>
  .sec {
    padding: 0 0 18px;
    border-bottom: 1px solid var(--rule-faint);
  }

  .sec:last-child {
    border-bottom: 0;
  }

  .sec-h {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 14px 2px;
  }

  .sec-h h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }

  .sec-h .meta {
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .note {
    margin: 0;
    padding: 2px 14px 4px;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .note.dim {
    color: var(--ink-4);
  }

  .filegroup {
    padding: 10px 14px 4px;
  }

  .fpath {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--ink-3);
    font: 11px var(--mono);
  }

  .fpath a:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  .fpath b {
    color: var(--ink-2);
    font-weight: 500;
  }

  .row {
    position: relative;
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    align-items: start;
    margin: 0 -6px;
    padding: 5px 6px 5px 4px;
    border: 1px solid transparent;
  }

  .row:hover {
    background: var(--press);
  }

  .row.armed {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .body {
    min-width: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .nm {
    overflow: hidden;
    min-width: 0;
    color: var(--ink);
    font: 12.5px var(--mono);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nm:not(.plain) {
    cursor: pointer;
  }

  .row.stub .nm {
    color: var(--ink-2);
  }

  .verb {
    margin-right: 6px;
    color: var(--ink-2);
    font-weight: 500;
  }

  .meta {
    margin-top: 1px;
    overflow: hidden;
    color: var(--ink-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .chip {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink-2);
    font: 11px var(--mono);
  }

  .chip:hover {
    border-color: var(--ink);
    color: var(--ink);
  }
</style>
