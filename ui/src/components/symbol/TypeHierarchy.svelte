<!--
  The type hierarchy: what this type is built on, and what is built on it
  (design spec §3.10).

  It sits above the members outline because it changes how the outline reads. A
  method on a class that implements a twelve-member interface is not the same
  object as a method on a class nothing extends: one is a contract you can break
  for eleven other files, the other is a private detail. The tree says which
  before the member list is on screen, and the outline's "overrides X" marks
  come from the same walk.

  Layout is arithmetic — fixed row height, fixed indent step — so the connectors
  are drawn from two numbers rather than measured. `implements` is dashed and
  `extends` solid; a synthesized edge (Go's implicit interface satisfaction) is
  dashed wider and says where it was wired, exactly as the Flow strip draws a
  synthesized hop.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import type { WireHierarchy, WireNodeDetail, WireNodeRef } from '../../lib/api';
  import {
    buildHierarchyModel,
    connectorPath,
    visibleHierarchy,
    HIER_ROW_H,
  } from '../../lib/hierarchy-model';

  interface Props {
    hierarchy: WireHierarchy;
    focus: WireNodeDetail;
    onopen: (node: WireNodeRef) => void;
  }

  let { hierarchy, focus, onopen }: Props = $props();

  let expanded = $state(false);
  let model = $derived(buildHierarchyModel(hierarchy, focus));
  let view = $derived(visibleHierarchy(model, expanded));

  // Reset the fold when the reader navigates to another type — an expanded fan
  // left open across a navigation would silently apply to a different symbol.
  $effect(() => {
    focus.id;
    expanded = false;
  });

  let counts = $derived(
    [
      hierarchy.ancestors.total > 0
        ? `${hierarchy.ancestors.total} above`
        : '',
      hierarchy.direct > 0 ? `${hierarchy.descendants.total} below` : '',
    ]
      .filter(Boolean)
      .join(' · ')
  );

  function title(row: (typeof view.rows)[number]): string {
    const where = `${row.node.file}:${row.node.line}`;
    if (!row.entry) return `${row.node.qualifiedName} — ${where}`;
    const wiring = row.entry.synthesized
      ? ` — matched by ${row.entry.via ?? 'the resolver'}${row.entry.registeredAt ? ` at ${row.entry.registeredAt}` : ''}`
      : '';
    return `${row.node.qualifiedName} — ${where}${wiring}`;
  }
</script>

<div class="subh">
  <span>Type hierarchy</span>
  <span class="n">{counts}</span>
  <span class="hint">supertypes above · subtypes below</span>
</div>

{#if model.headline}
  <p class="headline">{model.headline}</p>
{/if}

<div class="tree">
 <div class="canvas" style:height={`${view.height}px`}>
  <svg class="wires" width="100%" height={view.height} aria-hidden="true">
    {#each view.connectors as c, i (i)}
      <path
        d={connectorPath(c)}
        class:dashed={c.relation === 'implements'}
        class:synth={c.synthesized}
      />
    {/each}
  </svg>

  {#each view.rows as row (row.node.id + row.side)}
    {#if row.side === 'focus'}
      <div
        class="row focus"
        style:top={`${row.index * HIER_ROW_H}px`}
        style:padding-left={`${row.indent + 18}px`}
      >
        <KindGlyph kind={row.node.kind} />
        <span class="nm">{row.node.name}</span>
      </div>
    {:else}
      <button
        type="button"
        class="row"
        style:top={`${row.index * HIER_ROW_H}px`}
        style:padding-left={`${row.indent + 18}px`}
        onclick={() => onopen(row.node)}
        title={title(row)}
      >
        <KindGlyph kind={row.node.kind} />
        <span class="nm">{row.node.name}</span>
        <span class="word">{row.word}</span>
        {#if row.entry?.synthesized}
          <span class="pill" title={row.entry.registeredAt ?? ''}>
            via {row.entry.via ?? 'resolver'}
          </span>
        {/if}
        {#if row.entry && row.entry.hiddenSubtypes > 0}
          <span class="pill">+{row.entry.hiddenSubtypes} below</span>
        {/if}
        <span class="file">{row.node.file === focus.file ? 'same file' : row.node.file}</span>
      </button>
    {/if}
  {/each}
 </div>
</div>

{#if model.foldFrom !== null}
  <button type="button" class="fold" onclick={() => (expanded = !expanded)}>
    {expanded ? 'Fold' : `+${model.foldCount} more ${model.foldNoun}`}
  </button>
{/if}

{#if model.note}
  <div class="note">{model.note}</div>
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

  .subh .hint {
    margin-left: auto;
    color: var(--ink-3);
    font-size: 11.5px;
    font-weight: 400;
  }

  .headline {
    margin: 0 0 6px;
    color: var(--ink-2);
    font-size: 12px;
  }

  .tree {
    border-top: 1px solid var(--rule);
    padding-top: 6px;
  }

  /* The one positioned box: rows and wires share its origin, so a row's y and
     the y its connector lands on are the same arithmetic. */
  .canvas {
    position: relative;
  }

  .wires {
    position: absolute;
    top: 0;
    left: 0;
    overflow: visible;
    pointer-events: none;
  }

  .wires path {
    fill: none;
    stroke: var(--ink-4);
    stroke-width: 1;
  }

  .wires path.dashed {
    stroke-dasharray: 4 3;
  }

  .wires path.synth {
    stroke: var(--ink-3);
    stroke-dasharray: 6 3;
  }

  .row {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 24px;
    padding-right: 4px;
    border: 1px solid transparent;
    text-align: left;
  }

  button.row:hover {
    background: var(--press);
  }

  .nm {
    font: 12.5px var(--mono);
    white-space: nowrap;
  }

  .row.focus {
    color: var(--accent);
  }

  .row.focus .nm {
    font-weight: 600;
  }

  .word {
    color: var(--ink-3);
    font-size: 11px;
    white-space: nowrap;
  }

  .pill {
    padding: 0 4px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-3);
    font: 10.5px var(--mono);
    white-space: nowrap;
  }

  .file {
    overflow: hidden;
    margin-left: auto;
    padding-left: 10px;
    color: var(--ink-3);
    font: 11px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fold {
    margin-top: 6px;
    padding: 3px 8px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font-size: 11.5px;
  }

  .fold:hover {
    background: var(--press);
  }

  .note {
    padding: 8px 0;
    color: var(--ink-3);
    font-size: 11.5px;
  }
</style>
