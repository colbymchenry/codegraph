/**
 * A self-closing `<script ... />` in a Svelte component, such as a
 * third-party script in `<svelte:head>`, has no body. It used to be read as
 * an opening tag running on to the next `</script>`: the component's real
 * script was parsed with the markup in between, failed, and contributed no
 * symbols, and the template scan skipped that markup. The same fix as #2989
 * for Astro.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Svelte self-closing <script />', () => {
  it('does not swallow the component script that follows it', () => {
    const code = `<svelte:head>
  <script src="/analytics.js" />
</svelte:head>
<p>{formatDate(date)}</p>
<Header />
<script>
  const ready = true;
</script>
`;
    const result = extractFromSource('src/routes/+page.svelte', code);

    expect(result.errors).toEqual([]);
    const ready = result.nodes.find((n) => n.name === 'ready');
    expect(ready).toBeDefined();
    expect(ready?.startLine).toBe(7);
    // The markup between the two tags is still scanned.
    const call = result.unresolvedReferences.find(
      (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'formatDate' && ref.line === 4
    );
    expect(call).toBeDefined();
    expect(result.unresolvedReferences.some((ref) => ref.referenceName === 'Header' && ref.line === 5)).toBe(true);
  });

  it("still reads a call in a self-closing <script />'s attributes", () => {
    // A self-closing tag has no body for the template scan to skip.
    const code = `<svelte:head>
  <script src={assetUrl('/analytics.js')} />
</svelte:head>
<script>
  const ready = true;
</script>
`;
    const result = extractFromSource('src/routes/+layout.svelte', code);

    expect(result.errors).toEqual([]);
    expect(result.nodes.find((n) => n.name === 'ready')?.startLine).toBe(5);
    expect(result.unresolvedReferences.some(
      (ref) => ref.referenceKind === 'calls' && ref.referenceName === 'assetUrl' && ref.line === 2
    )).toBe(true);
  });
});
