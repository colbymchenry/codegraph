<!--
  "This file changed on disk after the last index sync."

  One block, said the same way on every screen that can say it (design spec:
  paper-2 fill, hairline rule, ⚠ in ink-3, 12.5px ink-2). Deliberately NOT
  amber: amber is the untested badge's colour and nothing else's, and a warning
  that borrows it makes two unrelated things look like the same kind of problem.
  Deliberately not a modal either — the screen underneath is still mostly true,
  and interrupting to say so would be the overclaim.

  The caller supplies the tail of the sentence, because what follows the dash is
  the only part that differs: what this particular screen did about it.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    /** Project-relative path, shown in mono. */
    file: string;
    /** The rest of the sentence: what this screen is showing instead. */
    children: Snippet;
  }

  let { file, children }: Props = $props();
</script>

<div class="drift" role="status">
  <span class="glyph" aria-hidden="true">⚠</span>
  <span class="body"><code>{file}</code> changed on disk after the last index sync — {@render children()}</span>
</div>

<style>
  .drift {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 6px;
    align-items: start;
    padding: 8px 12px;
    border: 1px solid var(--rule-soft);
    background: var(--paper-2);
    color: var(--ink-2);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .glyph {
    color: var(--ink-3);
    font-size: 12px;
    line-height: 1.55;
  }

  .body :global(code) {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--ink);
  }

  .body :global(button) {
    background: none;
    border: 0;
    padding: 0;
    color: var(--accent);
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }

  .body :global(a) {
    color: var(--accent);
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }
</style>
