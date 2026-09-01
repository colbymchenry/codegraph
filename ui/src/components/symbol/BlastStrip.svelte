<!--
  What would need re-checking if this symbol changed (design spec §3.2).

  The bar exists because the numbers alone do not answer the question a reader
  actually has, which is comparative: is 19 dependents a lot? So both fills are
  drawn against the widest radius in the index (`/api/stats` → `blastScale`),
  and the legend says so rather than letting a full-width bar imply "everything".

  The scale is sampled, not exhaustive — measuring every symbol's radius means a
  traversal per symbol. When the symbol on screen is wider than the sample found,
  it becomes the scale instead of overflowing it: a bar that runs past its track
  is a drawing bug, and clamping silently would be a lie about the comparison.
-->
<script lang="ts">
  import { fileHref } from '../../lib/navigation';
  import { plural } from '../../lib/symbol-model';
  import type { WireBlastScale, WireBlastSummary } from '../../lib/api';

  interface Props {
    blast: WireBlastSummary;
    scale: WireBlastScale | null;
    /** Calls from test files — the tests that would catch a regression. */
    testCalls: number;
    testFiles: number;
  }

  let { blast, scale, testCalls, testFiles }: Props = $props();

  let maxDirect = $derived(Math.max(1, scale?.maxDirect ?? 0, blast.direct));
  let maxWithin = $derived(Math.max(1, scale?.maxWithinHops ?? 0, blast.withinHops));

  const share = (value: number, max: number): number =>
    value <= 0 ? 0 : Math.max(0.5, Math.min(100, (100 * value) / max));
</script>

<div class="blast">
  <div class="bh">
    <b>Blast radius</b>
    <span class="stat"><strong>{blast.direct}</strong> direct dependent{blast.direct === 1 ? '' : 's'}</span>
    <span class="stat"><strong>{blast.withinHops}</strong> within {blast.hops} hops</span>
    <span class="stat"><strong>{blast.files}</strong> file{blast.files === 1 ? '' : 's'}</span>
    <span class="stat"><strong>{blast.testFiles}</strong> test file{blast.testFiles === 1 ? '' : 's'}</span>
    {#if blast.routes > 0}
      <span class="stat"><strong>{blast.routes}</strong> route{blast.routes === 1 ? '' : 's'}</span>
    {/if}
  </div>

  <div
    class="bar"
    title={`Scaled to the widest radius in the index: ${maxWithin} symbols within ${blast.hops} hops.`}
  >
    <i style:width={`${share(blast.withinHops, maxWithin)}%`}></i>
    <i class="direct" style:width={`${share(blast.direct, maxDirect)}%`}></i>
  </div>

  <div class="legend">
    dark: direct dependents · light: within {blast.hops} hops — scaled to the widest radius in the
    index{#if scale?.estimated}{' '}<span class="dim"
        >(measured across its {scale.sampled} most-depended-on symbols)</span
      >{/if}
  </div>

  {#if blast.topFiles.length > 0}
    <details>
      <summary>What would need re-checking if this changed</summary>
      <div class="body">
        {#each blast.topFiles as entry (entry.file)}
          <div class="fp">
            <a href={fileHref(entry.file)} class:test={entry.test}>{entry.file}</a>
            <b>{entry.symbols}</b>
          </div>
        {/each}
        {#if blast.files > blast.topFiles.length}
          <div class="fp dim">+{blast.files - blast.topFiles.length} more files</div>
        {/if}
        {#if testCalls > 0}
          <div class="note">
            plus {plural(testCalls, 'call')} from {plural(testFiles, 'test file')} — the tests that
            would catch a regression.
          </div>
        {/if}
      </div>
    </details>
  {/if}
</div>

<style>
  .blast {
    margin-top: 22px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
  }

  .bh {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 14px;
  }

  .bh b {
    font-weight: 600;
  }

  .stat {
    color: var(--ink-2);
    font-size: 12.5px;
  }

  .stat strong {
    color: var(--ink);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }

  .bar {
    position: relative;
    max-width: 420px;
    height: 6px;
    margin-top: 8px;
    background: var(--press);
  }

  .bar i {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    background: var(--ink-2);
  }

  /* Drawn second so the shorter, darker "direct" share sits over the lighter
     "within N hops" one rather than beside it — they are nested quantities. */
  .bar i.direct {
    background: var(--ink);
  }

  .legend {
    margin-top: 4px;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  details {
    margin-top: 8px;
  }

  summary {
    color: var(--ink-2);
    cursor: pointer;
    font-size: 12px;
    list-style: none;
  }

  summary::-webkit-details-marker {
    display: none;
  }

  summary::before {
    content: '+ ';
    color: var(--ink-3);
    font-family: var(--mono);
  }

  details[open] summary::before {
    content: '− ';
  }

  .body {
    padding-top: 6px;
  }

  .fp {
    display: flex;
    justify-content: space-between;
    gap: 10px;
    padding: 2px 0;
    color: var(--ink-2);
    font: 11px var(--mono);
  }

  .fp a:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  .fp a.test {
    color: var(--ink-3);
  }

  .fp b {
    color: var(--ink);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }

  .note {
    padding-top: 6px;
    color: var(--ink-3);
    font-size: 11.5px;
  }
</style>
