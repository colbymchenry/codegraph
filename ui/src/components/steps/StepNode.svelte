<script lang="ts">
  /**
   * One step on the Steps view's canvas: the shared box ({@link StepBox}) with
   * hidden handles along its top and bottom, one per port the layout decided
   * (`directional` ports), exactly as the screen box has.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import StepBox from './StepBox.svelte';
  import type { MapNodeLayout } from '../../lib/map-model';
  import type { ProjectKind, StepNodeInfo } from '../../lib/steps-model';

  let { data }: NodeProps = $props();

  const node = $derived(
    data as unknown as {
      layout: MapNodeLayout;
      info: StepNodeInfo;
      project: ProjectKind;
      selected: boolean;
      dimmed: boolean;
      onSelect: (id: string) => void;
      /** Re-anchor the picture on this step — a double-click; absent for a step with no symbol. */
      onStart?: (id: string) => void;
    }
  );
  const layout = $derived(node.layout);

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

<StepBox
  info={node.info}
  project={node.project}
  selected={node.selected}
  dimmed={node.dimmed}
  size={layout}
  onSelect={node.onSelect}
  onStart={node.onStart}
/>

{#each layout.ports.bottom as port, i (`${port.type}:${port.id}`)}
  <Handle
    type={port.type}
    id={`${port.type === 'source' ? 's' : 't'}:${port.id}`}
    position={Position.Bottom}
    style={portStyle(i, layout.ports.bottom.length)}
    isConnectable={false}
  />
{/each}
