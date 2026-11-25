<script lang="ts">
  /**
   * The rows of a palette — shared by the panel under the search box and the
   * empty screen's "where to start" list, because they are the same rows and a
   * second copy would drift.
   *
   * Selection is passed in rather than owned here: in the panel it belongs to
   * the keyboard, on the empty screen there is none.
   */
  import KindGlyph from './KindGlyph.svelte';
  import type { Palette, PaletteItem } from '../lib/search-model';

  interface Props {
    palette: Palette;
    /** Index into `palette.items`, or -1 for no keyboard selection. */
    selected?: number;
    /**
     * Set to 'option' when these rows sit inside a listbox (the search panel).
     * Left off on the empty screen, where they are just links: `role="option"`
     * outside a listbox is a lie a screen reader acts on.
     */
    rowRole?: 'option' | undefined;
    /** Prefix for each row's DOM id, so a combobox can point at the selected one. */
    idPrefix?: string;
    onpick: (item: PaletteItem) => void;
    onhover?: (index: number) => void;
  }

  let {
    palette,
    selected = -1,
    rowRole = undefined,
    idPrefix = 'palette-row',
    onpick,
    onhover,
  }: Props = $props();

  /** Running index into the flat item list, so a row knows its keyboard position. */
  function flatIndex(sectionIndex: number, rowIndex: number): number {
    let base = 0;
    for (let i = 0; i < sectionIndex; i += 1) base += palette.sections[i]?.items.length ?? 0;
    return base + rowIndex;
  }
</script>

{#each palette.sections as section, s (section.title)}
  <div class="head">
    <span class="head-title">{section.title}</span>
    {#if section.note}<span class="head-note">{section.note}</span>{/if}
  </div>
  {#each section.items as item, r (item.id)}
    {@const index = flatIndex(s, r)}
    <button
      type="button"
      class="row"
      class:sel={index === selected}
      data-palette-row={index}
      id={`${idPrefix}-${index}`}
      role={rowRole}
      aria-selected={rowRole ? index === selected : undefined}
      onmousedown={(event) => {
        // mousedown, not click: the input's blur would close the panel first.
        event.preventDefault();
        onpick(item);
      }}
      onmouseenter={() => onhover?.(index)}
    >
      {#if item.type === 'route'}
        <KindGlyph kind="route" />
        <span class="mid">
          <span class="nm">{item.url}</span>
          <span class="sig">{item.handler}</span>
        </span>
      {:else if item.type === 'flow'}
        <KindGlyph kind="route" />
        <span class="mid">
          <span class="nm">{item.name}</span>
        </span>
      {:else if item.type === 'entry'}
        <KindGlyph kind={item.row.kind} />
        <span class="mid" title={item.row.title}>
          <span class="nm">{item.name}</span>
          {#if item.meta}<span class="sig">{item.meta}</span>{/if}
        </span>
      {:else}
        <KindGlyph kind={item.node.kind} />
        <span class="mid" title={item.node.generated ? `${item.name} — tool-generated` : undefined}>
          <!-- Generated code recedes here too: a `.pb.go` stub and the
               hand-written thing beside it must not read the same. -->
          <span class="nm" class:gen={item.node.generated}>{item.name}</span>
          {#if item.meta}<span class="sig">{item.meta}</span>{/if}
        </span>
      {/if}
      <span class="loc">{item.location}</span>
    </button>
  {/each}
{/each}

<style>
  .head {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px 4px;
    border-bottom: 1px solid var(--rule-faint);
    color: var(--ink-3);
    font-size: 12px;
  }

  .head-note {
    overflow: hidden;
    color: var(--ink-4);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .row {
    display: grid;
    width: 100%;
    align-items: baseline;
    padding: 6px 10px;
    border-bottom: 1px solid var(--rule-faint);
    color: var(--ink);
    gap: 10px;
    grid-template-columns: 18px 1fr auto;
    text-align: left;
  }

  .row:last-child {
    border-bottom: 0;
  }

  .row:hover,
  .row.sel {
    background: var(--press);
  }

  .mid {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .nm {
    font-family: var(--mono);
    font-size: 12.5px;
  }

  .nm.gen {
    color: var(--ink-4);
  }

  .sig {
    margin-left: 6px;
    color: var(--ink-3);
    font-family: var(--mono);
    font-size: 11.5px;
  }

  .loc {
    color: var(--ink-3);
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
  }
</style>
