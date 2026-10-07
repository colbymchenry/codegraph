/**
 * When an interface method fans out to several implementations, the Flow goes
 * through the one the query names.
 *
 * Explore's `named` walk is breadth-first, and an interface method calls every
 * implementation at the same depth. Whichever implementation the index listed
 * first used to claim everything reached after it, so on prometheus
 *
 *   Engine.execEvalStmt Queryable.Querier fanout.Querier NewMergeQuerier
 *
 * came back as `Queryable.Querier → DB.Querier → NewMergeQuerier`: a route
 * through the TSDB's implementation, which nobody named, while
 * `fanout.Querier`, which was named and calls `NewMergeQuerier` just as
 * directly, was left off the Flow. gin's form binding did the same once its map
 * types counted as implementations: `setter.TrySet` went through
 * `headerSource.TrySet` when the query named `formSource.TrySet`.
 *
 * Every case is asked twice, naming one implementation and then the other, so
 * it fails whichever one the index happens to list first.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import { resolveNamedSymbolFlow } from '../src/graph/named-symbol-flow';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // gin's binding package, with structs where gin has map types.
  'binding/form_mapping.go': `package binding

type setter interface {
	TrySet(key string) (bool, error)
}

type formSource struct{ values map[string][]string }

func (form formSource) TrySet(key string) (bool, error) {
	return setByForm(form.values, key)
}

func tryToSetValue(s setter, key string) (bool, error) {
	return s.TrySet(key)
}

func setByForm(values map[string][]string, key string) (bool, error) {
	return len(values[key]) > 0, nil
}
`,
  'binding/header.go': `package binding

type headerSource struct{ values map[string][]string }

func (hs headerSource) TrySet(key string) (bool, error) {
	return setByForm(hs.values, key)
}
`,
  // Both implementations call the same function.
  'src/store.ts': `export interface Store {
  save(key: string): boolean;
}

export function persist(store: Store, key: string): boolean {
  return store.save(key);
}

export function writeEntry(key: string): boolean {
  return key.length > 0;
}
`,
  'src/memory-store.ts': `import { Store, writeEntry } from './store';

export class MemoryStore implements Store {
  save(key: string): boolean {
    return writeEntry(key);
  }
}
`,
  'src/disk-store.ts': `import { Store, writeEntry } from './store';

export class DiskStore implements Store {
  save(key: string): boolean {
    return writeEntry(key);
  }
}
`,
  // Each implementation calls its own function, and the query names both, so
  // the two routes end at different symbols that are equally deep.
  'src/cache.ts': `export interface Cache {
  evict(key: string): void;
}

export function expire(cache: Cache, key: string): void {
  cache.evict(key);
}

export function dropFromMemory(key: string): void {
  console.log(key);
}

export function dropFromDisk(key: string): void {
  console.log(key);
}
`,
  'src/memory-cache.ts': `import { Cache, dropFromMemory } from './cache';

export class MemoryCache implements Cache {
  evict(key: string): void {
    dropFromMemory(key);
  }
}
`,
  'src/disk-cache.ts': `import { Cache, dropFromDisk } from './cache';

export class DiskCache implements Cache {
  evict(key: string): void {
    dropFromDisk(key);
  }
}
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flow-named-impl-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The lead chain, each step as `qualifiedName@file`. */
function leadChain(query: string): string[] {
  const flow = resolveNamedSymbolFlow(cg, query);
  return (flow.chains[0]?.steps ?? []).map((s) => `${s.node.qualifiedName}@${s.node.filePath}`);
}

/** The numbered lines of explore's Flow section. */
async function exploreFlow(query: string): Promise<string[]> {
  const res = await new ToolHandler(cg).execute('codegraph_explore', { query });
  const text = res.content?.[0]?.text ?? '';
  const start = text.indexOf('**Flow (call path among the symbols you queried)**');
  if (start < 0) return [];
  const section = text.slice(start).split(/\n\n(?=\*\*|>)/)[0] ?? '';
  return section.split(/\r?\n/).filter((line) => /^\d+\. /.test(line));
}

