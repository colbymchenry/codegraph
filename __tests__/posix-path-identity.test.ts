import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getGitChangedFiles, scanDirectory } from '../src/extraction';
import { ToolHandler } from '../src/mcp/tools';
import { extractQueryPaths } from '../src/search/query-paths';
import { FileWatcher } from '../src/sync/watcher';
import { buildSource } from '../src/ui-server/api/source';
import { normalizePath } from '../src/utils';

const literal = 'foo\\bar.ts';
const nested = 'foo/bar.ts';
const ordinary = 'src/foo.ts';
const files = [literal, nested, ordinary].sort();
const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

describe('native pathname normalization', () => {
  it('preserves forward slashes and empty paths', () => {
    expect(normalizePath(ordinary)).toBe(ordinary);
    expect(normalizePath('')).toBe('');
  });

  it.runIf(process.platform !== 'win32')('preserves POSIX filename characters', () => {
    for (const file of ['\\', literal, 'src/foo\\bar.ts']) {
      expect(normalizePath(file)).toBe(file);
    }
    expect(normalizePath(literal)).not.toBe(normalizePath(nested));
  });

  it.runIf(process.platform === 'win32')('canonicalizes Windows directory separators', () => {
    expect(normalizePath('src\\foo\\bar.ts')).toBe('src/foo/bar.ts');
  });
});

