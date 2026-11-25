/**
 * A Python local built from a class through its module — `client =
 * pkg.AsyncClient()` — or bound by `with … as client` / `async with … as
 * client` holds an instance of that class (#2957). Its method calls link the
 * class's methods, never those of a class named like the variable (`Client`).
 * A module path picks the class it names among namesakes; an outside module's
 * class, and a `with` whose `__enter__` hands out something else, type nothing.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string | undefined;
let cg: CodeGraph | null = null;

async function index(files: Record<string, string>): Promise<void> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2957-'));
  for (const [rel, source] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
}

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = undefined;
});

/** The methods a function calls, as `Class::method@file`. */
function methodCallees(fn: string): string[] {
  const from = cg!.getNodesByKind('function').find((n) => n.qualifiedName === fn);
  expect(from, `${fn} should be indexed`).toBeDefined();
  return cg!
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg!.getNode(e.target))
    .filter((n): n is NonNullable<typeof n> => !!n && n.kind === 'method')
    .map((n) => `${n.qualifiedName}@${n.filePath}`)
    .sort();
}

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
].join('\n');

const ENTERING = [
  'class Client:',
  '    def __enter__(self):',
  '        return self',
  '',
  '    def __exit__(self, *a):',
  '        return None',
  '',
  '    def fetch(self, url):',
  '        return url',
  '',
  '',
  'class AsyncClient:',
  '    async def __aenter__(self):',
  '        return self',
  '',
  '    async def __aexit__(self, *a):',
  '        return None',
  '',
  '    async def fetch(self, url):',
  '        return url',
  '',
].join('\n');

const USE = [
  'import pkg',
  'from pkg import AsyncClient',
  '',
  '',
  'async def attr_named_client():',
  '    client = pkg.AsyncClient()',
  '    await client.fetch("u")',
  '',
  '',
  'async def attr_named_c():',
  '    c = pkg.AsyncClient()',
  '    await c.fetch("u")',
  '',
  '',
  'async def from_named_client():',
  '    client = AsyncClient()',
  '    await client.fetch("u")',
  '',
  '',
  'async def with_named_client():',
  '    async with pkg.AsyncClient() as client:',
  '        await client.fetch("u")',
  '',
  '',
  'async def with_direct_named_client():',
  '    async with AsyncClient() as client:',
  '        await client.fetch("u")',
  '',
  '',
  'async def with_second_item():',
  '    async with pkg.AsyncClient() as first, pkg.AsyncClient() as client:',
  '        await client.fetch("u")',
  '',
].join('\n');

const FNS = ['attr_named_client', 'attr_named_c', 'from_named_client', 'with_named_client', 'with_direct_named_client', 'with_second_item'];

describe('a Python local of a class built through its module or bound by with (#2957)', () => {
  it("the issue's repro: every form reaches AsyncClient.fetch, none Client.fetch", async () => {
    await index({ 'pkg/_client.py': CLIENT, 'pkg/__init__.py': 'from ._client import Client, AsyncClient\n', 'use.py': USE });
    for (const fn of FNS) expect(methodCallees(fn), fn).toEqual(['AsyncClient::fetch@pkg/_client.py']);
  });

  it('and so with a class whose __aenter__ returns itself, as httpx writes it', async () => {
    await index({ 'pkg/_client.py': ENTERING, 'pkg/__init__.py': 'from ._client import Client, AsyncClient\n', 'use.py': USE });
    for (const fn of FNS) expect(methodCallees(fn), fn).toEqual(['AsyncClient::fetch@pkg/_client.py']);
  });

  it('reads that __aenter__ in a file with Windows line endings', async () => {
    await index({
      'pkg/_client.py': ENTERING.replace(/\n/g, '\r\n'),
      'pkg/__init__.py': 'from ._client import Client, AsyncClient\r\n',
      'use.py': USE.replace(/\n/g, '\r\n'),
    });
    for (const fn of FNS) expect(methodCallees(fn), fn).toEqual(['AsyncClient::fetch@pkg/_client.py']);
  });

  it('takes the class the module path names among namesakes', async () => {
    await index({
      'pkg/__init__.py': '',
      'pkg/a.py': 'class Runner:\n    def run(self):\n        return 1\n',
      'pkg/b.py': 'class Runner:\n    def run(self):\n        return 2\n',
      'use.py': 'import pkg.b\n\n\ndef go():\n    r = pkg.b.Runner()\n    return r.run()\n',
    });
    expect(methodCallees('go')).toEqual(['Runner::run@pkg/b.py']);
  });

  it('does not type a with target by a class whose __enter__ hands out something else', async () => {
    await index({
      'db.py': [
        'class Conn:',
        '    def execute(self):',
        '        return 1',
        '',
        '',
        'class Pool:',
        '    def __enter__(self):',
        '        return Conn()',
        '',
        '    def __exit__(self, *a):',
        '        return None',
        '',
        '    def execute(self):',
        '        return 2',
        '',
        '',
        'def use():',
        '    with Pool() as conn:',
        '        return conn.execute()',
        '',
      ].join('\n'),
    });
    expect(methodCallees('use')).not.toContain('Pool::execute@db.py');
  });

  it("does not type a local by a project class sharing an outside module's class name", async () => {
    await index({
      'session.py': 'class Session:\n    def get(self, url):\n        return url\n',
      'use.py': 'import requests\n\n\ndef go():\n    s = requests.Session()\n    return s.get("u")\n',
    });
    expect(methodCallees('go')).toEqual([]);
  });
});
