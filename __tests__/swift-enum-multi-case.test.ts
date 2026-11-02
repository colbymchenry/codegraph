/**
 * Every case of a Swift multi-case `case` line is an enum member.
 *
 * The grammar gives one `enum_entry` per `case` keyword and one `name` field
 * per case on it: `case object([Int]), array([Value]), boolean(Bool), null`
 * is one entry with four names. Reading the entry's name field yields the
 * first only, so `Value.null` and `Value.boolean(true)` had no member to land
 * on. A single-case entry keeps its member spanning the whole entry; each case
 * of a multi-case entry spans its own name.
 *
 * The wasm arm runs always; the kernel arm runs when a kernel is staged and
 * must mint the same nodes.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { tryKernelExtract, resetKernelForTests } from '../src/extraction/kernel';
import type { ExtractionResult } from '../src/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const SOURCE = `enum CompleteJSON {
    indirect enum Value {
        case object([Int]), array([Value]), boolean(Bool), null
    }
    static func make() { _ = Value.boolean(true) }
}

enum Method {
    case put, delete
}

enum Single {
    case only(Int)
}
`;

function members(result: ExtractionResult, enumQualifiedName: string) {
  return result.nodes
    .filter((n) => n.kind === 'enum_member' && n.qualifiedName.startsWith(`${enumQualifiedName}::`))
    .map((n) => ({ name: n.name, qualifiedName: n.qualifiedName, startLine: n.startLine, endLine: n.endLine, startColumn: n.startColumn }))
    .sort((a, b) => a.startColumn - b.startColumn);
}

function assertMembers(result: ExtractionResult): void {
  const value = members(result, 'CompleteJSON::Value');
  expect(value.map((m) => m.name)).toEqual(['object', 'array', 'boolean', 'null']);
  expect(new Set(result.nodes.filter((n) => n.kind === 'enum_member').map((n) => n.id)).size).toBe(7);
  // Each case of a multi-case entry spans its own name.
  expect(value.map((m) => m.startColumn)).toEqual([13, 28, 44, 59]);
  for (const m of value) expect([m.startLine, m.endLine]).toEqual([3, 3]);

  expect(members(result, 'Method').map((m) => m.name)).toEqual(['put', 'delete']);

  // A single-case entry spans the whole entry, `case` keyword included.
  expect(members(result, 'Single')).toEqual([
    { name: 'only', qualifiedName: 'Single::only', startLine: 13, endLine: 13, startColumn: 4 },
  ]);
}

describe('Swift multi-case enum entries', () => {
  it('mints every case of a case line on the wasm arm', () => {
    const saved = process.env.CODEGRAPH_KERNEL;
    process.env.CODEGRAPH_KERNEL = '0';
    try {
      assertMembers(extractFromSource('Sources/App/JSON.swift', SOURCE, 'swift'));
    } finally {
      if (saved === undefined) delete process.env.CODEGRAPH_KERNEL;
      else process.env.CODEGRAPH_KERNEL = saved;
    }
  });
});

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);

describe.skipIf(!fs.existsSync(KERNEL_PATH))('Swift multi-case enum entries, kernel arm', () => {
  const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;
  let saved: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetKernelForTests();
  });

  it('mints the same members as the wasm arm', () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    resetKernelForTests();
    process.env.CODEGRAPH_KERNEL_LANGS = 'all';
    delete process.env.CODEGRAPH_KERNEL;
    const viaKernel = tryKernelExtract('Sources/App/JSON.swift', SOURCE, 'swift');
    expect(viaKernel, 'kernel extraction failed').not.toBeNull();
    assertMembers(viaKernel!);

    process.env.CODEGRAPH_KERNEL = '0';
    const viaWasm = extractFromSource('Sources/App/JSON.swift', SOURCE, 'swift');
    const strip = (r: ExtractionResult) =>
      r.nodes.filter((n) => n.kind === 'enum_member').map(({ updatedAt: _u, ...n }) => JSON.stringify(n, Object.keys(n).sort())).sort();
    expect(strip(viaKernel!)).toEqual(strip(viaWasm));
  });
});
