<!--
  A container's members in source order, with the two numbers that say which
  one to open (design spec §3.2).

  This replaces the body for anything over 80 lines, and the `← in  → out`
  columns are why it is a better view than the body rather than a poorer one:
  a class's own fan-out is nearly always zero because a class calls nothing —
  its methods do — so scrolling 700 lines of braces tells you less about where
  the weight sits than twenty rows with their edge counts.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import type { WireNodeRef, WireOverride } from '../../lib/api';
  import type { OutlineRow } from '../../lib/symbol-model';

  interface Props {
    rows: OutlineRow[];
    total: number;
    truncated: boolean;
    onopen: (node: WireNodeRef) => void;
  }

  let { rows, total, truncated, onopen }: Props = $props();

  /**
   * The override mark is a NAME match inside a chain the graph links, not an
   * `overrides` edge — nothing in the engine emits one. The tooltip says so,
   * because "overrides Base" and "declares the same name as Base" are different
   * claims and only the second one was checked.
   */
  function overrideTitle(o: WireOverride): string {
    return o.relation === 'implements'
      ? `Declares a member ${o.baseTypeName} requires — matched by name.`
      : `Redeclares a member of ${o.baseTypeName} — matched by name.`;
  }
</script>

<div class="subh">
  <span>Members</span>
  <span class="n">{total}</span>
</div>

<div class="outline">
  {#each rows as row (row.member.id)}
    <button
      type="button"
      class="orow"
      class:nested={row.nested}
      class:dimmed={row.dimmed}
      onclick={() => onopen(row.member)}
      title={`${row.member.qualifiedName} — ${row.member.file}:${row.member.line}`}
    >
      <KindGlyph kind={row.member.kind} />
      <span class="nm">{row.member.name}</span>
      <span class="sig">
        {#if row.member.overrides}
          <span class="ovr" title={overrideTitle(row.member.overrides)}>
            {row.member.overrides.relation === 'implements' ? 'satisfies' : 'overrides'}
            {row.member.overrides.baseTypeName}
          </span>
        {/if}{row.member.signature ?? ''}</span>
      <span class="cnt">
        {#if row.member.fanIn}← {row.member.fanIn}{/if}{#if row.member.fanIn && row.member.fanOut}&nbsp;
        {/if}{#if row.member.fanOut}→ {row.member.fanOut}{/if}
      </span>
    </button>
  {/each}
</div>

{#if truncated}
  <div class="note">
    Showing {rows.length} of {total} members — open the file to see the rest.
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

  .outline {
    border-top: 1px solid var(--rule);
  }

  .orow {
    display: grid;
    grid-template-columns: 16px minmax(160px, auto) 1fr auto;
    gap: 10px;
    align-items: baseline;
    width: 100%;
    padding: 6px 4px;
    border-bottom: 1px solid var(--rule-faint);
    text-align: left;
  }

  .orow:hover {
    background: var(--press);
  }

  .orow.nested {
    padding-left: 22px;
  }

  .nm {
    font: 12.5px var(--mono);
  }

  .orow.dimmed .nm {
    color: var(--ink-3);
  }

  .ovr {
    margin-right: 6px;
    padding: 0 4px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font: 10.5px var(--mono);
    white-space: nowrap;
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
    padding: 8px 0;
    color: var(--ink-3);
    font-size: 11.5px;
  }
</style>
