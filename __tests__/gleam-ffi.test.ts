import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Gleam Erlang FFI extraction', () => {
  it.each([
    ['pub fn', true],
    ['fn', false],
  ])('captures a renamed %s wrapper with module, function, and arity', (declaration, isExported) => {
    const result = extractFromSource(
      'src/config.gleam',
      `@external(erlang, "config_ffi", "getenv")\n${declaration} os_getenv(key: String, fallback: String) -> String`,
    );
    const wrapper = result.nodes.find((node) => node.kind === 'function' && node.name === 'os_getenv');
    const ffi = result.unresolvedReferences.find((ref) => ref.fromNodeId === wrapper?.id);

    expect(wrapper?.isExported).toBe(isExported);
    expect(ffi).toMatchObject({
      referenceName: 'config_ffi::getenv',
      referenceKind: 'calls',
      metadata: {
        ffi: true,
        targetLanguage: 'erlang',
        module: 'config_ffi',
        function: 'getenv',
        arity: 2,
      },
    });
  });

  it('selects the Erlang target from consecutive platform annotations', () => {
    const result = extractFromSource(
      'src/platform.gleam',
      '@external(erlang, "platform_ffi", "run")\n@external(javascript, "./platform.mjs", "run")\nfn run(value: Int) -> Int',
    );
    expect(result.unresolvedReferences.filter((ref) => ref.metadata?.ffi)).toEqual([
      expect.objectContaining({
        referenceName: 'platform_ffi::run',
        metadata: expect.objectContaining({ targetLanguage: 'erlang', arity: 1 }),
      }),
    ]);
  });

  it.each([
    '@external(erlang, config_ffi, "getenv")\nfn bad() -> Nil',
    '@external(erlang, "config_ffi")\nfn bad() -> Nil',
    '@external(javascript, "./ffi.mjs", "run")\nfn bad() -> Nil',
    '@external(erlang, "config_ffi", "run")\n// detached annotation\nfn bad() -> Nil',
  ])('keeps the wrapper but emits no Erlang FFI ref for unsupported input', (source) => {
    const result = extractFromSource('src/bad.gleam', source);
    expect(result.nodes.some((node) => node.kind === 'function' && node.name === 'bad')).toBe(true);
    expect(result.unresolvedReferences.some((ref) => ref.metadata?.ffi === true)).toBe(false);
  });
});

describe('Erlang FFI target arities', () => {
  it('records every arity supported by a grouped Erlang function node', () => {
    const result = extractFromSource(
      'src/ffi/config_ffi.erl',
      '-module(config_ffi).\n-export([getenv/1, getenv/2]).\ngetenv(Key) -> Key.\ngetenv(Key, Default) -> Default.\n',
    );
    const target = result.nodes.find(
      (node) => node.language === 'erlang' && node.kind === 'function' && node.qualifiedName === 'config_ffi::getenv',
    );
    expect(target?.decorators).toEqual(expect.arrayContaining(['erlang-arity:1', 'erlang-arity:2']));
  });

  it('recreates the function when the same Erlang file is extracted again', () => {
    const source = '-module(config_ffi).\n-export([getenv/2]).\ngetenv(Key, Default) -> Default.\n';
    extractFromSource('src/ffi/config_ffi.erl', source);

    const result = extractFromSource('src/ffi/config_ffi.erl', source);
    const target = result.nodes.find(
      (node) => node.language === 'erlang' && node.kind === 'function' && node.qualifiedName === 'config_ffi::getenv',
    );

    expect(target?.decorators).toContain('erlang-arity:2');
  });
});

