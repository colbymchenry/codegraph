import { describe, it, expect } from 'vitest';
import type { Node } from '../src/types';
import { captureLiterals, isSeedLiteral, seedLiteralsInQuery } from '../src/extraction/literal-capture';

function node(id: string, kind: Node['kind'], startLine: number, endLine: number): Node {
  return {
    id, kind, name: id, qualifiedName: id, filePath: 'src/a.ts', language: 'typescript',
    startLine, endLine, startColumn: 0, endColumn: Number.MAX_SAFE_INTEGER, updatedAt: 0,
  };
}

describe('isSeedLiteral', () => {
  it('keeps storage keys, flags, dotted names and paths', () => {
    for (const v of ['bompus_custom_ds_players', '--start', '-v', 'draft.pick', 'api/v1/users', 'ns:event'])
      expect(isSeedLiteral(v), v).toBe(v !== '-v');
  });
  it('drops plain words, prose, and values that start with a separator', () => {
    for (const v of ['ready', 'Error', 'not found', './utils', '../x', '', 'a_b'])
      expect(isSeedLiteral(v), v).toBe(false);
  });
});

describe('seedLiteralsInQuery', () => {
  it('finds quoted spans and bare runs, stripping surrounding punctuation', () => {
    expect(seedLiteralsInQuery('who writes "bompus_custom_ds_players" (via --start)?'))
      .toEqual(['bompus_custom_ds_players', '--start']);
  });
  it('returns nothing for a symbol-anchored question', () => {
    expect(seedLiteralsInQuery('callers of espnPlayerKey in shared')).toEqual([]);
  });
});

describe('captureLiterals', () => {
  const source = [
    `import { x } from './utils/helpers';`,            // 1: path starts with '.', never qualifies
    `const KEY = 'bompus_custom_ds_players';`,          // 2: top level → file node
    `export function save() {`,                         // 3
    `  storage.set('bompus_custom_ds_players', 1);`,    // 4
    `  log('ready');`,                                  // 5: plain word
    `  emit(\`draft.pick\`); emit(\`draft.\${n}\`);`,    // 6: second one interpolates
    `}`,                                                // 7
    `export class Boot { start() { run('--start'); } }`,// 8
  ].join('\n');

  it('attributes each literal to the innermost enclosing symbol, else the file', () => {
    const file = node('file:src/a.ts', 'file', 1, 8);
    const save = node('save', 'function', 3, 7);
    const boot = node('Boot', 'class', 8, 8);
    const start = node('start', 'method', 8, 8);
    const imp = node('./utils/helpers', 'import', 1, 1);
    const nodes = [file, imp, save, boot, start];
    captureLiterals(source, nodes);
    expect(file.literals).toEqual(['bompus_custom_ds_players']);
    expect(save.literals).toEqual(['bompus_custom_ds_players', 'draft.pick']);
    expect(start.literals).toEqual(['--start']);
    expect(boot.literals).toBeUndefined();
    expect(imp.literals).toBeUndefined();
  });

  it('dedupes per node and caps at 32', () => {
    const many = Array.from({ length: 40 }, (_, i) => `k('key_${i}'); k('key_${i}');`).join('\n');
    const fn = node('f', 'function', 1, 40);
    captureLiterals(many, [node('file:src/a.ts', 'file', 1, 40), fn]);
    expect(fn.literals).toHaveLength(32);
    expect(new Set(fn.literals).size).toBe(32);
  });

  it('uses UTF-16 columns to distinguish same-line siblings after non-ASCII source', () => {
    const prefix = '/* café 😀 */ ';
    const first = "function writer(){return 'cache.write';}";
    const second = "function reader(){return 'cache.read';}";
    const writer = { ...node('writer', 'function', 1, 1), startColumn: prefix.length, endColumn: (prefix + first).length };
    const reader = { ...node('reader', 'function', 1, 1), startColumn: (prefix + first).length, endColumn: (prefix + first + second).length };
    captureLiterals(prefix + first + second, [writer, reader]);
    expect(writer.literals).toEqual(['cache.write']);
    expect(reader.literals).toEqual(['cache.read']);
  });
});
