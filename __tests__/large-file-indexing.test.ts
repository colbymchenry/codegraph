/**
 * A large source file indexes in about the time its size asks for.
 *
 * It did not. Work was done for each symbol, or for each reference, that went
 * through the whole file, or through everything before it, so the time grew
 * with the square of the file: a Python file of plain functions took 3 seconds
 * at a third of a megabyte and 27 at nine tenths, a Ruby one twice that, a
 * table of rows that each call a helper 37 seconds at a third of a megabyte,
 * and one string of hex 30 KB long a second, which is eighteen minutes for a
 * megabyte of it. Past about a megabyte a file was given the 180 seconds a
 * file is allowed and then given up on, with no symbols.
 *
 * Each case here is a shape real large files take, at a size where the square
 * was minutes. They pin two things: that the file is indexed in seconds, and
 * that what the faster paths decide is what the slow ones decided — a
 * decorator belongs to the declaration under it, a Ruby method is as visible
 * as the last `private` above it says, a call is the local's once the function
 * has declared the name and the module's before, a column counts UTF-16 units.
 *
 * The time allowed is generous, for a loaded machine: every case takes a
 * second or two, and took from one minute to never.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { LONGEST_NAME_RUN, MAX_SOURCE_FILE_SIZE_BYTES, withoutLongRuns } from '../src/file-limits';
import type { Node } from '../src/types';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

/** What a case may take. Each took from a minute to never. */
const ALLOWED_MS = 60_000;

const MB = 1024 * 1024;

/** `unit(i)` repeated until the text is `bytes` long, between a head and a tail. */
function fill(bytes: number, unit: (i: number) => string, head = '', tail = ''): { text: string; count: number } {
  const parts = [head];
  let length = head.length + tail.length;
  let count = 0;
  for (; length < bytes; count++) {
    const part = unit(count);
    parts.push(part);
    length += part.length;
  }
  parts.push(tail);
  return { text: parts.join(''), count };
}

