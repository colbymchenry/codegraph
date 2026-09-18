<!--
  Outline or source — the two readings of a file (design spec §3.4).

  A link, not a toggle, because the choice belongs in the URL: a file opened at
  a line from a search result, a flow card or a review comment has to reopen in
  the same mode, and `?src=1` is how it travels.
-->
<script lang="ts">
  import { fileHref } from '../../lib/navigation';

  interface Props {
    path: string;
    line: number | null;
    /** Which mode is showing. */
    source: boolean;
  }

  let { path, line, source }: Props = $props();
</script>

<nav class="modes" aria-label="File view mode">
  <a
    class="mode"
    class:on={!source}
    href={fileHref(path, line ? { line } : {})}
    aria-current={!source ? 'page' : undefined}>Outline</a
  >
  <a
    class="mode"
    class:on={source}
    href={fileHref(path, { source: true, ...(line ? { line } : {}) })}
    aria-current={source ? 'page' : undefined}>Source</a
  >
</nav>

<style>
  .modes {
    display: flex;
    gap: 2px;
  }

  .mode {
    padding: 3px 10px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font-size: 12.5px;
    text-decoration: none;
  }

  .mode:hover {
    background: var(--press);
  }

  .mode.on {
    border-color: var(--ink);
    color: var(--ink);
  }
</style>
