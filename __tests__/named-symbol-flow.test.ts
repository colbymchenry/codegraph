import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import {
  findAllSymbols,
  flowTokens,
  matchesSymbol,
  normalizeToken,
  resolveNamedTokens,
  resolveNamedSymbolFlow,
} from '../src/graph/named-symbol-flow';

describe('named-symbol flow token normalization', () => {
  it('strips the Haskell file extension like every other source extension', () => {
    expect(flowTokens('Main.hs callback')).toEqual(['Main', 'callback']);
    expect(normalizeToken('Main.hs')).toBe('Main');
  });

  it('keeps Haskell primes in every qualified segment without accepting a leading quote', () => {
    expect(flowTokens("hover' Module'.convertWithOpts' 'invalid Module.'invalid"))
      .toEqual(["hover'", "Module'.convertWithOpts'"]);
    expect(normalizeToken("Module'.hover'.hs")).toBe("Module'.hover'");
  });

  it('canonicalizes parenthesized and bare Haskell operator tokens', () => {
    expect(flowTokens('(<+>) request finish')).toEqual(['(<+>)', 'request', 'finish']);
    expect(flowTokens('<+> request finish')).toEqual(['(<+>)', 'request', 'finish']);
    expect(flowTokens('(.) request finish')).toEqual(['(.)', 'request', 'finish']);
    expect(normalizeToken('<+>')).toBe('(<+>)');
  });

  it('keeps qualified Haskell operators and Unicode names as exact tokens', () => {
    expect(flowTokens('Ops.<+> request')).toEqual(['Ops::(<+>)', 'request']);
    expect(flowTokens('(Ops.<+>) request')).toEqual(['Ops::(<+>)', 'request']);
    expect(flowTokens('Data.Ops.. request')).toEqual(['Data.Ops::(.)', 'request']);
    expect(flowTokens('Éclair.Opérateurs.⊕ request')).toEqual([
      'Éclair.Opérateurs::(⊕)',
      'request',
    ]);
    expect(flowTokens('Éclair.sommé request')).toEqual(['Éclair.sommé', 'request']);
    expect(flowTokens('foo# Éclair.foo# request')).toEqual(['foo#', 'Éclair.foo#', 'request']);
    expect(flowTokens('函数 λ finish')).toEqual(['函数', 'λ', 'finish']);
    expect(flowTokens('Main.函数 finish')).toEqual(['Main.函数', 'finish']);
    expect(flowTokens('notOps.<+> request')).toEqual(['notOps', 'request']);
    expect(flowTokens('fooData.Ops.<+> request')).toEqual(['fooData.Ops', 'request']);
    expect(flowTokens('`Ops.<+>` request')).toEqual(['Ops::(<+>)', 'request']);
    expect(flowTokens('`⊕` request')).toEqual(['(⊕)', 'request']);
    expect(flowTokens('Ops::<::> request')).toEqual(['Ops::(<::>)', 'request']);
    expect(normalizeToken('(Ops.<+>)')).toBe('Ops::(<+>)');
    expect(normalizeToken('Data.Ops..')).toBe('Data.Ops::(.)');
    expect(normalizeToken('`Ops.<+>`')).toBe('Ops::(<+>)');
    expect(normalizeToken('`⊕`')).toBe('(⊕)');
  });

  it('preserves dollar signs throughout shared JavaScript-style identifiers', () => {
    expect(flowTokens('foo$bar render$ Module.foo$bar $foo$bar')).toEqual([
      'foo$bar',
      'render$',
      'Module.foo$bar',
      '$foo$bar',
    ]);
  });

  it.each(['-', '‐', '‑', '–', '—'])(
    'does not reinterpret fragments joined by dash %s as symbols',
    (dash) => {
      expect(flowTokens(`explain the higher${dash}order target mechanism`)).toEqual([
        'explain',
        'the',
        'target',
        'mechanism',
      ]);
    },
  );

  it('does not let a long directory path consume the token cap before named symbols', () => {
    expect(flowTokens(
      'in /Users/alice/work/company/platform/packages/payments/src/server/controllers/checkout/handlers ' +
      'explain PaymentController submitOrder PaymentService chargeCard',
    )).toEqual([
      'explain',
      'PaymentController',
      'submitOrder',
      'PaymentService',
      'chargeCard',
    ]);
  });
});

