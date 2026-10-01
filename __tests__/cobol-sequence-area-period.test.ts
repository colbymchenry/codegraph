/**
 * COBOL: a file that ends inside the sequence area must parse, not hang.
 *
 * The vendored COBOL grammar's external scanner skips the fixed-format
 * sequence area (columns 1-6) by advancing until the lexer reaches column 7.
 * At end of input `advance()` is a no-op, so a file whose last line stops
 * inside that area — `    .` (four spaces and a period: the period lands in
 * column 5), `X\n    .`, a paragraph closed by a short `    .` line — never
 * reached column 7 and the scanner spun forever inside WebAssembly. Indexing
 * such a file ran into the parse worker's timeout (about a minute and a half
 * with the retries) and stored it with zero symbols; the viewer's highlighter
 * froze on the same text. The scanner now stops at end of input.
 *
 * Both checks run against the built engine in a child process under a hard
 * timeout: a regression is an infinite loop inside wasm that no in-process
 * timer can interrupt, so parsing in this worker would hang the suite instead
 * of failing the test.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const DIST = path.resolve(__dirname, '../dist');

/** A fixed-format program whose last line is a lone period in column 5. */
const HANGY = [
  '       IDENTIFICATION DIVISION.',
  '       PROGRAM-ID. HANGY.',
  '       PROCEDURE DIVISION.',
  '       MAIN-PARA.',
  '           DISPLAY "X"',
  '    .',
  '',
].join('\n');

/** Under the parse worker's 30 s hard per-file timeout a hang would run into. */
const DEADLINE_MS = 20_000;

function runChild(script: string, args: string[]) {
  return spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, '-e', script, DIST, ...args], {
    encoding: 'utf8',
    timeout: DEADLINE_MS,
    env: { ...process.env, CODEGRAPH_TELEMETRY: '0' },
  });
}

describe('COBOL sequence-area period at end of file', () => {
  it('extracts every source that ends inside the sequence area', () => {
    const sources: Record<string, string> = {
      'hangy.cob': HANGY,
      'hangy-no-newline.cob': HANGY.trimEnd(),
      'period-only.cob': '    .',
      'after-statement.cob': '    PERFORM AssertOk\n    .',
      'after-word.cob': 'X\n    .',
    };
    const script = `
const path = require('path');
const { initGrammars, loadGrammarsForLanguages } = require(path.join(process.argv[1], 'extraction/grammars.js'));
const { extractFromSource } = require(path.join(process.argv[1], 'extraction/index.js'));
(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['cobol']);
  const out = {};
  for (const [file, source] of Object.entries(JSON.parse(process.argv[2]))) {
    const result = extractFromSource(file, source);
    out[file] = result.nodes.map((n) => n.kind + ':' + n.name);
  }
  process.stdout.write(JSON.stringify(out));
})();
`;
    const child = runChild(script, [JSON.stringify(sources)]);
    expect(child.signal, `COBOL parse did not finish within ${DEADLINE_MS}ms: ${child.stderr}`).toBeNull();
    expect(child.status, child.stderr).toBe(0);

    const nodes = JSON.parse(child.stdout) as Record<string, string[]>;
    expect(Object.keys(nodes).sort()).toEqual(Object.keys(sources).sort());
    for (const file of ['hangy.cob', 'hangy-no-newline.cob']) {
      expect(nodes[file]).toContain('module:HANGY');
      expect(nodes[file]).toContain('function:MAIN-PARA');
    }
  }, DEADLINE_MS + 10_000);

  describe('indexing a project', () => {
    let root: string;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-cobol-seq-period-'));
    });

    afterEach(() => {
      fs.rmSync(root, { recursive: true, force: true });
    });

    it('indexes the file with its symbols instead of timing it out', () => {
      fs.writeFileSync(path.join(root, 'hangy.cob'), HANGY);
      const script = `
const path = require('path');
const { default: CodeGraph } = require(path.join(process.argv[1], 'index.js'));
const cg = CodeGraph.initSync(process.argv[2]);
cg.indexAll().then((result) => {
  const nodes = cg.getNodesInFile('hangy.cob').map((n) => n.kind + ':' + n.name);
  process.stdout.write(JSON.stringify({ errored: result.filesErrored, indexed: result.filesIndexed, nodes }));
}).finally(() => cg.close());
`;
      const child = runChild(script, [root]);
      expect(child.signal, `indexing did not finish within ${DEADLINE_MS}ms: ${child.stderr}`).toBeNull();
      expect(child.status, child.stderr).toBe(0);

      const result = JSON.parse(child.stdout) as { errored: number; indexed: number; nodes: string[] };
      expect(result.errored).toBe(0);
      expect(result.indexed).toBe(1);
      expect(result.nodes).toContain('module:HANGY');
      expect(result.nodes).toContain('function:MAIN-PARA');
    }, DEADLINE_MS + 10_000);
  });
});
