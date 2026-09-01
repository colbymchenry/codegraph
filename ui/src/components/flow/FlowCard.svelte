<!--
  One hop of a flow: the symbol, where it lives, and the seven lines around the
  call that carries the reader to the next card (design spec §3.5).

  The card is a Svelte Flow node, but nothing about it is Svelte Flow's: the
  handles are hidden ports at the vertical middle of each side, the position
  came from `buildFlowLayout`, and the height is the one that layout computed —
  pinned here so the arrows land where the arithmetic said they would.

  The source window is the Symbol view's code block with the noise removed. It
  keeps the two things that make the code readable: the server's classified
  classification, and one accent link on the identifier the graph resolved. It
  drops gutter ports and multi-window folding, because a seven-line card has
  neither a gutter worth reading nor anything to fold.
-->
<script lang="ts">
  import { Handle, Position } from '@xyflow/svelte';
  import KindGlyph from '../KindGlyph.svelte';
  import { tokenClass, tokensByLine, type Token } from '../../lib/highlight';
  import { assignRefs, basename, type LineRef } from '../../lib/symbol-model';
  import type { FlowCardLayout } from '../../lib/flow-model';

  interface Props {
    data: {
      card: FlowCardLayout;
      current: boolean;
      dimmed: boolean;
      onOpen: (card: FlowCardLayout) => void;
      onFollow: (card: FlowCardLayout) => void;
    };
  }

  let { data }: Props = $props();
  let card = $derived(data.card);
  let hop = $derived(card.hop);
  let source = $derived(hop.source);

  /** The call site as the code block's overlay wants it: one ref on one line. */
  let refs = $derived.by<Map<number, LineRef[]>>(() => {
    const byLine = new Map<number, LineRef[]>();
    const ref = hop.callRef;
    if (!ref) return byLine;
    byLine.set(ref.line, [
      {
        ident: ref.name,
        col: ref.col,
        targetId: ref.targetId,
        uncertain: false,
        outside: false,
        title: ref.backwards
          ? `${hop.node.name} calls ${ref.name} here`
          : `calls ${ref.name}`,
      },
    ]);
    return byLine;
  });

  let tokens = $derived.by<Map<number, Token[]>>(() =>
    source?.lines ? tokensByLine(source.lines, source.from, source.highlight) : new Map()
  );

  interface Part {
    text: string;
    cls: string | null;
    ref: LineRef | null;
  }

  let rows = $derived.by(() => {
    if (!source?.lines) return [];
    return source.lines.map((text, offset) => {
      const n = source.from + offset;
      const lineTokens = tokens.get(n) ?? [{ cls: 'other' as const, text, col: 0 }];
      const claimed = assignRefs(lineTokens, refs.get(n) ?? []);
      return {
        n,
        call: n === hop.callRef?.line || n === card.stopLine,
        parts: lineTokens.map((token, index): Part => {
          const ref = claimed.get(index) ?? null;
          return { text: token.text, cls: ref ? null : tokenClass(token.cls), ref };
        }),
      };
    });
  });
</script>

<div
  class="card"
  class:cur={data.current}
  class:dim={data.dimmed}
  style={`width:${card.width}px;height:${card.height}px`}
>
  <Handle type="target" position={Position.Left} id="in" isConnectable={false} />
  <Handle type="source" position={Position.Right} id="out" isConnectable={false} />

  <button type="button" class="head" onclick={() => data.onOpen(card)}>
    <KindGlyph kind={hop.node.kind} />
    <span class="nm">{hop.node.name}</span>
    <span class="loc">{basename(hop.node.file)}:{hop.node.line}</span>
  </button>

  {#if rows.length > 0}
    <div class="code">
      {#each rows as row (row.n)}
        <div class="ln" class:call={row.call}>
          <span class="no">{row.n}</span>
          <span class="tx"
            >{#each row.parts as part, i (i)}{#if part.ref}<button
                  type="button"
                  class="ref"
                  title={part.ref.title}
                  onclick={() => data.onFollow(card)}>{part.text}</button
                >{:else if part.cls}<span class={part.cls}>{part.text}</span
                >{:else}{part.text}{/if}{/each}</span
          >
        </div>
      {/each}
    </div>
  {:else}
    <p class="nosource">
      {source?.drift
        ? 'Changed on disk after the last index sync — source is not shown.'
        : (source?.reason ?? 'Source outside this slice or this index.')}
    </p>
  {/if}
</div>

<style>
  .card {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--paper);
    border: 1px solid var(--rule-soft);
    text-align: left;
  }

  .card:hover {
    border-color: var(--ink);
  }

  .card.cur {
    border-color: var(--accent);
  }

  .card.dim {
    opacity: 0.4;
  }

  .head {
    display: grid;
    align-items: baseline;
    padding: 10px 12px 6px;
    border-bottom: 1px solid var(--rule-faint);
    background: none;
    color: var(--ink);
    gap: 8px;
    grid-template-columns: 16px 1fr auto;
    text-align: left;
  }

  .head:hover .nm {
    color: var(--accent);
  }

  .nm {
    overflow: hidden;
    font: 600 13px var(--mono);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loc {
    color: var(--ink-3);
    font: 11px var(--mono);
    white-space: nowrap;
  }

  .code {
    padding: 6px 0;
    font: 12px / 19px var(--mono);
  }

  .ln {
    display: grid;
    align-items: stretch;
    grid-template-columns: 40px 1fr 6px;
  }

  .ln.call {
    background: var(--accent-soft);
  }

  .no {
    padding-right: 10px;
    color: var(--ink-4);
    font-size: 11px;
    text-align: right;
    user-select: none;
  }

  .tx {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: pre;
  }

  .nosource {
    margin: 0;
    padding: 6px 12px;
    color: var(--ink-3);
    font-size: 12px;
    line-height: 19px;
  }

  /* Token classes — the same near-monochrome ramp the Symbol view paints
     (design spec §2.2); the class names come from the server's classifier. */
  .t-c {
    color: var(--code-comment);
  }
  .t-s {
    color: var(--ink-2);
  }
  .t-k {
    font-weight: 500;
  }
  .t-n {
    color: var(--ink-2);
  }

  /* A definition's own name, from the extractor's tables. */
  .t-def {
    font-weight: 600;
  }

  /* The only colour in the window: the call this card is opened at. */
  .ref {
    padding: 0;
    background: none;
    color: var(--accent);
    border: 0;
    cursor: pointer;
    font: inherit;
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }

  .ref:hover {
    text-decoration-color: var(--accent);
  }
</style>
