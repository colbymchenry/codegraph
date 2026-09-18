<!--
  One side of the File view: the files this one depends on, or the files that
  depend on it (design spec §3.4).

  Both rails are the same component because the row is the same thing in both
  directions — a file, whether it is reachable or reaching. The count in the
  header is the engine's own `getFileDependencies` / `getFileDependents`
  answer, so a rail and a blast radius can never disagree about how far a
  change here goes.

  Imports that resolved to nothing indexed — packages, runtime builtins — sit
  below the files, in `--ink-3` and not clickable. Leaving them out would make
  a file importing `react`, `fs` and one local module show a single row and
  read as broken.
-->
<script lang="ts">
  import { fileHref } from '../../lib/navigation';
  import { plural } from '../../lib/symbol-model';
  import type { FileRailModel, FileRailRow } from '../../lib/file-model';

  interface Props {
    title: string;
    model: FileRailModel;
    /** "none in the graph" reads wrong for both directions; each says its own. */
    emptyNote: string;
    side: 'left' | 'right';
    /** Index of the keyboard's position in this rail, or -1. */
    selected?: number;
    onhover?: (index: number) => void;
  }

  let { title, model, emptyNote, side, selected = -1, onhover }: Props = $props();

  /**
   * A path is drawn as a shrinkable directory plus a basename that never
   * truncates: the last segment is what tells two `index.ts` apart, so it is
   * the one part of a 300px column that must survive.
   */
  function dirOf(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut < 0 ? '' : path.slice(0, cut + 1);
  }

  function baseOf(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
  }

  function rowTitle(row: FileRailRow): string {
    if (row.symbols.length === 0) return row.path;
    const names = row.symbols.map((s) => s.name).join(', ');
    const more = row.symbolCount > row.symbols.length ? ', …' : '';
    return `${row.path} — ${names}${more}`;
  }
</script>

<div class="rail" class:right={side === 'right'} aria-label={title}>
  <div class="rail-h">
    <span>{title} <span class="n">{model.total}</span></span>
  </div>

  {#if model.rows.length === 0}
    <div class="note">{emptyNote}</div>
  {/if}

  {#each model.rows as row, index (row.path)}
    <a
      class="filerow"
      class:test={row.test}
      class:sel={index === selected}
      href={fileHref(row.path)}
      title={rowTitle(row)}
      onmouseenter={() => onhover?.(index)}
    >
      <span class="p"><span class="dir">{dirOf(row.path)}</span><span class="base"
          >{baseOf(row.path)}</span
        ></span>
      {#if row.symbolCount > 0}
        <span class="n2">{row.symbolCount}</span>
      {/if}
    </a>
  {/each}

  {#if model.testCount > 0 && model.testCount < model.rows.length}
    <div class="note dim">
      {plural(model.testCount, 'test file')} at the end of the list.
    </div>
  {/if}

  {#if model.outside.length > 0}
    <div class="sub">
      Outside the index <span class="n">{model.outside.length}</span>
    </div>
    {#each model.outside as row (row.name)}
      <div class="filerow outside" title={`imported at line ${row.lines.join(', ')}`}>
        <span class="p"><span class="dir">{row.name}</span></span>
        {#if row.lines.length > 1}<span class="n2">×{row.lines.length}</span>{/if}
      </div>
    {/each}
    <div class="note dim">
      Packages and runtime modules — nothing was indexed for them, so this
      viewer cannot open them.
    </div>
  {/if}
</div>

<style>
  .rail {
    overflow: auto;
    height: 100%;
    border-right: 1px solid var(--rule-soft);
    background: var(--paper);
  }

  .rail.right {
    border-right: none;
    border-left: 1px solid var(--rule-soft);
  }

  .rail-h {
    position: sticky;
    top: 0;
    z-index: 2;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: 12px 14px 8px;
    border-bottom: 1px solid var(--rule-soft);
    background: var(--paper);
    font-weight: 600;
    font-size: 13px;
  }

  .rail-h .n,
  .sub .n {
    color: var(--ink-3);
    font-weight: 400;
  }

  .sub {
    margin-top: 14px;
    padding: 10px 14px 4px;
    border-top: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font-size: 12px;
  }

  .filerow {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 8px;
    align-items: baseline;
    padding: 5px 14px;
    border-bottom: 1px solid var(--rule-faint);
    color: var(--ink-2);
    font: 12px var(--mono);
    text-decoration: none;
  }

  a.filerow:hover,
  a.filerow.sel {
    background: var(--press);
    color: var(--ink);
  }

  /* Not a link, and drawn so — nothing was indexed to open. */
  .filerow.outside {
    color: var(--ink-3);
    cursor: default;
  }

  .p {
    display: flex;
    min-width: 0;
  }

  .dir {
    overflow: hidden;
    flex: 0 1 auto;
    color: var(--ink-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .base {
    flex: 0 0 auto;
    white-space: nowrap;
  }

  .filerow.test .base {
    color: var(--ink-3);
  }

  .n2 {
    color: var(--ink-3);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  .note {
    padding: 8px 14px;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .note.dim {
    color: var(--ink-4);
  }
</style>
