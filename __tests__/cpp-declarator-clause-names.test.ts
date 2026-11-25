/**
 * A C++ function is named by its declarator, never by something written in
 * the clauses after its parameters. nlohmann/json's constructor
 *
 *   basic_json(CompatibleType && val) noexcept(noexcept(
 *               JSONSerializer<U>::to_json(std::declval<basic_json_t&>(), …)))
 *
 * had no node: both extractors looked for a qualified name anywhere in the
 * declarator except its parameters and trailing return type, found the call
 * inside `noexcept(…)`, and indexed a method `JSONSerializer::to_json` that
 * doesn't exist, which other `JSONSerializer<T>::to_json(…)` calls then
 * linked to. A `throw(std::bad_alloc)` specification and a trailing
 * `requires std::integral<T>` clause did the same. Runs against the native
 * kernel (when built) and the wasm extractor, which must agree.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult, Language } from '../src/types';

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);
const kernelAvailable = fs.existsSync(KERNEL_PATH) || process.env.CODEGRAPH_KERNEL_EXPECT === '1';

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

/** `<kind> <qualifiedName>` for every function and method. */
function callables(result: ExtractionResult): string[] {
  return result.nodes
    .filter((n) => n.kind === 'function' || n.kind === 'method')
    .map((n) => `${n.kind} ${n.qualifiedName}`);
}

describe('a C++ function named past the clauses after its parameters', () => {
  let savedEnv: Record<string, string | undefined> = {};

  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['cpp']);
  });

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    resetKernelForTests();
  });

  function extract(backend: 'kernel' | 'wasm', file: string, source: string, language: Language): ExtractionResult {
    if (backend === 'wasm') {
      process.env.CODEGRAPH_KERNEL = '0';
      return extractFromSource(file, source, language);
    }
    delete process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    const result = tryKernelExtract(file, source, language);
    expect(result, `kernel extraction of ${file}`).not.toBeNull();
    return result!;
  }

  const backends = kernelAvailable ? (['kernel', 'wasm'] as const) : (['wasm'] as const);

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it.each(backends)(`reproduction: nlohmann/json's constructor with noexcept(noexcept(JSONSerializer<U>::to_json(…))): %s${label}`, (backend) => {
      const source = [
        'namespace nlohmann {',
        'template<template<typename, typename> class JSONSerializer>',
        'class basic_json {',
        ' public:',
        '    template < typename CompatibleType, typename U = CompatibleType, int = 0 >',
        '    basic_json(CompatibleType && val) noexcept(noexcept( // NOLINT(bugprone-forwarding-reference-overload)',
        '                JSONSerializer<U>::to_json(*this,',
        '                                           val)))',
        '    {',
        '        JSONSerializer<U>::to_json(*this, val);',
        '    }',
        '};',
        '}  // namespace nlohmann',
        '',
      ].join('\n');
      const result = extract(backend, 'include/json.hpp', eol(source), 'cpp');
      expect(callables(result)).toEqual(['method nlohmann::basic_json::basic_json']);
    });

    it.each(backends)(`a throw(std::bad_alloc) specification and a trailing requires clause: %s${label}`, (backend) => {
      const source = [
        'namespace util {',
        'class Buffer {',
        ' public:',
        '  void Reserve(int n) throw(std::bad_alloc) {}',
        '};',
        'template <typename T>',
        'T Twice(T v) requires std::integral<T> {',
        '  return v * 2;',
        '}',
        '}  // namespace util',
        '',
      ].join('\n');
      const result = extract(backend, 'src/buffer.cpp', eol(source), 'cpp');
      expect(callables(result)).toEqual(['method util::Buffer::Reserve', 'function util::Twice']);
    });

    it.each(backends)(`an out-of-line method keeps its own qualified name past a noexcept clause: %s${label}`, (backend) => {
      const source = [
        'namespace util {',
        'struct Pool {',
        '  int Get() const;',
        '};',
        'int Pool::Get() const noexcept(noexcept(Other::Make())) {',
        '  return 1;',
        '}',
        '}  // namespace util',
        '',
      ].join('\n');
      const result = extract(backend, 'src/pool.cpp', eol(source), 'cpp');
      expect(callables(result)).toEqual(['method util::Pool::Get']);
    });
  }
});
