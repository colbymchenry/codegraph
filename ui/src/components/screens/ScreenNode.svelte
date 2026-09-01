<script lang="ts">
  /**
   * One screen on the Screens view: its path, and the component that renders
   * it. An origin — a function that navigates but belongs to no screen (a
   * store action after login) — draws dashed, so it reads as a trigger rather
   * than a place. The entry screen (`/`) carries a mark.
   *
   * Hidden handles along the top and bottom, one per port, exactly as the
   * Map's module box does — except that here a side may hold both kinds. The
   * layout routed every transition (`directional` ports): a return trip
   * leaves the TOP of this box and arrives at the BOTTOM of the screen it
   * returns to, so the line runs around the boxes instead of through them.
   * This only draws the ports the layout decided.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import type { MapNodeLayout } from '../../lib/map-model';
  import type { ScreenNodeInfo } from '../../lib/screens-model';

  let { data }: NodeProps = $props();

  const node = $derived(
    data as unknown as {
      layout: MapNodeLayout;
      info: ScreenNodeInfo;
      selected: boolean;
      dimmed: boolean;
      onSelect: (id: string) => void;
      /** Open what happens from this screen (the Steps picture) — a double-click. */
      onOpen?: (id: string) => void;
    }
  );
  const layout = $derived(node.layout);
  const info = $derived(node.info);

  function portStyle(index: number, total: number): string {
    return `left:${((index + 1) / (total + 1)) * 100}%`;
  }
</script>

{#each layout.ports.top as port, i (`${port.type}:${port.id}`)}
  <Handle
    type={port.type}
    id={`${port.type === 'source' ? 's' : 't'}:${port.id}`}
    position={Position.Top}
    style={portStyle(i, layout.ports.top.length)}
    isConnectable={false}
  />
{/each}

<button
  class="snode"
  class:sel={node.selected}
  class:dimmed={node.dimmed}
  class:origin={info.origin}
  class:entry={info.entry}
  class:unreached={info.unreached}
  style={`width:${layout.width}px;height:${layout.height}px`}
  onclick={() => node.onSelect(info.id)}
  ondblclickcapture={(e) => {
    // The flow canvas zooms on a double-click that reaches its pane; a
    // double-click on a box is a navigation, not a zoom — stop it here,
    // at the target, before it bubbles. The pane's own double-click keeps zooming.
    e.stopPropagation();
    node.onOpen?.(info.id);
  }}
  aria-pressed={node.selected}
  title={(info.origin
    ? `${info.label} — navigates, but no screen reaches it within the walk. In ${info.sub}.`
    : `${info.label} — rendered by ${info.sub}${info.entry ? '. The entry screen.' : ''}${
        info.unreached ? '. No transition in the graph reaches it from the entry.' : ''
      }`) + (node.onOpen ? ' Double-click for what happens here.' : '')}
>
  <span class="name">{#if info.entry}<span class="mark" aria-hidden="true">●</span>{/if}{info.label}</span>
  <span class="sub">{info.sub}</span>
</button>

{#each layout.ports.bottom as port, i (`${port.type}:${port.id}`)}
  <Handle
    type={port.type}
    id={`${port.type === 'source' ? 's' : 't'}:${port.id}`}
    position={Position.Bottom}
    style={portStyle(i, layout.ports.bottom.length)}
    isConnectable={false}
  />
{/each}

<style>
  .snode {
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
  .snode:hover,
  .snode.sel {
    border-width: 2px;
    padding: 0 8px;
    background: var(--press);
  }
  .snode.dimmed {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .snode.dimmed .sub {
    color: var(--ink-4);
  }
  .snode.origin {
    border-style: dashed;
    border-color: var(--ink-3);
  }
  .snode.unreached {
    border-color: var(--ink-4);
    color: var(--ink-2);
  }
  .snode:focus-visible {
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
  .mark {
    color: var(--accent);
    margin-right: 5px;
    font-size: 9px;
    vertical-align: 1px;
  }
  .sub {
    font: 400 11px var(--sans);
    line-height: 13px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
</style>
