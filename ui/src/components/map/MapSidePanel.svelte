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
  import { t, tPair } from '../../lib/locale.svelte';
  import type { WireMapLink, WireMapPayload } from '../../lib/api';
  import type { MapLayout } from '../../lib/map-model';

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
  const DEPTHS = [1, 2, 3, 4] as const;

  function depthLabel(depth: number): string {
    return depth === 1 ? t('map.topLevelFolders') : t('map.foldersDeep', { n: depth });
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
</script>

<aside class="mapside">
  <h2>{t('map.title')}</h2>
  <p>
    {t('map.intro')}
  </p>

  <!-- The map is the thing people paste into a README, so the way out sits
       directly under the sentence explaining what it is. -->
  <ExportButtons build={buildSvg} filename={exportName} />

  <label class="field">
    <span>{t('map.showingLabel')}</span>
    <select
      value={payload.root}
      onchange={(event) => onSelectRoot((event.currentTarget as HTMLSelectElement).value)}
    >
      {#each payload.roots as option (option.root)}
        <option value={option.root}>{t('map.rootOption', { label: option.label, files: option.files })}</option>
      {/each}
    </select>
  </label>

  <!-- The grouping. A repository whose whole program sits under one directory
       draws as one box at the shallowest setting, which is why the default is
       chosen from the repository rather than fixed at 1. -->
  <label class="field">
    <span>{t('map.groupingLabel')}</span>
    <select
      value={chosenDepth === null ? 'auto' : String(chosenDepth)}
      onchange={(event) => {
        const value = (event.currentTarget as HTMLSelectElement).value;
        onSelectDepth(value === 'auto' ? null : Number(value));
      }}
    >
      <option value="auto">{t('map.automatic', { dash: DASH, depth: depthLabel(payload.depth) })}</option>
      {#each DEPTHS as option (option)}
        <option value={String(option)}>{depthLabel(option)}</option>
      {/each}
    </select>
  </label>

  <label class="toggle">
    <input
      type="checkbox"
      checked={includeTests}
      onchange={(event) => onToggleTests((event.currentTarget as HTMLInputElement).checked)}
    />
    {t('map.includeTests')}
  </label>

  <div class="notes">
    {#if thinCount > 0}
      <p class="dim">
        {t('map.thinNote', {
          n: plural(thinCount, tPair('sym.linkWord')[0]),
          minWeight: layout.minWeight,
          isAre: thinCount === 1 ? t('map.is') : t('map.are'),
          itThey: thinCount === 1 ? t('map.it') : t('map.they'),
        })}
      </p>
    {/if}
    {#if layout.basis.kind === 'declared'}
      <p class="dim">
        {t('map.declaredBasis', { declared: layout.basis.declaredLinks, total: layout.basis.totalLinks })}
      </p>
    {:else}
      <p class="dim">
        {t('map.rawBasis')}
      </p>
    {/if}
    {#if payload.excluded.uncertainEdges > 0}
      <p class="dim">
        {t('map.uncertainNote', {
          n: plural(payload.excluded.uncertainEdges, tPair('sym.crossModuleReferenceWord')[0]),
          confidence: payload.excluded.confidenceBelow,
          isAre: payload.excluded.uncertainEdges === 1 ? t('map.is') : t('map.are'),
        })}
      </p>
    {/if}
  </div>

  {#if layout.mutual.length > 0}
    <details>
      <summary>
        {t('map.mutual')}
        <span class="dim">
          {t('map.mutualCount', { n: plural(layout.mutual.length, tPair('sym.pairWord')[0]) })}
        </span>
      </summary>
      {#each layout.mutual.slice(0, 8) as pair (pair.back.source + pair.back.target)}
        <div class="cyc">
          <b>{pair.back.source}</b> ⇄ {pair.back.target}
          <span class="dim">{t('map.backReferences', { n: pair.back.count })}</span>
        </div>
      {/each}
      {#if layout.mutual.length > 8}
        <div class="cyc dim">{t('map.more', { n: layout.mutual.length - 8 })}</div>
      {/if}
    </details>
  {/if}

  {#if layout.moduleCycles.length > 0}
    <details>
      <summary>
        {t('map.cycles')}
        <span class="dim">
          {t('map.cyclesCount', { n: plural(layout.moduleCycles.length, tPair('sym.loopWord')[0]) })}
        </span>
      </summary>
      {#each layout.moduleCycles.slice(0, 6) as cycle, i (i)}
        <div class="cyc">{cycle.join(' → ')} → {cycle[0]}</div>
      {/each}
    </details>
  {/if}

  {#if payload.cycles.total > 0}
    <details>
      <summary>
        {t('map.circularImports')}
        <span class="dim">
          {t('map.groupsCount', { n: plural(payload.cycles.total, tPair('sym.groupWord')[0]) })}
        </span>
      </summary>
      {#each payload.cycles.items.slice(0, 6) as cycle, i (i)}
        <div class="cyc">
          <span class="dim">{t('map.cycleFiles', { n: cycle.size })}</span>
          {cycle.modules.join(', ')}
        </div>
        {#each cycle.files as file (file)}
          <a class="filerow" href={fileHref(file)}>{file}</a>
        {/each}
        {#if cycle.size > cycle.files.length}
          <div class="cyc dim">{t('map.moreFilesInGroup', { n: cycle.size - cycle.files.length })}</div>
        {/if}
      {/each}
      {#if payload.cycles.truncated}
        <div class="cyc dim">{t('map.moreGroups', { n: payload.cycles.total - payload.cycles.shown })}</div>
      {/if}
    </details>
  {/if}

  {#if selectedModule}
    <div class="edgeinfo">
      <div class="head">
        <b class="mono">{selectedModule.id}</b>
        <button class="clear" onclick={() => onSelect(null)}>{t('scr.clear')}</button>
      </div>
      <p>
        {t('map.selectedCounts', { symbols: plural(selectedModule.symbols, tPair('file.symbolWord')[0]), files: plural(selectedModule.files, tPair('sym.fileWord')[0]) })}
        {#if selectedModule.languages.length > 0}
          · {selectedModule.languages.map((l) => `${l.language} ${l.files}`).join(', ')}
        {/if}
        {#if selectedModule.generated > 0}
          · {selectedModule.generated === selectedModule.files
            ? t('map.allToolGenerated')
            : t('map.toolGeneratedCount', { n: selectedModule.generated })}
        {/if}
      </p>

      {#if (selectedModule.dependents?.files ?? 0) > 0}
        <p class="reach">
          <b>{plural(selectedModule.dependents.files, tPair('sym.fileWord')[0])}</b> {t('map.reach', { modules: plural(selectedModule.dependents.modules, tPair('sym.moduleWord')[0]) })}
        </p>
      {/if}

      {#if selectedNode?.island}
        <p class="island">
          {t('map.islandBody')}
        </p>
      {/if}

      {@render linkList(t('map.dependsOn'), dependencies, 'target')}
      {@render linkList(t('map.dependedOnBy'), dependents, 'source')}

      <div class="pair label">{t('map.filesLabel')}</div>
      {#if files.length > 0}
        {#each files as file (file)}
          <a
            class="filerow"
            class:gen={generatedFiles.has(file)}
            href={fileHref(file)}
            title={generatedFiles.has(file) ? t('map.fileGeneratedTitle', { file }) : file}>{file}</a
          >
        {/each}
      {:else}
        <div class="pair dim">{t('map.noFiles')}</div>
      {/if}
    </div>
  {:else}
    <div class="edgeinfo">
      <p class="dim">
        {t('map.hint')}
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
    <div class="pair dim">{t('map.nothing')}</div>
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
