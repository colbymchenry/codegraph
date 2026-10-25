<!--
  Called by — the left rail (design spec §3.2).

  Grouped by file, the symbol's own file first as "same file", because the
  first question about a caller is "is this local, or does it come from
  somewhere else in the repo". The call-site chips (`:4657`) are the useful
  part: clicking one opens the caller already scrolled to the line that makes
  the call, which is the step a reader would otherwise do by hand.

  This rail draws no connectors. It scrolls independently of the code, so a
  line drawn to a caller row would point at the wrong place the moment either
  side moved.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { fileHref } from '../../lib/navigation';
  import { hot, railFocus } from '../../lib/focus.svelte';
  import { basename, plural, type CallerRailModel, type CallerRow } from '../../lib/symbol-model';
  import { t, tPair } from '../../lib/locale.svelte';
  import type { WireNodeRef } from '../../lib/api';

  interface Props {
    model: CallerRailModel;
    /** The symbol this one was reached from, when it is a caller. */
    originId: string | null;
    exported: boolean;
    /** Follow a caller, optionally landing on one of its call sites. */
    onstepUp: (node: WireNodeRef, line?: number) => void;
  }

  let { model, originId, exported, onstepUp }: Props = $props();

  /** A file node's own "symbol" is the file's top level; say so. */
  function rowName(node: WireNodeRef): string {
    return node.kind === 'file' ? t('sym.topLevel', { name: basename(node.file) }) : node.name;
  }

  function rowTitle(row: CallerRow): string {
    return `${row.relation.node.qualifiedName} — ${row.relation.node.file}:${row.relation.node.line}`;
  }

  /**
   * A row's place in the flat order the keyboard walks (file groups in order,
   * folds excluded — arrowing into collapsed content would move a selection
   * nobody can see). Computed from the group offsets so the rail can stay a
   * nested render while the keyboard sees one list.
   */
  function indexOf(groupIndex: number, rowIndex: number): number {
    let base = 0;
    for (let i = 0; i < groupIndex; i++) base += model.groups[i]?.rows.length ?? 0;
    return base + rowIndex;
  }
</script>

<div class="rail-h">
  <span>{t('sym.calledByAria')} <span class="n">{model.total}</span></span>
  <span class="hint">{t('sym.stepUpHint')}</span>
</div>

