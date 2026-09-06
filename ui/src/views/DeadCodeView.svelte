<script lang="ts">
  /**
   * Dead code — symbols nothing in this repository reaches, grouped by file
   * (design spec §3.11).
   *
   * The screen is a list and a disclaimer, deliberately in that order and
   * deliberately inseparable. The caveat line sits above the rows and never
   * goes away, because the claim behind every row is "no static reference in
   * the index" and not "unused": reflection, a framework registry and a
   * template can all reach code the graph cannot follow. Underneath, every
   * reason a candidate was left off is printed with its count — a list of
   * twenty drawn from two and a half thousand candidates means something very
   * different from a list of twenty drawn from twenty-one.
   *
   * The one switch is "including exported". Off (the default) the list is only
   * symbols nothing outside this repository could import either; on, it widens
   * to symbols the index has no way to check, and says so. It travels in the
   * URL like the map's shape does, so a link reopens the same list.
   *
   * The other half of this task lives on the Map: a module nothing depends on
   * says so in its own count line. See `lib/map-model.ts`.
   */
  import KindGlyph from '../components/KindGlyph.svelte';
  import { fetchDeadCode, ApiFailure, type WireDeadCode, type WireDeadCodeRow } from '../lib/api';
  import { deadHref, fileHref, navigate, symbolHref } from '../lib/navigation';
  import { live } from '../lib/live.svelte';
  import {
    DEAD_CODE_CAVEAT,
    deadCodeHeadline,
    deadCodeRowMeta,
    deadCodeScale,
    emptyMessage,
    exclusionPhrases,
    groupMeta,
  } from '../lib/deadcode-model';

  interface Props {
    /** Include symbols something outside the index could import. */
    exported?: boolean;
  }

  let { exported = false }: Props = $props();

  let payload = $state<WireDeadCode | null>(null);
  let failure = $state<string | null>(null);
  let loading = $state(true);

  $effect(() => {
    const includeExported = exported;
    // The index moving invalidates every row: a symbol is on this list because
    // of what the graph does NOT contain, which is exactly what a sync changes.
    void live.indexTick;
    const controller = new AbortController();
    loading = true;
    failure = null;
    fetchDeadCode({ includeExported }, controller.signal)
      .then((next) => {
        payload = next;
        loading = false;
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        failure = error instanceof ApiFailure ? error.message : 'The list could not be read.';
        loading = false;
      });
    return () => controller.abort();
  });

  let headline = $derived(deadCodeHeadline(payload));
  let scale = $derived(deadCodeScale(payload));
  let phrases = $derived(exclusionPhrases(payload));

  function open(row: WireDeadCodeRow): void {
    navigate(symbolHref(row.id, { line: row.line }));
  }
</script>

