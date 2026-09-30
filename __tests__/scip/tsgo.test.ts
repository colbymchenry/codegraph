import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import { importScipFile, runScipPass } from '../../src/scip';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../../src/file-limits';
import { resolveIndexer } from '../../src/scip/indexers';
import { indexProjects } from '../../src/scip/indexers/tsgo-index';
import { findTsgo } from '../../src/scip/indexers/typescript';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scip-ts');
/** TypeScript ≥ 7.1 to index with: `CODEGRAPH_TSGO_DIR`, else wherever the adapter would find one. */
const TSGO = process.env.CODEGRAPH_TSGO_DIR ?? (() => {
  const found = findTsgo(path.join(__dirname, '..', '..'));
  return found && 'dir' in found ? found.dir : undefined;
})();

describe.runIf(TSGO)('tsgo indexer (TypeScript fixture)', () => {
  let dir: string;
  let cg: CodeGraph;
  const edge = (src: string, tgt: string) => cg.scipReadDb().prepare(`
    SELECT e.kind, e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE s.qualified_name = ? AND t.qualified_name = ?`).get(src, tgt) as { kind: string; line: number; provenance: string | null } | undefined;
  const index = async (configs = ['tsconfig.json']) => {
    const out = path.join(dir, 'tsgo.scip');
    const result = await indexProjects(TSGO!, out, dir, configs.map(c => path.join(dir, c)));
    importScipFile(dir, out); // language from the tool name
    const report = await cg.scipWrite(db => runScipPass(db, dir));
    return { ...result, report: report! };
  };

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tsgo-'));
    fs.cpSync(path.join(FIXTURE, 'project'), dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'union.ts'),
      'class A { run() {} }\nclass B { run() {} }\nexport function both(x: A | B) {\n  x.run();\n}\n');
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
  }, 30_000);

  afterEach(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the fixture like scip-typescript', async () => {
    await index();
    expect(edge('sum', 'helper')?.provenance).toBe('scip');
    expect(edge('make', 'Invoice')).toMatchObject({ kind: 'instantiates', provenance: 'scip' });
    expect(edge('Service::run', 'Service::step')?.provenance).toBe('scip');
    expect(edge('sum', 'Invoice::totalPrice')).toMatchObject({ provenance: 'scip', line: 6 }); // missed by the heuristic
    expect(edge('usesOverloads', 'Registry::lookup')?.provenance).toBe('scip'); // the first signature
  }, 30_000);

  it('a call on a union-typed receiver reaches every member', async () => {
    await index();
    expect(edge('both', 'A::run')?.provenance).toBe('scip');
    expect(edge('both', 'B::run')?.provenance).toBe('scip');
  }, 30_000);

  it('a call through a constant of callable type is judged against the constant node', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'consts.ts'), [
      'type Fn = (n: number) => number;',
      'function makeDoubler(): Fn { return n => n * 2; }',
      'export const twice: Fn = makeDoubler();',
      'export function useConst() {',
      '  return twice(2);',
      '}',
    ].join('\n'));
    await cg.indexAll();
    await index();
    expect(cg.scipReadDb().prepare(`SELECT kind FROM nodes WHERE name = 'twice'`).get()).toEqual({ kind: 'constant' });
    expect(edge('useConst', 'twice')?.provenance).toBe('scip');
  }, 30_000);

  it('a file over codegraph\'s size limit is skipped, not reported stale', async () => {
    fs.writeFileSync(path.join(dir, 'src', 'big.ts'), `export function big() { return 1; }\n// ${'x'.repeat(MAX_SOURCE_FILE_SIZE_BYTES)}\n`);
    await cg.indexAll();
    const { report } = await index();
    expect(report.staleDocuments).toEqual([]);
    expect(report.freshDocuments).toBe(3);
  }, 30_000);

  it('a file is indexed by the deepest project containing it, whose paths resolve its imports', async () => {
    // The root config claims everything (no `include`); only sub/'s config maps `@models`.
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"target":"es2020","module":"commonjs"}}');
    fs.mkdirSync(path.join(dir, 'sub'));
    fs.writeFileSync(path.join(dir, 'sub', 'tsconfig.json'),
      '{"compilerOptions":{"strict":true,"target":"es2020","module":"commonjs","paths":{"@models":["../src/models.ts"]}}}');
    fs.writeFileSync(path.join(dir, 'sub', 'use.ts'), "import { helper } from '@models';\nexport function viaAlias() {\n  helper();\n}\n");
    await cg.indexAll();
    await index(['tsconfig.json', 'sub/tsconfig.json']); // root first, as heaviest-first would order it
    expect(edge('viaAlias', 'helper')?.provenance).toBe('scip');
  }, 30_000);

  it('a project it cannot open is a warning; the others are indexed', async () => {
    const { warnings, documents } = await index(['tsconfig.json', 'missing/tsconfig.json']);
    expect(warnings).toEqual([expect.stringMatching(/^missing\/tsconfig\.json: can't open the project/)]);
    expect(documents).toBe(3);
  }, 30_000);
});

describe('typescript adapter: tsgo when installed', () => {
  let dir: string;
  const savedPrefix = process.env.NPM_CONFIG_PREFIX;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tsgo-adapter-'));
    process.env.NPM_CONFIG_PREFIX = path.join(dir, 'no-global'); // `npm root -g` → an empty prefix: only what the test installs counts
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.mkdirSync(path.join(dir, 'pkg'));
    fs.writeFileSync(path.join(dir, 'pkg', 'jsconfig.json'), '{}');
    const ts = path.join(dir, 'node_modules', 'typescript');
    fs.mkdirSync(path.join(ts, 'dist', 'api', 'sync'), { recursive: true });
    fs.writeFileSync(path.join(ts, 'package.json'), '{"version":"7.1.0"}');
    fs.writeFileSync(path.join(ts, 'dist', 'api', 'sync', 'api.js'), '');
  });
  afterEach(() => {
    if (savedPrefix === undefined) delete process.env.NPM_CONFIG_PREFIX;
    else process.env.NPM_CONFIG_PREFIX = savedPrefix;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const tsPackage = (json: string) => fs.writeFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), json);

  it('runs tsgo-index over every project in one process, unless the command is overridden', () => {
    const out = path.join(dir, 'out.tmp');
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    expect(r.cmd).toBe(process.execPath);
    expect(r.runs).toHaveLength(1);
    const [script, tsDir, output, root, ...configs] = r.runs[0]!.args;
    expect(path.basename(script!)).toBe('tsgo-index.js');
    expect([tsDir, output, root]).toEqual([path.join(dir, 'node_modules', 'typescript'), out, dir]);
    expect(configs.sort()).toEqual(['pkg/jsconfig.json', 'tsconfig.json']);

    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: process.execPath } } }));
    const scipTs = resolveIndexer(dir, 'typescript', out);
    if ('skip' in scipTs) throw new Error(scipTs.skip);
    expect(scipTs.runs[0]!.args[0]).toBe('index'); // scip-typescript's arguments
  });

  it('ignores a TypeScript older than 7.1', () => {
    tsPackage('{"version":"7.0.2"}');
    expect(findTsgo(dir)).toBeNull();
  });

  it.runIf(process.platform !== 'win32')('a TypeScript ≥ 7.1 that can\'t be used is a warning on the scip-typescript run', () => {
    tsPackage('{"name":"typescript"}'); // no version
    expect(findTsgo(dir)).toEqual({ unusable: expect.stringMatching(/package\.json has no version/) });
    tsPackage('{"version":"7.1.0"}');
    fs.rmSync(path.join(dir, 'node_modules', 'typescript', 'dist'), { recursive: true });
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'scip-typescript'), '#!/bin/sh\n', { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      const r = resolveIndexer(dir, 'typescript', path.join(dir, 'out.tmp'));
      if ('skip' in r) throw new Error(r.skip);
      expect(r.cmd).toBe('scip-typescript');
      expect(r.warning).toMatch(/TypeScript 7\.1\.0 at .* has no API .* — using scip-typescript/);
    } finally {
      process.env.PATH = savedPath;
    }
  });
});
