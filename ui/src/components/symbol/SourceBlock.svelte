<!--
  The verbatim body, with a gutter port on every line that has an outgoing
  edge and an accent link on every call site (design spec §3.2).

  Two things make this more than a <pre>:

  * Syntax classification arrives already done, from `/api/source` — taken off
    the engine's own tree-sitter parse, server-side, indexed by file line. The
    whole slice is classified in one pass there, so a window that starts 200
    lines into a body still knows it is inside a block comment; nothing is
    re-lexed here.
  * Each ref is matched to an actual token rather than to a column, because the
    recorded column points at the start of the calling expression — see
    `assignRefs`. The overlay CLAIMS a token the highlighter produced; it never
    re-cuts one, which is what keeps the accent underline landing on the
    callee's own name whatever boundaries a grammar chose.
-->
<script lang="ts">
  import { tokenClass, type Token } from '../../lib/highlight';
  import { assignRefs, type CodeBlock, type LineRef } from '../../lib/symbol-model';
  import { hot } from '../../lib/focus.svelte';

  interface Props {
    block: CodeBlock;
    /** Classified source by 1-based file line — see `tokensByLine`. */
    tokens: Map<number, Token[]>;
    refs: Map<number, LineRef[]>;
    /** The line the definition's own name sits on — it is set in bold there. */
    defLine: number;
    defName: string;
    /** Line from `?hl=` — tinted and scrolled to. */
    highlight: number | null;
    onfollow: (ref: LineRef) => void;
  }

  let { block, tokens, refs, defLine, defName, highlight, onfollow }: Props = $props();

  interface Part {
    text: string;
    cls: string | null;
    ref: LineRef | null;
    def: boolean;
  }

  interface RenderedLine {
    n: number;
    parts: Part[];
    /** 'sure' = at least one resolved edge here; 'unsure' = only guesses. */
    port: 'sure' | 'unsure' | null;
    /** Targets named on this line, so a hovered rail row can light it. */
    targets: string[];
  }

  interface Chunk {
    /** Lines skipped before this window; 0 for the first. */
    gapBefore: number;
    lines: RenderedLine[];
  }

  let chunks = $derived.by<Chunk[]>(() =>
    block.windows.map((window, windowIndex) => ({
      gapBefore: windowIndex === 0 ? 0 : (block.gapsAfter[windowIndex - 1] ?? 0),
      lines: window.lines.map((text, offset) => {
        const n = window.start + offset;
        const lineTokens = tokens.get(n) ?? [{ cls: 'other' as const, text, col: 0 }];
        const lineRefs = refs.get(n) ?? [];
        const claimed = assignRefs(lineTokens, lineRefs);
        return {
          n,
          parts: toParts(lineTokens, claimed, n === defLine ? defName : null),
          port: portFor(lineRefs),
          targets: [...new Set(lineRefs.map((r) => r.targetId).filter((id): id is string => !!id))],
        };
      }),
    }))
  );

  function toParts(line: Token[], claimed: Map<number, LineRef>, definition: string | null): Part[] {
    return line.map((token, index) => {
      const ref = claimed.get(index) ?? null;
      return {
        text: token.text,
        cls: ref ? null : tokenClass(token.cls),
        ref,
        def:
          !ref &&
          definition !== null &&
          token.text === definition &&
          token.cls !== 'comment' &&
          token.cls !== 'string',
      };
    });
  }

  /**
   * A filled port means the graph resolved something on this line; a hollow one
   * means it only guessed. A line with no outgoing edge has no port at all —
   * absence is the signal, so an empty gutter must stay empty.
   */
  function portFor(lineRefs: readonly LineRef[]): 'sure' | 'unsure' | null {
    if (lineRefs.length === 0) return null;
    return lineRefs.some((r) => !r.uncertain && !r.outside) ? 'sure' : 'unsure';
  }

  function isHot(line: RenderedLine): boolean {
    return line.n === highlight || line.targets.some((id) => hot.is(id));
  }
</script>

