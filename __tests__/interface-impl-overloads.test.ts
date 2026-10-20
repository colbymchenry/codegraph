/**
 * An interface overload is implemented by the overload with its parameters
 * (#2663). The interface-impl synthesizer linked every overload of an
 * interface method to every same-named overload of the implementation, so
 * `putTairValue(String)` reached `putTairValue(List<String>, double)` and the
 * other way round. In Java, Kotlin and Scala an override repeats the
 * parameter list, so a base overload pairs with the implementation overloads
 * of its parameter count, and of those with the one whose parameter types are
 * written alike when there is one. A generic interface's `save(T)` still
 * reaches every one-parameter `save` of its implementation.
 *
 * The generic case is written in Kotlin: a Java `implements Store<String>`
 * gets no `implements` edge today, generic or not of this change.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-iface-overloads-'));
  const files: Record<string, string> = {
    // The issue's example.
    'src/ExampleService.java': `import java.util.List;

interface ExampleService {
    Object putTairValue(String tairKey);

    Object putTairValue(List<String> tairKey, double count);
}
`,
    'src/ExampleServiceImpl.java': `import java.util.List;

class ExampleServiceImpl implements ExampleService {
    @Override
    public Object putTairValue(String tairKey) {
        return null;
    }

    @Override
    public Object putTairValue(List<String> tairKey, double count) {
        return null;
    }
}
`,
    // Same parameter count, told apart by type, `final` and an annotation aside.
    'src/Store.java': `interface Store {
    void put(String key);
    void put(int index);
}

class MapStore implements Store {
    public void put(@Deprecated final String key) {}
    public void put(int index) {}
}
`,
    // A type parameter: no implementation's types are written alike, so every one of its count.
    'src/Repository.kt': `interface Repository<T> {
    fun save(entity: T)
    fun save(entities: List<T>, flush: Boolean)
}

class UserRepository : Repository<String> {
    override fun save(entity: String) {}
    fun save(entities: Map<String, Int>) {}
    override fun save(entities: List<String>, flush: Boolean) {}
}
`,
    'src/Cache.kt': `interface Cache {
    fun put(key: String): Any?
    fun put(keys: List<String>, count: Double = 1.0): Any?
}

class MemoryCache : Cache {
    override fun put(key: String): Any? = null
    override fun put(keys: List<String>, count: Double): Any? = null
}
`,
    'src/Repo.scala': `trait Repo {
  def find(id: Long): Any
  def find(ids: List[Long], limit: Int): Any
}

class SqlRepo extends Repo {
  def find(id: Long): Any = null
  def find(ids: List[Long], limit: Int): Any = null
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::name:line -> Owner::name:line` of every interface-impl edge from methods of `owner`. */
const implEdges = (owner: string): string[] => {
  const methods = cg.getNodesByKind('method').filter((n) => n.qualifiedName.startsWith(`${owner}::`));
  return methods.flatMap((m) => cg.getOutgoingEdges(m.id)
    .filter((e) => e.kind === 'calls' && e.metadata?.synthesizedBy === 'interface-impl')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${m.qualifiedName}:${m.startLine} -> ${t.qualifiedName}:${t.startLine}`;
    })).sort();
};

describe('an interface overload is implemented by the overload with its parameters (#2663)', () => {
  it('Java: by parameter count', () => {
    expect(implEdges('ExampleService')).toEqual([
      'ExampleService::putTairValue:4 -> ExampleServiceImpl::putTairValue:4',
      'ExampleService::putTairValue:6 -> ExampleServiceImpl::putTairValue:9',
    ]);
  });

  it('Java: by parameter types at the same count', () => {
    expect(implEdges('Store')).toEqual([
      'Store::put:2 -> MapStore::put:7',
      'Store::put:3 -> MapStore::put:8',
    ]);
  });

  it('a type parameter: every implementation overload of its count, as before', () => {
    expect(implEdges('Repository')).toEqual([
      'Repository::save:2 -> UserRepository::save:7',
      'Repository::save:2 -> UserRepository::save:8',
      'Repository::save:3 -> UserRepository::save:9',
    ]);
  });

  it('Kotlin and Scala: by parameter count, a default value aside', () => {
    expect(implEdges('Cache')).toEqual([
      'Cache::put:2 -> MemoryCache::put:7',
      'Cache::put:3 -> MemoryCache::put:8',
    ]);
    expect(implEdges('Repo')).toEqual([
      'Repo::find:2 -> SqlRepo::find:7',
      'Repo::find:3 -> SqlRepo::find:8',
    ]);
  });
});
