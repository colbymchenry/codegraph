<script lang="ts">
  /**
   * The provider: installs the adapter and the navigation driver, then renders
   * whatever the host puts inside it.
   *
   * It is a convenience, not a boundary. `setGraphAdapter` and
   * `setNavigationDriver` are module-level (see `lib/adapter.ts` for why: the
   * pure model modules are plain TypeScript and cannot read a component's
   * context), so this component's whole job is to call them during
   * initialisation — before any child's `$effect` has run and asked for data.
   *
   * That also means the last one to mount wins. A page shows one project; a
   * host that needs two at once needs two documents, not two providers.
   */
  import { untrack, type Snippet } from 'svelte';
  import { setGraphAdapter, type GraphAdapter } from '../lib/adapter';
  import { setNavigationDriver, type NavigationDriver } from '../lib/navigation';

  interface Props {
    /** Where every screen's data comes from. Omit for the loopback JSON API. */
    adapter?: GraphAdapter | null;
    /** Where a click on a symbol, file, flow or module goes. Omit for `#/…`. */
    nav?: NavigationDriver | null;
    /**
     * Force a colour scheme on this subtree.
     *
     * `'auto'` (the default) leaves it to the tokens, which follow the OS
     * unless `:root[data-theme]` says otherwise. The other two set
     * `data-theme` on this component's own wrapper, so a host can put a light
     * reader inside a dark application without redefining a single variable.
     */
    theme?: 'auto' | 'light' | 'dark';
    /** Fills the host's box by default; set false to size it yourself. */
    fill?: boolean;
    children?: Snippet;
  }

  let { adapter = null, nav = null, theme = 'auto', fill = true, children }: Props = $props();

  // Init, not $effect: a child's data effect can run before the parent's, so
  // installing these in an effect would let the first render ask the previous
  // adapter — or the default HTTP one, against a host that serves no `/api`.
  //
  // Once only, and `untrack` says so. Swapping the adapter on a mounted tree
  // would leave every screen holding answers from the old project until
  // something happened to refetch; a host that changes project re-mounts the
  // subtree instead (`{#key project}`), which is honest and one line.
  setGraphAdapter(untrack(() => adapter));
  setNavigationDriver(untrack(() => nav));
</script>

<div class="codegraph-ui" class:fill data-theme={theme === 'auto' ? undefined : theme}>
  {@render children?.()}
</div>

<style>
  /* The tokens are on :root (theme.css); this wrapper only re-establishes the
     type and the paper, so a component dropped into a host with its own body
     font does not inherit it. Geometry stays with the components. */
  .codegraph-ui {
    background: var(--paper);
    color: var(--ink);
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.45;
  }

  .fill {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  /* Every screen fills the provider; the view scrolls, not the page. */
  .fill > :global(*) {
    flex: 1;
    min-height: 0;
  }
</style>
