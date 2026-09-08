<script lang="ts">
  /**
   * A decision on the order reading's canvas — the point where a fork's arms
   * diverge. The condition is said ONCE, here, and each line out answers it
   * (`yes`, `no`, a case's value): two lines that each carried the whole
   * predicate, one of them negated, never said they were the same choice.
   * It is not a step — it takes no click and the panel has nothing to list —
   * so it draws quieter than a box: one centred line, asking.
   */
  import { Handle, Position, type NodeProps } from '@xyflow/svelte';
  import type { MapNodeLayout } from '../../lib/map-model';
  import type { StepForkInfo } from '../../lib/steps-model';
  import { joinTokens, whenTokens } from '../../lib/conditions';
  import { EDGE_LABEL_MAX } from '../../lib/screens-model';

  let { data }: NodeProps = $props();
  const node = $derived(data as unknown as { layout: MapNodeLayout; fork: StepForkInfo; dimmed: boolean });
  const layout = $derived(node.layout);
  const tokens = $derived(whenTokens(node.fork.on));
  // A condition past the box's cap is drawn as the capped plain label the box
  // was sized for, or the ellipsis eats the question mark.
  const plain = $derived(tokens.length === 0 || joinTokens(tokens).length > EDGE_LABEL_MAX);

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

<div
  class="fpoint"
  class:dimmed={node.dimmed}
  style={`width:${layout.width}px;height:${layout.height}px`}
  title={node.fork.on
    ? `${node.fork.on} — the code forks here; each line out is one arm.`
    : 'The code forks here; each line out is one arm.'}
>
  <span class="q"
    >{#if plain}{node.fork.label}{:else}{#each tokens as t, i (i)}{#if i > 0}{' '}{/if}{#if t.kw}<b class="kw"
            >{t.text}</b
          >{:else}{t.text}{/if}{/each}?{/if}</span
  >
</div>

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
  .fpoint {
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    padding: 0 9px;
    border: 1px solid var(--ink-2);
    background: var(--paper);
    color: var(--ink);
    user-select: none;
  }
  .fpoint.dimmed {
    border-color: var(--ink-4);
    color: var(--ink-4);
  }
  .q {
    font: 400 12px var(--mono);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .kw {
    font-weight: 600;
  }
</style>
