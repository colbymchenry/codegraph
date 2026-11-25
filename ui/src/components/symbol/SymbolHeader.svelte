<!--
  The focus card: what this symbol is, where it lives, and the three claims
  worth making before the body (design spec §3.2).

  The badges are the honesty layer. "exported" and "hub · N callers" are facts
  about reach; the test badge is the one that changes behaviour — an amber
  "No test reaches this within 3 caller hops" is the difference between editing
  freely and editing carefully, so it is stated in the header rather than left
  to be inferred from an empty rail.
-->
<script lang="ts">
  import KindGlyph from '../KindGlyph.svelte';
  import { fileHref } from '../../lib/navigation';
  import { kindPhrase, plural } from '../../lib/symbol-model';
  import type {
    WireNodeDetail,
    WireNodeRef,
    WireRelation,
    WireSymbolPayload,
  } from '../../lib/api';

  interface Props {
    payload: WireSymbolPayload;
    onopen: (node: WireNodeRef) => void;
    /**
     * Draw the `extends X` / `implemented by …` chips.
     *
     * Off when the type-hierarchy tree is on screen: the tree answers the same
     * question with more of the truth in it (depth, synthesized edges, the
     * subtypes that are not direct), and two renderings of one relation in one
     * column is how a reader ends up trusting neither.
     */
    relationChips?: boolean;
  }

  let { payload, onopen, relationChips = true }: Props = $props();

  let node = $derived<WireNodeDetail>(payload.node);
  let tests = $derived(payload.tests);

  /** `extends`/`implements` this symbol declares, and the ones declared on it. */
  let supertypes = $derived(
    relationChips
      ? payload.outgoing.items.filter((r) =>
          r.edgeKinds.some((k) => k === 'extends' || k === 'implements')
        )
      : []
  );
  let subtypes = $derived(
    relationChips
      ? payload.incoming.items.filter((r) =>
          r.edgeKinds.some((k) => k === 'extends' || k === 'implements')
        )
      : []
  );

  const TYPE_CHIP_LIMIT = 12;
  let typeChips = $derived(payload.typesUsed.slice(0, TYPE_CHIP_LIMIT));

  function relationWord(relation: WireRelation): string {
    return relation.edgeKinds.includes('implements') ? 'implements' : 'extends';
  }

  /**
   * The test claim, worded to exactly what was checked. An interrupted search
   * (`exhaustive: false`) only ever established that no test calls the symbol
   * directly, so the badge must not widen that to three hops.
   */
  let testBadge = $derived.by(() => {
    if (tests.reached) {
      return {
        warn: false,
        text: `Reached by tests · ${plural(tests.fileCount, 'file')} within ${tests.hopsSearched} hop${tests.hopsSearched === 1 ? '' : 's'}`,
        title: tests.files.join(', '),
      };
    }
    return {
      warn: true,
      text: tests.exhaustive
        ? `No test reaches this within ${tests.hopsSearched} caller hops`
        : 'No test calls this directly',
      title: tests.exhaustive
        ? 'No test file reaches this symbol within the caller hops searched.'
        : 'The caller search ran out of budget — only direct callers were checked.',
    };
  });
</script>

<div class="card-h">
  <KindGlyph kind={node.kind} titled />
  <h1>{node.name}</h1>
  <span class="kindword">{kindPhrase(node)}</span>
  <span class="loc mono">
    <a href={fileHref(node.file, { line: node.line })}>{node.file}</a>:{node.line}–{node.endLine}
    · {plural(node.lines, 'line')}
  </span>
</div>

{#if payload.ancestors.length > 0}
  <div class="parents mono">
    in {#each payload.ancestors as ancestor, i (ancestor.id)}{#if i > 0}<span class="sep"> › </span
        >{/if}<button type="button" onclick={() => onopen(ancestor)}>{ancestor.name}</button
      >{/each}
  </div>
{/if}

<div class="badges">
  {#if node.exported}<span class="badge">exported</span>{/if}
  {#if payload.counts.hub}
    <span class="badge hub" title="Changing this reaches a lot of the repo">
      hub · {plural(payload.counts.callers, 'caller')}
    </span>
  {/if}
  <span class="badge" class:warn={testBadge.warn} title={testBadge.title}>
    <span class="sw"></span>{testBadge.text}
  </span>
</div>

{#if node.signature}
  <div class="sig">{node.name}{node.signature}</div>
{/if}

{#if node.docstring}
  <div class="doc">{node.docstring}</div>
{/if}

{#if supertypes.length > 0 || subtypes.length > 0 || typeChips.length > 0}
  <div class="rel">
    {#if supertypes.length > 0}
      <span>
        {#each supertypes as relation (relation.node.id)}
          {relationWord(relation)}
          <button type="button" class="chip" onclick={() => onopen(relation.node)}>
            {relation.node.name}
          </button>
        {/each}
      </span>
    {/if}
    {#if subtypes.length > 0}
      <span>
        {subtypes[0]?.edgeKinds.includes('implements') ? 'implemented by' : 'extended by'}
        {#each subtypes as relation (relation.node.id)}
          <button type="button" class="chip" onclick={() => onopen(relation.node)}>
            {relation.node.name}
          </button>
        {/each}
      </span>
    {/if}
    {#if typeChips.length > 0}
      <span>
        uses types
        {#each typeChips as relation (relation.node.id)}
          <button type="button" class="chip" onclick={() => onopen(relation.node)}>
            {relation.node.name}
          </button>
        {/each}
        {#if payload.typesUsed.length > TYPE_CHIP_LIMIT}
          <span class="dim">+{payload.typesUsed.length - TYPE_CHIP_LIMIT}</span>
        {/if}
      </span>
    {/if}
  </div>
{/if}

<style>
  .card-h {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 12px;
  }

  .card-h h1 {
    margin: 0;
    font: 600 20px/1.2 var(--mono);
    letter-spacing: -0.01em;
  }

  .kindword {
    color: var(--ink-3);
    font-size: 12.5px;
  }

  .loc {
    color: var(--ink-2);
    font-size: 11.5px;
  }

  .loc a:hover {
    text-decoration: underline;
  }

  .parents {
    margin-top: 6px;
    color: var(--ink-3);
    font-size: 11.5px;
  }

  .parents button {
    color: inherit;
    font: inherit;
  }

  .parents button:hover {
    color: var(--ink);
    text-decoration: underline;
  }

  .parents .sep {
    color: var(--ink-4);
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 2px 7px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink-2);
    font-size: 11.5px;
  }

  /* Amber is used here and nowhere else in the app. */
  .badge.warn {
    border-color: var(--amber);
    background: var(--amber-soft);
    color: var(--amber);
  }

  .badge.hub {
    border-color: var(--ink);
  }

  .sw {
    display: inline-block;
    width: 8px;
    height: 8px;
    border: 1px solid currentColor;
  }

  .badge.warn .sw {
    background: currentColor;
  }

  .sig {
    margin-top: 10px;
    color: var(--ink-2);
    font: 12px var(--mono);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .doc {
    margin-top: 8px;
    max-width: 70ch;
    color: var(--ink-2);
    font-size: 12.5px;
    white-space: pre-wrap;
  }

  .rel {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
    margin-top: 10px;
    color: var(--ink-3);
    font-size: 12px;
  }

  .rel > span {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px;
  }

  .chip {
    padding: 1px 6px;
    border: 1px solid var(--rule-soft);
    background: var(--paper);
    color: var(--ink-2);
    font: 11.5px var(--mono);
  }

  .chip:hover {
    border-color: var(--ink);
    color: var(--ink);
  }
</style>
