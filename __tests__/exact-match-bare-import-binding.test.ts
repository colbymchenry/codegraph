/**
 * The exact-name strategy has the same single-survivor trap the fuzzy one had
 * (#1713): when a call site's own name comes from a bare import — `test` from
 * `vitest`, `resolve` from `node:path` — the real target is not in the graph,
 * and the one project symbol with that name must not inherit the reference.
 *
 * These drive the whole pipeline over source fixtures: a bare-import binding
 * with exactly one same-named project definition routes through
 * matchByExactName, which is the strategy under test. The alias cases pin the
 * other half of the rule — a binding the resolver cannot follow is not thereby
 * external, so its name match must survive.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let tempDir: string;
let cg: CodeGraph | null = null;

function project(files: Record<string, string>): void {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bare-exact-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(tempDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
}

async function callTargets(caller: string): Promise<string[]> {
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  const from = cg.getNodesByKind('function').find((n) => n.name === caller)!;
  expect(from).toBeDefined();
  return cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'calls').map((e) => e.target);
}

afterEach(() => {
  cg?.close();
  cg = null;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('exact-name matching declines a name bound to a bare import', () => {
  it.each([
    ["import { resolve } from 'node:path';", 'resolve'],
    ["import { resolve } from 'path';", 'resolve'],
    ["import { resolve as joinPath } from 'node:path';", 'joinPath'],
    ["import resolve from 'external-resolver';", 'resolve'],
    ["import { resolve } from '@scope/external-resolver/deep';", 'resolve'],
  ])('%s does not bind to the only project symbol of that name', async (declaration, name) => {
    project({
      'plugin.ts': `export function ${name}() { return 'plugin'; }`,
      'config.ts': `${declaration}\nexport function configure() { return ${name}('src'); }`,
    });
    const targets = await callTargets('configure');
    const wrong = cg!.getNodesByKind('function').find((n) => n.filePath === 'plugin.ts')!;
    expect(wrong).toBeDefined();
    expect(targets).not.toContain(wrong.id);
    const importEdges = cg!.getNodesByKind('file')
      .concat(cg!.getNodesByKind('import'))
      .filter((n) => n.filePath === 'config.ts')
      .flatMap((n) => cg!.getOutgoingEdges(n.id))
      .filter((e) => e.target === wrong.id);
    expect(importEdges).toEqual([]);
  });

  it('a same-file definition still shadows the import', async () => {
    project({
      'config.ts':
        "import { resolve } from 'node:path';\n" +
        "export function configure() {\n function resolve() { return 'local'; }\n return resolve();\n}",
    });
    const targets = await callTargets('configure');
    const local = cg!.getNodesByKind('function').find((n) => n.name === 'resolve')!;
    expect(local).toBeDefined();
    expect(targets).toContain(local.id);
  });
});

describe('a binding the resolver cannot follow is not thereby external', () => {
  // `~utils` is a tsconfig `paths` alias in vite's playground/tsconfig.json —
  // a nested tsconfig the alias loader never reads; `#lib/utils` a package.json
  // `imports` subpath; `$lib` SvelteKit's. Each reaches its target by name only.
  it.each(['~utils', '#lib/utils', '@/lib/utils', '$lib/utils', 'src/lib/utils', './generated/utils'])(
    'keeps the name match for a name imported from %s',
    async (specifier) => {
      project({
        'lib/utils.ts': 'export function resolve(value: string) { return value; }',
        'config.ts': `import { resolve } from '${specifier}';\nexport function configure() { return resolve('src'); }`,
      });
      const targets = await callTargets('configure');
      const target = cg!.getNodesByKind('function').find((n) => n.filePath === 'lib/utils.ts')!;
      expect(target).toBeDefined();
      expect(targets).toContain(target.id);
    }
  );

  it('keeps a name bound by no import at all', async () => {
    project({
      'lib/utils.ts': 'export function resolve(value: string) { return value; }',
      'config.ts': "export function configure() { return resolve('src'); }",
    });
    const targets = await callTargets('configure');
    const target = cg!.getNodesByKind('function').find((n) => n.filePath === 'lib/utils.ts')!;
    expect(targets).toContain(target.id);
  });
});
