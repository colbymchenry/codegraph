<script lang="ts">
  import { kindLetter, kindWord, FILLED_KINDS } from '../lib/kinds';

  interface Props {
    kind: string | null | undefined;
    /** Adds a tooltip; off by default so rails do not fight the browser. */
    titled?: boolean;
  }

  let { kind, titled = false }: Props = $props();

  // An unknown kind (a trail hop restored from a URL, before its node is
  // fetched) draws an empty box. A '?' would read as a claim about the symbol.
  let letter = $derived(kind ? kindLetter(kind) : '');
  let filled = $derived(kind ? FILLED_KINDS.has(kind) : false);
  let dashed = $derived(kind === 'file');
</script>

<span
  class="k"
  class:filled
  class:dashed
  class:wide={letter.length > 1}
  title={titled ? kindWord(kind) : undefined}
  aria-hidden={titled ? undefined : 'true'}
>{letter}</span>

<style>
  .k {
    display: inline-flex;
    width: 16px;
    height: 16px;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--ink-3);
    color: var(--ink-2);
    font: 500 9.5px var(--mono);
    line-height: 1;
    user-select: none;
  }

  .k.filled {
    background: var(--press);
  }

  .k.dashed {
    border-style: dashed;
  }

  /* Two-character letters (Tr, im, ex) need to lose a little tracking to
     sit inside the 16px box without touching the rule. */
  .k.wide {
    font-size: 8.5px;
    letter-spacing: -0.02em;
  }
</style>