describe('Gleam Erlang FFI resolution', () => {
  let projectDir = '';
  let graph: CodeGraph | undefined;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-gleam-ffi-'));
    fs.mkdirSync(path.join(projectDir, 'src', 'ffi'), { recursive: true });
  });

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (fs.existsSync(projectDir)) fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('links an indexed target by module, function, and arity with FFI metadata', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'config.gleam'),
      '@external(erlang, "config_ffi", "getenv")\nfn os_getenv(key: String, fallback: String) -> String\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'ffi', 'config_ffi.erl'),
      '-module(config_ffi).\n-export([getenv/2]).\ngetenv(Key, Default) -> Default.\n',
    );

    graph = await CodeGraph.init(projectDir, { index: true });
    const wrapper = graph.getNodesByKind('function').find((node) => node.name === 'os_getenv');
    const edges = wrapper ? graph.getOutgoingEdges(wrapper.id).filter((edge) => edge.kind === 'calls') : [];

    expect(edges).toHaveLength(1);
    expect(graph.getNode(edges[0]!.target)).toMatchObject({
      language: 'erlang',
      qualifiedName: 'config_ffi::getenv',
    });
    expect(edges[0]!.metadata).toMatchObject({
      ffi: true,
      targetLanguage: 'erlang',
      module: 'config_ffi',
      function: 'getenv',
      arity: 2,
      resolvedBy: 'foreign-function',
    });
  }, 30_000);

  it('ignores Erlang comments when matching FFI target arity', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'config.gleam'),
      '@external(erlang, "config_ffi", "getenv")\nfn os_getenv(key: String, fallback: String) -> String\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'ffi', 'config_ffi.erl'),
      '-module(config_ffi).\n-export([getenv/2]).\ngetenv(Key, % fallback value\n Default) -> Default.\n',
    );

    graph = await CodeGraph.init(projectDir, { index: true });
    const wrapper = graph.getNodesByKind('function').find((node) => node.name === 'os_getenv')!;
    const calls = graph.getOutgoingEdges(wrapper.id).filter((edge) => edge.kind === 'calls');

    expect(calls).toHaveLength(1);
    expect(graph.getNode(calls[0]!.target)).toMatchObject({
      language: 'erlang',
      qualifiedName: 'config_ffi::getenv',
    });
  }, 30_000);

  it.each([
    ['unindexed OTP target', '@external(erlang, "timer", "sleep")\nfn sleep(ms: Int) -> Nil\n', ''],
    ['wrong target arity', '@external(erlang, "config_ffi", "getenv")\nfn getenv(key: String, fallback: String) -> String\n', '-module(config_ffi).\n-export([getenv/1]).\ngetenv(Key) -> Key.\n'],
  ])('does not create a false edge for an %s', async (_label, gleam, erlang) => {
    fs.writeFileSync(path.join(projectDir, 'src', 'config.gleam'), gleam);
    if (erlang) fs.writeFileSync(path.join(projectDir, 'src', 'ffi', 'config_ffi.erl'), erlang);

    graph = await CodeGraph.init(projectDir, { index: true });
    const wrapper = graph.getNodesByKind('function').find(
      (node) => node.language === 'gleam' && (node.name === 'sleep' || node.name === 'getenv'),
    );
    expect(wrapper ? graph.getOutgoingEdges(wrapper.id).filter((edge) => edge.kind === 'calls') : []).toHaveLength(0);
    if (_label === 'unindexed OTP target') {
      expect(graph.getNodesByKind('function').some((node) => node.qualifiedName === 'timer::sleep')).toBe(false);
    }
  }, 30_000);

  it('leaves an ambiguous duplicate Erlang target unresolved', async () => {
    fs.writeFileSync(
      path.join(projectDir, 'src', 'config.gleam'),
      '@external(erlang, "duplicate_ffi", "run")\nfn run(value: Int) -> Int\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'ffi', 'one.erl'),
      '-module(duplicate_ffi).\n-export([run/1]).\nrun(Value) -> Value.\n',
    );
    fs.writeFileSync(
      path.join(projectDir, 'src', 'ffi', 'two.erl'),
      '-module(duplicate_ffi).\n-export([run/1]).\nrun(Value) -> Value.\n',
    );

    graph = await CodeGraph.init(projectDir, { index: true });
    const wrapper = graph.getNodesByKind('function').find(
      (node) => node.language === 'gleam' && node.name === 'run',
    );
    expect(wrapper ? graph.getOutgoingEdges(wrapper.id).filter((edge) => edge.kind === 'calls') : []).toHaveLength(0);
  }, 30_000);
});