{#if model.total === 0}
  <div class="note">
    {t('sym.emptyCallers')}{exported ? t('sym.exportedNote') : '.'}
  </div>
{/if}

{#each model.groups as group, groupIndex (group.file)}
  <div class="filegroup">
    <div class="fpath">
      <a href={fileHref(group.file)} title={group.file}>{group.same ? t('sym.sameFile') : group.file}</a>
      <b>{group.rows.length}</b>
    </div>
    {#each group.rows as row, rowIndex (row.relation.node.id)}
      {@const node = row.relation.node}
      {@const isOrigin = node.id === originId}
      <div
        class="row"
        class:origin={isOrigin}
        class:sel={railFocus.at('left', indexOf(groupIndex, rowIndex))}
        data-target={node.id}
        role="button"
        tabindex="0"
        title={rowTitle(row)}
        onclick={() => onstepUp(node)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onstepUp(node);
          }
        }}
        onmouseenter={() => hot.set(node.id)}
        onmouseleave={() => hot.clear(node.id)}
      >
        <KindGlyph kind={node.kind} />
        <div>
          <div class="nm">{rowName(node)}</div>
          <div class="meta">
            {#if row.words.length > 0}<span class="kindlbl">{row.words.join(', ')}</span>{/if}
            {#each row.when as w (w)}<span class="tag when" title={t('sym.whenTitle')}
                >{t('sym.when', { w })}</span
              >{/each}
            {#each row.lines as line (line)}
              <button
                type="button"
                class="chip"
                title={t('sym.openAtLine', { name: node.name, line })}
                onclick={(e) => {
                  e.stopPropagation();
                  onstepUp(node, line);
                }}>:{line}</button
              >
            {/each}
            {#if row.via}<span class="kindlbl">{t('sym.via', { via: row.via })}</span>{/if}
            {#if isOrigin}<span class="kindlbl">{t('sym.cameFromHere')}</span>{/if}
          </div>
        </div>
      </div>
    {/each}
  </div>
{/each}

{#if model.tests.rows.length > 0}
  <details class="fold">
    <summary>
      {t('sym.tests')} <span class="dim"
        >{t('sym.testsSummary', {
          calls: plural(model.tests.calls, tPair('sym.callWord')[0]),
          files: plural(model.tests.files.length, tPair('sym.fileWord')[0]),
        })}</span
      >
    </summary>
    <div class="body">
      {#each model.tests.rows as row (row.relation.node.id)}
        {@const node = row.relation.node}
        <div
          class="row"
          role="button"
          tabindex="0"
          title={rowTitle(row)}
          onclick={() => onstepUp(node)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onstepUp(node);
            }
          }}
          onmouseenter={() => hot.set(node.id)}
          onmouseleave={() => hot.clear(node.id)}
        >
          <KindGlyph kind={node.kind} />
          <div>
            <div class="nm">{rowName(node)}</div>
            <div class="meta"><span class="kindlbl">{node.file}</span></div>
          </div>
        </div>
      {/each}
    </div>
  </details>
{/if}

{#if model.uncertain.length > 0}
  <details class="fold">
    <summary>
      {t('sym.uncertain')} <span class="dim"
        >{t('sym.uncertainSummary', {
          n: model.uncertain.length,
          m: model.uncertain.length === 1 ? 'match' : 'matches',
        })}</span
      >
    </summary>
    <div class="body">
      {#each model.uncertain as row (row.relation.node.id)}
        {@const node = row.relation.node}
        <div
          class="row uncertain"
          role="button"
          tabindex="0"
          title={rowTitle(row)}
          onclick={() => onstepUp(node)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              onstepUp(node);
            }
          }}
          onmouseenter={() => hot.set(node.id)}
          onmouseleave={() => hot.clear(node.id)}
        >
          <KindGlyph kind={node.kind} />
          <div>
            <div class="nm">{rowName(node)}</div>
            <div class="meta">
              <span class="kindlbl">{basename(node.file)}</span>
              {#if row.relation.confidence !== null}
                <span class="kindlbl">{row.relation.confidence}</span>
              {/if}
            </div>
          </div>
        </div>
      {/each}
    </div>
  </details>
{/if}

{#if model.hiddenGroups > 0}
  <div class="note">
    {t('sym.moreCallers', { n: model.hiddenGroups, s: model.hiddenGroups === 1 ? '' : 's' })}
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
    cursor: pointer;
  }

  .row:hover {
    background: var(--press);
  }

  .row.sel {
    border-color: var(--ink);
  }

  .row.origin {
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .nm {
    overflow: hidden;
    color: var(--ink);
    font: 12.5px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row.uncertain .nm {
    color: var(--ink-2);
    text-decoration: underline dotted var(--ink-4);
    text-underline-offset: 3px;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    align-items: baseline;
    margin-top: 1px;
    color: var(--ink-3);
    font-size: 11px;
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

  .kindlbl {
    color: var(--ink-3);
  }

  .chip {
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

  .fold {
    padding: 8px 14px;
  }

  .fold > summary {
    display: flex;
    gap: 6px;
    align-items: baseline;
    color: var(--ink-2);
    cursor: pointer;
    font-size: 12px;
    list-style: none;
  }

  .fold > summary::-webkit-details-marker {
    display: none;
  }

  .fold > summary::before {
    content: '+';
    width: 10px;
    color: var(--ink-3);
    font-family: var(--mono);
  }

  .fold[open] > summary::before {
    content: '−';
  }

  .fold .body {
    padding: 6px 0 0 16px;
  }

  .note {
    padding: 8px 14px;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }
</style>
