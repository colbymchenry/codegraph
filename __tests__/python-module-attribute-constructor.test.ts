/**
 * A Python local built through a module attribute (`client = pkg.AsyncClient()`)
 * or bound by `with` (`async with pkg.AsyncClient() as client`) got no type, so
 * `client.fetch()` fell to the guess by the variable's name and linked the
 * class named like it, `Client`, not the `AsyncClient` the code built (#2957).
 *
 * The local now has the class it is built from, when that class is the
 * project's. Under `with`, it holds what `__enter__` (`__aenter__`) returns, so
 * it is typed only when that is `self`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const KERNEL = path.join(__dirname, '..', 'codegraph-kernel', 'prebuilds', `${process.platform}-${process.arch}`, 'codegraph-kernel.node');
const ARMS = [
  { arm: 'wasm', env: { CODEGRAPH_KERNEL: '0' } as Record<string, string> },
  ...(fs.existsSync(KERNEL) ? [{ arm: 'kernel', env: { CODEGRAPH_KERNEL_LANGS: 'python' } as Record<string, string> }] : []),
];

const CLIENT = [
  'class Client:',
  '    def fetch(self, url):',
  '        return url',
  '',
  '',
  'class AsyncClient:',
  '    async def fetch(self, url):',
  '        return url',
  '',
  '    async def __aenter__(self):',
  '        return self',
  '',
  '    async def __aexit__(self, *exc):',
  '        pass',
];

describe.each(ARMS)('a Python local built from a class ($arm)', ({ env }) => {
  let root: string;
  let cg: CodeGraph;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  const index = async (files: Record<string, string[]>, eol = '\n'): Promise<void> => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-ctor-'));
    for (const [file, lines] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), lines.join(eol) + eol);
    }
    cg = await CodeGraph.init(root, { index: true });
  };

  const fn = (qualified: string): Node => cg.getNodesByKind('function').find((n) => n.qualifiedName === qualified)!;
  // Methods only: building the client is an edge to the class.
  const callees = (qualified: string): string[] => cg.getCallees(fn(qualified).id)
    .filter((c) => c.node.kind === 'method').map((c) => c.node.qualifiedName).sort();

  const withPkg = (use: string[]): Record<string, string[]> => ({
    'pkg/__init__.py': ['from ._client import Client, AsyncClient'],
    'pkg/_client.py': CLIENT,
    'use.py': use,
  });

  it('types a local built through a module attribute', async () => {
    await index(withPkg([
      'import pkg',
      '',
      '',
      'async def run():',
      '    client = pkg.AsyncClient()',
      '    await client.fetch("u")',
    ]));
    expect(callees('run')).toEqual(['AsyncClient::fetch']);
  });

  it('types it whatever the local is called', async () => {
    await index(withPkg([
      'import pkg',
      '',
      '',
      'async def run():',
      '    c = pkg.AsyncClient(timeout=5)',
      '    await c.fetch("u")',
    ]));
    expect(callees('run')).toEqual(['AsyncClient::fetch']);
  });

  it('types a local bound by async with through a module', async () => {
    await index(withPkg([
      'import pkg',
      '',
      '',
      'async def run():',
      '    async with pkg.AsyncClient() as client:',
      '        await client.fetch("u")',
    ]));
    expect(callees('run')).toEqual(['AsyncClient::fetch']);
  });

  it('reads __aenter__ in a file with Windows line endings', async () => {
    await index(withPkg([
      'import pkg',
      '',
      '',
      'async def run():',
      '    async with pkg.AsyncClient() as client:',
      '        await client.fetch("u")',
    ]), '\r\n');
    expect(callees('run')).toEqual(['AsyncClient::fetch']);
  });

  it('types a local bound by async with a class imported by name', async () => {
    await index(withPkg([
      'from pkg import AsyncClient',
      '',
      '',
      'async def run():',
      '    async with AsyncClient(base="b") as client:',
      '        await client.fetch("u")',
    ]));
    expect(callees('run')).toEqual(['AsyncClient::fetch']);
  });

  it('types a local bound by with, one item of several, when __enter__ comes from a base', async () => {
    await index({
      'store.py': [
        'class Base:',
        '    def __enter__(self):',
        '        return self',
        '',
        '    def __exit__(self, *exc):',
        '        pass',
        '',
        '',
        'class Store(Base):',
        '    def save(self):',
        '        return 1',
        '',
        '',
        'class Storage:',
        '    def save(self):',
        '        return 2',
      ],
      'use.py': [
        'import store',
        '',
        '',
        'def run(path):',
        '    with open(path) as f, store.Store() as storage:',
        '        storage.save()',
      ],
    });
    expect(callees('run')).toEqual(['Store::save']);
  });

  it('does not type a local bound by with when __enter__ returns something else', async () => {
    await index({
      'db.py': [
        'class Connection:',
        '    def query(self):',
        '        return 1',
        '',
        '',
        'class Transaction:',
        '    def __enter__(self):',
        '        return Connection()',
        '',
        '    def __exit__(self, *exc):',
        '        pass',
        '',
        '    def query(self):',
        '        return 2',
      ],
      'use.py': [
        'import db',
        '',
        '',
        'def run():',
        '    with db.Transaction() as conn:',
        '        conn.query()',
      ],
    });
    expect(callees('run')).not.toContain('Transaction::query');
  });

  it('does not type a local built from a class of an outside module', async () => {
    await index({
      'session.py': [
        'class Session:',
        '    def close(self):',
        '        return 1',
      ],
      'use.py': [
        'import requests',
        '',
        '',
        'def run():',
        '    s = requests.Session()',
        '    s.close()',
      ],
    });
    expect(callees('run')).toEqual([]);
  });
});
