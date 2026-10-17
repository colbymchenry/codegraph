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
  import { moduleTarget } from '../../lib/map-scope';
  import DirectoryBrowser from '../graph/DirectoryBrowser.svelte';
  import { getGraphAdapter } from '../../lib/adapter';
  import { graphText } from '../../lib/graph-copy';
  import { graphCycles } from '../../lib/graph-analysis';
  import VirtualList from '../graph/VirtualList.svelte';
  import ExportButtons from '../ExportButtons.svelte';
  import { fileHref } from '../../lib/navigation';
  import { plural } from '../../lib/symbol-model';
  import type { WireMapLink, WireMapPayload } from '../../lib/api';
  import type { MapLayout } from '../../lib/map-model';

  interface Props {
    payload: WireMapPayload;
    layout: MapLayout;
    selected: string | null;
    includeTests: boolean;
    detailsRequested?: boolean;
    detailsLoading?: boolean;
    detailsFailed?: boolean;
    onLoadDetails?: () => void;
    files: string[];
    onToggleTests: (value: boolean) => void;
    onSelectRoot: (root: string) => void;
    onSelect: (id: string | null) => void;
    /** Builds the map as an SVG at a given device-pixel scale. */
    buildSvg: (scale: number) => string;
    /** File stem for a downloaded map, without an extension. */
    exportName: string;
  }

  let {
    payload,
    detailsRequested = false,
    detailsLoading = false,
    detailsFailed = false,
    onLoadDetails,
    layout,
    selected,
    files,
    onSelect,
    onSelectRoot,
    buildSvg,
    exportName,
  }: Props = $props();

  const selectedNode = $derived(
    selected === null ? null : (layout.nodes.find((n) => n.id === selected) ?? null)
  );
  const selectedModule = $derived(selectedNode?.module ?? null);
  const target = $derived(selectedModule ? moduleTarget(selectedModule) : null);
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

  const thinCount = $derived(layout.edges.filter((e) => e.thin).length);
  const moduleCycles = $derived(graphCycles(layout.nodes.map(n=>n.id),layout.edges.filter(e=>!e.thin)));
</script>

<aside class="mapside">
  <h2>Architecture map</h2>
  <p>
    {graphText('默认从左向右分层，也可切换力导向、同心圆或环形。同心圆按连接数量排列，连接多的节点更靠内。箭头从调用或依赖方指向目标，双向依赖合并为双箭头；悬停显示各方向数量。拖动节点可整理位置，播放仅示意静态关系。', 'The default layout is left to right; force-directed, concentric and circular layouts are also available. Concentric rings place nodes with more neighbours closer to the centre. Arrows point from caller or dependent to target; mutual dependencies share a double arrow. Hover for directional counts. Drag to arrange; playback illustrates static relationships.')}
  </p>

  <!-- The map is the thing people paste into a README, so the way out sits
       directly under the sentence explaining what it is. -->
  <ExportButtons build={buildSvg} filename={exportName} />

  <div class="notes">
    {#if payload.detailsDeferred}
      <p class="dim">{graphText('概览仅加载模块关系。调用点请在符号关系列表中查看；文件级循环需要显式加载。', 'The overview loads module relationships only. Inspect call sites in symbol relationships; load file-level cycles explicitly.')}</p>
      {#if onLoadDetails}<button class="load-details" disabled={detailsLoading} onclick={onLoadDetails}>{detailsLoading && detailsRequested ? graphText('加载中…', 'Loading…') : graphText('加载文件级循环', 'Load file-level cycles')}</button>{/if}
      {#if detailsRequested && !detailsLoading && !detailsFailed}<p class="dim">{graphText('该范围仍超过 400 个文件或 2000 条文件关系，请进一步缩小目录范围后加载。', 'This scope still exceeds 400 files or 2,000 file relationships. Narrow the directory before loading cycles.')}</p>{/if}
    {:else if detailsRequested && payload.cycles.total === 0 && !payload.cycles.truncated}
      <p class="dim">{graphText('当前文件范围已检查，未发现文件级循环。', 'The current file scope was checked; no file-level cycles were found.')}</p>
    {/if}
    {#if thinCount > 0}
      <p class="dim">
        {graphText('权重筛选隐藏关系：', 'Relationships hidden by weight filter: ')}{thinCount} · &lt; {layout.minWeight}
      </p>
    {/if}
    <p class="dim">{graphText('布局与模块级循环分析使用当前筛选范围内的真实有向关系。模块级循环与下方文件级循环独立计算；缺失置信度不作推断。', 'Layout and module cycles use real directed relationships in the filtered scope. Module cycles and file cycles below are computed independently; missing confidence is not inferred.')}</p>
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
          · {plural(layout.mutual.length, 'pair')} · {graphText('双箭头，保留两个方向计数', 'double arrow, both directional counts retained')}
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

  {#if moduleCycles.length > 0}
    <details>
      <summary>
        {graphText('模块级循环', 'Module cycles')}
        <span class="dim">
          · {moduleCycles.length}
        </span>
      </summary>
      {#each moduleCycles.slice(0, 6) as cycle, i (i)}
        <div class="cyc"><button onclick={() => onSelect(cycle[0] ?? null)}>{cycle.join(' → ')} → {cycle[0]}</button></div>
      {/each}
    </details>
  {/if}

  {#if payload.cycles.total > 0 && (payload.detailsDeferred === undefined || detailsRequested)}
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

      {#if selectedNode?.island}
        <p class="island">
          Nothing in the index depends on this module — no import, call or reference crosses into
          it. It may be an entry point, or reached in a way the graph cannot see.
        </p>
      {/if}

      {@render linkList('depends on', dependencies, 'target')}
      {@render linkList('depended on by', dependents, 'source')}

      {#if target?.kind === 'file'}
        <a class="filerow" href={fileHref(target.path)}>{target.path}</a>
      {:else if target && getGraphAdapter().browse}
        <DirectoryBrowser root={target.path} filesOnly={target.kind === 'root-files'} onOpen={onSelectRoot} />
      {:else if files.length > 0}
        <VirtualList items={files}>{#snippet row(file)}
          <a
            class="filerow"
            class:gen={generatedFiles.has(file)}
            href={fileHref(file)}
            title={generatedFiles.has(file) ? `${file} — tool-generated` : file}>{file}</a
          >
        {/snippet}</VirtualList>
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
    <VirtualList items={links}>{#snippet row(link)}
      <div class="pair">
        <b>{side === 'target' ? link.target : link.source}</b>
        <span>{link.count}</span>
      </div>
    {/snippet}</VirtualList>
  {:else}
    <div class="pair dim">nothing</div>
  {/if}
{/snippet}

<style>
  .load-details{min-height:36px;padding:4px 10px;border:1px solid var(--rule);background:var(--paper);color:var(--ink);font:14px var(--sans)}
  .mapside {
    border-left: 1px solid var(--route-branch);
    overflow: auto;
    padding: 14px 16px;
    background: var(--paper-2);
    box-shadow: inset 3px 0 0 color-mix(in srgb, var(--route-branch) 28%, transparent);
  }
  h2 {
    margin: 0 0 6px;
    font-size: 15px;
    font-weight: 600;
    padding-left: 8px;
    border-left: 3px solid var(--route-main);
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