describe.runIf(process.platform !== 'win32')('POSIX pathname identity', () => {
  let root: string;
  let cg: CodeGraph | undefined;
  let watcher: FileWatcher | undefined;
  const git = (...args: string[]) => execFileSync('git', args, {
    cwd: root, encoding: 'utf8', stdio: 'pipe',
  });
  const write = (file: string, symbol: string) => {
    const absolute = path.join(root, file);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, `export function ${symbol}() { return 1; }\n`);
  };
  const initGit = () => {
    git('init', '-q');
    git('add', '-A');
    git('-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture');
  };
  const index = async () => {
    cg = CodeGraph.initSync(root);
    const result = await cg.indexAll();
    expect(result.success).toBe(true);
    expect(result.filesIndexed).toBe(3);
    return cg;
  };

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-posix-path-'));
    fs.writeFileSync(path.join(root, '.gitignore'), '.codegraph/\n');
    // An unsupported but legal filename must pass through ignore matching
    // unchanged and then be skipped by source-file detection.
    fs.writeFileSync(path.join(root, '\\'), 'not source');
    write(literal, 'literalVersion');
    write(nested, 'nestedVersion');
    write(ordinary, 'ordinaryVersion');
  });

  afterEach(() => {
    watcher?.stop();
    watcher = undefined;
    cg?.close();
    cg = undefined;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('agrees across filesystem fallback, tracked and untracked Git scans', () => {
    expect(scanDirectory(root).sort()).toEqual(files);
    initGit();
    expect(scanDirectory(root).sort()).toEqual(files);
    write('new\\file.ts', 'untrackedVersion');
    expect(scanDirectory(root).sort()).toEqual([...files, 'new\\file.ts'].sort());
    const changes = getGitChangedFiles(root);
    // A non-null answer proves the Git path itself succeeded, not fallback.
    expect(changes).not.toBeNull();
    expect(changes!.added).toContain('new\\file.ts');
  });

  it('does not apply a directory ignore rule to a literal backslash filename', () => {
    fs.appendFileSync(path.join(root, '.gitignore'), 'foo/\n');
    expect(scanDirectory(root).sort()).toEqual([literal, ordinary].sort());
    initGit();
    expect(scanDirectory(root).sort()).toEqual([literal, ordinary].sort());
  });

  for (const mode of ['filesystem', 'git'] as const) {
    it(`keeps separate SQLite file and symbol paths, query pins and reads (${mode})`, async () => {
      if (mode === 'git') initGit();
      const graph = await index();
      // Reopen to assert persisted SQLite identity, not just in-memory output.
      graph.close();
      cg = CodeGraph.openSync(root);
      expect(cg.getFiles().map(f => f.path).sort()).toEqual(files);
      const handler = new ToolHandler(cg);
      for (const [file, symbol, other] of [
        [literal, 'literalVersion', 'nestedVersion'],
        [nested, 'nestedVersion', 'literalVersion'],
      ]) {
        expect(cg.getNodesInFile(file!).find(n => n.name === symbol)?.filePath).toBe(file);
        expect(extractQueryPaths(`read ${file}`, files).pinnedFiles).toEqual([file]);
        const result = await handler.execute('codegraph_node', { file });
        expect(result.isError).toBeFalsy();
        expect(result.content[0]!.text).toContain(symbol);
        expect(result.content[0]!.text).not.toContain(other);
        const listing = await handler.execute('codegraph_files', { path: file, format: 'flat' });
        expect(listing.content[0]!.text).toContain(file);
        const source = await buildSource(cg, root, new URLSearchParams({ file: file! }));
        expect(source.file).toBe(file);
        expect(source.drift).toBe(false);
        expect(JSON.stringify(source.lines)).toContain(symbol);
        expect(JSON.stringify(source.lines)).not.toContain(other);
      }
    });

    it(`syncs modifications, additions and deletions without touching the other file (${mode})`, async () => {
      if (mode === 'git') initGit();
      const graph = await index();
      for (const [file, other, symbol] of [
        [literal, nested, 'literalUpdated'],
        [nested, literal, 'nestedUpdated'],
      ]) {
        const untouched = graph.getFile(other!);
        write(file!, symbol!);
        expect(graph.getChangedFiles()).toEqual({ added: [], modified: [file], removed: [] });
        expect(await graph.sync()).toMatchObject({ filesAdded: 0, filesModified: 1, filesRemoved: 0 });
        expect(graph.getFile(other!)).toEqual(untouched);
        expect(graph.getNodesInFile(file!).some(n => n.name === symbol)).toBe(true);
      }
      fs.unlinkSync(path.join(root, literal));
      expect(graph.getChangedFiles()).toEqual({ added: [], modified: [], removed: [literal] });
      await graph.sync();
      expect(graph.getFile(literal)).toBeNull();
      expect(graph.getFile(nested)).not.toBeNull();
      write(literal, 'literalRecreated');
      expect(graph.getChangedFiles()).toEqual({ added: [literal], modified: [], removed: [] });
      await graph.sync();
      expect(graph.getFiles().map(f => f.path).sort()).toEqual(files);
    });
  }

  it('keeps embedded Git repository prefixes with literal backslashes', () => {
    initGit();
    const child = 'embedded\\repo';
    write(`${child}/child.ts`, 'childSymbol');
    git('-C', child, 'init', '-q');
    git('-C', child, 'add', '-A');
    git('-C', child, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'child');
    const expected = [...files, `${child}/child.ts`].sort();
    expect(scanDirectory(root).sort()).toEqual(expected);
    // Stage it as a gitlink too, exercising both embedded-repository paths.
    git('add', child);
    expect(scanDirectory(root).sort()).toEqual(expected);
  });

  it('resolves relative imports within a directory containing a backslash', async () => {
    for (const dir of ['pkg\\name', 'pkg/name']) {
      write(`${dir}/target.ts`, 'target');
      fs.writeFileSync(path.join(root, dir, 'entry.ts'), "import { target } from './target';\nexport function entry() { return target(); }\n");
    }
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    for (const dir of ['pkg\\name', 'pkg/name']) {
      const entry = cg.getNodesInFile(`${dir}/entry.ts`).find(n => n.name === 'entry')!;
      expect(cg.getCallees(entry.id).map(c => c.node.filePath)).toContain(`${dir}/target.ts`);
      expect(cg.getCallees(entry.id).every(c => c.node.filePath === `${dir}/target.ts`)).toBe(true);
    }
  });

  it('reads percent escapes as literal filename characters without reading an unindexed sibling', async () => {
    const encoded = 'foo%5cbar.ts';
    write(encoded, 'encodedVersion');
    fs.unlinkSync(path.join(root, literal));
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    write(literal, 'unindexedVersion');
    expect(cg.getFile(literal)).toBeNull();

    const query = (ondrift: string) => new URLSearchParams(
      new URLSearchParams({ file: encoded, ondrift }).toString(),
    );
    const indexed = await buildSource(cg, root, query('omit'));
    expect(indexed.file).toBe(encoded);
    expect(indexed.drift).toBe(false);
    expect(indexed.lines).toEqual(['export function encodedVersion() { return 1; }']);

    write(encoded, 'encodedUpdated');
    const current = await buildSource(cg, root, query('current'));
    expect(current.file).toBe(encoded);
    expect(current.drift).toBe(true);
    expect(current.lines).toEqual(['export function encodedUpdated() { return 1; }']);
  });

  it('syncs a literal backslash filename starting with two dots through the watcher', async () => {
    const file = '..\\file.ts';
    write(file, 'dotVersion');
    cg = CodeGraph.initSync(root);
    expect((await cg.indexAll()).success).toBe(true);
    expect(cg.getFile(file)?.path).toBe(file);
    const graph = cg;
    const onSyncComplete = vi.fn();
    const sync = vi.fn(async (paths?: string[]) => {
      const result = await graph.sync({ paths });
      return { filesChanged: result.filesModified, durationMs: result.durationMs };
    });
    watcher = new FileWatcher(root, sync, { inertForTests: true, debounceMs: 20, onSyncComplete });
    watcher.start();
    await watcher.waitUntilReady();
    write(file, 'dotUpdated');
    watcher.ingestEventForTests(file);
    expect(watcher.getPendingFiles().map(f => f.path)).toEqual([file]);
    await vi.waitFor(() => expect(onSyncComplete).toHaveBeenCalled());
    expect(sync).toHaveBeenCalledWith([file]);
    expect(graph.getNodesInFile(file).some(n => n.name === 'dotUpdated')).toBe(true);
    expect(graph.getNodesInFile(literal).some(n => n.name === 'literalVersion')).toBe(true);
  });

  it('delivers native watcher events to scoped sync with their original identity', async () => {
    const graph = await index();
    const sync = vi.fn(async (paths?: string[]) => {
      const result = await graph.sync({ paths });
      return {
        filesChanged: result.filesAdded + result.filesModified + result.filesRemoved,
        durationMs: result.durationMs,
      };
    });
    const onSyncComplete = vi.fn();
    watcher = new FileWatcher(root, sync, { debounceMs: 30, onSyncComplete });
    expect(watcher.start()).toBe(true);
    await watcher.waitUntilReady();
    for (const [file, symbol, other] of [
      [literal, 'literalWatched', nested],
      [nested, 'nestedWatched', literal],
    ]) {
      sync.mockClear();
      onSyncComplete.mockClear();
      const untouched = graph.getFile(other!);
      write(file!, symbol!);
      await vi.waitFor(() => {
        expect(onSyncComplete).toHaveBeenCalled();
        expect(graph.getNodesInFile(file!).some(n => n.name === symbol)).toBe(true);
      }, { timeout: 10000, interval: 50 });
      expect(sync.mock.calls.some(([paths]) => paths?.includes(file!))).toBe(true);
      expect(sync.mock.calls.every(([paths]) => !paths?.includes(other!))).toBe(true);
      expect(graph.getFile(other!)).toEqual(untouched);
    }
  }, 25000);

  it('indexes both files through the built CLI with --verbose', () => {
    initGit();
    CodeGraph.initSync(root).close();
    execFileSync(process.execPath, [BIN, 'index', '--verbose', root], {
      cwd: root, encoding: 'utf8', timeout: 30000, stdio: 'pipe',
      env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1' },
    });
    cg = CodeGraph.openSync(root);
    expect(cg.getFiles().map(f => f.path).sort()).toEqual(files);
  }, 35000);
});
