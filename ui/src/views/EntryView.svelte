<script lang="ts">
  /**
   * Entry points — where a project starts, and where a flow starts.
   *
   * Four lists, all derived from the graph rather than from a filename
   * convention (see `src/ui-server/api/entrypoints.ts` for what each is derived
   * from), regrouped by the file or directory their rows share.
   *
   * The second half of the screen is the flow: a row that names a callable
   * symbol arms a flow from it, and the panel then wants one more name. That
   * second name can be typed, or picked by arming another row — "how does
   * `POST /v1/payroll/cycles/{cycleID}/run` reach the database" is two clicks
   * once both ends are on screen, which is the whole reason this list and the
   * Flow strip belong on speaking terms.
   *
   * The payload is the palette's: one `/api/entrypoints` serves the search box
   * at rest, the empty screen and this panel, so all three agree on the order.
   */
  import EntrySection from '../components/entry/EntrySection.svelte';
  import SavedTrails from '../components/SavedTrails.svelte';
  import { palette } from '../lib/palette.svelte';
  import { buildEntryPanel, flowPair, type EntryRow } from '../lib/entry-model';
  import { flowHref, navigate } from '../lib/navigation';
  import { openEntryTarget } from '../lib/walk';

  interface Props {
    project?: string | null;
  }
  let { project = null }: Props = $props();

  $effect(() => {
    void palette.ensureEntries();
  });

  let panel = $derived(buildEntryPanel(palette.entries));

  /** The row a flow is being drawn from, and the name it will start at. */
  let armed = $state<{ id: string; name: string } | null>(null);
  let reaches = $state('');
  let input: HTMLInputElement | null = $state(null);

  // A refetch (the index moved) can retire the armed row. Dropping the arming
  // is the honest response: the symbol it named may not be there any more.
  $effect(() => {
    const id = armed?.id;
    if (id && !panel.rows.some((row) => row.id === id)) armed = null;
  });

  function open(row: EntryRow): void {
    openEntryTarget(row.target);
  }

  function draw(from: string, to: string): void {
    const pair = flowPair(from, to);
    if (!pair) return;
    armed = null;
    reaches = '';
    navigate(flowHref(pair));
  }

  function onflow(row: EntryRow): void {
    if (!row.flowFrom) return;
    if (armed === null) {
      armed = { id: row.id, name: row.flowFrom };
      reaches = '';
      // The input is the faster path for anyone who already knows the other
      // end; focusing it costs nothing to anyone who would rather click a row.
      queueMicrotask(() => input?.focus());
      return;
    }
    if (armed.id === row.id) {
      armed = null;
      return;
    }
    draw(armed.name, row.flowFrom);
  }

  function onkeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      armed = null;
    }
  }
</script>

<div class="scroll">
  <div class="head">
    <h2>Entry points</h2>
    <p>
      Where a flow starts{project ? ` in ${project}` : ''} — every list below is read out of the
      graph, not guessed from a filename. Open a row to read the code, or use
      <span class="chiplike">Flow ›</span> to draw the path from it to a second symbol.
    </p>
  </div>

  {#if armed}
    <div class="arming" role="group" aria-label="Draw a flow">
      <span class="from">{armed.name}</span>
      <span class="arrow" aria-hidden="true">→</span>
      <input
        bind:this={input}
        bind:value={reaches}
        {onkeydown}
        type="text"
        autocomplete="off"
        spellcheck="false"
        placeholder="a symbol it reaches"
        aria-label={`The symbol ${armed.name} should reach`}
        onkeypress={(event) => {
          if (event.key === 'Enter' && armed) draw(armed.name, reaches);
        }}
      />
      <button
        type="button"
        class="go"
        disabled={flowPair(armed.name, reaches) === null}
        onclick={() => armed && draw(armed.name, reaches)}>Draw the flow</button
      >
      <button type="button" class="cancel" onclick={() => (armed = null)}>Cancel</button>
      <span class="hint">or pick the other end with <span class="chiplike">→ here</span></span>
    </div>
  {/if}

  <!-- The one list here that a person wrote rather than the graph derived. It
       is drawn in full (not hidden when empty) because this screen is where a
       reader comes looking for one. -->
  <div class="saved">
    <SavedTrails hideWhenEmpty={false} />
  </div>

  {#if palette.entriesFailure}
    <p class="state">Could not read the entry points — {palette.entriesFailure}</p>
  {:else if !palette.entriesSettled}
    <p class="state">Reading the graph…</p>
  {:else if panel.empty}
    <p class="state">{panel.empty}</p>
  {:else}
    <div class="sections">
      {#each panel.sections as section (section.id)}
        <EntrySection {section} armed={armed?.id ?? null} onopen={open} {onflow} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .scroll {
    height: 100%;
    overflow: auto;
  }

  .head {
    max-width: 760px;
    padding: 26px 40px 6px;
  }

  .saved {
    max-width: 800px;
    padding: 14px 40px 0;
  }

  .head h2 {
    margin: 0 0 6px;
    font-size: 20px;
    font-weight: 600;
    letter-spacing: -0.01em;
  }

  .head p {
    margin: 0;
    color: var(--ink-2);
    font-size: 13px;
    line-height: 1.45;
  }

  .chiplike {
    padding: 0 4px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font: 11px var(--mono);
  }

  .arming {
    position: sticky;
    top: 0;
    z-index: 4;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 12px 40px 0;
    padding: 8px 12px;
    border: 1px solid var(--accent-line);
    background: var(--accent-soft);
  }

  .arming .from {
    color: var(--ink);
    font: 500 12.5px var(--mono);
  }

  .arming .arrow {
    color: var(--ink-3);
  }

  .arming input {
    width: 220px;
    height: 26px;
    padding: 0 8px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink);
    font: 12.5px var(--mono);
  }

  .arming input:focus {
    border-color: var(--ink);
    outline: none;
  }

  .arming button {
    height: 26px;
    padding: 0 10px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink-2);
    font-size: 12px;
  }

  .arming button:hover:not(:disabled) {
    border-color: var(--ink);
    color: var(--ink);
  }

  .arming button:disabled {
    color: var(--ink-4);
    cursor: default;
  }

  .arming .hint {
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .state {
    max-width: 760px;
    padding: 16px 40px 40px;
    color: var(--ink-3);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .sections {
    max-width: 760px;
    margin: 14px 40px 48px;
    border: 1px solid var(--rule-soft);
  }
</style>
