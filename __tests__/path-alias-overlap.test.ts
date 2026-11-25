/**
 * A `paths` wildcard whose prefix and suffix overlap.
 *
 * `"@x/*\/index"` splits into the prefix `@x/` and the suffix `/index`. An
 * import of `@x/index` starts with the one and ends with the other, but only
 * by counting its single `/` twice: nothing is left for `*`. tsc's
 * `isPatternMatch` asks for a specifier at least as long as the prefix and the
 * suffix together, so it skips the pattern there. The resolver took the empty
 * capture instead and linked the import, and every call through it, to
 * `widgets/index` — a file the import never named.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { applyAliases, loadProjectAliases } from '../src/resolution/path-aliases';

let dirs: string[] = [];
let graphs: CodeGraph[] = [];
afterEach(() => {
  for (const graph of graphs) graph.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  graphs = [];
  dirs = [];
});

const project = (files: Record<string, string>): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-alias-overlap-'));
  dirs.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  return dir;
};

const tsconfig = (paths: Record<string, string[]>): string =>
  JSON.stringify({ compilerOptions: { baseUrl: './src', paths } });

describe('a wildcard alias whose prefix and suffix overlap', () => {
  it('does not match a specifier that leaves nothing for the wildcard', () => {
    const root = project({ 'tsconfig.json': tsconfig({ '@x/*/index': ['widgets/*/index'] }) });
    const aliases = loadProjectAliases(root)!;

    expect(applyAliases('@x/index', aliases, root)).toEqual([]);
    expect(applyAliases('@x/button/index', aliases, root)).toEqual(['src/widgets/button/index']);
  });

  it('falls through to the next pattern that does match', () => {
    // Both prefixes are `@x/`, so the first-declared pattern is tried first,
    // as in tsc. Skipping it must not end the search.
    const root = project({ 'tsconfig.json': tsconfig({ '@x/*/index': ['widgets/*/index'], '@x/*': ['lib/*'] }) });
    const aliases = loadProjectAliases(root)!;

    expect(applyAliases('@x/index', aliases, root)).toEqual(['src/lib/index']);
    expect(applyAliases('@x/button/index', aliases, root)).toEqual(['src/widgets/button/index']);
  });

  it('still accepts an empty capture when the specifier is exactly the prefix plus the suffix', () => {
    // tsc's bound is `>=`: here the prefix and suffix meet without sharing
    // a character, so `*` matches the empty string.
    const root = project({ 'tsconfig.json': tsconfig({ '@x/*/index': ['widgets/*/index'] }) });

    expect(applyAliases('@x//index', loadProjectAliases(root)!, root)).toEqual(['src/widgets/index']);
  });

  it('links neither the import nor its calls to the file the empty capture named', async () => {
    const root = project({
      'tsconfig.json': tsconfig({ '@x/*/index': ['widgets/*/index'] }),
      'src/index.ts': 'export function trap(): number { return 1; }\n',
      'src/widgets/index.ts': 'export function trap(): number { return 0; }\n',
      'src/widgets/button/index.ts': 'export function press(): number { return 2; }\n',
      'src/main.ts':
        "import { trap as caught } from '@x/index';\n" +
        "import { press } from '@x/button/index';\n" +
        'export function go(): number { return caught() + press(); }\n',
    });
    const cg = await CodeGraph.init(root, { index: true });
    graphs.push(cg);

    const fn = (name: string, file: string) =>
      cg.getNodesByKind('function').find((n) => n.name === name && n.filePath === file)!;
    const go = fn('go', 'src/main.ts');

    // The overlapping import names no project file.
    const widgetsFile = cg.getNodesInFile('src/widgets/index.ts').find((n) => n.kind === 'file')!;
    expect(cg.getIncomingEdges(widgetsFile.id).filter((e) => e.kind === 'imports')).toEqual([]);
    expect(cg.getCallers(fn('trap', 'src/widgets/index.ts').id)).toEqual([]);

    // The pattern still serves a specifier with a segment for `*`.
    expect(cg.getCallees(go.id).map((c) => `${c.node.name}@${c.node.filePath}`)).toEqual([
      'press@src/widgets/button/index.ts',
    ]);
  });
});