describe('a large file indexes in the time its size asks for', () => {
  let dir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-large-file-'));
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Writes the files, indexes them, and returns how long indexing took. */
  async function index(files: Record<string, string>): Promise<number> {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    cg = await CodeGraph.init(dir);
    const started = Date.now();
    await cg.indexAll();
    return Date.now() - started;
  }

  const inFile = (file: string, kind?: Node['kind']): Node[] =>
    cg!.getNodesInFile(file).filter((n) => n.kind !== 'file' && (!kind || n.kind === kind));
  const named = (file: string, name: string): Node => {
    const found = cg!.getNodesInFile(file).filter((n) => n.name === name);
    expect(found.map((n) => n.kind), `${name} in ${file}`).toHaveLength(1);
    return found[0]!;
  };
  const callersOf = (node: Node): string[] => cg!.getCallers(node.id).map((c) => c.node.name).sort();

  it('is no longer held to one megabyte', () => {
    expect(MAX_SOURCE_FILE_SIZE_BYTES).toBeGreaterThanOrEqual(4 * MB);
  });

  it('a Python file of decorated functions: each decorator on the function under it', async () => {
    const { text, count } = fill(1.2 * MB, (i) => `@cached\ndef thing${i}(name):\n    return name + "${i}"\n\n`, 'def cached(f):\n    return f\n\n');
    expect(await index({ 'src/big.py': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.py', 'function')).toHaveLength(count + 1);
    const decorated = cg!.getIncomingEdges(named('src/big.py', 'cached').id).filter((e) => e.kind === 'decorates');
    expect(decorated).toHaveLength(count);
    // The one under the last decorator, and no other.
    const last = named('src/big.py', `thing${count - 1}`);
    expect(cg!.getOutgoingEdges(last.id).filter((e) => e.kind === 'decorates')).toHaveLength(1);
  });

  it('a Python table of rows, one statement: a lambda or a comprehension binds its own name on the row it is on', async () => {
    const rows = fill(0.6 * MB, (i) => `    ("name${i}", ${i}, helper(${i})),\n`).text;
    const text = [
      'from pkg import tool as other',
      '',
      'def helper(x):',
      '    return x',
      '',
      'ROWS = [',
      rows.trimEnd(),
      // The lambda's own parameter, to the comma that ends its body; the module after it.
      '    (lambda other: other.in_lambda(), other.after_lambda()),',
      // The comprehension's own target, inside its brackets; the module outside them.
      '    [other.in_loop() for other in range(3)],',
      '    other.plain(),',
      ']',
      '',
    ].join('\n');
    const tool = ['in_lambda', 'after_lambda', 'in_loop', 'plain'].map((n) => `def ${n}():\n    return 1\n`).join('\n');
    expect(await index({ 'src/big.py': text, 'pkg/__init__.py': '', 'pkg/tool.py': tool })).toBeLessThan(ALLOWED_MS);
    expect(cg!.getCallers(named('src/big.py', 'helper').id).length).toBeGreaterThan(0);
    expect(cg!.getCallers(named('pkg/tool.py', 'plain').id)).toHaveLength(1);
    expect(cg!.getCallers(named('pkg/tool.py', 'after_lambda').id)).toHaveLength(1);
    expect(cg!.getCallers(named('pkg/tool.py', 'in_lambda').id)).toHaveLength(0);
    expect(cg!.getCallers(named('pkg/tool.py', 'in_loop').id)).toHaveLength(0);
  });

  it('a Ruby class of methods: each as visible as the last visibility call above it says', async () => {
    const methods = (from: number, bytes: number) => fill(bytes, (i) => `  def thing${from + i}(name)\n    name.to_s + "${i}"\n  end\n\n`);
    const open = methods(0, 0.4 * MB);
    const hidden = methods(open.count, 0.4 * MB);
    const guarded = methods(open.count + hidden.count, 0.4 * MB);
    // Read from a call with arguments; the bare word alone is not one, and never was.
    const text = `class Big\n${open.text}  private :thing0\n\n${hidden.text}  protected :thing0\n\n${guarded.text}  public :thing0\n\n  def last(name)\n    name\n  end\nend\n`;
    expect(await index({ 'src/big.rb': text })).toBeLessThan(ALLOWED_MS);
    const total = open.count + hidden.count + guarded.count;
    expect(inFile('src/big.rb', 'method')).toHaveLength(total + 1);
    const visibility = (i: number) => named('src/big.rb', `thing${i}`).visibility;
    expect([visibility(0), visibility(open.count - 1)]).toEqual(['public', 'public']);
    expect([visibility(open.count), visibility(open.count + hidden.count - 1)]).toEqual(['private', 'private']);
    expect([visibility(open.count + hidden.count), visibility(total - 1)]).toEqual(['protected', 'protected']);
    expect(named('src/big.rb', 'last').visibility).toBe('public');
  });

  it('a C++ file of free functions and a class with sections', async () => {
    const { text, count } = fill(1.2 * MB, (i) => `int thing${i}(int name) {\n  return name + ${i};\n}\n\n`,
      'class Box {\n  int unmarked() { return 1; }\nprivate:\n  int hidden() { return 2; }\npublic:\n  int open() { return 3; }\n};\n\n');
    expect(await index({ 'src/big.cpp': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.cpp', 'function')).toHaveLength(count);
    // The class's first specifier decides for all of its members, as it did.
    expect(['unmarked', 'hidden', 'open'].map((n) => named('src/big.cpp', n).visibility)).toEqual(['private', 'private', 'private']);
  });

  it('a TypeScript function of many calls: a name is the local\'s once the function has declared it, the module\'s before', async () => {
    const calls = (bytes: number) => fill(bytes, (i) => `  helper(${i}, "name${i}");\n`).text;
    const text = [
      'function helper(x: number, y: string) { return x; }',
      'function shadowed(x: number) { return x; }',
      // Calls it before declaring the name: the module's function.
      `export function before() {\n  shadowed(1);\n${calls(0.3 * MB)}  const shadowed = (x: number) => x;\n  return shadowed;\n}`,
      // Declares the name, then calls it a few thousand lines down: its own.
      `export function after() {\n  const shadowed = (x: number) => x;\n${calls(0.3 * MB)}  shadowed(2);\n}`,
      // Takes the name as a parameter.
      `export function given(shadowed: (x: number) => number) {\n${calls(0.3 * MB)}  shadowed(3);\n}`,
      '',
    ].join('\n');
    expect(await index({ 'src/big.ts': text })).toBeLessThan(ALLOWED_MS);
    expect(callersOf(named('src/big.ts', 'helper'))).toEqual(['after', 'before', 'given']);
    const module = cg!.getNodesInFile('src/big.ts').find((n) => n.name === 'shadowed' && n.startLine === 2)!;
    expect(callersOf(module)).toEqual(['before']);
  });

  it('a script minified to one line: every function, each at its UTF-16 column', async () => {
    // What stands before the functions is wider in bytes than in UTF-16 units.
    const head = 'var s="é😀日本";function h(x){return x}';
    const { text, count } = fill(1.2 * MB, (i) => `function t${i}(n){var v=h(n);return t${i ? i - 1 : 0}(v)}`, head, '\n');
    expect(await index({ 'src/big.js': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.js', 'function')).toHaveLength(count + 1);
    for (const i of [0, 1, Math.floor(count / 2), count - 1]) {
      const fn = named('src/big.js', `t${i}`);
      expect(fn.startLine).toBe(1);
      expect(fn.startColumn, `t${i}`).toBe(text.indexOf(`function t${i}(`));
    }
    expect(callersOf(named('src/big.js', 'h')).length).toBe(count);
  });

  it('a file that holds one long string of hex', async () => {
    const blob = '0f3a'.repeat((1.5 * MB) / 4);
    const text = `function helper(x: string) { return x.length; }\nexport const BLOB = "${blob}";\nexport function use() { return helper(BLOB); }\n`;
    expect(await index({ 'src/big.ts': text })).toBeLessThan(ALLOWED_MS);
    expect(callersOf(named('src/big.ts', 'helper'))).toEqual(['use']);
    expect(named('src/big.ts', 'BLOB').kind).toBe('constant');
  });

  it('a Rust file of `use crate::…` lines, each an import named `crate`', async () => {
    const { text, count } = fill(0.9 * MB, (i) => `use crate::mod${i}::Name${i};\n`, '', '\nfn helper() -> i32 { 1 }\n\nfn run() -> i32 { helper() }\n');
    expect(await index({ 'src/big.rs': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.rs', 'import')).toHaveLength(count);
    expect(callersOf(named('src/big.rs', 'helper'))).toEqual(['run']);
  });

  it('a C# class whose methods call each other through the object', async () => {
    const { text, count } = fill(1.2 * MB, (i) => `  string Thing${i}(string name) {\n    var value = this.Helper(name);\n    return this.Thing${i ? i - 1 : 0}(value);\n  }\n\n`,
      'public class Big {\n  string Helper(string x) { return x; }\n\n', '}\n');
    expect(await index({ 'src/Big.cs': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/Big.cs', 'method')).toHaveLength(count + 1);
    expect(callersOf(named('src/Big.cs', 'Thing5'))).toEqual(['Thing6']);
    expect(cg!.getCallers(named('src/Big.cs', 'Helper').id)).toHaveLength(count);
  });

  it('a Kotlin test class of many small tests', async () => {
    const { text, count } = fill(1.2 * MB, (i) => `    @Test\n    fun thing${i}() {\n        val value = helper(${i})\n        assertEquals(${i}, value)\n    }\n\n`,
      'import kotlin.test.Test\nimport kotlin.test.assertEquals\n\nfun helper(x: Int): Int { return x }\n\nclass BigTest {\n', '}\n');
    expect(await index({ 'src/BigTest.kt': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/BigTest.kt', 'method')).toHaveLength(count);
    expect(cg!.getCallers(named('src/BigTest.kt', 'helper').id)).toHaveLength(count);
  });

  it('a Java file of some hundred thousand imports, which overflowed the stack', async () => {
    const { text, count } = fill(3.9 * MB, (i) => `import pkg.mod${i}.Name${i};\n`, '', '\npublic class Big {\n  static int helper() { return 1; }\n  int run() { return helper(); }\n}\n');
    expect(count).toBeGreaterThan(125_000);
    expect(await index({ 'src/Big.java': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/Big.java', 'import')).toHaveLength(count);
    expect(callersOf(named('src/Big.java', 'helper'))).toEqual(['run']);
  });

  it('a Ruby class near the size limit, its methods calling each other', async () => {
    const { text, count } = fill(3.5 * MB, (i) => `  def thing${i}(name)\n    value = self.helper(name)\n    self.thing${i ? i - 1 : 0}(value)\n  end\n\n`,
      'class Big\n  def helper(x)\n    x\n  end\n\n', 'end\n');
    expect(await index({ 'src/big.rb': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.rb', 'method')).toHaveLength(count + 1);
    expect(callersOf(named('src/big.rb', 'thing5'))).toEqual(['thing6']);
  });

  it('a Java class near the size limit, its methods calling each other', async () => {
    const { text, count } = fill(3.5 * MB, (i) => `  String thing${i}(String name) {\n    String value = helper(name);\n    return thing${i ? i - 1 : 0}(value);\n  }\n\n`,
      'public class Big {\n  static String helper(String x) { return x; }\n\n', '}\n');
    expect(await index({ 'src/Big.java': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/Big.java', 'method')).toHaveLength(count + 1);
    expect(callersOf(named('src/Big.java', 'thing5'))).toEqual(['thing6']);
    expect(cg!.getCallers(named('src/Big.java', 'helper').id)).toHaveLength(count);
  });

  it('a Go constant block of some hundred thousand names', async () => {
    const { text, count } = fill(3 * MB, (i) => `\tMember${i} = ${i}\n`, 'package big\n\nconst (\n', ')\n');
    expect(await index({ 'src/big.go': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.go', 'constant')).toHaveLength(count);
  });

  it('a file that is mostly comment lines', async () => {
    const comments = fill(3.5 * MB, (i) => `# a line of commentary, number ${i}\n`).text;
    const text = `class Big\n  def run(name)\n    helper(name)\n  end\n\n  def helper(name)\n    name\n  end\nend\n${comments}`;
    expect(await index({ 'src/big.rb': text })).toBeLessThan(ALLOWED_MS / 2);
    expect(callersOf(named('src/big.rb', 'helper'))).toEqual(['run']);
  });

  it('a JavaScript file of stores, two of them exported by a later statement', async () => {
    const { text, count } = fill(0.9 * MB, (i) => `const store${i} = create((set) => ({ act${i}: () => set({ n: ${i} }) }));\n`,
      "import { create } from 'zustand';\n\n", '\nexport default store7;\nexport { store9, store11 as renamed };\n');
    expect(await index({ 'src/big.js': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.js').filter((n) => /^store\d+$/.test(n.name))).toHaveLength(count);
    // Only a store the file exports has its actions as functions of their own.
    const actions = inFile('src/big.js').filter((n) => /^act\d+$/.test(n.name)).map((n) => n.name).sort();
    expect(actions).toEqual(['act11', 'act7', 'act9']);
  });
});

describe('the runs of name characters a pattern is not given', () => {
  const run = (length: number) => 'a1.b2'.repeat(Math.ceil(length / 5)).slice(0, length);

  it('leaves a text with no run longer than a name as it is, the same string', () => {
    const text = `const key = "${run(LONGEST_NAME_RUN)}";\nfunction use() { return key; }\n`;
    expect(withoutLongRuns(text)).toBe(text);
  });

  it('blanks a longer run at its length, and nothing around it', () => {
    const long = run(LONGEST_NAME_RUN + 1);
    const text = `const a = "${long}"; const b = "${run(40)}";\nconst c = "${long}";`;
    const read = withoutLongRuns(text);
    expect(read).toHaveLength(text.length);
    expect(read).toBe(text.split(long).join('\u0001'.repeat(long.length)));
    expect(read).toContain(`const b = "${run(40)}";\nconst c = "`);
  });

  it('takes a run to end at a blank, a quote, a bracket, or a character past ASCII', () => {
    const half = run(LONGEST_NAME_RUN / 2 + 1);
    for (const between of [' ', '"', '(', ',', '\n', 'é']) {
      const text = `${half}${between}${half}`;
      expect(withoutLongRuns(text), JSON.stringify(between)).toBe(text);
    }
    // What joins names into one run does not end it.
    for (const between of ['.', ':', '/', '+', '=', '-', '_', '$']) {
      expect(withoutLongRuns(`${half}${between}${half}`), between).toBe('\u0001'.repeat(half.length * 2 + 1));
    }
  });

  it('blanks a run that reaches the end of the text', () => {
    const long = run(LONGEST_NAME_RUN * 3);
    expect(withoutLongRuns(`x = ${long}`)).toBe(`x = ${'\u0001'.repeat(long.length)}`);
  });
});
