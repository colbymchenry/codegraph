<!--
  Calls — the right rail (design spec §3.2).

  Every row is absolutely positioned beside the line that makes the call, which
  is the whole idea of the screen: the callee list is not a list, it is an
  annotation of the body. Rows keep source order and are pushed down when two
  call sites are closer together than a row is tall, so the sequence still reads
  top to bottom even where the geometry cannot be exact.

  The tops are computed by the view, which is the only thing that can measure
  where a line ended up. This component draws what it is told.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { hot, railFocus } from '../../lib/focus.svelte';
  import { plural, type CalleeRailModel, type CalleeRow } from '../../lib/symbol-model';
  import type { WireNodeRef } from '../../lib/api';

  interface Props {
    model: CalleeRailModel;
    /** Top offset in px for each row in `model.rows`, same order. */
    tops: number[];
    foldTop: number;
    noteTop: number;
    /** False until the view has measured the rail — see SymbolView. */
    placed: boolean;
    /** The focal symbol's file — a callee in it reads "same file", not a path. */
    focalFile: string;
    /** The symbol this one was reached from, when it is a callee. */
    originId: string | null;
    /** Empty-rail wording depends on why it is empty. */
    emptyReason: string;
    onstepDown: (node: WireNodeRef) => void;
  }

  let { model, tops, foldTop, noteTop, placed, focalFile, originId, emptyReason, onstepDown }: Props =
    $props();

  function rowTitle(row: CalleeRow): string {
    return `${row.relation.node.qualifiedName} — ${row.relation.node.file}:${row.relation.node.line}`;
  }
</script>

<div class="rail-h" data-rail-header>
  <span>Calls <span class="n">{model.rows.length}</span></span>
  <span class="hint">step down →</span>
</div>

{#each model.rows as row, i (row.relation.node.id)}
  {@const node = row.relation.node}
  <div
    class="rrow"
    class:origin={node.id === originId}
    class:hot={hot.is(node.id)}
    class:sel={railFocus.at('right', i)}
    class:unplaced={!placed}
    style:top={`${tops[i] ?? 0}px`}
    data-target={node.id}
    role="button"
    tabindex="0"
    title={rowTitle(row)}
    onclick={() => onstepDown(node)}
    onkeydown={(e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onstepDown(node);
      }
    }}
    onmouseenter={() => hot.set(node.id)}
    onmouseleave={() => hot.clear(node.id)}
  >
    <KindGlyph kind={node.kind} />
    <div class="body">
      <div class="nm">
        {node.name}{#if row.lines.length > 1}<span class="dim"> ×{row.lines.length}</span>{/if}
      </div>
      <div class="meta">
        <span>{node.file === focalFile ? 'same file' : node.file}</span>
        {#if row.words.length > 0}<span>{row.words.join(', ')}</span>{/if}
        {#if row.relation.hub}<span class="tag">hub · {row.relation.fanIn}</span>{/if}
        {#if row.via}<span class="tag" title="A synthesized edge — dynamic dispatch the parser cannot see"
            >via {row.via}</span
          >{/if}
        {#each row.when as w (w)}<span class="tag when" title="The call runs only under this condition — read from the source as it is now"
            >when {w}</span
          >{/each}
      </div>
    </div>
  </div>
{/each}

{#if model.uncertain.length > 0}
  <details class="rfold" class:unplaced={!placed} data-rail-fold style:top={`${foldTop}px`}>
    <summary>
      Uncertain <span class="dim"
        >· {model.uncertain.length} name-only match{model.uncertain.length === 1 ? '' : 'es'},
        confidence &lt; 0.6</span
      >
    </summary>
    <div class="fold-body">
      {#each model.uncertain as row (row.relation.node.id)}
        {@const node = row.relation.node}
        <div
          class="rrow static uncertain"
          class:hot={hot.is(node.id)}
          data-target={node.id}
          role="button"
          tabindex="0"
          title={rowTitle(row)}
          onclick={() => onstepDown(node)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onstepDown(node);
            }
          }}
          onmouseenter={() => hot.set(node.id)}
          onmouseleave={() => hot.clear(node.id)}
        >
          <KindGlyph kind={node.kind} />
          <div class="body">
            <div class="nm">{node.name}</div>
            <div class="meta">
              <span>{node.file}</span>
              {#if row.relation.confidence !== null}<span>{row.relation.confidence}</span>{/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  </details>
{/if}

{#if model.rows.length === 0 && model.uncertain.length === 0}
  <div class="rnote" style:top="60px">{emptyReason}</div>
{:else if model.outsideCalls > 0 || model.outsideTypeRefs > 0 || model.hiddenGroups > 0}
  <div class="rnote" class:unplaced={!placed} style:top={`${noteTop}px`}>
    {#if model.outsideCalls > 0}
      +{plural(model.outsideCalls, 'more call')} into symbols outside the index{#if model.outsideTypeRefs > 0}{' '}·
        {plural(model.outsideTypeRefs, 'type reference')}{/if}.
    {:else if model.outsideTypeRefs > 0}
      {plural(model.outsideTypeRefs, 'type reference')} into symbols outside the index.
    {/if}
    {#if model.hiddenGroups > 0}
      <br />+{model.hiddenGroups} more callee{model.hiddenGroups === 1 ? '' : 's'} not shown.
    {/if}
  </div>
{/if}

<style>
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

  .rail-h .n {
    color: var(--ink-3);
    font-weight: 400;
  }

  .rail-h .hint {
    color: var(--ink-3);
    font-weight: 400;
    font-size: 11.5px;
  }

  /* Positioned by measurement, so it must not paint before it is measured. */
  .unplaced {
    visibility: hidden;
  }

  .rrow {
    position: absolute;
    right: 12px;
    left: 14px;
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    align-items: center;
    height: 34px;
    padding: 0 6px;
    border: 1px solid transparent;
    cursor: pointer;
  }

  /* Inside the uncertain fold the rows are a list again — nothing to line up
     with, because an unresolved edge has no trustworthy call site. */
  .rrow.static {
    position: static;
    height: auto;
    padding: 4px 6px;
  }

  .rrow:hover {
    background: var(--press);
  }

  .rrow.sel {
    border-color: var(--ink);
  }

  .rrow.hot {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .rrow.origin {
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

  .tag.when {
    color: var(--ink-2);
  }

  .rfold {
    position: absolute;
    right: 12px;
    left: 14px;
  }

  .rfold summary {
    padding: 6px;
    color: var(--ink-2);
    cursor: pointer;
    font-size: 12px;
    list-style: none;
  }

  .rfold summary::-webkit-details-marker {
    display: none;
  }

  .rfold summary::before {
    content: '+ ';
    color: var(--ink-3);
    font-family: var(--mono);
  }

  .rfold[open] summary::before {
    content: '− ';
  }

  .rnote {
    position: absolute;
    right: 12px;
    left: 20px;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>
