<script lang="ts">
  /**
   * The trails somebody kept — the fifth answer to "where do I start".
   *
   * The other four (routes, executable files, tests, hubs) are derived from the
   * graph and describe the project. This one is written by hand and describes
   * what a person thought was worth explaining, which is why it sits above them
   * on the empty screen: a named walk beats a ranked list every time there is
   * one.
   *
   * Rows follow the search-result grid (18px glyph · name · meta) so the empty
   * screen reads as one list rather than two lists in one column. What they add
   * is the honesty line: a trail is a claim about code that has since moved, and
   * every row says what became of its hops.
   */
  import KindGlyph from './KindGlyph.svelte';
  import { symbolHref, navigate } from '../lib/navigation';
  import { trails } from '../lib/trails.svelte';
  import { trail } from '../lib/trail.svelte';
  import { decodeTrail } from '../lib/trail-codec';
  import {
    isOpenable,
    trailDecay,
    trailExport,
    trailMeta,
    trailOpens,
    trailTitle,
  } from '../lib/trails-model';
  import type { WireTrail } from '../lib/api';

  interface Props {
    /** Heading text. The empty screen and the entry-points panel word it alike. */
    title?: string;
    /** Render nothing at all when there are no saved trails (the empty screen). */
    hideWhenEmpty?: boolean;
  }
  let { title = 'Saved trails', hideWhenEmpty = true }: Props = $props();

  $effect(() => {
    void trails.ensure();
  });

  /** Which row is asking to be confirmed before it is deleted. */
  let confirming = $state<string | null>(null);

  let list = $derived(trails.list);

  /**
   * Open a trail: adopt its hops, then navigate to the one it ends on.
   *
   * The store is primed BEFORE the URL changes so the bar draws named hops
   * immediately rather than a row of hashes that resolve a moment later — the
   * encoded trail carries ids and nothing else, and every name is already here.
   */
  function open(saved: WireTrail) {
    if (!isOpenable(saved)) return;
    const hops = decodeTrail(saved.encoded);
    trail.clear();
    const resolved = saved.hops.filter((hop) => hop.id !== null);
    for (const hop of hops) {
      const known = resolved.find((h) => h.id === hop.id);
      trail.push({ id: hop.id, name: known?.name ?? null, kind: known?.kind ?? null, dir: hop.dir });
    }
    navigate(symbolHref(saved.openId as string, { trail: saved.encoded as string }));
  }

  async function remove(saved: WireTrail) {
    if (confirming !== saved.id) {
      confirming = saved.id;
      return;
    }
    confirming = null;
    await trails.remove(saved.id);
  }

  /**
   * Hand the trail over as the file it is.
   *
   * `.codegraph/` is gitignored wholesale, which is right for a scratch walk
   * and wrong for a tour worth committing — so exporting is a copy the reader
   * makes deliberately, and lands wherever their browser puts downloads.
   */
  function download(saved: WireTrail) {
    const blob = new Blob([trailExport(saved)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${saved.id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }
</script>

{#if !(hideWhenEmpty && list.length === 0 && trails.failure === null)}
  <section class="trails" aria-label={title}>
    <div class="head">
      <h3>{title}</h3>
      {#if trails.directory}
        <span class="where">{trails.directory}</span>
      {/if}
    </div>

    {#if trails.failure}
      <p class="msg err">{trails.failure}</p>
    {:else if !trails.settled}
      <p class="msg">Reading saved trails…</p>
    {:else if list.length === 0}
      <p class="msg">
        No saved trails yet. Walk a path through the code, then press
        <strong>Save trail</strong> on the trail bar to keep it.
        {#if trails.readOnlyReason}
          <br />{trails.readOnlyReason}
        {/if}
      </p>
    {:else}
      <div class="rows">
        {#each list as saved (saved.id)}
          {@const decay = trailDecay(saved)}
          {@const opens = trailOpens(saved)}
          <div class="row" class:dead={!isOpenable(saved)}>
            <button
              type="button"
              class="pick"
              title={trailTitle(saved)}
              disabled={!isOpenable(saved)}
              onclick={() => open(saved)}
            >
              <KindGlyph kind={saved.hops[0]?.kind ?? null} />
              <span class="mid">
                <span class="nm">{saved.name}</span>
                {#if saved.note}<span class="note">{saved.note}</span>{/if}
              </span>
              <span class="meta">{trailMeta(saved)}</span>
            </button>

            <div class="acts">
              <button type="button" class="act" onclick={() => download(saved)}>Export</button>
              {#if trails.canSave}
                <button
                  type="button"
                  class="act"
                  class:armed={confirming === saved.id}
                  disabled={trails.busy}
                  onclick={() => remove(saved)}
                  onblur={() => (confirming = confirming === saved.id ? null : confirming)}
                >
                  {confirming === saved.id ? 'Delete?' : 'Delete'}
                </button>
              {/if}
            </div>

            <!-- The honesty line. A saved trail is a claim about code that has
                 since moved; this is where the graph gets to say so. -->
            {#if decay || opens}
              <p class="decay" class:warn={decay?.tone === 'warn'}>
                {[decay?.text, opens].filter(Boolean).join(' ')}
              </p>
            {/if}
          </div>
        {/each}
      </div>
      {#if trails.payload?.bounded}
        <p class="msg">Only the first trails in the directory are listed.</p>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .trails {
    max-width: 720px;
  }

  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 8px;
  }

  .trails h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .where {
    color: var(--ink-4);
    font-family: var(--mono);
    font-size: 11px;
  }

  .msg {
    margin: 0;
    padding: 8px 0 0;
    color: var(--ink-3);
    font-size: 12px;
  }

  .msg.err {
    color: var(--accent);
  }

  .rows {
    border: 1px solid var(--rule-soft);
  }

  .row {
    position: relative;
    border-bottom: 1px solid var(--rule-faint);
  }

  .row:last-child {
    border-bottom: 0;
  }

  .pick {
    display: grid;
    width: 100%;
    align-items: baseline;
    padding: 6px 10px;
    color: var(--ink);
    gap: 10px;
    grid-template-columns: 18px 1fr auto;
    text-align: left;
  }

  .pick:hover:not(:disabled) {
    background: var(--press);
  }

  .pick:disabled {
    color: var(--ink-3);
    cursor: default;
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

  .note {
    margin-left: 6px;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  /* Room for the actions, which overlay the row's right edge. */
  .meta {
    padding-right: 96px;
    color: var(--ink-3);
    font-family: var(--mono);
    font-size: 11px;
    white-space: nowrap;
  }

  /* Always drawn, never revealed on hover: a control that appears when the
     pointer arrives is one a keyboard reader has to guess at. It recedes to
     ink-3 instead, which is the same thing done with ink. */
  .acts {
    position: absolute;
    top: 4px;
    right: 8px;
    display: flex;
    gap: 4px;
  }

  .act {
    padding: 2px 6px;
    color: var(--ink-3);
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    font-family: var(--sans);
    font-size: 11px;
  }

  .act:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
  }

  .act.armed {
    color: var(--accent);
    border-color: var(--accent-line);
    background: var(--accent-soft);
  }

  .decay {
    margin: 0;
    padding: 0 10px 6px 38px;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .decay.warn {
    color: var(--amber);
  }
</style>
