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
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.js'], exclude: [] } });
    await cg.indexAll();
  };

  const callersOf = (name: string): string[] => {
    const target = cg.getNodesByKind('function').find((n) => n.name === name);
    expect(target, `fixture symbol ${name} was not indexed`).toBeDefined();
    return cg.getCallers(target!.id).filter(c => c.edge.kind === 'calls').map((c) => c.node.name);
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

  describe.each(['ts', 'js'])('object member boundaries (%s)', (ext) => {
    it.each([
      ['sibling literals', 'const first = { wrong }; export const api = { run: right };', 'run', true],
      ['unicode before literal', "const label = 'é🙂'; export const api = { run: right };", 'run', true],
      ['absent sibling member', 'const first = { wrong }; export const api = { right };', 'wrong', false],
      ['duplicate key', 'export const api = { run: wrong, run: right };', 'run', true],
      ['non-callable overwrite', 'export const api = { wrong, wrong: 0 };', 'wrong', false],
      ['nested member', 'export const api = { box: { wrong }, method() { return { wrong }; } };', 'wrong', false],
      ['unknown spread', 'export const api = { wrong, ...unknown };', 'wrong', false],
      ['explicit after spread', 'export const api = { ...unknown, run: right };', 'run', true],
      ['quoted overwrite', "export const api = { wrong, 'wrong': 0 };", 'wrong', false],
      ['computed overwrite', 'export const api = { wrong, [unknown]: 0 };', 'wrong', false],
      ['frozen literal', 'export const api = Object.freeze({ run: right });', 'run', true],
      ['parenthesized literal', 'export const api = ({ run: right });', 'run', true],
      ['inline overwrite', 'export const api = { run() { return 0; }, run: right };', 'run', true],
      ['nested inline', 'export const api = { box: { wrong() { return 0; } } };', 'wrong', false],
    ])('%s', async (_name, declaration, member, resolves) => {
      await index({
        [`impl.${ext}`]: `function wrong() { return 1; }
function right() { return 2; }
${declaration}
export function sameCaller() { return api.${member}(); }
`,
        [`consumer.${ext}`]: `import { api } from './impl';
export function crossCaller() { return api.${member}(); }
`,
      });
      for (const caller of ['sameCaller', 'crossCaller']) {
        expect(callersOf('wrong')).not.toContain(caller);
        if (resolves) expect(callersOf('right')).toContain(caller);
        else expect(callersOf('right')).not.toContain(caller);
      }
      const inline = cg.getNodesByKind('function').filter(n => n.name === member && n.name !== 'right' && n.name !== 'wrong');
      for (const node of inline) {
        expect(cg.getCallers(node.id).map(c => c.node.name)).not.toContain('sameCaller');
        expect(cg.getCallers(node.id).map(c => c.node.name)).not.toContain('crossCaller');
      }
    });
  });

  it('does not cross parameter or value shadows', async () => {
    await index({
      'impl.ts': `function target() { return 0; }
export function parameter(target: () => number) {
  const api = { target };
  return api.target();
}
export function value() {
  const target = 0;
  const api = { target };
  return api.target();
}
export function later() {
  const api = { target };
  const target = 0;
  return api.target();
}
`,
    });
    const targets = cg.getNodesByKind('function').filter(n => n.name === 'target').sort((a, b) => a.startLine - b.startLine);
    expect(targets).toHaveLength(1);
    const outer = cg.getCallers(targets[0]!.id).filter(c => c.edge.kind === 'calls').map(c => c.node.name);
    for (const name of ['parameter', 'value', 'later']) expect(outer).not.toContain(name);
  });

  it('resolves renamed imports at the literal and ignores unrelated nested bindings', async () => {
    await index({
      'target.ts': 'export function actual() { return 1; }',
      'impl.ts': `import { actual as renamed } from './target';
function unrelated() { function renamed() { return 0; } return renamed(); }
export const api = { run: renamed };
export function sameCaller() { return api.run(); }
`,
      'consumer.ts': `import { api as facade } from './impl';
export function crossCaller() { return facade.run(); }
`,
    });
    expect(callersOf('actual')).toEqual(expect.arrayContaining(['sameCaller', 'crossCaller']));
    expect(callersOf('renamed')).not.toContain('sameCaller');
    expect(callersOf('renamed')).not.toContain('crossCaller');
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
