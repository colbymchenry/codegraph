<!--
  Where the graph stops (design spec §3.5).

  The last thing on a strip that did not reach what it was asked about. It is
  not an error state and not an apology: a flow running through a computed
  member call, a string-keyed bus or a reflective invoke genuinely has no static
  edge to follow, and the useful answer is the dispatch site itself — the form,
  the key when the source makes it visible, the line, and the symbols that could
  plausibly be on the other side.

  Every claim on it comes from the server, which builds it with the same
  detector `codegraph_explore` announces boundaries with. Nothing here guesses:
  a candidate row is a shortlist, and it says so by being under a heading that
  counts it rather than under an arrow that asserts it.

  The last block is the one that matters most. A name-only match under 0.6
  confidence is a continuation the search deliberately refused to follow, and
  leaving it invisible would read as "there is nothing here" — which is the one
  thing it does not mean.
-->
<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import { endCapText, type FlowEndCapLayout } from '../../lib/flow-model';
  import { basename } from '../../lib/symbol-model';

  interface Props {
    data: {
      cap: FlowEndCapLayout;
      dimmed: boolean;
      onOpen: (nodeId: string) => void;
    };
  }

  let { data }: Props = $props();
  let cap = $derived(data.cap);
  let text = $derived(endCapText(cap.boundary));
</script>

<div
  class="endcap"
  class:dim={data.dimmed}
  style={`width:${cap.width}px;min-height:${cap.height}px`}
>
  <Handle type="target" position={Position.Left} id="in" isConnectable={false} />

  <p class="lead"><b>Where the graph stops.</b> {text.intro}</p>

  {#each text.sites as site, i (i)}
    <div class="site">
      <p class="form">{site.headline}</p>
      {#if site.key !== null}
        <p class="key">key <span class="mono">{site.key}</span></p>
      {/if}
      {#each site.notes as note (note)}
        <p class="soft">{note}</p>
      {/each}
      {#if site.candidateHeading !== null}
        <p class="soft">{site.candidateHeading}</p>
        {#each site.candidates as candidate (candidate.node.id)}
          <button type="button" class="row" onclick={() => data.onOpen(candidate.node.id)}>
            <span class="nm">{candidate.display}</span>
            <span class="at">{basename(candidate.node.file)}:{candidate.node.line}</span>
          </button>
        {/each}
      {:else if site.candidateNote !== null}
        <p class="soft">{site.candidateNote}</p>
      {/if}
    </div>
  {/each}

  {#if text.quiet !== null}
    <p class="soft block">{text.quiet}</p>
  {/if}

  {#if text.uncertainHeading !== null}
    <div class="block">
      <p class="soft">{text.uncertainHeading}</p>
      {#each text.uncertain as next (next.node.id)}
        <button type="button" class="row" onclick={() => data.onOpen(next.node.id)}>
          <span class="nm unsure">{next.node.name}</span>
          <span class="at">{next.confidence === null ? '' : next.confidence.toFixed(2)}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if text.further !== null}
    <p class="block">{text.further}</p>
  {/if}
  {#if text.missed !== null}
    <p class="block">{text.missed}</p>
  {/if}
</div>

<style>
  .endcap {
    box-sizing: border-box;
    padding: 12px;
    background: var(--paper);
    border: 1px dashed var(--rule-soft);
    color: var(--ink-2);
    font-size: 12px;
    line-height: 1.45;
    text-align: left;
  }

  .endcap.dim {
    opacity: 0.4;
  }

  .lead {
    margin: 0;
  }

  .lead b {
    color: var(--ink);
    font-weight: 600;
  }

  .site,
  .block {
    margin-top: 8px;
  }

  .endcap p {
    margin: 0;
  }

  .form {
    color: var(--ink);
  }

  .soft {
    color: var(--ink-3);
  }

  .key .mono,
  .mono {
    font-family: var(--mono);
  }

  .row {
    display: flex;
    width: 100%;
    align-items: baseline;
    padding: 0;
    background: none;
    border: 0;
    color: var(--ink-2);
    cursor: pointer;
    font: 11.5px / 18px var(--mono);
    gap: 8px;
    justify-content: space-between;
    text-align: left;
  }

  .row:hover .nm {
    color: var(--accent);
  }

  .nm {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* A refused match reads as refused: the dotted rule under it is the same one
     the code block draws under an uncertain call site. */
  .unsure {
    text-decoration: underline dotted var(--ink-4);
    text-underline-offset: 3px;
  }

  .at {
    color: var(--ink-4);
    font-size: 11px;
    white-space: nowrap;
  }
</style>
