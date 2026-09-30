import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../../src/index';
import { importScipFile, runScipPass } from '../../src/scip';
import { resolveIndexer } from '../../src/scip/indexers';
import { findVenv, projectName, pythonIndexer, venvPackages } from '../../src/scip/indexers/python';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scip-py');

describe('SCIP merge (Python fixture)', () => {
  let dir: string;
  let cg: CodeGraph;

  const edge = (src: string, tgt: string) => cg.scipReadDb().prepare(`
    SELECT e.kind, e.line, e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind IN ('calls', 'instantiates') AND s.qualified_name = ? AND t.qualified_name = ?`).get(src, tgt) as
    { kind: string; line: number; provenance: string | null } | undefined;
  const nodeId = (qn: string) => (cg.scipReadDb().prepare('SELECT id FROM nodes WHERE qualified_name = ?').get(qn) as { id: string }).id;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-py-'));
    fs.cpSync(path.join(FIXTURE, 'project'), dir, { recursive: true });
    cg = await CodeGraph.init(dir);
    await cg.indexAll();
    const built = path.join(dir, 'built.scip'); // "built" after the sources were copied in
    fs.copyFileSync(path.join(FIXTURE, 'index.scip'), built);
    importScipFile(dir, built);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('verifies `Foo()` as instantiates and adds calls the heuristic missed', async () => {
    const before = edge('total', 'Invoice::total_price');
    expect(before).toBeUndefined(); // call inside a generator expression
    await cg.scipWrite(db => runScipPass(db, dir));
    expect(edge('make', 'Invoice')).toEqual({ kind: 'instantiates', line: 11, provenance: 'scip' });
    expect(edge('total', 'Invoice::total_price')?.provenance).toBe('scip');
    expect(edge('Service::run', 'Child::step')?.provenance).toBe('scip'); // Child().step()
    expect(edge('Child::step', 'Base::step')?.provenance).toBe('scip'); // super().step()
    expect(cg.scipReadDb().prepare(`SELECT e.provenance FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'extends' AND s.qualified_name = 'Child' AND t.qualified_name = 'Base'`).all())
      .toEqual([{ provenance: 'scip' }]); // class Child(Base): verified from SCIP relationships
    expect(edge('Service::run', 'Service::step')?.provenance).toBe('scip'); // self.step(), same line, same name
  });

  it('keys calls by the caller codegraph names: decorators → class, nested class body → that class', async () => {
    await cg.scipWrite(db => runScipPass(db, dir));
    // SCIP's range for `build` includes its decorator; codegraph's node starts at `def`.
    expect(edge('Registry', 'register')).toEqual({ kind: 'calls', line: 34, provenance: 'scip' });
    expect(edge('Registry::build', 'register')).toBeUndefined();
    expect(edge('Registry::nested::Local', 'helper')?.provenance).toBe('scip');
    expect(edge('Registry::nested', 'helper')).toBeUndefined();
  });

  it('drops a heuristic guess where the call resolved to the standard library', async () => {
    // `items.append(1)` is list.append — the POC's classic false edge (ListMixin.append on Django).
    cg.scipReadDb().prepare(`INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, 'calls', 6, 4)`)
      .run(nodeId('total'), nodeId('Stack::append'));
    await cg.scipWrite(db => runScipPass(db, dir));
    expect(edge('total', 'Stack::append')).toBeUndefined();
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
});
