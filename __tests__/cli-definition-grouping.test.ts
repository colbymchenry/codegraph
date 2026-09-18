/** CLI parity with MCP definition grouping and file narrowing (#1512, #1656). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { lookupSymbolNodes } from '../src/graph/symbol-lookup';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');
const COMMANDS = ['callers', 'callees', 'impact'] as const;
type Command = typeof COMMANDS[number];
let projectRoot: string;
let cg: CodeGraph;
let handler: ToolHandler;

function runCli(command: Command, symbol = 'handle', args: string[] = []) {
  return spawnSync(process.execPath, [BIN, command, '-p', projectRoot, ...args, '--', symbol], {
    encoding: 'utf-8',
    env: { ...process.env, CODEGRAPH_NO_DAEMON: '1', CODEGRAPH_WASM_RELAUNCHED: '1', NO_COLOR: '1' },
    timeout: 30_000,
  });
}

function json(command: Command, symbol = 'handle', args: string[] = []) {
  const result = runCli(command, symbol, [...args, '--json']);
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function resultKey(command: Command) {
  return command === 'impact' ? 'affected' : command;
}

function write(file: string, source: string) {
  const absolute = path.join(projectRoot, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cli-1512-'));
  for (const [dir, helper] of [['a', 'alpha'], ['b', 'beta']]) {
    write(`${dir}/${helper}.js`, `export function ${helper}() { return 1; }\n`);
    write(`${dir}/svc.js`, `import { ${helper} } from './${helper}.js';\nexport function handle() { return ${helper}(); }\n`);
    write(`${dir}/main.js`, `import { handle } from './svc.js';\nexport function ${dir}Main() { return handle(); }\nexport function ${dir}Entry() { return ${dir}Main(); }\n`);
    write(`${dir}/work.js`, `import { shared } from '../shared.js';\nimport { ${helper} } from './${helper}.js';\nexport function work() { shared(); return ${helper}(); }\n`);
    write(`${dir}/work-caller.js`, `import { work } from './work.js';\nexport function ${dir}Worker() { work(); }\n`);
  }
  write('shared.js', 'export function shared() {}\n');
  write('both.js', "import { work as aWork } from './a/work.js';\nimport { work as bWork } from './b/work.js';\nexport function both() { aWork(); bWork(); }\n");
  write('quiet-a.js', 'export function quiet() {}\n');
  write('quiet-b.js', "import { alpha } from './a/alpha.js';\nexport function quiet() { alpha(); }\nexport function wake() { quiet(); }\n");
  write('scopes.ts', [
    'function leftOnly() {}',
    'function rightOnly() {}',
    'export class Left { run() { leftOnly(); } }',
    'export class Right { run() { rightOnly(); } }',
  ].join('\n'));
  // Java overloads have separate bodies/nodes; TS signature-only overloads are
  // intentionally skipped by extraction, so they cannot exercise grouping.
  write('Overloads.java', [
    'public class Overloads {',
    '  static String stringIdentity(String value) { return value; }',
    '  static int intIdentity(int value) { return value; }',
    '  public static String convert(String value) { return stringIdentity(value); }',
    '  public static int convert(int value) { return intIdentity(value); }',
    '  public static void convertCaller() { convert(1); convert("value"); }',
    '}',
  ].join('\n'));
  for (let i = 0; i < 55; i++) {
    write(`crowd/def-${i}.js`, "import { shared } from '../shared.js';\nexport function crowded() { shared(); }\n");
  }
  cg = CodeGraph.initSync(projectRoot);
  await cg.indexAll();
  handler = new ToolHandler(cg);
}, 30_000);

afterAll(() => {
  handler?.closeAll();
  cg?.close();
  if (projectRoot) fs.rmSync(projectRoot, { recursive: true, force: true });
});

describe.each(COMMANDS)('%s definition grouping (#1512)', (command) => {
  it('attributes every result and graph edge to its definition in JSON', () => {
    const out = json(command);
    expect(out.ambiguous).toBe(true);
    expect(out.aggregation).toBe('union');
    expect(out.definitions).toHaveLength(2);
    const key = resultKey(command);
    for (const [dir, other] of [['a', 'b'], ['b', 'a']]) {
      const group = out.definitions.find((d: any) => d.definition.filePath === `${dir}/svc.js`);
      expect(group.definition).toMatchObject({ name: 'handle', kind: 'function', startLine: 2 });
      expect(group.roots).toHaveLength(1);
      expect(group[key].length).toBeGreaterThan(0);
      expect(group[key].every((n: any) => n.filePath.startsWith(`${dir}/`))).toBe(true);
      expect(JSON.stringify(group)).not.toContain(`"filePath":"${other}/`);
      const actual = cg.getNodesByName('handle').find(n => n.filePath === `${dir}/svc.js`)!;
      const expectedNodes = command === 'impact'
        ? [...cg.getImpactRadius(actual.id, 2).nodes.values()]
        : cg[command === 'callers' ? 'getCallers' : 'getCallees'](actual.id).map(c => c.node);
      expect(new Set(group[key].map((n: any) => n.id))).toEqual(new Set(expectedNodes.map(n => n.id)));
      const ids = new Set([...group.roots, ...group[key].map((n: any) => n.id)]);
      expect(group.edges.length).toBeGreaterThan(0);
      for (const edge of group.edges) {
        expect(ids.has(edge.source)).toBe(true);
        expect(ids.has(edge.target)).toBe(true);
      }
    }
  });

  it('prints each definition above only its own results', () => {
    const result = runCli(command);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('2 distinct definitions');
    expect(result.stdout).toContain('--file');
    const sections = result.stdout.split(/(?=function handle \(javascript\) — [ab]\/svc\.js:2)/).slice(1);
    expect(sections).toHaveLength(2);
    for (const section of sections) {
      const dir = section.includes('— a/svc.js:2') ? 'a' : 'b';
      expect(section).toContain(command === 'callees' ? `${dir}/${dir === 'a' ? 'alpha' : 'beta'}.js` : `${dir}/main.js`);
      expect(section).not.toContain(dir === 'a' ? 'b/' : 'a/');
    }
  });

  it.each(['a/svc.js', './a/svc.js'])('--file %s selects the same definition as MCP', async (file) => {
    const out = json(command, 'handle', ['--file', file]);
    expect(out.definitions).toHaveLength(1);
    expect(out.definitions[0].definition.filePath).toBe('a/svc.js');
    expect(out.targets.every((n: any) => n.filePath === 'a/svc.js')).toBe(true);
    expect(out.ambiguous).toBe(false);
    expect(out.filteredOut).toBe(false);
    expect(out[resultKey(command)].every((n: any) => n.filePath.startsWith('a/'))).toBe(true);
    const human = runCli(command, 'handle', ['--file', file]).stdout;
    const mcp = (await handler.execute(`codegraph_${command}`, { symbol: 'handle', file })).content[0]?.text ?? '';
    for (const text of [human, mcp]) {
      expect(text).not.toContain('b/');
      expect(text).not.toContain('distinct definitions');
      expect(text).toContain(command === 'callees' ? 'a/alpha.js' : 'a/main.js');
    }
  });

  it('a suffix matching both files keeps both definitions', () => {
    const out = json(command, 'handle', ['-f', 'svc.js']);
    expect(out.definitions).toHaveLength(2);
    expect(out.filteredOut).toBe(false);
  });

  it('a non-matching file discloses the fallback in JSON and text', async () => {
    const note = 'no definition of "handle" matches file "missing.js" — showing all definitions instead.';
    const out = json(command, 'handle', ['--file', 'missing.js']);
    expect(out.filteredOut).toBe(true);
    expect(out.note).toBe(note);
    expect(out.definitions).toHaveLength(2);
    expect(runCli(command, 'handle', ['--file', 'missing.js']).stdout).toContain(note);
    const mcp = await handler.execute(`codegraph_${command}`, { symbol: 'handle', file: 'missing.js' });
    expect(mcp.content[0]?.text).toContain(note);
  });

  it('keeps same-file overloads together as MCP does', () => {
    const out = json(command, 'convert');
    expect(cg.getNodesByName('convert').length).toBeGreaterThan(1);
    expect(out.definitions).toHaveLength(1);
    expect(out.definitions[0].roots.length).toBeGreaterThan(1);
    expect(out.ambiguous).toBe(false);
    expect(lookupSymbolNodes(cg, 'convert').ambiguous).toBe(false);
    expect(out.definitions[0][resultKey(command)].length).toBeGreaterThan(0);
  });

  it('does not substitute another definition for an unknown qualified name', () => {
    const out = runCli(command, 'Missing.run');
    expect(out.status, out.stderr).toBe(0);
    expect(out.stdout).toContain('Symbol "Missing.run" not found');
    expect(out.stdout).not.toContain('leftOnly');
    expect(out.stdout).not.toContain('rightOnly');
  });
});

describe('CLI definition boundaries and limits', () => {
  it('separates different qualified names within the same file', () => {
    const out = json('callees', 'run', ['--file', 'scopes.ts']);
    expect(out.definitions).toHaveLength(2);
    for (const name of ['Left', 'Right']) {
      const group = out.definitions.find((d: any) => d.definition.qualifiedName === `${name}::run`);
      expect(group.callees.map((n: any) => n.name)).toEqual([`${name.toLowerCase()}Only`]);
    }
    const qualified = json('callees', 'Left.run');
    expect(qualified.definitions).toHaveLength(1);
    expect(qualified.callees.map((n: any) => n.name)).toEqual(['leftOnly']);
  });

  it.each(['callers', 'callees'] as const)('%s includes definitions with no edges', (command) => {
    const out = json(command, 'quiet');
    expect(out.definitions).toHaveLength(2);
    const empty = out.definitions.find((d: any) => d.definition.filePath === 'quiet-a.js');
    expect(empty[command]).toEqual([]);
    expect(empty.edges).toEqual([]);
    expect(empty).toMatchObject({ total: 0, limit: 20, truncated: false });
    expect(runCli(command, 'quiet').stdout).toContain(`(no ${command})`);
  });

  it('keeps shared callers and callees in each definition instead of deduplicating across them', () => {
    for (const command of ['callers', 'callees'] as const) {
      const out = json(command, 'work');
      expect(out.definitions).toHaveLength(2);
      for (const group of out.definitions) {
        expect(group[command].map((n: any) => n.name)).toContain(command === 'callers' ? 'both' : 'shared');
      }
      expect(out[command].filter((n: any) => n.name === (command === 'callers' ? 'both' : 'shared'))).toHaveLength(1);
    }
  });

  it.each(['callers', 'callees'] as const)('%s preserves union metadata and limits each definition independently', (command) => {
    // Callers include the importing file nodes as well as the calling functions.
    const total = command === 'callers' ? 6 : 3;
    const perDefinition = command === 'callers' ? 4 : 2;
    const out = json(command, 'work', ['--limit', '1']);
    expect(out).toMatchObject({ total, limit: 1, truncated: true });
    expect(out[command]).toHaveLength(1);
    for (const group of out.definitions) {
      expect(group).toMatchObject({ total: perDefinition, limit: 1, truncated: true });
      expect(group[command]).toHaveLength(1);
      expect(group.edges).toHaveLength(1);
      expect(group.edges[0][command === 'callers' ? 'source' : 'target']).toBe(group[command][0].id);
    }
    const human = runCli(command, 'work', ['--limit', '1']).stdout;
    expect(human.split(`Showing 1 of ${perDefinition}; pass --limit to widen.`)).toHaveLength(3);
    const complete = json(command, 'work', ['--limit', '100']);
    expect(complete).toMatchObject({ total, limit: 100, truncated: false });
    for (const group of complete.definitions) {
      expect(group).toMatchObject({ total: perDefinition, limit: 100, truncated: false });
      expect(group[command]).toHaveLength(perDefinition);
    }
  });

  it('applies impact depth within each definition and reports its own graph counts', () => {
    for (const depth of [1, 2]) {
      const out = json('impact', 'handle', ['--depth', String(depth)]);
      expect(out.depth).toBe(depth);
      // Each root also has an importing file node at depth one.
      expect(out.nodeCount).toBe(2 * (depth + 2));
      expect(out.edgeCount).toBe(2 * (depth + 1));
      for (const group of out.definitions) {
        expect(group.nodeCount).toBe(depth + 2);
        expect(group.affected).toHaveLength(group.nodeCount);
        expect(group.edgeCount).toBe(depth + 1);
        expect(group.edges).toHaveLength(group.edgeCount);
      }
    }
  });

  it('enumerates definitions beyond the FTS cap and can narrow to any of them', () => {
    const out = json('callees', 'crowded');
    expect(out.definitions).toHaveLength(55);
    for (const group of out.definitions) expect(group.callees.map((n: any) => n.name)).toEqual(['shared']);
    const narrowed = json('callees', 'crowded', ['--file', 'crowd/def-54.js']);
    expect(narrowed.definitions).toHaveLength(1);
    expect(narrowed.definitions[0].definition.filePath).toBe('crowd/def-54.js');
  });
});
