<!--
  The Map's 320px side panel (design spec §3.6).

  Three jobs, in the order a reader needs them: say what the picture IS and how
  it was derived, account for everything the picture leaves out, and — once a
  module is selected — become that module's dependency sheet.

  The accounting is not decoration. A map that hides thin links, drops
  name-only edges and layers on declared ones is a map with three deliberate
  omissions in it; each of them gets a sentence here, because a diagram nobody
  can audit is a diagram that gets believed too much.
-->
<script lang="ts">
  import ExportButtons from '../ExportButtons.svelte';
  import { fileHref } from '../../lib/navigation';
  import { plural } from '../../lib/symbol-model';
  import type { WireMapLink, WireMapPayload } from '../../lib/api';
  import type { MapLayout } from '../../lib/map-model';
  import type { MapFocusDirection } from '../../lib/map-focus';

  /** Older independently packaged adapters did not send `maxDepth`. */
  const LEGACY_ADAPTER_MAX_DEPTH = 4;
  /** Focus is a view state, never a normalized indexed directory root. */
  const FOCUSED_SHOWING_VALUE = '.';

  interface Props {
    payload: WireMapPayload;
    layout: MapLayout;
    selected: string | null;
    includeTests: boolean;
    files: string[];
    onToggleTests: (value: boolean) => void;
    onSelectRoot: (root: string) => void;
    /** What the reader asked for, or `null` when the depth in `payload` was chosen for them. */
    chosenDepth: number | null;
    onSelectDepth: (depth: number | null) => void;
    onSelect: (id: string | null) => void;
    /** Builds the map as an SVG at a given device-pixel scale. */
    buildSvg: (scale: number) => string;
    /** File stem for a downloaded map, without an extension. */
    exportName: string;
    focus: { id: string; direction: MapFocusDirection } | null;
    onFocus: (id: string) => void;
    onSelectFocusDirection: (direction: MapFocusDirection) => void;
    onClearFocus: () => void;
    restoredRoot: string | null;
    restoredDepth: number | null;
  }

  let {
    payload,
    layout,
    selected,
    includeTests,
    files,
    onToggleTests,
    onSelectRoot,
    chosenDepth,
    onSelectDepth,
    onSelect,
    buildSvg,
    exportName,
    focus,
    onFocus,
    onSelectFocusDirection,
    onClearFocus,
    restoredRoot,
    restoredDepth,
  }: Props = $props();

  /**
   * The grouping options.
   *
   * The first one is the default and is not a number: the answering side reads
   * the repository and picks the shallowest grouping that is not one box
   * holding the whole program. The numbers below it are there for when its
   * choice is wrong for what the reader is looking at — an escape hatch, not
   * the thing anybody should have to reach for.
   */
  const DEPTHS = $derived(
    Array.from({ length: payload.maxDepth ?? LEGACY_ADAPTER_MAX_DEPTH }, (_, index) => index + 1)
  );

  function depthLabel(depth: number): string {
    return depth === 1 ? 'top-level folders' : `${depth} folders deep`;
  }

  /** An em dash the mono face has; the select is narrow enough to notice a tofu. */
  const DASH = '\u2014';

  const selectedNode = $derived(
    selected === null ? null : (layout.nodes.find((n) => n.id === selected) ?? null)
  );
  const selectedModule = $derived(selectedNode?.module ?? null);
  /** Which of the listed files are tool-generated — the rows drawn in ink-4. */
  const generatedFiles = $derived(new Set(selectedModule?.generatedFiles ?? []));

  const dependencies = $derived(
    selected === null
      ? []
      : layout.edges
          .filter((e) => e.source === selected)
          .map((e) => e.link)
          .sort((a, b) => b.count - a.count || a.target.localeCompare(b.target))
  );
  const dependents = $derived(
    selected === null
      ? []
      : layout.edges
          .filter((e) => e.target === selected)
          .map((e) => e.link)
          .sort((a, b) => b.count - a.count || a.source.localeCompare(b.source))
  );

  const thinCount = $derived(layout.edges.filter((e) => e.thin && !e.back).length);
  const focusDirectionLabel = $derived(focus?.direction === 'depends-on' ? 'Depends on' : 'Used by');