describe('a Flow through an interface goes through the implementation the query names', () => {
  it('Go: the route through formSource.TrySet when the query names it', () => {
    expect(leadChain('tryToSetValue setter.TrySet formSource.TrySet setByForm')).toEqual([
      'tryToSetValue@binding/form_mapping.go',
      'setter::TrySet@binding/form_mapping.go',
      'formSource::TrySet@binding/form_mapping.go',
      'setByForm@binding/form_mapping.go',
    ]);
  });

  it('Go: the route through headerSource.TrySet when the query names it', () => {
    expect(leadChain('tryToSetValue setter.TrySet headerSource.TrySet setByForm')).toEqual([
      'tryToSetValue@binding/form_mapping.go',
      'setter::TrySet@binding/form_mapping.go',
      'headerSource::TrySet@binding/header.go',
      'setByForm@binding/form_mapping.go',
    ]);
  });

  it('TypeScript: the route through the named class when two classes call the same function', () => {
    expect(leadChain('persist Store.save MemoryStore.save writeEntry')).toEqual([
      'persist@src/store.ts',
      'Store::save@src/store.ts',
      'MemoryStore::save@src/memory-store.ts',
      'writeEntry@src/store.ts',
    ]);
    expect(leadChain('persist Store.save DiskStore.save writeEntry')).toEqual([
      'persist@src/store.ts',
      'Store::save@src/store.ts',
      'DiskStore::save@src/disk-store.ts',
      'writeEntry@src/store.ts',
    ]);
  });

  it('TypeScript: of two equally deep ends, the one reached through the named class', () => {
    expect(leadChain('expire Cache.evict MemoryCache.evict dropFromMemory dropFromDisk')).toEqual([
      'expire@src/cache.ts',
      'Cache::evict@src/cache.ts',
      'MemoryCache::evict@src/memory-cache.ts',
      'dropFromMemory@src/cache.ts',
    ]);
    expect(leadChain('expire Cache.evict DiskCache.evict dropFromMemory dropFromDisk')).toEqual([
      'expire@src/cache.ts',
      'Cache::evict@src/cache.ts',
      'DiskCache::evict@src/disk-cache.ts',
      'dropFromDisk@src/cache.ts',
    ]);
  });

  it('still bridges through an implementation when the query names none', () => {
    const chain = leadChain('tryToSetValue setter.TrySet setByForm');
    expect(chain).toHaveLength(4);
    expect(chain[0]).toBe('tryToSetValue@binding/form_mapping.go');
    expect(chain[1]).toBe('setter::TrySet@binding/form_mapping.go');
    expect(['formSource::TrySet@binding/form_mapping.go', 'headerSource::TrySet@binding/header.go']).toContain(chain[2]);
    expect(chain[3]).toBe('setByForm@binding/form_mapping.go');
  });

  it("codegraph_explore's Flow section lists the named implementation", async () => {
    const formLine = cg.getNodesByName('TrySet').find((n) => n.qualifiedName === 'formSource::TrySet')!.startLine;
    const headerLine = cg.getNodesByName('TrySet').find((n) => n.qualifiedName === 'headerSource::TrySet')!.startLine;

    const viaForm = await exploreFlow('tryToSetValue setter.TrySet formSource.TrySet setByForm');
    expect(viaForm).toHaveLength(4);
    expect(viaForm[2]).toBe(`3. TrySet (binding/form_mapping.go:${formLine})`);

    const viaHeader = await exploreFlow('tryToSetValue setter.TrySet headerSource.TrySet setByForm');
    expect(viaHeader).toHaveLength(4);
    expect(viaHeader[2]).toBe(`3. TrySet (binding/header.go:${headerLine})`);
  });
});
