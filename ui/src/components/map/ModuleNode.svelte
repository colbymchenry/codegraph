<script lang="ts">
  /**
   * One module box on the Map (design spec §3.6): a 40px rectangle carrying
   * the module's path and what is inside it.
   *
   * The handles are the point of the component. Svelte Flow routes an edge
   * between two handles, so giving each box one hidden handle per link — laid
   * out along its top and bottom edges at `(i+1)/(n+1)` — is what makes a
   * bundle of eight dependencies fan across the box instead of converging on a
   * single corner. They are invisible and non-connectable: this canvas is a
   * drawing, never an editor.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import { moduleMetaLabel, type MapNodeLayout } from '../../lib/map-model';

  let { data }: NodeProps = $props();

  const node = $derived(
    data as unknown as {
      layout: MapNodeLayout;
      selected: boolean;
      dimmed: boolean;
      onSelect: (id: string) => void;
    }
  );
  const layout = $derived(node.layout);
  const module = $derived(layout.module);

  function portStyle(index: number, total: number): string {
    return `left:${((index + 1) / (total + 1)) * 100}%`;
  }
</script>

{#each layout.targetHandles as handle, i (handle)}
  <Handle
    type="target"
    id={`t:${handle}`}
    position={Position.Top}
    style={portStyle(i, layout.targetHandles.length)}
    isConnectable={false}
  />
{/each}

<button
  class="mnode"
  class:sel={node.selected}
  class:dimmed={node.dimmed}
  class:test={module.test}
  class:gen={layout.generated}
  style={`width:${layout.width}px;height:${layout.height}px`}
  onclick={() => node.onSelect(layout.id)}
  aria-pressed={node.selected}
  title={`${module.id} — ${module.symbols} symbols in ${module.files} file${
    module.files === 1 ? '' : 's'
  }${layout.island ? '. Nothing in the index depends on it.' : ''}${
    layout.generated ? '. Every file in it is tool-generated.' : ''
  }`}
>
  <span class="name">{module.id}</span>
  <!-- The same string nodeWidth() sized the box for; they must not drift. -->
  <span class="count" class:island={layout.island}
    >{moduleMetaLabel(module, layout.island)}</span
  >
</button>

{#each layout.sourceHandles as handle, i (handle)}
  <Handle
    type="source"
    id={`s:${handle}`}
    position={Position.Bottom}
    style={portStyle(i, layout.sourceHandles.length)}
    isConnectable={false}
  />
{/each}

<style>
  .mnode {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 1px;
    box-sizing: border-box;
    padding: 0 9px;
    border: 1px solid var(--ink);
    border-radius: 0;
    background: var(--paper);
    text-align: left;
    cursor: pointer;
    font: inherit;
    color: var(--ink);
    transition: background 90ms linear;
  }
  .mnode:hover,
  .mnode.sel {
    border-width: 2px;
    padding: 0 8px;
    background: var(--press);
  }
  .mnode.dimmed {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .mnode.dimmed .count {
    color: var(--ink-4);
  }
  /* Nothing depends on it — the stroke stays normal (it is not a lesser module,
     it is an unreached one); only the count line changes what it says. */
  .count.island {
    color: var(--ink-2);
  }
  /* Generated code: nobody wrote it by hand and nobody deletes it by hand. */
  .mnode.gen {
    color: var(--ink-4);
    border-color: var(--rule-soft);
  }
  .mnode.gen .count {
    color: var(--ink-4);
  }
  /* Test modules read as scaffolding, not as part of the program. */
  .mnode.test {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .mnode:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 1px;
  }
  .name {
    font: 500 13px var(--mono);
    line-height: 15px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .count {
    font: 400 11px var(--sans);
    line-height: 13px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