<div class="scroll">
  <div class="head">
    <h2>Dead code</h2>
    <p>
      Symbols no import, call or reference in this index reaches, largest first. Everything below
      is what the graph can see; the notes under the list are what it cannot.
    </p>
  </div>

  <div class="bar">
    <p class="caveat">{DEAD_CODE_CAVEAT}</p>
    <a
      class="toggle"
      class:on={exported}
      href={deadHref({ exported: !exported })}
      title={exported
        ? 'Back to symbols nothing outside this repository could import either'
        : 'Also list symbols something outside this repository could import — the index cannot check those'}
      onclick={(event) => {
        event.preventDefault();
        navigate(deadHref({ exported: !exported }));
      }}>{exported ? 'Including exported' : 'Internal only'}</a
    >
  </div>

  {#if failure}
    <p class="state">Could not read the list — {failure}</p>
  {:else if loading && payload === null}
    <p class="state">Reading the graph…</p>
  {:else if payload}
    {#if exported}
      <p class="warn">
        Exported symbols are on this list. Nothing in this repository references them, but anything
        outside it can — a published package, another service, a script. Read each one before you
        believe it.
      </p>
    {/if}

    {#if payload.groups.length === 0}
      <p class="state">{emptyMessage(payload)}</p>
    {:else}
      <p class="headline">{headline}</p>
      <div class="groups">
        {#each payload.groups as group (group.file)}
          <div class="filegroup" class:gen={group.generated}>
            <div class="fpath">
              <a href={fileHref(group.file)} title={group.file}>{group.file}</a>
              <b>{groupMeta(group)}</b>
            </div>
            {#each group.rows as row (row.id)}
              <div class="row">
                <KindGlyph kind={row.kind} />
                <div class="body">
                  <div class="line">
                    <button
                      type="button"
                      class="nm"
                      title={row.qualifiedName}
                      data-dead-row={row.id}
                      onclick={() => open(row)}>{row.name}</button
                    >
                    <a class="ln" href={fileHref(group.file, { source: true, line: row.line })}
                      >{row.file}:{row.line}</a
                    >
                    {#if row.exported}<span class="chip">exported</span>{/if}
                  </div>
                  <div class="meta">{deadCodeRowMeta(row)}</div>
                  {#if row.members.items.length > 0}
                    <div class="members">
                      {#each row.members.items as member (member.id)}
                        <a class="member" href={symbolHref(member.id)}>{member.name}</a>
                      {/each}
                      {#if row.members.truncated}
                        <span class="member more"
                          >+{row.members.total - row.members.shown} more</span
                        >
                      {/if}
                    </div>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/each}
      </div>
    {/if}

    <div class="notes">
      <p>{scale}</p>
      {#if phrases.length > 0}
        <ul>
          {#each phrases as phrase (phrase)}
            <li>{phrase}</li>
          {/each}
        </ul>
      {/if}
      {#if !payload.corroborated}
        <p>
          The rows were not checked against the text of the files that can reach them, so a
          reference the extractor did not record would not have been caught.
        </p>
      {/if}
      {#if payload.bounded}
        <p>
          The scan stopped at its cap — this index holds more unreferenced symbols than were
          considered.
        </p>
      {/if}
      {#if payload.rows.truncated}
        <p>
          Showing {payload.rows.shown} of {payload.rows.total} — the rest are in the index, not on
          this list.
        </p>
      {/if}
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

  .bar {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 16px;
    max-width: 760px;
    margin: 14px 40px 0;
    padding: 6px 0;
    border-top: 1px solid var(--rule-soft);
    border-bottom: 1px solid var(--rule-soft);
  }

  /* The caveat is never dismissible and never collapsed: it is the difference
     between "nothing references this" and "nobody uses this". */
  .caveat {
    margin: 0;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.4;
  }

  .toggle {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--rule-soft);
    color: var(--ink-2);
    font: 11px var(--mono);
    text-decoration: none;
  }

  .toggle:hover {
    border-color: var(--ink);
    color: var(--ink);
  }

  .toggle.on {
    border-color: var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
  }

  .warn {
    max-width: 760px;
    margin: 12px 40px 0;
    padding: 8px 12px;
    border: 1px solid var(--accent-line);
    background: var(--accent-soft);
    color: var(--ink-2);
    font-size: 11.5px;
    line-height: 1.45;
  }

  .headline {
    max-width: 760px;
    margin: 14px 40px 0;
    color: var(--ink-2);
    font-size: 12.5px;
  }

  .state {
    max-width: 760px;
    padding: 16px 40px 40px;
    color: var(--ink-3);
    font-size: 12.5px;
    line-height: 1.5;
  }

  .groups {
    max-width: 760px;
    margin: 8px 40px 0;
    border: 1px solid var(--rule-soft);
  }

  .filegroup {
    padding: 10px 14px 6px;
    border-bottom: 1px solid var(--rule-faint);
  }

  .filegroup:last-child {
    border-bottom: 0;
  }

  .fpath {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 4px;
    color: var(--ink-3);
    font: 11px var(--mono);
  }

  .fpath a {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .fpath a:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  .fpath b {
    flex: none;
    color: var(--ink-2);
    font-weight: 500;
  }

  /* Generated code recedes wherever it appears (design spec §2.6). */
  .filegroup.gen .fpath,
  .filegroup.gen .fpath b,
  .filegroup.gen .nm,
  .filegroup.gen .meta {
    color: var(--ink-4);
  }

  .row {
    display: grid;
    grid-template-columns: 16px 1fr;
    gap: 8px;
    align-items: start;
    margin: 0 -6px;
    padding: 5px 6px 5px 4px;
    border: 1px solid transparent;
  }

  .row:hover {
    background: var(--press);
  }

  .body {
    min-width: 0;
  }

  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
  }

  .nm {
    overflow: hidden;
    min-width: 0;
    color: var(--ink);
    font: 12.5px var(--mono);
    text-align: left;
    text-overflow: ellipsis;
    white-space: nowrap;
    cursor: pointer;
  }

  .ln {
    flex: none;
    color: var(--ink-3);
    font: 11px var(--mono);
    text-decoration: none;
  }

  .ln:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .chip {
    flex: none;
    padding: 0 4px;
    border: 1px solid var(--accent-line);
    background: var(--accent-soft);
    color: var(--accent);
    font: 11px var(--mono);
  }

  .meta {
    margin-top: 1px;
    overflow: hidden;
    color: var(--ink-3);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .members {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 8px;
    margin-top: 3px;
  }

  .member {
    color: var(--ink-3);
    font: 11px var(--mono);
    text-decoration: none;
  }

  .member:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .member.more {
    color: var(--ink-4);
  }

  .notes {
    max-width: 760px;
    margin: 14px 40px 48px;
    color: var(--ink-3);
    font-size: 11.5px;
    line-height: 1.5;
  }

  .notes p {
    margin: 0 0 6px;
  }

  .notes ul {
    margin: 0;
    padding-left: 16px;
  }
</style>
