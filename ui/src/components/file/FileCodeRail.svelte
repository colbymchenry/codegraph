<!--
  The whole-file view's callee rail: one row per (calling symbol, called symbol)
  pair, beside the line that makes the call (design spec §3.4, task CG-52).

  The Symbol view's rail annotates one body. This one annotates a whole file, so
  the unit is the PAIR rather than the callee: the same helper called from two
  functions a thousand lines apart is two rows, because a row is anchored to a
  line and there is no line that is both. `buildFileCallRows` does the placing;
  the view windows it; this draws what it is handed.

  Uncertain rows are not folded away here. In a single body the fold is what
  keeps a guess from reading as a resolved call — there is a header to hang it
  under. Across six thousand lines there is nowhere to put a fold that does not
  detach it from the source, so a name-only match stays where its call site is
  and wears the dotted underline that says what it is.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { hot } from '../../lib/focus.svelte';
  import type { FileCallRow } from '../../lib/filecode-model';
  import type { WireNodeRef } from '../../lib/api';

  interface Props {
    /** Already windowed to the viewport by the view. */
    rows: FileCallRow[];
    /** This file's path — a callee inside it reads "same file", not a path. */
    focalFile: string;
    /** The symbol whose neighbourhood is lit. */
    focusId: string | null;
    onopen: (node: WireNodeRef) => void;
    onhover: (row: FileCallRow | null) => void;
  }

  let { rows, focalFile, focusId, onopen, onhover }: Props = $props();

  function title(row: FileCallRow): string {
    const node = row.call.relation.node;
    const where = row.lines.length > 0 ? ` · called from line ${row.lines.join(', ')}` : '';
    return `${node.qualifiedName} — ${node.file}:${node.line}${where}`;
  }
</script>

{#each rows as row (row.key)}
  {@const node = row.call.relation.node}
  <div
    class="rrow"
    class:hot={hot.is(node.id)}
    class:focused={focusId !== null && (row.ownerId === focusId || node.id === focusId)}
    class:uncertain={row.call.relation.uncertain}
    style:top={`${row.top}px`}
    data-target={node.id}
    role="button"
    tabindex="0"
    title={title(row)}
    onclick={() => onopen(node)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onopen(node);
      }
    }}
    onmouseenter={() => {
      hot.set(node.id);
      onhover(row);
    }}
    onmouseleave={() => {
      hot.clear(node.id);
      onhover(null);
    }}
  >
    <KindGlyph kind={node.kind} />
    <div class="body">
      <div class="nm">
        {node.name}{#if row.lines.length > 1}<span class="dim"> ×{row.lines.length}</span>{/if}
      </div>
      <div class="meta">
        <span>{node.file === focalFile ? 'same file' : node.file}</span>
        {#if row.words.length > 0}<span>{row.words.join(', ')}</span>{/if}
        {#if row.via}<span
            class="tag"
            title="A synthesized edge — dynamic dispatch the parser cannot see">via {row.via}</span
          >{/if}
      </div>
    </div>
  </div>
{/each}

<style>
  .rrow {
    position: absolute;
    right: 12px;
    left: 14px;
    display: grid;
    height: 34px;
    box-sizing: border-box;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    align-items: center;
    padding: 0 6px;
    border: 1px solid transparent;
    background: var(--paper);
    cursor: pointer;
  }

  .rrow:hover {
    background: var(--press);
  }

  .rrow.focused {
    border-color: var(--rule-soft);
  }

  .rrow.hot {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .body {
    min-width: 0;
  }

  .nm {
    overflow: hidden;
    font: 12.5px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .rrow.uncertain .nm {
    color: var(--ink-2);
    text-decoration: underline dotted var(--ink-4);
    text-underline-offset: 3px;
  }

  .meta {
    display: flex;
    gap: 8px;
    overflow: hidden;
    color: var(--ink-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tag {
    flex: 0 0 auto;
    padding: 0 4px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-3);
    font-size: 10.5px;
  }
</style>
