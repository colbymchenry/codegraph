<script lang="ts">
  /**
   * The path the reader walked — and the one place they can keep it.
   *
   * "Save trail" is the viewer's only write. It opens a one-field form rather
   * than a dialog because naming a walk is a thought the reader is already
   * having; anything modal would stop the reading to ask about filing.
   */
  import KindGlyph from './KindGlyph.svelte';
  import { trail, hopLabel, encodeTrail } from '../lib/trail.svelte';
  import { navigate, symbolHref, flowHref } from '../lib/navigation';
  import { trails } from '../lib/trails.svelte';
  import { replacedTrail, trailNameProblem } from '../lib/trails-model';
  import { toast } from '../lib/toast.svelte';

  /** Matches `MAX_TRAIL_NAME` in `src/ui-server/api/trail-store.ts`. */
  const MAX_NAME = 120;

  let hops = $derived(trail.hops);

  let naming = $state(false);
  let name = $state('');
  let nameInput: HTMLInputElement | null = $state(null);

  // The list is wanted before Save is pressed, not after: it decides whether
  // this name would REPLACE something, which the form has to say beforehand.
  $effect(() => {
    if (naming) void trails.ensure();
  });

  let problem = $derived(trailNameProblem(name, MAX_NAME));
  let replaces = $derived(naming ? replacedTrail(name, trails.list) : null);

  function openForm() {
    trails.clearFailure();
    naming = true;
    // The last hop is the thing the reader is looking at, so it is the most
    // likely name for the walk that got there — offered, not imposed.
    name = trail.current?.name ?? '';
    queueMicrotask(() => {
      nameInput?.focus();
      nameInput?.select();
    });
  }

  function closeForm() {
    naming = false;
    name = '';
  }

  async function submit(event: Event) {
    event.preventDefault();
    if (problem || trails.busy) return;
    const replacing = replaces !== null;
    const saved = await trails.save(name, '', hops);
    if (saved === null) return; // the reason is on `trails.failure`, shown below
    toast.show(replacing ? `Trail replaced · ${name.trim()}` : `Trail saved · ${name.trim()}`);
    closeForm();
  }

  function onkeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeForm();
    }
  }

  function step(index: number) {
    const hop = hops[index];
    if (!hop) return;
    trail.truncateTo(index);
    navigate(symbolHref(hop.id, { trail: encodeTrail(trail.hops) }));
  }

  /**
   * The walk itself IS the flow: the Flow view does not search for a path, it
   * looks up the edge already joining each consecutive pair and draws the cards
   * at those lines. So the trail travels under the same `t` param it uses
   * everywhere else — a flow read from a trail is one walk under two lenses.
   */
  function readAsFlow() {
    navigate(flowHref({ trail: encodeTrail(hops) }));
  }

  /**
   * Clear the path, keep the place.
   *
   * Emptying the trail while you are reading a symbol would also throw the
   * symbol away, which is not what "Clear" says. It restarts the trail at
   * where you are — one `start` hop — and only leaves for the empty screen
   * when there is nowhere to stay.
   */
  function clear() {
    const here = trail.current;
    trail.clear();
    if (!here) {
      navigate('#/');
      return;
    }
    trail.push({ id: here.id, name: here.name, kind: here.kind, dir: 'start' });
    navigate(symbolHref(here.id, { trail: encodeTrail(trail.hops) }), { replace: true });
  }
</script>

<!-- One root element, always: the save form is a second row inside it rather
     than a sibling, so a host's layout still sees the trail bar as one box
     whose height grows only while the form is open. -->
