/**
 * `status` must distinguish files SEEN from files PARSED.
 *
 * The per-language file count is derived from the file EXTENSION, so it counts
 * a file the parser never understood identically to one it parsed perfectly.
 * That makes a broken language very cheap to ship: with a grammar missing,
 * `init` still succeeds, `status` still lists the language with its full file
 * count, and a symbol lookup still "runs" — every obvious check stays green
 * while the language contributes nothing to the graph.
 *
 * The parsed count is the cheap signal that separates the two, and it is only
 * meaningful if it excludes the `file` node every indexed file gets regardless.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { initGrammars, loadAllGrammars, hasGrammar } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function hasSqliteBindings(): boolean {
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.close();
    return true;
  } catch {
    return false;
  }
}
const HAS_SQLITE = hasSqliteBindings();

describe('hasGrammar — which languages are expected to yield symbols', () => {
  it('is true for grammar-backed languages', () => {
    expect(hasGrammar('typescript')).toBe(true);
    expect(hasGrammar('python')).toBe(true);
    expect(hasGrammar('rust')).toBe(true);
  });

  it('is false for the formats tracked at file level on purpose', () => {
    // These must never raise a "parsed nothing" warning — producing no symbols
    // is their designed behaviour, not a broken grammar.
    expect(hasGrammar('yaml')).toBe(false);
    expect(hasGrammar('twig')).toBe(false);
    expect(hasGrammar('xml')).toBe(false);
    expect(hasGrammar('unknown')).toBe(false);
  });
});

describe.skipIf(!HAS_SQLITE)('getStats — parsedFilesByLanguage', () => {
  let projectRoot: string;
  let cg: any;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-parsed-'));
  });

  afterEach(() => {
    cg?.destroy();
    if (fs.existsSync(projectRoot)) fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>, include: string[]): Promise<any> {
    for (const [rel, body] of Object.entries(files)) {
      const full = path.join(projectRoot, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, body);
    }
    const CodeGraph = (await import('../src/index')).default;
    cg = CodeGraph.initSync(projectRoot, { config: { include, exclude: [] } });
    await cg.indexAll();
    return cg.getStats();
  }

  it('counts a file that yielded symbols as parsed', async () => {
    const stats = await index(
      { 'src/a.ts': 'export function alpha(): number { return 1; }\n' },
      ['**/*.ts']
    );
    expect(stats.filesByLanguage.typescript).toBe(1);
    expect(stats.parsedFilesByLanguage.typescript).toBe(1);
  }, 60000);

  it('does NOT count a file whose only node is its own file node', async () => {
    // An empty source file is indexed — it gets a `file` node like every other
    // — but nothing was extracted from it. If the parsed count included the
    // file node it would equal the seen count always, and detect nothing.
    const stats = await index({ 'src/empty.ts': '\n\n' }, ['**/*.ts']);
    expect(stats.filesByLanguage.typescript).toBe(1);
    expect(stats.parsedFilesByLanguage.typescript ?? 0).toBe(0);
  }, 60000);

  it('reports seen and parsed separately per language', async () => {
    const stats = await index(
      {
        'src/a.ts': 'export function alpha(): number { return 1; }\n',
        'src/empty.ts': '\n',
        'src/b.py': 'def beta():\n    return 2\n',
      },
      ['**/*.ts', '**/*.py']
    );
    expect(stats.filesByLanguage.typescript).toBe(2);
    expect(stats.parsedFilesByLanguage.typescript).toBe(1);
    expect(stats.filesByLanguage.python).toBe(1);
    expect(stats.parsedFilesByLanguage.python).toBe(1);
  }, 60000);

  it('a language that parsed nothing is detectable from the stats alone', async () => {
    // The shape `status --strict` gates on: files present, none parsed, and the
    // language is one a grammar is supposed to handle.
    const stats = await index({ 'src/empty.ts': '\n' }, ['**/*.ts']);
    const unparsed = Object.entries(stats.filesByLanguage as Record<string, number>)
      .filter(
        ([lang, count]) =>
          count > 0 &&
          ((stats.parsedFilesByLanguage as Record<string, number>)[lang] ?? 0) === 0 &&
          hasGrammar(lang as never)
      )
      .map(([lang]) => lang);
    expect(unparsed).toEqual(['typescript']);
  }, 60000);
});
