/**
 * Svelte template references — the `{fn(...)}` call expressions and
 * `<PascalCase>` component usages a .svelte template contributes to the
 * graph. These are extracted in ONE pass over the template lines (perf: init
 * benchmark merged the former two passes); the ORDER the merged pass emits —
 * every call reference first, then every component reference — is part of the
 * contract, because resolution can disambiguate same-named candidates by
 * insertion order.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

/** Template references only (script-block refs are separate). */
const templateRefs = (r: ReturnType<typeof extractFromSource>) =>
  r.unresolvedReferences.filter((ref) => ref.language === 'svelte' && ref.fromNodeId.startsWith('component:'));

describe('svelte template references', () => {
  it('collects {call(...)} expressions and <Component> usages with line and column', () => {
    const r = extractFromSource('App.svelte', `<script>
  import Child from './Child.svelte';
</script>

<div class={cn('a', 'b')}>
  <Child {value} />
  <span>{format(value)}</span>
</div>
`);
    const refs = templateRefs(r);
    // Component usages
    expect(refs.filter((x) => x.referenceKind === 'references').map((x) => [x.referenceName, x.line, x.column]))
      .toEqual([['Child', 6, 3]]);
    // Template call expressions (cn, format) — NOT the script import
    expect(refs.filter((x) => x.referenceKind === 'calls').map((x) => [x.referenceName, x.line]))
      .toEqual([['cn', 5], ['format', 7]]);
  });

  it('emits every call reference before every component reference (merge-order contract)', () => {
    const r = extractFromSource('App.svelte', `<Widget />
<div>{helper()}</div>
<Gadget />
`);
    const kinds = templateRefs(r).map((x) => x.referenceKind);
    const lastCall = kinds.lastIndexOf('calls');
    const firstRef = kinds.indexOf('references');
    expect(lastCall).toBeLessThan(firstRef);
  });

  it('skips lines inside <script> and <style> blocks', () => {
    const r = extractFromSource('App.svelte', `<script context="module">
  const inModule = compute(1);
</script>
<style>
  .x { width: calc(100% - 2px); }
</style>
<Real />
`);
    // The module script IS parsed — its call is attributed to the script's
    // own symbol, from the script extraction, not the template pass.
    expect(r.unresolvedReferences.some((x) => x.referenceName === 'compute')).toBe(true);
    // …and the template pass must not ALSO emit it (it skips script lines) —
    // nor the style block's calc(…) call.
    const componentCalls = templateRefs(r).filter((x) => x.referenceKind === 'calls').map((x) => x.referenceName);
    expect(componentCalls).not.toContain('compute');
    expect(componentCalls).not.toContain('calc');
    expect(templateRefs(r).filter((x) => x.referenceKind === 'references').map((x) => x.referenceName)).toEqual(['Real']);
  });

  it('skips svelte runes and control-flow keywords in expressions', () => {
    const r = extractFromSource('App.svelte', `{#if ready}
  <Show />
{:else}
  <Hide />
{/if}
{#each items as item}
  <Row {item} />
{/each}
`);
    const refs = templateRefs(r);
    // if / else / each are block syntax, not calls
    expect(refs.filter((x) => x.referenceKind === 'calls')).toEqual([]);
    expect(refs.filter((x) => x.referenceKind === 'references').map((x) => x.referenceName))
      .toEqual(['Show', 'Hide', 'Row']);
  });
});
