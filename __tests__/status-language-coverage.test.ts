/**
 * `status`: files found against files that yielded symbols, and `--strict`.
 *
 * A language's file count says what the files are, not whether anything came of
 * them, so a language with nothing in the graph could read as healthy. These pin
 * the count, what is left out of it on purpose, the text lines scripts may read,
 * and every way the gate fails: the failure that started this no longer shows up
 * as a zero, because a grammar that can't load stores no row at all (#2335).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import { ToolHandler } from '../src/mcp/tools';
import { endFreshnessMeasurements } from '../src/mcp/index-freshness';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

// These index a project and spawn the real CLI, up to several times a test.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const HAS_SYMBOL = 'export function alpha(): number { return 1; }\n';
const NO_SYMBOL = '// nothing here but a comment\n';

describe('status language coverage', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-language-coverage-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function write(files: Record<string, string>): void {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
  }

  async function indexed(files: Record<string, string>): Promise<CodeGraph> {
    write(files);
    const cg = await CodeGraph.init(dir);
    await cg.indexAll();
    return cg;
  }

  async function indexedAndClosed(files: Record<string, string>): Promise<void> {
    (await indexed(files)).close();
  }

  function status(...args: string[]): { code: number | null; stdout: string; stderr: string } {
    const run = spawnSync(process.execPath, [BIN, 'status', dir, ...args], {
      encoding: 'utf-8',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', NO_COLOR: '1' },
    });
    return { code: run.status, stdout: run.stdout, stderr: run.stderr };
  }

  function statusJson(...args: string[]): { code: number | null; json: Record<string, any> } {
    const { code, stdout } = status('--json', ...args);
    return { code, json: JSON.parse(stdout) };
  }

  /** The whole row a language prints under `Files by Language:`. */
  function languageRow(stdout: string, language: string): string | undefined {
    return stdout.split(/\r?\n/).find((line) => line.startsWith(`  ${language} `));
  }

  describe('the count', () => {
    it('counts a file with a symbol, and not one with only its own file node', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL, 'b.ts': NO_SYMBOL });

      expect(cg.getStats().filesByLanguage.typescript).toBe(2);
      expect(cg.getLanguageCoverage()).toEqual({ parsedFilesByLanguage: { typescript: 1 }, unparsedLanguages: [] });
      cg.close();
    });

    it('names a language none of whose files yielded a symbol', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL, 'stub.lua': '-- nothing here\n' });

      expect(cg.getLanguageCoverage()).toEqual({
        parsedFilesByLanguage: { lua: 0, typescript: 1 },
        unparsedLanguages: ['lua'],
      });
      cg.close();
    });

    it('leaves out the languages tracked at file level, which yield nothing by design', async () => {
      const cg = await indexed({
        'a.ts': HAS_SYMBOL,
        'config.yaml': 'key: value\n',
        'application.properties': 'key=value\n',
        'pom.xml': '<project></project>\n',
      });

      expect(cg.getStats().filesByLanguage).toMatchObject({ yaml: 1, properties: 1, xml: 1 });
      expect(cg.getLanguageCoverage()).toEqual({ parsedFilesByLanguage: { typescript: 1 }, unparsedLanguages: [] });
      cg.close();
    });

    it('asks the nodes when the stored count cannot say', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL });
      // A file whose one symbol is its only node reads like a file with none.
      const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { run(): unknown } } } }).db.getDb();
      db.prepare('UPDATE files SET node_count = 1').run();

      expect(cg.getLanguageCoverage().parsedFilesByLanguage.typescript).toBe(1);
      cg.close();
    });

    it('counts a file over the size limit as found, not parsed', async () => {
      const cg = await indexed({
        'a.ts': HAS_SYMBOL,
        'huge.ts': `// ${'x'.repeat(MAX_SOURCE_FILE_SIZE_BYTES)}\n${HAS_SYMBOL}`,
      });

      expect(cg.getStats().filesByLanguage.typescript).toBe(2);
      expect(cg.getLanguageCoverage().parsedFilesByLanguage.typescript).toBe(1);
      cg.close();
    });

    it('costs an explore nothing: only status runs it', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL });
      const queries = (cg as unknown as { queries: { getParsedFileCounts(): unknown } }).queries;
      let calls = 0;
      const original = queries.getParsedFileCounts.bind(queries);
      queries.getParsedFileCounts = () => {
        calls++;
        return original();
      };
      const handler = new ToolHandler(cg);

      const explored = await handler.execute('codegraph_explore', { query: 'alpha' });
      expect(explored.isError).toBeFalsy();
      cg.getStats();
      expect(calls).toBe(0);

      await handler.execute('codegraph_status', {});
      expect(calls).toBe(1);
      await endFreshnessMeasurements();
      cg.close();
    });
  });

  describe('status text', () => {
    it('leaves a language row as it was when every file yielded symbols', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'b.ts': HAS_SYMBOL });

      expect(languageRow(status().stdout, 'typescript')).toBe('  typescript      2');
    });

    it('adds the count to a row when the two differ', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'b.ts': NO_SYMBOL });

      expect(languageRow(status().stdout, 'typescript')).toBe('  typescript      2  (1 with symbols)');
    });

    it('leaves a file-level language row as it was', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'config.yaml': 'key: value\n' });

      expect(languageRow(status().stdout, 'yaml')).toBe('  yaml            1');
    });

    it('says which language yielded nothing and names its files, without failing', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, '.nvim.lua': '-- settings\n' });

      const { code, stdout } = status();

      expect(code).toBe(0);
      expect(languageRow(stdout, 'lua')).toBe('  lua             1  (0 with symbols)');
      expect(stdout).toMatch(/No symbols came from any lua file .* \.nvim\.lua/);
      expect(stdout).toContain('Index is up to date');
    });

    it('says nothing of the kind about a healthy index', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL });

      expect(status().stdout).not.toContain('No symbols came from');
    });
  });

  describe('status --json', () => {
    it('adds the coverage fields and keeps every field it had', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'b.ts': NO_SYMBOL, 'c.yaml': 'key: value\n' });

      const { json } = statusJson();

      expect(json).toMatchObject({
        filesByLanguage: { typescript: 2, yaml: 1 },
        parsedFilesByLanguage: { typescript: 1 },
        unparsedLanguages: [],
      });
      expect(json.parsedFilesByLanguage).not.toHaveProperty('yaml');
      expect(Object.keys(json)).toEqual(
        expect.arrayContaining([
          'initialized', 'version', 'projectPath', 'indexPath', 'lastIndexed', 'fileCount', 'nodeCount', 'edgeCount',
          'dbSizeBytes', 'walSizeBytes', 'backend', 'journalMode', 'nodesByKind', 'languages', 'pendingChanges',
          'worktreeMismatch', 'rebuildInProgress', 'index',
        ]),
      );
      expect(json.languages).toEqual(expect.arrayContaining(['typescript', 'yaml']));
    });

    it('keeps the uninitialized answer as it was', () => {
      const { code, json } = statusJson();

      expect(code).toBe(0);
      expect(Object.keys(json).sort()).toEqual(['indexPath', 'initialized', 'lastIndexed', 'projectPath', 'version']);
    });
  });

  describe('status --strict', () => {
    const healthy = { 'a.ts': HAS_SYMBOL, 'config.yaml': 'key: value\n', 'pom.xml': '<project></project>\n' };

    function setIndexState(state: string): void {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(path.join(dir, '.codegraph', 'codegraph.db'));
      db.prepare(
        "INSERT INTO project_metadata (key, value, updated_at) VALUES ('index_state', ?, 0) " +
          'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(state);
      db.close();
    }

    it('passes a finished, current index whose languages all yielded symbols', async () => {
      await indexedAndClosed(healthy);

      expect(status('--strict').code).toBe(0);
      expect(statusJson('--strict').code).toBe(0);
    });

    it('prints the same text as a plain status', async () => {
      await indexedAndClosed(healthy);

      expect(status('--strict').stdout).toBe(status().stdout);
    });

    it('fails a language that yielded nothing, in either output mode', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'stub.lua': '-- nothing here\n' });

      expect(status('--strict').code).toBe(1);
      const { code, json } = statusJson('--strict');
      expect(code).toBe(1);
      expect(json.unparsedLanguages).toEqual(['lua']);
    });

    it('does not fail a language for one file that yielded nothing', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'b.ts': NO_SYMBOL });

      expect(status('--strict').code).toBe(0);
    });

    it('fails with no index to read, in either output mode', () => {
      expect(status('--strict').code).toBe(1);
      expect(statusJson('--strict').code).toBe(1);
    });

    it.each(['indexing', 'partial', 'failed'])('fails an index left %s', async (state) => {
      await indexedAndClosed(healthy);
      setIndexState(state);

      expect(status().code).toBe(0);
      expect(status('--strict').code).toBe(1);
    });

    it('fails while a rebuild runs: its numbers are a snapshot', async () => {
      await indexedAndClosed(healthy);
      const lock = JSON.stringify({ pid: process.pid, mode: 'rebuild', startedAt: Date.now(), ready: false });
      fs.writeFileSync(path.join(dir, '.codegraph', 'rebuild.pid'), lock);
      fs.writeFileSync(path.join(dir, '.codegraph', 'writer.pid'), lock);

      expect(status().code).toBe(0);
      expect(status('--strict').code).toBe(1);
      expect(statusJson('--strict').code).toBe(1);
    });

    it('fails files the index does not have, which is all a grammar that cannot load leaves', async () => {
      await indexedAndClosed(healthy);
      write({ 'b.ts': HAS_SYMBOL });

      expect(status().code).toBe(0);
      expect(status('--strict').code).toBe(1);
    });

    it('fails a file that lost its symbols', async () => {
      const cg = await indexed(healthy);
      const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { run(...args: unknown[]): unknown } } } }).db.getDb();
      db.prepare('DELETE FROM nodes WHERE file_path = ?').run('a.ts');
      db.prepare('UPDATE files SET node_count = 0 WHERE path = ?').run('a.ts');
      cg.close();

      expect(status().code).toBe(0);
      expect(status('--strict').code).toBe(1);
    });

    it('does not fail one file that cannot be parsed', async () => {
      await indexedAndClosed({ 'a.ts': HAS_SYMBOL, 'bad.ts': '@@@ ((( }}} class 1 = ;\n' });

      const { code, stdout } = status('--strict');

      expect(stdout).toContain('could not be parsed');
      expect(code).toBe(0);
    });
  });

  describe('codegraph_status', () => {
    afterEach(async () => {
      await endFreshnessMeasurements();
    });

    async function statusText(cg: CodeGraph): Promise<string> {
      const result = await new ToolHandler(cg).execute('codegraph_status', {});
      expect(result.isError).toBeFalsy();
      return result.content[0]!.text as string;
    }

    it('leaves a language row as it was when every file yielded symbols', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL, 'config.yaml': 'key: value\n' });

      const text = await statusText(cg);

      expect(text).toContain('- typescript: 1\n');
      expect(text).toMatch(/- yaml: 1(\n|$)/);
      expect(text).not.toContain('No symbols from');
      cg.close();
    });

    it('shows the count when the two differ', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL, 'b.ts': NO_SYMBOL });

      expect(await statusText(cg)).toContain('- typescript: 2 (1 with symbols)');
      cg.close();
    });

    it('tells an agent which languages it cannot search, as a normal answer', async () => {
      const cg = await indexed({ 'a.ts': HAS_SYMBOL, 'stub.lua': '-- nothing here\n' });

      const text = await statusText(cg);

      expect(text).toContain('- lua: 1 (0 with symbols)');
      expect(text).toContain('**No symbols from:** ⚠ lua');
      cg.close();
    });
  });
});
