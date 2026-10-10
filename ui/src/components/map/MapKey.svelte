<script lang="ts">
  import { graphText } from '../../lib/graph-copy';
  /**
   * The Map's key (design spec §3.6), matching the Screens and Steps views'.
   *
   * Each row draws the actual stroke or box rather than a word for it — a
   * reader matches shapes. Two rows here exist because the Map hides things at
   * rest and a picture that hides must say so: the thin links, and the dashed
   * back-edges that appear only once a module is selected. A reader who selects
   * `src/utils` and watches four maroon dashes appear has no way to guess what
   * they are, and the side panel's prose is not where anyone looks for a stroke.
   */

  interface Props {
    /** The weight below which a link waits for a selection. */
    minWeight: number;
    /** How many links are waiting on one right now; the row is skipped at zero. */
    thinCount: number;
    /** Whether the vertical order came from declared edges or from raw counts. */
    declaredBasis: boolean;
    open: boolean;
    onToggle: (open: boolean) => void;
  }
  let { minWeight, thinCount, declaredBasis, open, onToggle }: Props = $props();
</script>

<div class="legend" class:open>
  <button class="legend-h" onclick={() => onToggle(!open)} aria-expanded={open}>
    Key <span class="dim">{open ? '▾' : '▸'}</span>
  </button>
  {#if open}
    <div class="legend-body">
      <div class="lrow">
        <span class="k-box mono">src/api</span>
        <span>{graphText('模块——一个目录及其中的符号和文件', 'A module — one directory, with the symbols and files in it')}</span>
      </div>
      <div class="lrow">
        <span class="k-box k-weight mono">src/db</span>
        <span>
          {graphText('底部横条表示依赖程度：其他位置直接引用该模块的文件数，相对于当前被依赖最多的模块。数量显示在方框上', 'The bar along the bottom is how much leans on it — files elsewhere that reference straight into it, against the most depended-on box here. The count is on the box')}
        </span>
      </div>
      <div class="lrow">
        <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line" /></svg>
        <span>
          Depends on — the box above calls, imports, extends or names a type from the box below.
          Thicker is more references{declaredBasis
            ? ''
            : '; here the layering had too few imports to trust, so it used raw counts'}
        </span>
      </div>
      <div class="lrow">
        <svg width="44" height="12" aria-hidden="true"><path d="M2 6 H42" class="k-line k-back" /></svg>
        <span>
          {graphText('向上返回——相互依赖中较轻的一侧，或没有导入或声明类型依据的连接。仅在选中其关联模块时绘制', 'Points back up — the lighter half of a mutual dependency, or a link with no import or declared type behind it. Drawn only while a module it touches is selected')}
        </span>
      </div>
      <div class="lrow">
        <span class="k-label">top / bottom</span>
        <span>
          {graphText('模块位于其所有依赖的上一层，因此入口点在顶部，不依赖更下层模块的基础部分在底部', 'A module sits one layer above everything it depends on, so entry points end up at the top and the foundations — which depend on nothing below — at the bottom')}
        </span>
      </div>
      <div class="lrow">
        <span class="k-box k-sel mono">src/api</span>
        <span>{graphText('选中：点击模块以突出显示其连接并列出文件；距离超过一跳的内容会淡化', 'Selected: click a module to bring out its links and list its files; everything more than one hop away fades')}</span>
      </div>
      <div class="lrow">
        <span class="k-label">nothing depends on this</span>
        <span>{graphText('索引中没有连接到达这里——可能是脚本、工作流或未被引用的部分', 'No link in the index arrives here — a script, a workflow, an unreferenced corner')}</span>
      </div>
      <div class="lrow">
        <span class="k-box k-test mono">__tests__</span>
        <span>{graphText('超过一半的文件是测试；只有开启测试显示后才可见', 'More than half its files are tests; off unless you turn tests on')}</span>
      </div>
      <div class="lrow">
        <span class="k-box k-gen mono">gen</span>
        <span>{graphText('其中每个文件均由工具生成，并非人工编写或编辑', 'Every file in it is tool-generated — nobody wrote it and nobody edits it')}</span>
      </div>
      {#if thinCount > 0}
        <div class="lrow">
          <span class="k-label">{thinCount} hidden</span>
          <span>
            Links carrying fewer than {minWeight} references wait until you select a module they
            touch, so a weak coincidence never draws as a dependency
          </span>
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
  .legend {
    position: absolute;
    left: 12px;
    bottom: 12px;
    z-index: 4;
    max-width: 400px;
    border: 1px solid var(--rule);
    background: var(--paper);
    font-size: 11.5px;
    color: var(--ink-2);
  }
  .legend-h {
    display: block;
    width: 100%;
    border: 0;
    background: transparent;
    padding: 5px 10px;
    text-align: left;
    color: var(--ink);
    font: 600 12px var(--sans);
    cursor: pointer;
  }
  .legend-body {
    padding: 2px 10px 8px;
    border-top: 1px solid var(--rule-soft);
  }
  .lrow {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 3px 0;
  }
  .lrow > :first-child {
    flex: 0 0 52px;
    display: inline-flex;
    justify-content: center;
  }
  .k-line {
    stroke: var(--ink);
    stroke-opacity: 0.6;
    stroke-width: 1.5;
    fill: none;
  }
  .k-line.k-back {
    stroke: var(--accent);
    stroke-opacity: 0.8;
    stroke-dasharray: 4 3;
  }
  .k-label {
    font-size: 10px;
    color: var(--ink-3);
    text-align: center;
    line-height: 1.2;
  }
  .k-box {
    box-sizing: border-box;
    padding: 1px 5px;
    border: 1px solid var(--ink);
    font-size: 10.5px;
    color: var(--ink);
    line-height: 14px;
  }
  /* The bar, drawn the way the canvas draws it: inside the bottom edge. */
  .k-box.k-weight {
    position: relative;
  }
  .k-box.k-weight::after {
    content: '';
    position: absolute;
    left: 0;
    bottom: 0;
    width: 68%;
    height: 4px;
    background: var(--ink);
    opacity: 0.3;
  }
  /* The same three treatments the canvas uses, at key size. */
  .k-box.k-sel {
    border-width: 2px;
    background: var(--press);
  }
  .k-box.k-test {
    border-style: dashed;
    border-color: var(--ink-3);
    color: var(--ink-3);
  }
  .k-box.k-gen {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .dim {
    color: var(--ink-3);
  }
</style>
