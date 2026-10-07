import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { INDEXERS, resolveIndexer } from '../../src/scip/indexers';
import { findVenv, projectName, pythonIndexer, venvPackages } from '../../src/scip/indexers/python';
import { findTsgo, planRuns, projectWeights, toolsDir, tsProjects } from '../../src/scip/indexers/typescript';

/** How each language's indexer is found and run: the commands, the runs a repo splits into, and the runs a patch takes. */

describe('go, rust and scip-typescript adapters', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-adapters-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('detect by go.mod / Cargo.toml and build the documented commands', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { go: { cmd: process.execPath }, rust: { cmd: process.execPath } } }));
    expect(resolveIndexer(dir, 'go', out)).toEqual({ skip: 'no go project markers found' });
    fs.writeFileSync(path.join(dir, 'go.mod'), 'module x\n');
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    expect(resolveIndexer(dir, 'go', out)).toMatchObject({ runs: [{ args: ['index', '--quiet', '--output', out], output: out, cwd: '.' }] });
    expect(resolveIndexer(dir, 'rust', out)).toMatchObject({ runs: [{ args: ['scip', '.', '--output', out], output: out, cwd: '.' }] });
  });

  it('finds go modules and cargo workspaces below the root: one run each, in its folder', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { go: { cmd: process.execPath }, rust: { cmd: process.execPath } } }));
    const put = (f: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), text); };
    put('svc/go.mod', 'module svc\n');
    put('tools/gen/go.mod', 'module gen\n');
    put('svc/testdata/mod/go.mod', 'module fixture\n'); // test input, not a module to index
    put('cli/Cargo.toml', '[workspace]\n');
    put('cli/crates/a/Cargo.toml', '[package]\nname = "a"\n'); // a member: indexed with its workspace
    put('kernel/Cargo.toml', '[package]\nname = "k"\n');
    const plan = (lang: 'go' | 'rust') => {
      const r = resolveIndexer(dir, lang, out);
      if ('skip' in r) throw new Error(r.skip);
      return r.runs.map(x => [x.cwd, x.output]);
    };
    expect(plan('go')).toEqual([['svc', `${out}.part0`], ['tools/gen', `${out}.part1`]]);
    expect(plan('rust')).toEqual([['cli', `${out}.part0`], ['kernel', `${out}.part1`]]);
  });

  it('go patches by package: each changed file\'s package, in its module\'s run', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { go: { cmd: process.execPath } } }));
    for (const f of ['go.mod', 'tools/gen/go.mod']) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'module x\n');
    }
    const r = resolveIndexer(dir, 'go', out);
    if ('skip' in r) throw new Error(r.skip);
    const units = INDEXERS.go.patch!['scip-go']!.units(dir, ['main.go', 'pkg/a/a.go', 'pkg/a/b.go', 'tools/gen/gen.go', 'tools/gen/sub/x.go']);
    expect(units).toEqual(['.', 'pkg/a', 'tools/gen', 'tools/gen/sub']);
    const runs = INDEXERS.go.patch!['scip-go']!.runs(r.runs, units, out)!;
    expect(runs.map(x => [x.cwd, x.args.slice(4)])).toEqual([['.', ['.', './pkg/a']], ['tools/gen', ['.', './sub']]]);
  });

  it('TS: one run per tsconfig/jsconfig project (node_modules ignored), a single project stays one run', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: process.execPath } } }));
    expect(resolveIndexer(dir, 'typescript', out)).toMatchObject({ runs: [{ label: 'typescript', output: out }] });

    for (const p of ['src', 'extensions/git', 'extensions/web', 'node_modules/dep']) fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/git/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/web/jsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'node_modules/dep/tsconfig.json'), '{}');
    expect(tsProjects(dir)).toEqual(['.', 'extensions/git', 'extensions/web', 'src']);
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    // All light: tsconfig projects share one batch (retried one by one if it fails); jsconfig ones infer theirs.
    expect(r.runs.map(x => x.args.slice(3))).toEqual([['.', 'extensions/git', 'src'], ['extensions/web', '--infer-tsconfig']]);
    expect(r.runs[0]!.fallback?.map(f => f.label)).toEqual(['.', 'extensions/git', 'src']);
    expect(r.runs.every(x => x.light && /--max-old-space-size=\d+/.test(x.env?.NODE_OPTIONS ?? ''))).toBe(true);
  });

  it('TS (scip-typescript) patches by project: the changed files\' deepest projects, overrides kept', () => {
    const out = path.join(dir, 'out.tmp');
    fs.writeFileSync(path.join(dir, 'package.json'), '{}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{}');
    for (const p of ['src', 'extensions/git', 'extensions/web']) fs.mkdirSync(path.join(dir, p), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/git/tsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'extensions/web/jsconfig.json'), '{}');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: 'npx', args: ['-y', 'scip-ts', '{args}'] } } }));
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    expect(r.tool).toBe('scip-typescript');
    const spec = INDEXERS.typescript.patch!['scip-typescript']!;
    const units = spec.units(dir, ['extensions/git/a.ts', 'extensions/git/b/c.ts', 'tools/x.ts']);
    expect(units).toEqual(['extensions/git', '.']);
    const runs = spec.runs(r.runs, ['extensions/git'], out)!;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.args).toEqual(['-y', 'scip-ts', 'index', '--output', `${out}.part0`, 'extensions/git']);
    expect(runs[0]!.output).toBe(`${out}.part0`);
  });

  it('TS: heavy projects run alone with the big heap, light ones are batched by size', () => {
    const projects = ['core', 'a', 'b', 'c'];
    const weights = new Map([['core', 5000], ['a', 900], ['b', 900], ['c', 10]]);
    for (const p of projects) fs.mkdirSync(path.join(dir, p));
    for (const p of projects) fs.writeFileSync(path.join(dir, p, 'tsconfig.json'), '{}');
    const runs = planRuns(dir, projects, weights, path.join(dir, 'out'));
    expect(runs.map(r => [r.args.slice(3), !!r.light])).toEqual([
      [['core'], false], // heavy first, alone
      [['a'], true], // a + b would pass 1,500 files
      [['b', 'c'], true],
    ]);
    const heap = (r: typeof runs[number]) => Number(/--max-old-space-size=(\d+)/.exec(r.env?.NODE_OPTIONS ?? '')?.[1]);
    if (!process.env.NODE_OPTIONS?.includes('--max-old-space-size')) expect(heap(runs[0]!)).toBeGreaterThanOrEqual(heap(runs[1]!));
    expect(projectWeights(['.', 'src', 'src/sub'], ['a.ts', 'src/x.ts', 'src/sub/y.ts', 'src/sub/z.js', 'README.md']))
      .toEqual(new Map([['.', 1], ['src', 1], ['src/sub', 2]])); // each file counted for its deepest project
  });

  it.runIf(process.platform !== 'win32')('skips a rust-analyzer that is on PATH but broken (the rustup shim without the component)', () => {
    fs.writeFileSync(path.join(dir, 'Cargo.toml'), '[package]\nname = "x"\n');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'rust-analyzer'), "#!/bin/sh\necho \"error: Unknown binary 'rust-analyzer'\" >&2\nexit 1\n", { mode: 0o755 });
    const savedPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
      expect(resolveIndexer(dir, 'rust', path.join(dir, 'out.tmp'))).toEqual({
        skip: expect.stringMatching(/rust-analyzer --version` failed \(error: Unknown binary/),
      });
    } finally {
      process.env.PATH = savedPath;
    }
  });
});

describe('typescript adapter: tsgo when installed', () => {
  let dir: string;
  const savedPrefix = process.env.NPM_CONFIG_PREFIX;
  const savedInstallDir = process.env.CODEGRAPH_INSTALL_DIR;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-tsgo-adapter-'));
    process.env.NPM_CONFIG_PREFIX = path.join(dir, 'no-global'); // `npm root -g` → an empty prefix: only what the test installs counts
    process.env.CODEGRAPH_INSTALL_DIR = path.join(dir, 'codegraph-home'); // likewise for codegraph's tools folder
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
    if (savedInstallDir === undefined) delete process.env.CODEGRAPH_INSTALL_DIR;
    else process.env.CODEGRAPH_INSTALL_DIR = savedInstallDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const tsPackage = (json: string) => fs.writeFileSync(path.join(dir, 'node_modules', 'typescript', 'package.json'), json);

  it('runs tsgo-index over every project in one process, unless the command is overridden', () => {
    const out = path.join(dir, 'out.tmp');
    const r = resolveIndexer(dir, 'typescript', out);
    if ('skip' in r) throw new Error(r.skip);
    expect(r.cmd).toBe(process.execPath);
    expect(r.runs).toHaveLength(1);
    const [script, tsDir, output, root, refsFlag, refs, ...configs] = r.runs[0]!.args;
    expect(path.basename(script!)).toBe('tsgo-index.js');
    expect([tsDir, output, root]).toEqual([path.join(dir, 'node_modules', 'typescript'), out, dir]);
    expect([refsFlag, refs]).toEqual(['--refs', `${out}.refs`]); // written by produce.ts
    expect(configs.sort()).toEqual(['pkg/jsconfig.json', 'tsconfig.json']);

    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: process.execPath } } }));
    const scipTs = resolveIndexer(dir, 'typescript', out);
    if ('skip' in scipTs) throw new Error(scipTs.skip);
    expect(scipTs.runs[0]!.args[0]).toBe('index'); // scip-typescript's arguments
  });

  it('warns when a lockfile has no node_modules beside it, with the command that installs it', () => {
    const warning = () => {
      const r = resolveIndexer(dir, 'typescript', path.join(dir, 'out.tmp'));
      if ('skip' in r) throw new Error(r.skip);
      return r.warning;
    };
    fs.writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(warning()).toBeUndefined(); // installed
    fs.renameSync(path.join(dir, 'node_modules'), path.join(dir, 'moved'));
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({ scip: { typescript: { cmd: process.execPath } } })); // scip-typescript's path
    expect(warning()).toMatch(/pnpm-lock\.yaml but no node_modules — .* run `pnpm install` and reindex/);
  });

  it('finds TypeScript in codegraph\'s tools folder when the project has none', () => {
    const tools = path.join(toolsDir(), 'node_modules', 'typescript');
    fs.renameSync(path.join(dir, 'node_modules', 'typescript'), path.join(dir, 'moved'));
    expect(findTsgo(dir)).toBeNull();
    fs.mkdirSync(path.dirname(tools), { recursive: true });
    fs.renameSync(path.join(dir, 'moved'), tools);
    expect(findTsgo(dir)).toEqual({ dir: tools });
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

describe('scip-python adapter', () => {
  let dir: string;
  const activeVenv = process.env.VIRTUAL_ENV;
  beforeEach(() => {
    delete process.env.VIRTUAL_ENV; // the runner's own venv must not leak into "no venv"
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-pyadapter-'));
    fs.mkdirSync(path.join(dir, '.codegraph', 'scip'), { recursive: true });
  });
  afterEach(() => {
    if (activeVenv !== undefined) process.env.VIRTUAL_ENV = activeVenv;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('falls back to the active $VIRTUAL_ENV', () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-venv-'));
    try {
      fs.writeFileSync(path.join(elsewhere, 'pyvenv.cfg'), 'home = /usr/bin\n');
      process.env.VIRTUAL_ENV = elsewhere;
      expect(findVenv(dir)).toBe(elsewhere);
    } finally {
      fs.rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  const makeVenv = () => {
    const venv = path.join(dir, '.venv');
    const info = path.join(venv, 'lib', 'python3.12', 'site-packages', 'foo-1.2.dist-info');
    fs.mkdirSync(info, { recursive: true });
    fs.writeFileSync(path.join(venv, 'pyvenv.cfg'), 'home = /usr/bin\n');
    fs.writeFileSync(path.join(info, 'METADATA'), 'Metadata-Version: 2.1\nName: foo\nVersion: 1.2\n\nbody\n');
    fs.writeFileSync(path.join(info, 'RECORD'), [
      'foo/__init__.py,sha256=x,10', 'foo/types.pyi,,', 'foo/__pycache__/x.cpython-312.pyc,,',
      '../../bin/foo,,', 'foo/data.txt,,', 'foo-1.2.dist-info/RECORD,,',
    ].join('\n'));
    return venv;
  };

  it('builds the environment manifest from dist-info records, no pip needed', () => {
    expect(venvPackages(makeVenv())).toEqual([{ name: 'foo', version: '1.2', files: ['foo/__init__.py', 'foo/types.pyi'] }]);
  });

  it('activates the venv and writes its manifest; warns without one', () => {
    const out = path.join(dir, '.codegraph', 'scip', 'python.scip.tmp');
    const manifest = path.join(dir, '.codegraph', 'scip', 'python-environment.json');

    const bare = pythonIndexer.invocation(dir, out);
    expect(bare.warning).toMatch(/third-party/);
    expect(bare.warning).not.toMatch(/run `/); // nothing says how this project builds its venv
    fs.writeFileSync(path.join(dir, 'uv.lock'), '');
    expect(pythonIndexer.invocation(dir, out).warning).toMatch(/uv\.lock found: run `uv sync` and reindex$/);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))).toEqual([]);
    expect(bare.runs).toHaveLength(1);
    expect(bare.runs[0]!.args).toEqual(expect.arrayContaining(['--environment', manifest, '--output', out]));

    const venv = makeVenv();
    const inv = pythonIndexer.invocation(dir, out);
    expect(inv.warning).toBeUndefined();
    expect(inv.env?.VIRTUAL_ENV).toBe(venv);
    expect(inv.env?.PATH?.startsWith(path.join(venv, process.platform === 'win32' ? 'Scripts' : 'bin'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(manifest, 'utf8'))[0].name).toBe('foo');
  });

  it('names the project from pyproject, poetry, setup.cfg, or the directory', () => {
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[build-system]\nname = "nope"\n\n[project]\nname = "real-name"\n');
    expect(projectName(dir)).toBe('real-name');
    fs.writeFileSync(path.join(dir, 'pyproject.toml'), '[tool.poetry]\nname = \'poetic\'\n');
    expect(projectName(dir)).toBe('poetic');
    fs.rmSync(path.join(dir, 'pyproject.toml'));
    fs.writeFileSync(path.join(dir, 'setup.cfg'), '[metadata]\nname = cfgname\n');
    expect(projectName(dir)).toBe('cfgname');
    fs.rmSync(path.join(dir, 'setup.cfg'));
    expect(projectName(dir)).toBe(path.basename(dir));
  });

  it('an `{args}` override element splices in the adapter arguments', () => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({
      scip: { python: { cmd: process.execPath, args: ['-y', '@sourcegraph/scip-python', '{args}'] } },
    }));
    const r = resolveIndexer(dir, 'python', path.join(dir, '.codegraph', 'scip', 'out.tmp'));
    expect('skip' in r ? r.skip : r.runs[0]!.args.slice(0, 4)).toEqual(['-y', '@sourcegraph/scip-python', 'index', '.']);
  });

  it('patches changed files with one --target-only run per directory, overrides kept', () => {
    fs.writeFileSync(path.join(dir, 'requirements.txt'), '');
    fs.writeFileSync(path.join(dir, 'codegraph.json'), JSON.stringify({
      scip: { python: { cmd: process.execPath, args: ['-y', '@sourcegraph/scip-python', '{args}'] } },
    }));
    const out = path.join(dir, '.codegraph', 'scip', 'out.tmp');
    const r = resolveIndexer(dir, 'python', out);
    if ('skip' in r) throw new Error(r.skip);
    const units = pythonIndexer.patch!['scip-python']!.units(dir, ['pkg/a.py', 'pkg/b.py', 'tests/test_a.py']);
    expect(units).toEqual(['pkg', 'tests']);
    const runs = pythonIndexer.patch!['scip-python']!.runs(r.runs, units, out)!;
    expect(runs.map(x => x.args.slice(-2))).toEqual([['--target-only', 'pkg'], ['--target-only', 'tests']]); // a file target omits itself
    expect(runs.map(x => x.args[x.args.indexOf('--output') + 1])).toEqual([`${out}.part0`, `${out}.part1`]);
    expect(runs.every(x => x.light && x.args[0] === '-y')).toBe(true);
  });
});
