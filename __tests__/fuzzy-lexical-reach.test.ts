/**
 * A function nested inside another function is only callable from inside its
 * container. matchByExactName already filters candidates that way; matchFuzzy
 * must too, or a call to a builtin method (`res.text()`) whose only same-named
 * project symbol is some file's closure resolves onto that closure.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

describe('fuzzy matching respects lexical reachability of nested functions', () => {
  let tempDir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-fuzzy-reach-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = null;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Windows can still hold the SQLite handle for a moment; the OS temp dir is swept anyway.
    }
  });

  it('does not resolve a builtin method call onto another file\'s closure of the same name', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'seed.ts'),
      [
        'export function readSeedState(raw: string): string {',
        '  function text(): string {',
        '    return raw.trim();',
        '  }',
        '  return text();',
        '}',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(tempDir, 'fetch.ts'),
      [
        'export async function readOkText(settled: { value: Response }): Promise<string> {',
        '  // A chained receiver reaches the resolver as the bare method name.',
        '  return settled.value.text();',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(tempDir, { index: true });
    cg.resolveReferences();

    const closure = cg
      .getNodesByKind('function')
      .find((n) => n.name === 'text' && n.filePath === 'seed.ts');
    const caller = cg.getNodesByKind('function').find((n) => n.name === 'readOkText');
    expect(closure).toBeDefined();
    expect(caller).toBeDefined();

    const fromCaller = cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls');
    expect(fromCaller.map((e) => e.target)).not.toContain(closure!.id);

    // The in-container call still resolves.
    const container = cg.getNodesByKind('function').find((n) => n.name === 'readSeedState');
    const inside = cg.getOutgoingEdges(container!.id).filter((e) => e.kind === 'calls');
    expect(inside.map((e) => e.target)).toContain(closure!.id);
  });
});
