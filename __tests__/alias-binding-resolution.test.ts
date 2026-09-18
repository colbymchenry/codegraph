/**
 * Calls through an alias binding.
 *
 * A name bound to nothing but another symbol — `export const alias = fn`,
 * `export { fn as alias }`, `export const api = { run: fn }`, or a same-file
 * `const local = fn` — used to resolve to the BINDING, one hop short of the
 * function. The edge existed, so nothing looked broken, but `callers fn` omitted
 * every caller that went through the alias and reported a confident zero while
 * `callers alias` found them.
 *
 * Specifiers here are extensionless so these cases stand independently of
 * `.js`-specifier resolution.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';

describe('calls through an alias binding reach the aliased symbol', () => {
  let cg: CodeGraph;
  let dir: string;

  afterEach(() => {
    if (cg) cg.destroy();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  const index = async (files: Record<string, string>): Promise<void> => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-alias-'));
    for (const [name, content] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), content);
    }
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  };

  const callersOf = (name: string): string[] => {
    const target = cg.getNodesByKind('function').find((n) => n.name === name);
    expect(target, `fixture symbol ${name} was not indexed`).toBeDefined();
    return cg.getCallers(target!.id).map((c) => c.node.name);
  };

  it('follows `export const alias = fn`', async () => {
    await index({
      'impl.ts': 'export function realImpl(): number { return 1; }\nexport const aliasName = realImpl;\n',
      'consumer.ts': "import { aliasName } from './impl';\nexport function consumerFn(): number { return aliasName(); }\n",
    });
    expect(callersOf('realImpl')).toContain('consumerFn');
  });

  it('follows a local `export { fn as alias }` clause', async () => {
    // The declaration carries no `export` keyword, so extraction does not flag
    // it exported — the export index must still bind the renamed export to it.
    await index({
      'impl.ts': 'function realImpl(): number { return 1; }\nexport { realImpl as aliasName };\n',
      'consumer.ts': "import { aliasName } from './impl';\nexport function consumerFn(): number { return aliasName(); }\n",
    });
    expect(callersOf('realImpl')).toContain('consumerFn');
  });

  it('follows a function reference held in an object-literal property', async () => {
    await index({
      'impl.ts': 'export function realImpl(): number { return 1; }\nexport const api = { run: realImpl };\n',
      'consumer.ts': "import { api } from './impl';\nexport function consumerFn(): number { return api.run(); }\n",
    });
    expect(callersOf('realImpl')).toContain('consumerFn');
  });

  it('follows a same-file alias binding', async () => {
    await index({
      'impl.ts':
        'function realImpl(): number { return 1; }\n' +
        'const localAlias = realImpl;\n' +
        'export function consumerFn(): number { return localAlias(); }\n',
    });
    expect(callersOf('realImpl')).toContain('consumerFn');
  });

  it('leaves a genuine wrapper pointing at the wrapper, not the wrapped function', async () => {
    // `wrapper` is a real function, not an alias: the call site calls IT.
    await index({
      'impl.ts':
        'export function realImpl(): number { return 1; }\n' +
        'export const wrapper = (): number => realImpl();\n',
      'consumer.ts': "import { wrapper } from './impl';\nexport function consumerFn(): number { return wrapper(); }\n",
    });
    expect(callersOf('realImpl')).not.toContain('consumerFn');
  });

  it('does not hop when the aliased name is ambiguous across files', async () => {
    // Two same-named callables and no same-file declaration to prefer: a hop
    // would have to guess, and a wrong edge is worse than a missing one.
    await index({
      'one.ts': 'export function shared(): number { return 1; }\n',
      'two.ts': 'export function shared(): number { return 2; }\n',
      'alias.ts': "import { shared } from './one';\nexport const aliasName = shared;\n",
      'consumer.ts': "import { aliasName } from './alias';\nexport function consumerFn(): number { return aliasName(); }\n",
    });

    const sharedNodes = cg.getNodesByKind('function').filter((n) => n.name === 'shared');
    expect(sharedNodes).toHaveLength(2);
    for (const node of sharedNodes) {
      expect(cg.getCallers(node.id).map((c) => c.node.name)).not.toContain('consumerFn');
    }
  });
});