</script>

<aside class="mapside">
  <h2>Architecture map</h2>
  <p>
    Derived from the graph, not drawn by hand: each module sits one layer above the modules it
    depends on, so reading top to bottom follows the dependency direction. Line weight is how many
    calls, imports and type references cross the link.
  </p>

  <!-- The map is the thing people paste into a README, so the way out sits
       directly under the sentence explaining what it is. -->
  <ExportButtons build={buildSvg} filename={exportName} />

  <label class="field">
    <span>Showing</span>
    <select
      value={focus === null ? payload.root : FOCUSED_SHOWING_VALUE}
      onchange={(event) => {
        const root = (event.currentTarget as HTMLSelectElement).value;
        if (root !== FOCUSED_SHOWING_VALUE) onSelectRoot(root);
      }}
    >
      {#if focus !== null}
        <option value={FOCUSED_SHOWING_VALUE} disabled
          >Focus: {focus.id} · {focusDirectionLabel}</option
        >
      {/if}
      {#each payload.roots as option (option.root)}
        <option value={option.root}>{option.label} · {option.files} files</option>
      {/each}
    </select>
  </label>

  <!-- The grouping. A repository whose whole program sits under one directory
       draws as one box at the shallowest setting, which is why the default is
       chosen from the repository rather than fixed at 1. -->
  <label class="field">
    <span>Grouping</span>
    <select
      value={chosenDepth === null ? 'auto' : String(chosenDepth)}
      disabled={focus !== null}
      onchange={(event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        onSelectDepth(value === 'auto' ? null : Number(value));
      }}
    >
      <option value="auto">automatic {DASH} {depthLabel(payload.depth)}</option>
      {#each DEPTHS as option (option)}
        <option value={String(option)}>{depthLabel(option)}</option>
      {/each}
    </select>
  </label>
  {#if focus !== null}
    <p class="focusname">
      <b>Focused module</b><br />
      <span class="mono">{focus.id}</span><br />
      {focus.direction === 'depends-on' ? 'Everything it depends on' : 'Everything that uses it'}
    </p>
    {#if layout.nodes.length === 1}
      <p class="dim">
        No other indexed modules {focus.direction === 'depends-on'
          ? 'are reachable through its dependencies'
          : 'depend on it'} under the current filters.
      </p>
    {/if}
    <p class="dim">Grouping stays fixed while focused so module identities remain stable.</p>
    <label class="field">
      <span>Direction</span>
      <select
        value={focus.direction}
        onchange={(event) =>
          onSelectFocusDirection((event.currentTarget as HTMLSelectElement).value as MapFocusDirection)}
      >
        <option value="depends-on">Depends on</option>
        <option value="used-by">Used by</option>
      </select>
    </label>
    <button class="clear" onclick={onClearFocus}
      >Clear focus · return to {restoredRoot || 'whole repository'} · {restoredDepth === null
        ? 'automatic grouping'
        : depthLabel(restoredDepth)}</button
    >
  {/if}

  <label class="toggle">
    <input
      type="checkbox"
      checked={includeTests}
      onchange={(event) => onToggleTests((event.currentTarget as HTMLInputElement).checked)}
    />
    Include test modules
  </label>

  <div class="notes">
    {#if thinCount > 0}
      <p class="dim">
        {plural(thinCount, 'link')} carrying fewer than {layout.minWeight} references
        {thinCount === 1 ? 'is' : 'are'} hidden until you select a module {thinCount === 1
          ? 'it'
          : 'they'} touch.
      </p>
    {/if}
    {#if layout.basis.kind === 'declared'}
      <p class="dim">
        The layering uses the {layout.basis.declaredLinks} of {layout.basis.totalLinks} links with an
        import, a qualified name, an inheritance clause or a typed receiver behind them. Bare
        name matches still count toward line weight, but they do not decide what sits above what.
      </p>
    {:else}
      <p class="dim">
        Too few links here carry an import or a declared type, so the layering uses raw reference
        counts. A name shared by two unrelated modules can move a box.
      </p>
    {/if}
    {#if payload.excluded.uncertainEdges > 0}
      <p class="dim">
        {plural(payload.excluded.uncertainEdges, 'cross-module reference')} below confidence {payload
          .excluded.confidenceBelow}
        {payload.excluded.uncertainEdges === 1 ? 'is' : 'are'} excluded from every count on this
        screen — they are name-only guesses.
      </p>
    {/if}
  </div>

  {#if layout.mutual.length > 0}
    <details>
      <summary>
        Mutual dependencies
        <span class="dim">
          · {plural(layout.mutual.length, 'pair')} — the lighter direction, dashed when
          selected
        </span>
      </summary>
      {#each layout.mutual.slice(0, 8) as pair (pair.back.source + pair.back.target)}
        <div class="cyc">
          <b>{pair.back.source}</b> ⇄ {pair.back.target}
          <span class="dim">({pair.back.count} back-references)</span>
        </div>
      {/each}
      {#if layout.mutual.length > 8}
        <div class="cyc dim">+{layout.mutual.length - 8} more</div>
      {/if}
    </details>
  {/if}

  {#if layout.moduleCycles.length > 0}
    <details>
      <summary>
        Dependency cycles
        <span class="dim">
          · {plural(layout.moduleCycles.length, 'loop')} of three or more modules
        </span>
      </summary>
      {#each layout.moduleCycles.slice(0, 6) as cycle, i (i)}
        <div class="cyc">{cycle.join(' → ')} → {cycle[0]}</div>
      {/each}
    </details>
  {/if}

  {#if focus === null && payload.cycles.total > 0}
    <details>
      <summary>
        Circular imports between files
        <span class="dim">
          · {plural(payload.cycles.total, 'group')}
        </span>
      </summary>
      {#each payload.cycles.items.slice(0, 6) as cycle, i (i)}
        <div class="cyc">
          <span class="dim">{cycle.size} files ·</span>
          {cycle.modules.join(', ')}
        </div>
        {#each cycle.files as file (file)}
          <a class="filerow" href={fileHref(file)}>{file}</a>
        {/each}
        {#if cycle.size > cycle.files.length}
          <div class="cyc dim">+{cycle.size - cycle.files.length} more files in this group</div>
        {/if}
      {/each}
      {#if payload.cycles.truncated}
        <div class="cyc dim">+{payload.cycles.total - payload.cycles.shown} more groups</div>
      {/if}
    </details>
  {/if}

  {#if selectedModule}
    <div class="edgeinfo">
      <div class="head">
        <b class="mono">{selectedModule.id}</b>
        <button class="clear" onclick={() => onSelect(null)}>clear</button>
      </div>
      <p>
        {plural(selectedModule.symbols, 'symbol')} in {plural(selectedModule.files, 'file')}
        {#if selectedModule.languages.length > 0}
          · {selectedModule.languages.map((l) => `${l.language} ${l.files}`).join(', ')}
        {/if}
        {#if selectedModule.generated > 0}
          · {selectedModule.generated === selectedModule.files
            ? 'all tool-generated'
            : `${selectedModule.generated} tool-generated`}
        {/if}
      </p>
      {#if focus === null || focus.id !== selectedModule.id}
        <button class="clear" onclick={() => onFocus(selectedModule.id)}>Focus</button>
      {/if}

      {#if (selectedModule.dependents?.files ?? 0) > 0}
        <p class="reach">
          <b>{plural(selectedModule.dependents.files, 'file')}</b> outside it, across
          {plural(selectedModule.dependents.modules, 'module')}, reference straight into it — the
          floor on what a change here has to be checked against, and the bar along the bottom of
          the box.
        </p>
      {/if}

      {#if selectedNode?.island}
        <p class="island">
          Nothing in this view depends on this module — no import, call or reference crosses into
          it. It may be an entry point, or reached in a way the graph cannot see.
        </p>
      {/if}

      {@render linkList('depends on', dependencies, 'target')}
      {@render linkList('depended on by', dependents, 'source')}

      <div class="pair label">files</div>
      {#if files.length > 0}
        {#each files as file (file)}
          <a
            class="filerow"
            class:gen={generatedFiles.has(file)}
            href={fileHref(file)}
            title={generatedFiles.has(file) ? `${file} — tool-generated` : file}>{file}</a
          >
        {/each}
      {:else}
        <div class="pair dim">no files in the index for this module</div>
      {/if}
    </div>
  {:else}
    <div class="edgeinfo">
      <p class="dim">
        Hover a link to see what crosses it — the counts by kind and the symbol pairs behind the
        weight. Click a module to isolate its links and list its files.
      </p>
    </div>
  {/if}
</aside>

{#snippet linkList(label: string, links: WireMapLink[], side: 'source' | 'target')}
  <div class="pair label">{label}</div>
  {#if links.length > 0}
    {#each links as link (link.source + link.target)}
      <div class="pair">
        <b>{side === 'target' ? link.target : link.source}</b>
        <span>{link.count}</span>
      </div>
    {/each}
  {:else}
    <div class="pair dim">nothing</div>
  {/if}
{/snippet}

<style>
  .mapside {
    border-left: 1px solid var(--rule-soft);
    overflow: auto;
    padding: 14px 16px;
    background: var(--paper);
  }
  h2 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
  }
  p {
    margin: 0 0 10px;
    color: var(--ink-2);
    font-size: 12.5px;
    line-height: 1.5;
    max-width: 40ch;
  }
  .dim {
    color: var(--ink-3);
  }
  .notes p {
    font-size: 11.5px;
    margin-bottom: 8px;
  }
  .reach {
    font-size: 11.5px;
    margin: 0 0 8px;
  }
  .focusname {
    overflow-wrap: anywhere;
  }
  .field {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12.5px;
    color: var(--ink-2);
    margin: 12px 0 8px;
  }
  .field select {
    flex: 1 1 auto;
    min-width: 0;
    font: 12px var(--mono);
    color: var(--ink);
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    border-radius: 0;
    padding: 3px 4px;
  }
  .toggle {
    display: flex;
    gap: 8px;
    align-items: center;
    font-size: 12.5px;
    color: var(--ink-2);
    margin: 0 0 12px;
    cursor: pointer;
  }
  .toggle input {
    margin: 0;
    accent-color: var(--ink);
  }
  details {
    margin: 4px 0 10px;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    font-size: 12.5px;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  summary .dim {
    font-weight: 400;
  }
  .cyc {
    font: 11.5px var(--mono);
    color: var(--ink-2);
    padding: 3px 0;
  }
  .cyc b {
    color: var(--accent);
    font-weight: 500;
  }
  .edgeinfo {
    margin-top: 12px;
    border-top: 1px solid var(--rule-soft);
    padding-top: 10px;
  }
  .head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 8px;
  }
  .mono {
    font: 500 12.5px var(--mono);
  }
  .clear {
    border: 0;
    background: none;
    padding: 0;
    font: 11.5px var(--sans);
    color: var(--ink-3);
    cursor: pointer;
    text-decoration: underline;
  }
  .clear:hover {
    color: var(--accent);
  }
  .pair {
    font: 11.5px var(--mono);
    color: var(--ink-2);
    padding: 2px 0;
    display: flex;
    justify-content: space-between;
    gap: 10px;
  }
  .pair b {
    color: var(--ink);
    font-weight: 500;
  }
  .pair.label {
    font: 400 11.5px var(--sans);
    color: var(--ink-3);
    margin-top: 8px;
  }
  .filerow {
    display: block;
    font: 11.5px var(--mono);
    color: var(--ink-2);
    padding: 2px 0;
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .filerow:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  /* Generated code recedes wherever it appears (design spec §2.6). */
  .filerow.gen {
    color: var(--ink-4);
  }

  .island {
    margin: 6px 0 0;
    color: var(--ink-2);
    font-size: 11.5px;
    line-height: 1.45;
  }
</style>
