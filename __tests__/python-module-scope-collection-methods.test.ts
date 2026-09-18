import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const collections = [
  { name: 'dict_literal', value: '{"answer": "42"}', method: 'get' },
  { name: 'empty_dict', value: '{}', method: 'get' },
  { name: 'dict_constructor', value: 'dict()', method: 'get' },
  { name: 'list_literal', value: '[1]', method: 'append' },
  { name: 'empty_list', value: '[]', method: 'append' },
  { name: 'list_constructor', value: 'list()', method: 'append' },
  { name: 'set_literal', value: '{1}', method: 'add' },
  { name: 'set_constructor', value: 'set()', method: 'add' },
  { name: 'tuple_literal', value: '(1,)', method: 'index' },
  { name: 'empty_tuple', value: '()', method: 'index' },
  { name: 'tuple_constructor', value: 'tuple()', method: 'index' },
  { name: 'frozenset_constructor', value: 'frozenset()', method: 'union' },
];

let dir: string;
let cg: CodeGraph;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-1652-'));
  fs.writeFileSync(path.join(dir, 'settings.py'), `DEFAULTS = {"answer": "42"}

def read_setting(name):
    return DEFAULTS.get(name, None)
`);
  fs.writeFileSync(path.join(dir, 'cache.py'), `class LRUCache:
    def __init__(self):
        self._store = {}

    def get(self, key):
        return self._store.get(key)

class ProjectCollection:
    def append(self, item):
        pass
    def add(self, item):
        pass
    def index(self, item):
        return 0
    def union(self, item):
        return self
`);
  for (const { name, value, method } of collections) {
    // Capitalizing lRUCache matches a real class. Its name must not override
    // the same-file binding's collection initializer (#1652).
    fs.writeFileSync(path.join(dir, `${name}.py`), `lRUCache = ${value}

def use_${name}(item):
    return lRUCache.${method}(item)
`);
  }
  fs.writeFileSync(path.join(dir, 'unknown.py'), `UNKNOWN = load_defaults()

def read_unknown(name):
    return UNKNOWN.get(name)
`);
  fs.writeFileSync(path.join(dir, 'client.py'), `from cache import LRUCache

def read_cache(lRUCache: LRUCache, name):
    return lRUCache.get(name)
`);
  cg = await CodeGraph.init(dir, { index: true });
});

afterAll(() => {
  cg?.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectNoMethodCall(callerName: string, file: string, methodName: string) {
  const caller = cg.getNodesByName(callerName).find((n) => n.kind === 'function' && n.filePath === file);
  const method = cg.getNodesByName(methodName).find((n) => n.kind === 'method' && n.filePath === 'cache.py');
  expect(caller).toBeDefined();
  expect(method).toBeDefined();
  expect(cg.getCallers(method!.id).map(({ node }) => node.id)).not.toContain(caller!.id);
  expect(cg.getCallees(caller!.id).map(({ node }) => node.id)).not.toContain(method!.id);
}

describe('Python module-scope collection methods (#1652)', () => {
  it('does not connect DEFAULTS.get to the unrelated LRUCache.get method', () => {
    expectNoMethodCall('read_setting', 'settings.py', 'get');
  });

  it.each(collections)('keeps $name ($method) external even when the receiver resembles a class', ({ name, method }) => {
    expectNoMethodCall(`use_${name}`, `${name}.py`, method);
  });

  it('does not treat an unrelated variable as evidence of a project class', () => {
    expectNoMethodCall('read_unknown', 'unknown.py', 'get');
  });

  it('preserves real instance calls despite same-named collections in other files', () => {
    const caller = cg.getNodesByName('read_cache').find((n) => n.kind === 'function')!;
    const method = cg.getNodesByName('get').find((n) => n.kind === 'method' && n.filePath === 'cache.py')!;
    expect(caller).toBeDefined();
    expect(method).toBeDefined();
    expect(cg.getCallees(caller.id).map(({ node }) => node.id)).toContain(method.id);
    expect(cg.getCallers(method.id).map(({ node }) => node.id)).toContain(caller.id);
  });
});