<div class="trailwrap">
<div class="trailbar">
  <span class="label">Trail</span>

  {#if hops.length === 0}
    <span class="empty"
      >Step into a call on the right, or up to a caller on the left — the trail records the
      path.</span
    >
  {:else}
    {#each hops as hop, i (hop.id)}
      {#if i > 0}
        <span
          class="hop-arrow"
          class:up={hop.dir === 'up'}
          title={hop.dir === 'up'
            ? 'stepped up to a caller'
            : hop.dir === 'down'
              ? 'stepped down into a call'
              : 'jumped here'}
          aria-hidden="true"
        >
          {hop.dir === 'up' ? '←' : hop.dir === 'down' ? '→' : '·'}
        </span>
      {/if}
      <button
        type="button"
        class="hop"
        class:cur={i === hops.length - 1}
        aria-current={i === hops.length - 1 ? 'true' : undefined}
        onclick={() => step(i)}
      >
        <KindGlyph kind={hop.kind} />
        <span>{hopLabel(hop)}</span>
      </button>
    {/each}
  {/if}

  <span class="spacer"></span>

  {#if hops.length > 1}
    <button type="button" class="tb-btn" onclick={readAsFlow}>Read as flow</button>
  {/if}
  {#if hops.length > 0 && trails.canSave && !naming}
    <button type="button" class="tb-btn" onclick={openForm}>Save trail</button>
  {/if}
  {#if hops.length > 0}
    <button type="button" class="tb-btn" onclick={clear}>Clear</button>
  {/if}
</div>

{#if naming}
  <form class="saveform" onsubmit={submit}>
    <label for="trail-name">Name this trail</label>
    <input
      bind:this={nameInput}
      bind:value={name}
      {onkeydown}
      id="trail-name"
      type="text"
      maxlength={MAX_NAME}
      autocomplete="off"
      spellcheck="false"
      placeholder="How a request reaches the handler"
    />
    <button type="submit" class="tb-btn" disabled={problem !== null || trails.busy}>
      {trails.busy ? 'Saving…' : replaces ? 'Replace' : 'Save'}
    </button>
    <button type="button" class="tb-btn" onclick={closeForm}>Cancel</button>
    <!-- Everything the reader should know BEFORE pressing, in one line: what
         it will be called, that it will overwrite, and where it lands. -->
    <span class="hint" class:warn={replaces !== null}>
      {#if replaces}
        Replaces the saved trail of the same name.
      {:else if trails.directory}
        {hops.length} hop{hops.length === 1 ? '' : 's'} · saved to {trails.directory}
      {:else}
        {hops.length} hop{hops.length === 1 ? '' : 's'}
      {/if}
    </span>
    {#if trails.failure}
      <span class="err">{trails.failure}</span>
    {/if}
  </form>
{/if}
</div>

<style>
  .trailwrap {
    display: flex;
    min-height: 0;
    flex-direction: column;
    background: var(--paper-2);
    border-bottom: 1px solid var(--rule-soft);
  }

  .trailbar {
    display: flex;
    height: var(--trailbar-h, 34px);
    align-items: center;
    flex: 0 0 auto;
    gap: 0;
    padding: 0 18px;
    overflow-x: auto;
    white-space: nowrap;
    font-family: var(--mono);
    font-size: 12px;
  }

  .label {
    margin-right: 10px;
    color: var(--ink-3);
    font-family: var(--sans);
  }

  .empty {
    color: var(--ink-3);
    font-family: var(--sans);
  }

  .hop {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 8px;
    color: var(--ink-2);
    border: 1px solid transparent;
    font-family: var(--mono);
    font-size: 12px;
  }

  .hop:hover {
    color: var(--ink);
    background: var(--press);
  }

  .hop.cur {
    color: var(--accent);
    border-color: var(--accent-line);
    background: var(--paper);
  }

  .hop-arrow {
    padding: 0 2px;
    color: var(--ink-3);
  }

  .hop-arrow.up {
    color: var(--ink-2);
  }

  .spacer {
    flex: 1;
  }

  .tb-btn {
    margin-left: 8px;
    padding: 4px 8px;
    color: var(--ink-2);
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    font-family: var(--sans);
  }

  .tb-btn:hover:not(:disabled) {
    color: var(--ink);
    border-color: var(--ink);
  }

  .tb-btn:disabled {
    color: var(--ink-4);
    border-color: var(--rule-faint);
  }

  /* ---------- the one-field save form ---------- */

  .saveform {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 18px 8px;
    border-top: 1px solid var(--rule-faint);
    flex-wrap: wrap;
  }

  .saveform label {
    color: var(--ink-2);
    font-family: var(--sans);
    font-size: 12px;
  }

  .saveform input {
    width: 320px;
    height: 30px;
    max-width: 100%;
    padding: 0 10px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink);
    font: 13px var(--sans);
  }

  .saveform input:focus {
    border-color: var(--ink);
    outline: none;
  }

  .saveform input::placeholder {
    color: var(--ink-4);
  }

  .hint {
    color: var(--ink-3);
    font-family: var(--sans);
    font-size: 11.5px;
  }

  .hint.warn {
    color: var(--amber);
  }

  .err {
    color: var(--accent);
    font-family: var(--sans);
    font-size: 11.5px;
  }
</style>