<div class="code">
  {#each chunks as chunk (chunk.lines[0]?.n ?? -1)}
    {#if chunk.gapBefore > 0}
      <div class="gap">⋯ {chunk.gapBefore} lines without calls</div>
    {/if}
    {#each chunk.lines as line (line.n)}
      <div class="ln" class:hot={isHot(line)} data-line={line.n}>
        <span class="no">{line.n}</span>
        <span class="tx"
          >{#each line.parts as part, i (i)}{#if part.ref && !part.ref.outside}{@const ref = part.ref}<span
                class="ref"
                class:uncertain={ref.uncertain}
                class:hot={hot.is(ref.targetId)}
                role="link"
                tabindex="0"
                title={ref.title}
                onclick={() => onfollow(ref)}
                onkeydown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onfollow(ref);
                  }
                }}
                onmouseenter={() => hot.set(ref.targetId)}
                onmouseleave={() => hot.clear(ref.targetId)}>{part.text}</span
              >{:else if part.ref}<span class="ref stub" title={part.ref.title}>{part.text}</span
              >{:else if part.def}<span class="t-def">{part.text}</span
              >{:else if part.cls}<span class={part.cls}>{part.text}</span
              >{:else}{part.text}{/if}{/each}</span
        >
        <span class="port">
          {#if line.port}<i class:sure={line.port === 'sure'}></i>{/if}
        </span>
      </div>
    {/each}
  {/each}

  {#if block.tailGap > 0}
    <div class="gap">⋯ {block.tailGap} more lines</div>
  {/if}
</div>

<style>
  .code {
    margin-top: 16px;
    padding-top: 6px;
    border-top: 1px solid var(--rule);
    font: var(--code-size) / var(--code-lh) var(--mono);
  }

  /* 44px gutter | source | 18px port cell. The port lives in its own column
     so a long line scrolling sideways never slides under it. */
  .ln {
    position: relative;
    display: grid;
    grid-template-columns: 44px 1fr 18px;
    align-items: stretch;
  }

  .ln:hover {
    background: var(--paper-2);
  }

  .ln.hot {
    background: var(--accent-soft);
  }

  .no {
    padding-right: 12px;
    color: var(--ink-4);
    font-size: 11px;
    text-align: right;
    user-select: none;
  }

  .tx {
    white-space: pre;
    overflow-x: auto;
    scrollbar-width: none;
  }

  .tx::-webkit-scrollbar {
    display: none;
  }

  .port {
    position: relative;
  }

  .port i {
    position: absolute;
    top: 7px;
    right: 4px;
    width: 6px;
    height: 6px;
    border: 1px solid var(--ink-3);
    background: var(--paper);
  }

  .port i.sure {
    background: var(--ink-3);
  }

  .ln.hot .port i {
    border-color: var(--accent);
    background: var(--accent);
  }

  .gap {
    margin: 2px 0;
    padding: 2px 0 2px 44px;
    border-top: 1px dashed var(--rule-soft);
    border-bottom: 1px dashed var(--rule-soft);
    color: var(--ink-4);
    font-size: 11px;
  }

  /* ---- token classes (near-monochrome by design, spec §2.2) ----
     Comments use --code-comment rather than --ink-3: the spec's colour reads
     at 3.46:1 on paper, under AA for 12.5px text. See app.css. */
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

  .t-def {
    font-weight: 600;
  }

  /* The only colour in the body: a call site the graph resolved. */
  .ref {
    color: var(--accent);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--accent-line);
    text-underline-offset: 3px;
  }

  .ref:hover,
  .ref.hot {
    background: var(--accent-soft);
    text-decoration-color: var(--accent);
  }

  .ref.uncertain {
    color: var(--ink-2);
    text-decoration-style: dotted;
    text-decoration-color: var(--ink-4);
  }

  /* Outside the index: there is nothing to open, so it does not offer to. */
  .ref.stub {
    color: var(--ink-2);
    cursor: default;
    text-decoration-color: var(--rule-soft);
  }

  .ref.stub:hover {
    background: none;
    text-decoration-color: var(--rule-soft);
  }
</style>
