import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EDGE_KINDS, NODE_KINDS } from '../src/types';

/**
 * These arrays cross the TypeScript/Rust boundary as numeric indexes.
 * Repository-document support may append kinds but may never renumber the
 * existing CodeGraph protocol.
 */
describe('native graph wire contract', () => {
  it('keeps every pre-document node kind at its original index', () => {
    expect(NODE_KINDS.slice(0, 22)).toEqual([
      'file',
      'module',
      'class',
      'struct',
      'interface',
      'trait',
      'protocol',
      'function',
      'method',
      'property',
      'field',
      'variable',
      'constant',
      'enum',
      'enum_member',
      'type_alias',
      'namespace',
      'parameter',
      'import',
      'export',
      'route',
      'component',
    ]);
    expect(NODE_KINDS[22]).toBe('section');
  });

  it('does not change any existing edge-kind index', () => {
    expect(EDGE_KINDS).toEqual([
      'contains',
      'calls',
      'imports',
      'exports',
      'extends',
      'implements',
      'references',
      'type_of',
      'returns',
      'instantiates',
      'overrides',
      'decorates',
    ]);
  });

  it('keeps the checked-in Rust wire tables identical to TypeScript', () => {
    const rust = fs.readFileSync(
      path.resolve(__dirname, '../codegraph-kernel/src/buffers.rs'),
      'utf8'
    );
    const readRustArray = (name: string): string[] => {
      const match = rust.match(
        new RegExp(`pub const ${name}: \\[&str; \\d+\\] = \\[([\\s\\S]*?)\\];`)
      );
      expect(match, `${name} must exist in buffers.rs`).not.toBeNull();
      return [...match![1]!.matchAll(/"([^"]+)"/g)].map((entry) => entry[1]!);
    };

    expect(readRustArray('NODE_KINDS')).toEqual([...NODE_KINDS]);
    expect(readRustArray('EDGE_KINDS')).toEqual([...EDGE_KINDS]);
  });
});
