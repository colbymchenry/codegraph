<script lang="ts">
  /**
   * The search box and its results panel — one component, because the keyboard
   * is the point (design spec §3.7).
   *
   * ↑/↓ move the selection and Enter follows it, and those keys are pressed in
   * the INPUT, not in the panel. Splitting the two across a host's markup is
   * what breaks a palette: the box ends up owning a selection index it has to
   * hand down, and any host that forgets to wire one of the three keys ships a
   * list you cannot use without a mouse. So the box, the keys and the panel
   * travel together, and `PalettePanel` below is only the drawing half.
   *
   * `onpick` replaces what following a row DOES. Left unset, a row walks the
   * graph through the installed navigation driver — which is the right default
   * both for `codegraph ui` and for a host that installed one.
   */
  import PalettePanel from './PalettePanel.svelte';
  import { palette } from '../lib/palette.svelte';
  import type { PaletteItem } from '../lib/search-model';
  import { fileHref, flowHref, navigate } from '../lib/navigation';
  import { openEntryTarget, walkTo } from '../lib/walk';

  interface Props {
    placeholder?: string;
    /** Optional label for the input, when a host's own layout needs one. */
    label?: string;
    /** Replaces the default "walk the graph" behaviour of following a row. */
    onpick?: (item: PaletteItem) => void;
  }

  let {
    placeholder = 'Search a symbol or file, or ask “how does execute reach getFile” — press / to focus',
    label = 'Search symbols and files',
    onpick,
  }: Props = $props();

  let input: HTMLInputElement | null = $state(null);
  let box: HTMLDivElement | null = $state(null);

  /** Focus and select the box — what `/` and Cmd-K reach. */
  export function focus(): void {
    input?.focus();
    input?.select();
    palette.show();
  }

  /**
   * Following a result is a `start` hop, never `down` or `up`: nothing on
   * screen was stepped through to get there, and claiming a direction would
   * put a `→` in the trail that describes no call.
   */
  export function pick(item: PaletteItem): void {
    palette.reset();
    input?.blur();
    if (onpick) {
      onpick(item);
      return;
    }
    // A flow is not a place in the graph, so it does not join the trail: it is
    // a question about two symbols, and the Flow strip answers it.
    if (item.type === 'flow') {
      navigate(flowHref({ from: item.from, to: item.to }));
      return;
    }
    // An entry-point row already knows where it goes — a handler, a file, a
    // hub — and it is the one row type that can point at a FILE.
    if (item.type === 'entry') {
      if (item.row.target) openEntryTarget(item.row.target);
      return;
    }
    const id = item.type === 'route' ? item.nodeId : item.id;
    // A route whose handler never resolved to a node has nowhere to go; the
    // row stays, because "this URL exists and we could not place it" is true.
    if (!id) return;
    // A file result opens the File view, not the file node's Symbol view: the
    // outline is there either way, and only the File view carries the import
    // rails. (CG-45 routed these at the Symbol view because #/file was a stub.)
    if (item.type === 'symbol' && item.node.kind === 'file') {
      navigate(fileHref(item.node.file));
      return;
    }
    walkTo(
      item.type === 'route'
        ? { id, name: item.handler, kind: null }
        : { id, name: item.node.name, kind: item.node.kind },
      'start'
    );
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      palette.hide();
      input?.blur();
      return;
    }
    if (!palette.open) {
      // Any other key means the box is being used again after a dismissal.
      if (event.key !== 'Tab') palette.show();
      return;
    }
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        palette.move(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        palette.move(-1);
        break;
      case 'Enter': {
        event.preventDefault();
        const item = palette.selectedItem;
        if (item) pick(item);
        break;
      }
    }
  }

  /**
   * A click anywhere else closes the panel. `mousedown` on a row calls
   * `preventDefault`, so picking a result never races this.
   */
  function onpointerdown(event: PointerEvent) {
    if (!palette.open) return;
    const target = event.target;
    if (target instanceof Node && box?.contains(target)) return;
    palette.hide();
  }
</script>

<svelte:window {onpointerdown} />

<div class="search" role="search" bind:this={box}>
  <input
    bind:this={input}
    bind:value={palette.query}
    {onkeydown}
    onfocus={() => palette.show()}
    id="q"
    type="search"
    autocomplete="off"
    spellcheck="false"
    {placeholder}
    aria-label={label}
    role="combobox"
    aria-expanded={palette.open}
    aria-controls="palette-panel"
    aria-autocomplete="list"
    aria-activedescendant={palette.open ? `palette-row-${palette.selected}` : undefined}
  />
  {#if palette.open}
    <PalettePanel onpick={pick} />
  {/if}
</div>

<style>
  .search {
    position: relative;
    width: 100%;
    max-width: 720px;
  }

  #q {
    width: 100%;
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink);
    font: 13px var(--sans);
  }

  #q:focus {
    border-color: var(--ink);
    outline: none;
  }

  #q::placeholder {
    color: var(--ink-3);
  }
</style>
