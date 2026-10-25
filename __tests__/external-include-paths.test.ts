/**
 * External include paths (`codegraph.json` `includePaths`, issue #499).
 *
 * A project can index, sync, and search directories OUTSIDE its root — the
 * multi-repo / microservice case where an agent working in project A must see
 * sibling projects B and C without indexing a shared parent.
 *
 * Three layers under test:
 *   1. Config: parse/validate `includePaths`, and the `addIncludePaths` writer
 *      the CLI's `init --include` uses to persist paths to `codegraph.json`.
 *   2. Resolution: relative entries resolve against the project root; mounts
 *      get unique slugs; virtual ↔ real path translation (index reads and
 *      content serving) maps only to the configured mounts.
 *   3. Behavior: `scanDirectory` includes external source as virtual paths, a
 *      full index stores them, queries find their symbols, content serving
 *      reads their bodies, and a `sync` reconciles adds/removals in them.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import {
  loadIncludePaths,
  addIncludePaths,
  clearProjectConfigCache,
} from '../src/project-config';
import {
  loadExternalMounts,
  externalToVirtual,
  resolveExternalVirtual,
  resolveIndexReadPath,
  resolveServablePath,
  EXTERNAL_PREFIX,
} from '../src/external-paths';
import { scanDirectory, scanDirectoryAsync } from '../src/extraction';

describe('includePaths loader (codegraph.json)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify(obj));

  it('returns an empty list by default', () => {
    expect(loadIncludePaths(dir)).toEqual([]);
  });

  it('loads a well-formed array, relative entries kept verbatim', () => {
    writeConfig({ includePaths: ['../project-B/src', '/abs/path/c'] });
    expect(loadIncludePaths(dir)).toEqual(['../project-B/src', '/abs/path/c']);
  });

  it('trims whitespace and drops blank / non-string entries', () => {
    writeConfig({ includePaths: ['  ../B  ', '', '   ', 42, null, '../C'] });
    expect(loadIncludePaths(dir)).toEqual(['../B', '../C']);
  });

  it('ignores a non-array value without throwing', () => {
    writeConfig({ includePaths: '../B' });
    expect(loadIncludePaths(dir)).toEqual([]);
  });

  it('ignores malformed JSON without throwing', () => {
    writeConfig('{ not: valid json ');
    expect(loadIncludePaths(dir)).toEqual([]);
  });

  it('coexists with other config keys in one file', () => {
    writeConfig({ extensions: { '.foo': 'typescript' }, include: ['Tools/'], includePaths: ['../B'] });
    expect(loadIncludePaths(dir)).toEqual(['../B']);
  });
});

describe('addIncludePaths writer (CLI init --include persistence)', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-w-'));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates codegraph.json and writes the list', () => {
    const added = addIncludePaths(dir, ['../B']);
    expect(added).toBe(1);
    expect(loadIncludePaths(dir)).toEqual(['../B']);
  });

  it('is idempotent and preserves other keys', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ extensions: { '.x': 'rust' } }));
    expect(addIncludePaths(dir, ['../B', '../B', '../C'])).toBe(2);
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'codegraph.json'), 'utf-8'));
    expect(parsed.extensions).toEqual({ '.x': 'rust' });
    expect(parsed.includePaths).toEqual(['../B', '../C']);
    // Re-run adds nothing new.
    expect(addIncludePaths(dir, ['../B'])).toBe(0);
  });

  it('throws on an unparseable existing config', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), '{ nope ');
    expect(() => addIncludePaths(dir, ['../B'])).toThrow();
  });
});

describe('external mount resolution', () => {
  let dir: string;
  let sibling: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-r-'));
    sibling = path.join(path.dirname(dir), 'sibling-b');
    fs.mkdirSync(path.join(sibling, 'src'), { recursive: true });
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('resolves a relative entry against the project root', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ includePaths: ['../sibling-b'] }));
    const mounts = loadExternalMounts(dir);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.abs).toBe(path.resolve(dir, '../sibling-b'));
    expect(mounts[0]!.slug).toBe('sibling-b');
  });

  it('dedupes the same resolved directory and gives unique slugs', () => {
    fs.writeFileSync(
      path.join(dir, 'codegraph.json'),
      JSON.stringify({ includePaths: ['../sibling-b', path.relative(dir, sibling), '../sibling-b'] })
    );
    const mounts = loadExternalMounts(dir);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]!.slug).toBe('sibling-b');
  });

  it('maps virtual ↔ real only for the configured mount', () => {
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ includePaths: ['../sibling-b'] }));
    const [mount] = loadExternalMounts(dir);
    const virtual = externalToVirtual(mount!, 'src/util.ts');
    expect(virtual).toBe(`${EXTERNAL_PREFIX}/sibling-b/src/util.ts`);
    expect(resolveExternalVirtual(dir, virtual)).toEqual({ mount: mount!, rel: 'src/util.ts' });
    expect(resolveExternalVirtual(dir, `${EXTERNAL_PREFIX}/unknown/x.ts`)).toBeNull();

    // The real file exists → both read + serve paths resolve.
    fs.writeFileSync(path.join(sibling, 'src', 'util.ts'), 'export const helper = 1;\n');
    expect(resolveIndexReadPath(dir, virtual)).toBe(path.join(sibling, 'src', 'util.ts'));
    expect(resolveServablePath(dir, virtual)).toBe(fs.realpathSync(path.join(sibling, 'src', 'util.ts')));
    // A path that does not exist on disk must not be servable.
    expect(resolveServablePath(dir, externalToVirtual(mount!, 'missing.ts'))).toBeNull();
    // A real in-root file still resolves through the normal path.
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    expect(resolveServablePath(dir, 'src/a.ts')).toBe(fs.realpathSync(path.join(dir, 'src', 'a.ts')));
  });
});

describe('external path containment (security, #527)', () => {
  let dir: string;
  let sibling: string;
  let secret: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-sec-'));
    // sibling lives next to the root, so `../sibling` is the mount.
    sibling = path.join(path.dirname(dir), 'sibling-sec');
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'file.ts'), 'export const inMount = 1;\n');
    // A file just OUTSIDE the mount but inside the parent — the target of a
    // crafted `../` escape or a symlink escape from inside the mount.
    secret = path.join(path.dirname(dir), 'secret.txt');
    fs.writeFileSync(secret, 'top secret\n');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ includePaths: ['../sibling-sec'] }));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
    fs.rmSync(secret, { force: true });
  });

  const mountRel = (rel: string) => `${EXTERNAL_PREFIX}/sibling-sec/${rel}`;

  it('serve blocks `../` traversal out of the mount', () => {
    expect(resolveServablePath(dir, mountRel('../secret.txt'))).toBeNull();
    expect(resolveServablePath(dir, mountRel('sub/../../secret.txt'))).toBeNull();
  });

  it('index-read blocks `../` traversal out of the mount', () => {
    expect(resolveIndexReadPath(dir, mountRel('../secret.txt'))).toBeNull();
    expect(resolveIndexReadPath(dir, mountRel('sub/../../secret.txt'))).toBeNull();
  });

  it('serve blocks a symlink inside the mount that points outside', () => {
    fs.symlinkSync(secret, path.join(sibling, 'link.txt'));
    expect(resolveServablePath(dir, mountRel('link.txt'))).toBeNull();
  });

  it('normal in-mount files still read through both paths', () => {
    const real = fs.realpathSync(path.join(sibling, 'file.ts'));
    expect(resolveServablePath(dir, mountRel('file.ts'))).toBe(real);
    expect(resolveIndexReadPath(dir, mountRel('file.ts'))).toBe(path.join(sibling, 'file.ts'));
  });
});

describe('scanDirectory includes external source as virtual paths', () => {
  let dir: string;
  let sibling: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-s-'));
    sibling = path.join(path.dirname(dir), 'svc-c');
    fs.mkdirSync(path.join(sibling, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sibling, 'src', 'helper.ts'), 'export const helper = 1;\n');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ includePaths: ['../svc-c'] }));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('scanDirectory (sync) lists the external file under its virtual path', () => {
    const files = scanDirectory(dir);
    expect(files).toContain('src/a.ts');
    expect(files).toContain(`${EXTERNAL_PREFIX}/svc-c/src/helper.ts`);
  });

  it('scanDirectoryAsync (async) lists it too', async () => {
    const files = await scanDirectoryAsync(dir);
    expect(files).toContain(`${EXTERNAL_PREFIX}/svc-c/src/helper.ts`);
  });
});

describe('end-to-end: index, query, serve, sync', () => {
  let root: string;
  let sibling: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-extinc-e2e-'));
    sibling = path.join(path.dirname(root), 'svc-d');
    fs.mkdirSync(path.join(sibling, 'src'), { recursive: true });
    fs.writeFileSync(path.join(sibling, 'src', 'helper.ts'), 'export function helper(): number { return 42; }\n');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'import { helper } from "__unresolved__";\nexport function main() { return helper(); }\n');
    fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify({ includePaths: ['../svc-d'] }));
    clearProjectConfigCache();
    cg = await CodeGraph.init(root, { index: true });
  });

  afterEach(() => {
    cg?.close();
    clearProjectConfigCache();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(sibling, { recursive: true, force: true });
  });

  it('indexes external symbols and serves their code', async () => {
    const nodes = cg.getNodesByName('helper');
    expect(nodes.length).toBeGreaterThan(0);
    const node = nodes.find((n) => n.kind === 'function' || n.kind === 'method') ?? nodes[0]!;
    // The stored path is virtual and inside the reserved prefix.
    expect(node.filePath.startsWith(`${EXTERNAL_PREFIX}/svc-d/`)).toBe(true);
    const code = await cg.getCode(node.id);
    expect(code).toContain('return 42');
  });

  it('sync picks up a new external file and reconciles a removal', async () => {
    // Add a file in the external sibling.
    fs.writeFileSync(path.join(sibling, 'src', 'extra.ts'), 'export function extra() { return 1; }\n');
    await cg.sync();
    expect(cg.getNodesInFile(`${EXTERNAL_PREFIX}/svc-d/src/extra.ts`).length).toBeGreaterThan(0);
    expect(cg.getNodesByName('extra').length).toBeGreaterThan(0);

    // Remove it; sync should drop it from the index.
    fs.rmSync(path.join(sibling, 'src', 'extra.ts'));
    await cg.sync();
    expect(cg.getNodesInFile(`${EXTERNAL_PREFIX}/svc-d/src/extra.ts`)).toEqual([]);
  });
});
