import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import type { ResolutionContext } from '../src/resolution/types';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';
import { cppNamespaceAliases, cppNamespaceAliasWalk } from '../src/resolution/cpp-namespaces';
import { cppTemplateArgumentEdges } from '../src/resolution/cpp-template-instantiations';

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
    const open = vi.spyOn(fs, 'openSync');
    expect(context.readFile(relative)).toBeNull();
    expect(context.readFile(relative)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(1);
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

  describe('a walk over every file', () => {
    function oversizeHeader(): string {
      const fd = fs.openSync(path.join(root, 'generated.h'), 'w');
      try {
        fs.writeSync(fd, 'template <typename T> struct Box {};\nBox<int> box;\n');
        fs.ftruncateSync(fd, MAX_SOURCE_FILE_SIZE_BYTES + 1);
      } finally {
        fs.closeSync(fd);
      }
      return 'generated.h';
    }

    it('reads a file past the content cache, byte for byte', () => {
      fs.writeFileSync(path.join(root, 'small.h'), 'int caf\u00e9;\n');
      expect(context.scanFile!('small.h')).toBe(Buffer.from('int caf\u00e9;\n').toString('latin1'));
      const read = vi.spyOn(fs, 'readFileSync');
      context.scanFile!('small.h');
      expect(read).toHaveBeenCalledTimes(1);
    });

    it('leaves an oversize header that names a template unread', () => {
      const header = oversizeHeader();
      const read = vi.spyOn(fs, 'readFileSync');
      expect(context.scanFile!(header)).toBeNull();
      expect(read).not.toHaveBeenCalled();
    });

    it('accepts exactly the byte limit and rejects one byte more', () => {
      fs.writeFileSync(path.join(root, 'boundary.h'), 'a'.repeat(MAX_SOURCE_FILE_SIZE_BYTES));
      expect(context.scanFile!('boundary.h')).toHaveLength(MAX_SOURCE_FILE_SIZE_BYTES);
      fs.appendFileSync(path.join(root, 'boundary.h'), 'a');
      expect(context.scanFile!('boundary.h')).toBeNull();
    });

    it('gives a namespace alias to every later lookup, read from its text alone', () => {
      fs.writeFileSync(path.join(root, 'a.h'), '// caf\u00e9\nnamespace al = one::two;\n');
      fs.writeFileSync(path.join(root, 'b.txt'), 'namespace not_a_header = one;\n');
      const walk = cppNamespaceAliasWalk(context)!;
      for (const file of ['a.h', 'b.txt']) walk.add(file, context.scanFile!(file)!);
      walk.finish();
      const read = vi.spyOn(fs, 'readFileSync');
      expect([...cppNamespaceAliases(context)]).toEqual([['al', 'one::two']]);
      expect(read).not.toHaveBeenCalled();
      expect(cppNamespaceAliasWalk(context)).toBeNull();
    });

    it('rejects a directory and a missing file', () => {
      fs.mkdirSync(path.join(root, 'directory'));
      expect(context.scanFile!('directory')).toBeNull();
      expect(context.scanFile!('missing.h')).toBeNull();
    });

    // mkfifo is POSIX-only.
    it.runIf(process.platform !== 'win32')('leaves a FIFO unread, with no writer to wait for', () => {
      execFileSync('mkfifo', [path.join(root, 'blocked.h')]);
      expect(context.scanFile!('blocked.h')).toBeNull();
    });

    it('keeps the pass from reading an oversize header, whatever it names', async () => {
      fs.writeFileSync(path.join(root, 'a.cc'), 'struct Foo { static void Go() {} };\nstruct Bar { static void Go() {} };\ntemplate <typename T> struct Box { void Run() { T::Go(); } };\nBox<Foo> box;\n');
      oversizeHeader();
      await cg.indexAll();
      expect(context.getAllFiles()).toContain('generated.h');
      resolver.clearCaches();
      const read = vi.spyOn(fs, 'readFileSync');
      const edges = await cppTemplateArgumentEdges(cg.queries, context, () => undefined);
      expect(edges.length).toBeGreaterThan(0);
      expect(read.mock.results.some((r) => typeof r.value === 'string' && r.value.length > MAX_SOURCE_FILE_SIZE_BYTES)).toBe(false);
    });
  });

  it('rejects directories before reading and caches missing files', () => {
    fs.mkdirSync(path.join(root, 'directory'));
    const read = vi.spyOn(fs, 'readFileSync');
    const open = vi.spyOn(fs, 'openSync');
    for (const name of ['directory', 'missing.ts']) {
      expect(context.readFile(name)).toBeNull();
      expect(context.readFile(name)).toBeNull();
    }
    expect(read).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledTimes(2);
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
    const open = vi.spyOn(fs, 'openSync');
    await cg.indexAll();
    const archive = path.join(root, relative);
    expect(open.mock.calls.some(([file]) => String(file) === archive)).toBe(true);
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