describe('named-symbol flow with Haskell prime identifiers', () => {
  let dir: string | undefined;
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    cg = undefined;
  });

  async function setup(): Promise<CodeGraph> {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-haskell-prime-flow-'));
    fs.writeFileSync(path.join(dir, 'Main.hs'), [
      'module Main where',
      '',
      '(<+>) :: Int -> Int',
      '(<+>) value = request value',
      '',
      "hover' :: Int -> Int",
      "hover' value = request value",
      '',
      'request :: Int -> Int',
      'request value = finish value',
      '',
      'finish :: Int -> Int',
      'finish value = value',
      '',
      '函数 value = finish value',
    ].join('\n'));
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.hs'], exclude: [] } });
    await cg.indexAll();
    return cg;
  }

  it('resolves a primed symbol as a precise flow endpoint', async () => {
    const graph = await setup();
    const hover = graph.getNodesByName("hover'")[0];
    expect(hover).toBeDefined();

    const flow = resolveNamedSymbolFlow(graph, "hover' request finish");
    expect(flow.tokens).toEqual(["hover'", 'request', 'finish']);
    expect(flow.tokenNodes.get("hover'")).toEqual([hover!.id]);
    expect(flow.preciseNamedIds.has(hover!.id)).toBe(true);
    expect(flow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(["hover'", 'request', 'finish']);
  });

  it('resolves an operator as a precise flow endpoint', async () => {
    const graph = await setup();
    const operator = graph.getNodesByName('(<+>)')[0];
    expect(operator).toBeDefined();

    const flow = resolveNamedSymbolFlow(graph, '(<+>) request finish');
    expect(flow.tokens).toEqual(['(<+>)', 'request', 'finish']);
    expect(flow.tokenNodes.get('(<+>)')).toEqual([operator!.id]);
    expect(flow.preciseNamedIds.has(operator!.id)).toBe(true);
    expect(flow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['(<+>)', 'request', 'finish']);
  });

  it('resolves an Other_Letter identifier as a precise flow endpoint', async () => {
    const graph = await setup();
    const symbol = graph.getNodesByName('函数')[0];
    expect(symbol).toBeDefined();

    const flow = resolveNamedSymbolFlow(graph, '函数 finish');
    expect(flow.tokenNodes.get('函数')).toEqual([symbol!.id]);
    expect(flow.preciseNamedIds.has(symbol!.id)).toBe(true);
    expect(flow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['函数', 'finish']);

    const qualifiedFlow = resolveNamedSymbolFlow(graph, 'Main.函数 finish');
    expect(qualifiedFlow.tokenNodes.get('Main.函数')).toEqual([symbol!.id]);
    expect(qualifiedFlow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['函数', 'finish']);
  });

  it('uses a qualified Haskell operator to disambiguate modules without a fuzzy fallback', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-haskell-qualified-op-flow-'));
    fs.writeFileSync(path.join(dir, 'odd-location.hs'), [
      'module Data.Ops ((<+>), (.)) where',
      '(<+>) value = request value',
      '(.) value = request value',
      'request value = finish value',
      'finish value = value',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'other-location.hs'), [
      'module Other ((<+>), (.)) where',
      '(<+>) value = other value',
      '(.) value = other value',
      'other value = value',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'unicode-location.hs'), [
      'module Éclair.Opérateurs ((⊕)) where',
      '(⊕) value = unicodeRequest value',
      'unicodeRequest value = value',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'local-only.hs'), [
      'module LocalOnly where',
      'outer left right = left <+> right',
      '  where',
      '    x <+> y = x + y',
    ].join('\n'));
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.hs'], exclude: [] } });
    await cg.indexAll();

    const dataPlus = cg.getNodesByName('(<+>)')
      .find((node) => node.qualifiedName === 'Data.Ops::(<+>)')!;
    const dataCompose = cg.getNodesByName('(.)')
      .find((node) => node.qualifiedName === 'Data.Ops::(.)')!;
    expect(dataPlus).toBeDefined();
    expect(dataCompose).toBeDefined();

    const plusFlow = resolveNamedSymbolFlow(cg, 'Data.Ops.<+> request finish');
    expect(plusFlow.tokenNodes.get('Data.Ops::(<+>)')).toEqual([dataPlus.id]);
    expect(plusFlow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['(<+>)', 'request', 'finish']);

    const composeFlow = resolveNamedSymbolFlow(cg, 'Data.Ops.. request finish');
    expect(composeFlow.tokenNodes.get('Data.Ops::(.)')).toEqual([dataCompose.id]);
    expect(composeFlow.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['(.)', 'request', 'finish']);

    const missing = resolveNamedSymbolFlow(cg, 'Missing.<+> request');
    expect(missing.tokenNodes.get('Missing::(<+>)')).toEqual([]);
    const missingBare = resolveNamedSymbolFlow(cg, '⊗ request');
    expect(missingBare.tokenNodes.get('(⊗)')).toEqual([]);
    const localOnly = resolveNamedSymbolFlow(cg, 'LocalOnly.<+> outer');
    expect(localOnly.tokenNodes.get('LocalOnly::(<+>)')).toEqual([]);

    const unicode = cg.getNodesByName('(⊕)')
      .find((node) => node.qualifiedName === 'Éclair.Opérateurs::(⊕)')!;
    expect(unicode).toBeDefined();
    const unicodeFlow = resolveNamedSymbolFlow(cg, 'Éclair.Opérateurs.⊕ unicodeRequest');
    expect(unicodeFlow.tokenNodes.get('Éclair.Opérateurs::(⊕)')).toEqual([unicode.id]);

    const directed = resolveNamedSymbolFlow(
      cg,
      '(Data.Ops.<+>) finish',
      { mode: 'directed', from: '(Data.Ops.<+>)', to: 'finish' },
    );
    expect(directed.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['(<+>)', 'request', 'finish']);

    const backtickDirected = resolveNamedSymbolFlow(
      cg,
      '`Data.Ops.<+>` finish',
      { mode: 'directed', from: '`Data.Ops.<+>`', to: 'finish' },
    );
    expect(backtickDirected.chains[0]?.steps.map((step) => step.node.name))
      .toEqual(['(<+>)', 'request', 'finish']);
  });

  it('keeps bare dollar-only JavaScript identifiers alongside Haskell operators', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-dollar-flow-'));
    fs.writeFileSync(path.join(dir, 'main.js'), [
      'function $$$() { return finish(); }',
      'function finish() { return finishLeaf(); }',
      'function finishLeaf() { return 1; }',
      'class Ops { $$$() { return finish(); } }',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'Ops.hs'), [
      'module Ops where',
      '($$) value = haskellFinish value',
      '($$$) value = haskellFinish value',
      'haskellFinish value = haskellLeaf value',
      'haskellLeaf value = value',
    ].join('\n'));
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();

    expect(flowTokens('$$$ finish')).toEqual(['$$$', 'finish']);
    expect(normalizeToken('$$$')).toBe('$$$');
    const jsFlow = resolveNamedSymbolFlow(cg, '$$$ finish');
    expect(jsFlow.chains[0]?.steps.map(({ node }) => node.name)).toEqual(['$$$', 'finish']);
    expect(findAllSymbols(cg, 'Ops.$$$').nodes.map((node) => node.qualifiedName))
      .toEqual(['Ops::($$$)', 'Ops::$$$']);
    expect(findAllSymbols(cg, '$$$$').nodes).toEqual([]);
    for (const token of ['$$', '($$)', 'Ops.$$', 'Ops::($$)']) {
      const flow = resolveNamedSymbolFlow(cg, `${token} haskellFinish`);
      expect(flow.chains[0]?.steps.map(({ node }) => node.name)).toEqual(['($$)', 'haskellFinish']);
    }
    for (const [query, entry, file] of [
      ['$$$ finish finishLeaf', '$$$', 'main.js'],
      ['$$ haskellFinish haskellLeaf', '($$)', 'Ops.hs'],
      ['$$$ haskellFinish haskellLeaf', '($$$)', 'Ops.hs'],
    ]) {
      const result = await new ToolHandler(cg).execute('codegraph_explore', { query });
      const text = result.content[0]?.text as string;
      expect(text).toContain('**Flow (call path among the symbols you queried)**');
      expect(text).toContain(`1. ${entry} (${file}:`);
    }
  });

  it('does not let Haskell operator canonicalization hide a qualified Scala operator', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cross-language-op-flow-'));
    fs.writeFileSync(path.join(dir, 'Ops.scala'), [
      'object Ops {',
      '  def <+>(left: Int, right: Int): Int = left + right',
      '  def <::>(left: Int, right: Int): Int = left + right',
      '}',
      'object Outer {',
      '  object Ops {',
      '    def <::>(left: Int, right: Int): Int = left + right',
      '  }',
      '}',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, 'HaskellOps.hs'), [
      'module Ops ((<+>)) where',
      '(<+>) left _ = left',
    ].join('\n'));
    cg = CodeGraph.initSync(dir, {
      config: { include: ['**/*.scala', '**/*.hs'], exclude: [] },
    });
    await cg.indexAll();

    const scalaOperator = cg.getNodesByName('<+>')
      .find((node) => node.language === 'scala' && node.qualifiedName === 'Ops::<+>')!;
    const haskellOperator = cg.getNodesByName('(<+>)')
      .find((node) => node.language === 'haskell' && node.qualifiedName === 'Ops::(<+>)')!;
    expect(scalaOperator).toBeDefined();
    expect(haskellOperator).toBeDefined();
    expect(matchesSymbol(scalaOperator, 'Ops.<+>')).toBe(true);
    expect(findAllSymbols(cg, 'Ops.<+>').nodes.map((node) => node.id).sort())
      .toEqual([scalaOperator.id, haskellOperator.id].sort());
    const scalaColonOperator = cg.getNodesByName('<::>')
      .find((node) => node.language === 'scala' && node.qualifiedName === 'Ops::<::>')!;
    expect(scalaColonOperator).toBeDefined();
    expect(matchesSymbol(scalaColonOperator, 'Ops::<::>')).toBe(true);
    const nestedScalaOperator = cg.getNodesByName('<::>')
      .find((node) => node.language === 'scala' && node.qualifiedName === 'Outer::Ops::<::>')!;
    expect(nestedScalaOperator).toBeDefined();
    expect(findAllSymbols(cg, 'Ops::<::>').nodes.map((node) => node.id).sort())
      .toEqual([scalaColonOperator.id, nestedScalaOperator.id].sort());
    for (const spelling of ['Outer.Ops.<::>', 'Outer::Ops::<::>']) {
      expect(matchesSymbol(nestedScalaOperator, spelling)).toBe(true);
      expect(findAllSymbols(cg, spelling).nodes.map((node) => node.id))
        .toEqual([nestedScalaOperator.id]);
    }
  });

  it('treats colons inside operator names like every other operator during co-naming', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-colon-op-overloads-'));
    for (let index = 0; index < 5; index++) {
      fs.writeFileSync(path.join(dir, `Module${index}.hs`), [
        `module Module${index} ((<+>), (<::>), target${index}) where`,
        '(<+>) value = value',
        '(<::>) value = value',
        `target${index} value = value`,
      ].join('\n'));
    }
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.hs'], exclude: [] } });
    await cg.indexAll();

    const ordinary = resolveNamedTokens(cg, '(<+>) target0');
    const withColons = resolveNamedTokens(cg, '(<::>) target0');
    expect(ordinary.tokenNodes.get('(<+>)')).toEqual([]);
    expect(withColons.tokenNodes.get('(<::>)')).toEqual([]);
  });

  it('admits an exported symbolic constructor as a precise flow endpoint', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-constructor-op-flow-'));
    fs.writeFileSync(path.join(dir, 'Ctor.hs'), [
      '{-# LANGUAGE TypeOperators #-}',
      'module Ctor (T((:::)), build) where',
      'data T a b = a ::: b',
      'build left right = left ::: right',
    ].join('\n'));
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.hs'], exclude: [] } });
    await cg.indexAll();

    const constructor = cg.getNodesByName('(:::)')
      .find((node) => node.kind === 'enum_member')!;
    expect(constructor).toBeDefined();
    const flow = resolveNamedSymbolFlow(
      cg,
      'build Ctor.:::',
      { mode: 'directed', from: 'build', to: 'Ctor.:::' },
    );
    expect(flow.tokenNodes.get('Ctor::(:::)')).toEqual([constructor.id]);
    expect(flow.chains[0]?.steps.map((step) => step.node.name)).toEqual(['build', '(:::)']);
    expect(resolveNamedTokens(cg, 'build (:::)').tokenNodes.get('(:::)'))
      .toEqual([constructor.id]);
  });

  it("ignores a prose contraction that has no matching symbol", async () => {
    const graph = await setup();
    const baseline = resolveNamedSymbolFlow(graph, 'request finish');
    const withContraction = resolveNamedSymbolFlow(graph, "don't request finish");

    expect([...withContraction.named.keys()]).toEqual([...baseline.named.keys()]);
    expect(withContraction.chains[0]?.steps.map((step) => step.node.id))
      .toEqual(baseline.chains[0]?.steps.map((step) => step.node.id));
  });

  it("renders a primed Haskell entrypoint in codegraph_explore's Flow", async () => {
    const graph = await setup();
    const result = await new ToolHandler(graph).execute('codegraph_explore', {
      query: "hover' request finish",
    });
    const text = result.content[0]?.text as string;

    expect(text).toContain('**Flow (call path among the symbols you queried)**');
    expect(text).toMatch(/1\. hover' \(Main\.hs:7\)/);
    expect(text).toMatch(/2\. request \(Main\.hs:10\)/);
    expect(text).toMatch(/3\. finish \(Main\.hs:13\)/);
  });
});
