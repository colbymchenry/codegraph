import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import type { ResolutionContext } from '../src/resolution/types';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';

vi.mock('fs', async (importOriginal) => ({ ...await importOriginal<typeof import('fs')>() }));

describe('resolution file reads', () => {
  let root: string;
  let cg: CodeGraph;
  let resolver: ReferenceResolver;
  let context: ResolutionContext;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-resolution-read-'));
    cg = CodeGraph.initSync(root);
    resolver = new ReferenceResolver(root, cg.queries);
    context = resolver.getResolutionContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    cg.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });

  function sparseArchive(): string {
    const relative = 'node_modules/example/react_native_openharmony.har';
    const archive = path.join(root, relative);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const fd = fs.openSync(archive, 'w');
    try {
      fs.writeSync(fd, Buffer.from([0x1f, 0x8b]));
      fs.ftruncateSync(fd, 2 * 1024 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    return relative;
  }

  it('reads normal source files', () => {
    fs.writeFileSync(path.join(root, 'small.ts'), 'export const answer = 42;\n');
    expect(context.readFile('small.ts')).toBe('export const answer = 42;\n');
  });

  it('rejects an oversized package archive before decoding and caches the rejection', () => {
    const relative = sparseArchive();
    const read = vi.spyOn(fs, 'readFileSync');
    const stat = vi.spyOn(fs, 'statSync');
    expect(context.readFile(relative)).toBeNull();
    expect(context.readFile(relative)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, relative), 'export const repaired = true;');
    resolver.clearCaches();
    expect(context.readFile(relative)).toBe('export const repaired = true;');
  });

  it('accepts exactly the byte limit and rejects one byte more', () => {
    const content = 'a'.repeat(MAX_SOURCE_FILE_SIZE_BYTES);
    fs.writeFileSync(path.join(root, 'boundary.ts'), content);
    expect(context.readFile('boundary.ts')).toBe(content);
    fs.appendFileSync(path.join(root, 'boundary.ts'), 'a');
    resolver.clearCaches();
    const read = vi.spyOn(fs, 'readFileSync');
    expect(context.readFile('boundary.ts')).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('rejects directories before reading and caches missing files', () => {
    fs.mkdirSync(path.join(root, 'directory'));
    const read = vi.spyOn(fs, 'readFileSync');
    const stat = vi.spyOn(fs, 'statSync');
    for (const name of ['directory', 'missing.ts']) {
      expect(context.readFile(name)).toBeNull();
      expect(context.readFile(name)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
    expect(stat).toHaveBeenCalledTimes(2);
  });

  it('skips excluded HAR imports during indexing while preserving source workspace imports', async () => {
    const relative = sparseArchive();
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data/oh-package.json5'), JSON.stringify({ name: 'data', main: 'Index.ets' }));
    fs.writeFileSync(path.join(root, 'data/Index.ets'), 'export class Repository {}\n');
    fs.writeFileSync(path.join(root, 'oh-package.json5'), JSON.stringify({ dependencies: {
      archive: `file:./${relative}`, data: 'file:./data',
    } }));
    fs.writeFileSync(path.join(root, 'MainAbility.ets'),
      "import { RNAbility } from 'archive';\nimport { Repository } from 'data';\n" +
      'export class MainAbility extends RNAbility {}\nexport class Local extends Repository {}\n');
    const read = vi.spyOn(fs, 'readFileSync');
    const stat = vi.spyOn(fs, 'statSync');
    await cg.indexAll();
    const archive = path.join(root, relative);
    expect(stat.mock.calls.some(([file]) => String(file) === archive)).toBe(true);
    expect(read.mock.calls.some(([file]) => String(file) === archive)).toBe(false);
    const repository = cg.getNodesByKind('class').find(n => n.name === 'Repository');
    const local = cg.getNodesByKind('class').find(n => n.name === 'Local');
    expect(repository).toBeDefined();
    expect(local).toBeDefined();
    expect(cg.getOutgoingEdges(local!.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'extends', target: repository!.id }),
    ]));
  });
});
