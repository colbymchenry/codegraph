/**
 * A parameter's class from its call sites. `table.foreign_key` in rails'
 * `def add_to(table)` went to whatever class is called `Table`, while the one
 * caller of `add_to` passes `self`, a `TableDefinition`.
 *
 * Exact or nothing: a call site that can't be typed, two that disagree, or
 * anything of a shape that could be a call the graph never linked (an untyped
 * receiver, `send`, `&:name`, an alias, a subclass's `super`) leaves the call
 * exactly as resolution answered it. And a sync gives what a fresh index gives
 * when a caller's file changes what the callee's calls mean.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { QueryBuilder } from '../src/db/queries';
import { ParameterFlowQueries } from '../src/db/parameter-flow-queries';
import { ReferenceResolver } from '../src/resolution';
import { rubyParameterFlow } from '../src/resolution/ruby-parameter-flow';
import { MAX_SOURCE_FILE_SIZE_BYTES } from '../src/file-limits';

const REFERENCE = `class Reference
  def add_to(table)
    table.column(:a)
    table.index(:a)
  end
end
`;

const TABLES = `class TableDefinition
  def references(name)
    Reference.new.add_to(self)
  end

  def column(name)
    name
  end

  def index(name)
    name
  end
end

class OtherDefinition
  def column(name)
    name
  end

  def index(name)
    name
  end
end
`;

/** What a guess by the receiver's word finds. */
const GUESS = `class Table
  def column(name)
    name
  end

  def index(name)
    name
  end
end
`;

const BASE: Record<string, string> = {
  'lib/reference.rb': REFERENCE,
  'lib/tables.rb': TABLES,
  'lib/guess.rb': GUESS,
};

const roots: string[] = [];
const open: CodeGraph[] = [];

function write(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function indexed(files: Record<string, string>): Promise<{ root: string; cg: CodeGraph }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parameter-flow-'));
  roots.push(root);
  write(root, files);
  const cg = await CodeGraph.init(root, { index: true });
  open.push(cg);
  return { root, cg };
}

afterEach(() => {
  for (const cg of open.splice(0)) {
    try { cg.close(); } catch { /* closed by the test */ }
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** The qualified name each `calls` edge out of the method reaches, by the reference that made it. */
function callsOf(cg: CodeGraph, file: string, method: string): Record<string, string[]> {
  const nodes = cg.getNodesInFile(file);
  const source = nodes.find((n) => n.qualifiedName === method && n.kind === 'method');
  expect(source, method).toBeDefined();
  const calls: Record<string, string[]> = {};
  for (const e of cg.getOutgoingEdgesFrom([source!.id])) {
    if (e.kind !== 'calls') continue;
    const name = String(e.metadata?.refName);
    (calls[name] ??= []).push(cg.getNode(e.target)!.qualifiedName);
  }
  return calls;
}

const addToCalls = (cg: CodeGraph): Record<string, string[]> => callsOf(cg, 'lib/reference.rb', 'Reference::add_to');
const FLOWED = { 'table.column': ['TableDefinition::column'], 'table.index': ['TableDefinition::index'] };
const GUESSED = { 'table.column': ['Table::column'], 'table.index': ['Table::index'] };

describe('a parameter takes its class from its call sites', () => {
  it('answers a call on the parameter with the method of the class every call passes', async () => {
    const { cg } = await indexed(BASE);
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('beats a guess, and marks the edge as its own', async () => {
    const { cg } = await indexed(BASE);
    const source = cg.getNodesInFile('lib/reference.rb').find((n) => n.name === 'add_to')!;
    const edge = cg.getOutgoingEdgesFrom([source.id]).find((e) => e.metadata?.refName === 'table.column')!;
    expect(edge.metadata).toMatchObject({ resolvedBy: 'instance-method', confidence: 0.9, parameterFlow: 'table' });
  });

  it.each<[string, string]>([
    ['Const.new', `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n`],
    ['Const.new with arguments', `class A\n  def run(x)\n    Reference.new.add_to(OtherDefinition.new(x, [1, 2]))\n  end\nend\n`],
    ['a local assigned one', `class A\n  def run\n    table = OtherDefinition.new\n    Reference.new.add_to(table)\n  end\nend\n`],
    ['a typed instance variable', `class A\n  def initialize\n    @t = OtherDefinition.new\n  end\n\n  def run\n    Reference.new.add_to(@t)\n  end\nend\n`],
    ['a parameter that flows', `class A\n  def run\n    go(OtherDefinition.new)\n  end\n\n  def go(t)\n    Reference.new.add_to(t)\n  end\nend\n`],
    ['a call with no parentheses', `class A\n  def run\n    Reference.new.add_to OtherDefinition.new\n  end\nend\n`],
    ['arguments across lines', `class A\n  def run\n    Reference.new.add_to(\n      OtherDefinition.new,\n    )\n  end\nend\n`],
    ['a chain broken across lines', `class A\n  def run\n    Reference\n      .new\n      .add_to(OtherDefinition.new)\n  end\nend\n`],
    ['a receiver typed by a local', `class A\n  def run\n    r = Reference.new\n    r.add_to(OtherDefinition.new)\n  end\nend\n`],
    ['the argument of a modifier line', `class A\n  def run(flag)\n    Reference.new.add_to OtherDefinition.new if flag\n  end\nend\n`],
  ])('types a value that is %s', async (_shape, caller) => {
    // The only call site, in place of the one that passes `self`.
    const { cg } = await indexed({
      ...BASE,
      'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name'),
      'lib/caller.rb': caller,
    });
    expect(addToCalls(cg)).toEqual({ 'table.column': ['OtherDefinition::column'], 'table.index': ['OtherDefinition::index'] });
  });

  it.each<[string, string, string]>([
    ['past a string with a comma', 'add_to(name, table)', 'add_to("a,b", self)'],
    ['past a call with its own arguments', 'add_to(name, table)', 'add_to(name.to_s(1, 2), self)'],
    ['past a hash', 'add_to(name, table)', 'add_to({ a: 1, b: 2 }, self)'],
    ['before keywords', 'add_to(table, flag: nil)', 'add_to(self, flag: 1)'],
    ['before a block', 'add_to(table)', 'add_to(self) { |x| x }'],
    ['before a block passed on', 'add_to(table, &block)', 'add_to(self, &:to_s)'],
    ['with a default the call overrides', 'add_to(table = nil)', 'add_to(self)'],
  ])('reads an argument %s', async (_shape, declared, called) => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': REFERENCE.replace('add_to(table)', declared),
      'lib/tables.rb': TABLES.replace('add_to(self)', called),
    });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('reads a call on self', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': `class Reference\n  def run\n    self.add_to(TableDefinition.new)\n  end\n\n  def add_to(table)\n    table.column(:a)\n    table.index(:a)\n  end\nend\n`,
      'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name'),
    });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('types a keyword parameter by its keyword', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': REFERENCE.replace('add_to(table)', 'add_to(flag, table:)'),
      'lib/tables.rb': TABLES.replace('add_to(self)', 'add_to(name, table: self)'),
    });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('reads a constant naming a class as the class, and calls its class method', async () => {
    const { cg } = await indexed({
      'lib/reference.rb': `class Reference\n  def add_to(table)\n    table.build(:a)\n  end\nend\n`,
      'lib/tables.rb': `class TableDefinition\n  def build(name)\n    name\n  end\n\n  def self.build(name)\n    name\n  end\nend\n\nclass Table\n  def build(name)\n    name\n  end\nend\n`,
      'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to(TableDefinition)\n  end\nend\n`,
    });
    const source = cg.getNodesInFile('lib/reference.rb').find((n) => n.name === 'add_to')!;
    const edge = cg.getOutgoingEdgesFrom([source.id]).find((e) => e.kind === 'calls')!;
    const target = cg.getNode(edge.target)!;
    expect(target.qualifiedName).toBe('TableDefinition::build');
    expect(target.isStatic).toBe(true);
  });

  it('takes `self` in a class method for the class itself', async () => {
    const { cg } = await indexed({
      'lib/reference.rb': `class Reference\n  def add_to(table)\n    table.build(:a)\n  end\nend\n`,
      'lib/tables.rb': `class TableDefinition\n  def build(name)\n    name\n  end\n\n  def self.build(name)\n    name\n  end\n\n  def self.run\n    Reference.new.add_to(self)\n  end\nend\n\nclass Table\n  def build(name)\n    name\n  end\nend\n`,
    });
    const source = cg.getNodesInFile('lib/reference.rb').find((n) => n.name === 'add_to')!;
    const target = cg.getNode(cg.getOutgoingEdgesFrom([source.id]).find((e) => e.kind === 'calls')!.target)!;
    expect(target.isStatic).toBe(true);
  });

  it('follows a parameter that passes itself back, by the calls from outside the cycle', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': `class Reference\n  def add_to(table)\n    table.column(:a)\n    table.index(:a)\n    add_to(table)\n  end\nend\n`,
    });
    expect(callsOf(cg, 'lib/reference.rb', 'Reference::add_to')).toMatchObject(FLOWED);
  });

  it('reaches a method the class has from its ancestors', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/tables.rb': TABLES.replace('class TableDefinition\n', 'class TableDefinition < OtherDefinition\n')
        .replace(`  def column(name)\n    name\n  end\n\n  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition`, `end\n\nclass OtherDefinition`)
        .replace(/class TableDefinition < OtherDefinition\n([\s\S]*?)end\n\nclass OtherDefinition/, 'class OtherDefinition') +
        `\nclass TableDefinition < OtherDefinition\n  def references(name)\n    Reference.new.add_to(self)\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual({ 'table.column': ['OtherDefinition::column'], 'table.index': ['OtherDefinition::index'] });
  });

  it.each<[string, string]>([
    ['one line', `class Reference\n  def add_to(table) = table.column(:a)\nend\n`],
    ['a body after a semicolon', `class Reference\n  def add_to(table); table.column(:a)\n  end\nend\n`],
    ['a modifier before the def', `class Reference\n  protected def add_to(table)\n    table.column(:a)\n  end\nend\n`],
    ['no parentheses', `class Reference\n  def add_to table\n    table.column(:a)\n  end\nend\n`],
    ['a list across lines', `class Reference\n  def add_to(\n    table,\n    other = nil\n  )\n    table.column(:a)\n  end\nend\n`],
  ])('reads a method written as %s', async (_shape, reference) => {
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': reference });
    expect(addToCalls(cg)['table.column']).toEqual(['TableDefinition::column']);
  });

  it('sees an assignment on the line of the def', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': `class Reference\n  def add_to(table); table = table.first\n    table.column(:a)\n  end\nend\n`,
    });
    expect(addToCalls(cg)['table.column']).toEqual(['Table::column']);
  });

  it('reads no comment as a mention', async () => {
    const { cg } = await indexed({ ...BASE, 'lib/doc.rb': `# Call send(:add_to, table) to attach it.\n#   %i[add_to]\nclass Doc\nend\n` });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });
});

describe('no answer when a call site says nothing', () => {
  it.each<[string, string]>([
    ['two classes', `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n`],
    ['a value of no known class', `class A\n  def run(thing)\n    Reference.new.add_to(thing.table)\n  end\nend\n`],
    ['a parameter nothing types', `class A\n  def run(thing)\n    Reference.new.add_to(thing)\n  end\nend\n`],
    ['a literal', `class A\n  def run\n    Reference.new.add_to(nil)\n  end\nend\n`],
    ['a splat', `class A\n  def run(args)\n    Reference.new.add_to(*args)\n  end\nend\n`],
    ['a block parameter', `class A\n  def run(items)\n    items.each { |t| Reference.new.add_to(t) }\n  end\nend\n`],
    ['a local assigned two classes', `class A\n  def run(flag)\n    t = OtherDefinition.new\n    t = TableDefinition.new if flag\n    Reference.new.add_to(t)\n  end\nend\n`],
    ['a conditional', `class A\n  def run(flag)\n    Reference.new.add_to(flag ? TableDefinition.new : OtherDefinition.new)\n  end\nend\n`],
    ['a constant holding a value', `class A\n  TABLE = OtherDefinition.new\n\n  def run\n    Reference.new.add_to(TABLE)\n  end\nend\n`],
    ['a call on what new made', `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new.tap { |t| t })\n  end\nend\n`],
  ])('leaves the guess when another site passes %s', async (_shape, caller) => {
    const { cg } = await indexed({ ...BASE, 'lib/caller.rb': caller });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it.each<[string, string, string]>([
    ['past a splat', 'add_to(*rest, table)', 'add_to(self)'],
    ['a required one past an optional', 'add_to(flag = nil, table)', 'add_to(self)'],
  ])('reads no place for a parameter %s', async (_shape, declared, called) => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': REFERENCE.replace('add_to(table)', declared),
      'lib/tables.rb': TABLES.replace('add_to(self)', called),
    });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it.each<[string, string]>([
    ['in a module, which runs on whatever includes it', `module A\n  def run\n    Reference.new.add_to(self)\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
    ['in a block run on something else', `class A\n  def run(thing)\n    thing.instance_eval { Reference.new.add_to(self) }\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
    ['in a def inside a block of the class', `class A\n  included do\n    def run\n      Reference.new.add_to(self)\n    end\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
    ['in a def of a class made at runtime', `class A\n  Point = Struct.new(:x) do\n    def run\n      Reference.new.add_to(self)\n    end\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
  ])('says nothing of self %s', async (_shape, caller) => {
    const { cg } = await indexed({
      ...BASE,
      'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name'),
      'lib/caller.rb': caller,
    });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it('leaves the guess when a site passes no argument', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/reference.rb': REFERENCE.replace('add_to(table)', 'add_to(table = nil)'),
      'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it.each<[string, string]>([
    ['a block parameter of the name', `class Reference\n  def add_to(table)\n    [1].each { |table| table.column(:a) }\n    table.index(:a)\n  end\nend\n`],
    ['an assignment', `class Reference\n  def add_to(table)\n    table = table.first\n    table.column(:a)\n    table.index(:a)\n  end\nend\n`],
    ['several assignment', `class Reference\n  def add_to(table)\n    a, table = table\n    table.column(:a)\n    table.index(:a)\n  end\nend\n`],
    ['a rescue', `class Reference\n  def add_to(table)\n    table.column(:a)\n    table.index(:a)\n  rescue StandardError => table\n    nil\n  end\nend\n`],
  ])('leaves the guess when the method rebinds the parameter by %s', async (_shape, reference) => {
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': reference });
    const calls = addToCalls(cg);
    expect(calls['table.column']).toEqual(['Table::column']);
    expect(calls['table.index']).toEqual(['Table::index']);
  });
});

const IVAR_SITE = TABLES.replace('Reference.new.add_to(self)', 'Reference.new.add_to(name)').replace('class TableDefinition\n', 'class Holder\n  def go\n    Reference.new.add_to(@table)\n  end\nend\n\nclass TableDefinition\n');

describe('an instance variable typed in another file', () => {
  it('says nothing: an edit of that file couldn\'t reach the flow', async () => {
    const { cg } = await indexed({
      'lib/reference.rb': REFERENCE,
      'lib/guess.rb': GUESS,
      'lib/tables.rb': IVAR_SITE.replace('Reference.new.add_to(name)', 'name'),
      'lib/holder.rb': 'class Holder\n  def initialize\n    @table = TableDefinition.new\n  end\nend\n',
    });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });
});

describe('no answer when the project may call the method some way the graph never linked', () => {
  it.each<[string, string]>([
    ['a call on an untyped receiver', `class A\n  def run(thing, x)\n    thing.add_to(x)\n  end\nend\n`],
    ['a bare call nothing placed', `module A\n  def run(x)\n    add_to(x)\n  end\nend\n`],
    ['a call in a class body, which the graph records nowhere', `class A\n  Reference.new.add_to(self)\nend\n`],
    ['a call in a block of a class body', `class A\n  test "x" do\n    Reference.new.add_to(1)\n  end\nend\n`],
    ['a call at the top of a file', `Reference.new.add_to(1)\n`],
    ['a spec', `describe Reference do\n  it "adds" do\n    described_class.new.add_to(table)\n  end\nend\n`],
    ['send', `class A\n  def run(x)\n    Reference.new.send(:add_to, x)\n  end\nend\n`],
    ['public_send', `class A\n  def run(x)\n    Reference.new.public_send(:add_to, x)\n  end\nend\n`],
    ['__send__ with a string', `class A\n  def run(x)\n    Reference.new.__send__("add_to", x)\n  end\nend\n`],
    ['method', `class A\n  def run(x)\n    Reference.new.method(:add_to).call(x)\n  end\nend\n`],
    ['a symbol to proc', `class A\n  def run(xs)\n    xs.each(&:add_to)\n  end\nend\n`],
    ['alias', `class Reference\n  alias attach add_to\nend\n`],
    ['alias with symbols', `class Reference\n  alias :attach :add_to\nend\n`],
    ['alias_method', `class Reference\n  alias_method :attach, :add_to\nend\n`],
    ['delegate', `class A\n  delegate :add_to, to: :reference\nend\n`],
    ['a list of symbols', `class A\n  def run(r, x)\n    %i[add_to].each { |m| r.public_send(m, x) }\n  end\nend\n`],
    ['a list of words', `class A\n  def run(r, x)\n    %w(add_to).each { |m| r.public_send(m, x) }\n  end\nend\n`],
    ["a subclass's super", `class Sub < Reference\n  def add_to(table)\n    super\n  end\nend\n`],
    ["a subclass's super with arguments", `class Sub < Reference\n  def add_to(table)\n    super(table)\n  end\nend\n`],
  ])('abstains on %s', async (_shape, extra) => {
    const { cg } = await indexed({ ...BASE, 'lib/extra.rb': extra });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it("counts a subclass's override: a call of it passes the same parameter", async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/sub.rb': `class Sub < Reference\n  def add_to(table)\n    table\n  end\n\n  def run\n    Sub.new.add_to(OtherDefinition.new)\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });
});

describe('a call that is not a caller of this method', () => {
  it('tells a typed call of a same-named method of another class apart', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/other.rb': `class Other\n  def add_to(table)\n    table\n  end\n\n  def run\n    Other.new.add_to(OtherDefinition.new)\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('tells an untyped call apart by its arguments', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/format.rb': `class Format\n  def add_to(buffer, hash)\n    buffer\n  end\n\n  def run(part, buffer, hash)\n    part.add_to(buffer, hash)\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('tells a call on a class from outside apart', async () => {
    const { cg } = await indexed({ ...BASE, 'lib/outside.rb': `class A\n  def run(x)\n    Rack::Utils.add_to(x)\n  end\nend\n` });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });
});

describe('what the pass costs a project', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads nothing of the graph in a project with no Ruby', async () => {
    const outlines = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
    await indexed({ 'src/a.ts': 'export function a(b: { c(): void }) {\n  b.c();\n}\n', 'src/b.py': 'def a(b):\n    b.c()\n' });
    expect(outlines).not.toHaveBeenCalled();
  });

  /** Index `files`, counting how often the whole project's text was read for a flow. */
  async function wholeProjectReads(files: Record<string, string>): Promise<number> {
    let reads = 0;
    const adapter = rubyParameterFlow.adapter.bind(rubyParameterFlow);
    vi.spyOn(rubyParameterFlow, 'adapter').mockImplementation((...args) => {
      const made = adapter(...args);
      const written = made.written.bind(made);
      made.written = (names, files) => {
        reads++;
        return written(names, files);
      };
      return made;
    });
    await indexed(files);
    return reads;
  }

  it('reads the whole project only when a flow would change something', async () => {
    expect(await wholeProjectReads(BASE)).toBe(1);
  });

  it('leaves the whole project unread when no flow changes anything', async () => {
    // The flow finds what resolution already answered, so there is nothing to prove.
    const right = TABLES.replace(/class TableDefinition/, 'class Table').replace(/class OtherDefinition[\s\S]*$/, '');
    expect(await wholeProjectReads({ 'lib/reference.rb': REFERENCE, 'lib/tables.rb': right })).toBe(0);
  });

  it('leaves the whole project unread when nothing types', async () => {
    const untyped = TABLES.replace('add_to(self)', 'add_to(name)');
    expect(await wholeProjectReads({ ...BASE, 'lib/tables.rb': untyped })).toBe(0);
  });
});

describe('what the pass reads of a file', () => {
  const inAddTo = (line: string): string => REFERENCE.replace('    table.column(:a)\n', `    ${line}\n    table.column(:a)\n`);

  it('takes a file over the size limit for nothing, as the index does', async () => {
    // A mention it could read would cost the flow, and reading it costs the heap.
    const mention = 'class Huge\n  def run(name)\n    name.send(:add_to, name)\n  end\nend\n';
    const huge = `${mention}${'# a line of padding, to go over the limit\n'.repeat(30_000)}`;
    expect(Buffer.byteLength(huge)).toBeGreaterThan(MAX_SOURCE_FILE_SIZE_BYTES);
    const { cg } = await indexed({ ...BASE, 'lib/huge.rb': huge });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('counts a mention in a file just under the limit', async () => {
    const mention = 'class Big\n  def run(name)\n    name.send(:add_to, name)\n  end\nend\n';
    const big = `${mention}${'# a line of padding, to go near the limit\n'.repeat(20_000)}`;
    expect(Buffer.byteLength(big)).toBeLessThan(MAX_SOURCE_FILE_SIZE_BYTES);
    const { cg } = await indexed({ ...BASE, 'lib/big.rb': big });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it('takes every word of a line past the cap as bound, so the flow abstains', async () => {
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': inAddTo(`puts "${'x'.repeat(3_000)}", table`) });
    expect(addToCalls(cg)).toEqual(GUESSED);
  });

  it('reads a line short of the cap as it always did', async () => {
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': inAddTo(`puts "${'x'.repeat(1_000)}", table`) });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('gets through an assignment on a line of a third of a megabyte', async () => {
    // `x = a`, spaces, `b`: quadratic in a pattern that looks for the end of the value.
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': inAddTo(`x = a${' '.repeat(320_000)}b`) });
    expect(addToCalls(cg)).toEqual(FLOWED);
  }, 30_000);

  it('gets through a rescue on a line of two thirds of a megabyte', async () => {
    // Each `rescue` looks along the rest of the line for a `=>`.
    const { cg } = await indexed({ ...BASE, 'lib/reference.rb': inAddTo(`x = "${'rescue '.repeat(95_000)}"`) });
    expect(addToCalls(cg)).toEqual(FLOWED);
  }, 30_000);

  it('gets through one line full of a name, and counts it', async () => {
    const full = `puts "${'add_to '.repeat(140_000)}"\n`;
    expect(Buffer.byteLength(full)).toBeLessThan(MAX_SOURCE_FILE_SIZE_BYTES);
    const { cg } = await indexed({ ...BASE, 'lib/full.rb': full });
    expect(addToCalls(cg)).toEqual(GUESSED);
  }, 30_000);

  it('still reads a comment as no mention when it isn\'t the first thing on a file\'s line', async () => {
    const lines = '# add_to in a comment\n  # add_to, indented\n';
    const { cg } = await indexed({ ...BASE, 'lib/comments.rb': lines });
    expect(addToCalls(cg)).toEqual(FLOWED);
  });
});

describe('a failure on the way to the graph', () => {
  afterEach(() => vi.restoreAllMocks());

  /** Throws when the pass writes its first edge, as a full disk would. */
  function failingFlowEdges(): void {
    const insert = QueryBuilder.prototype.insertEdges;
    vi.spyOn(QueryBuilder.prototype, 'insertEdges').mockImplementation(function (this: QueryBuilder, edges) {
      if (edges.some((edge) => edge.metadata?.parameterFlow !== undefined)) throw new Error('stopped');
      return insert.call(this, edges);
    });
  }

  it('leaves the old edge in place, and the next sync finishes the job', async () => {
    failingFlowEdges();
    const { root, cg } = await indexed(BASE);
    expect(addToCalls(cg)).toEqual(GUESSED);
    vi.restoreAllMocks();
    write(root, { 'lib/guess.rb': `# a note\n${GUESS}` });
    await cg.sync();
    expect(addToCalls(cg)).toEqual(FLOWED);
  });

  it('leaves the failed call in place when it was to get its first edge', async () => {
    const names = (text: string): string => text.replace(/TableDefinition/g, 'Frame').replace(/OtherDefinition/g, 'Panel');
    failingFlowEdges();
    const { root, cg } = await indexed({ 'lib/reference.rb': REFERENCE, 'lib/tables.rb': names(TABLES) });
    expect(addToCalls(cg)).toEqual({});
    vi.restoreAllMocks();
    write(root, { 'lib/reference.rb': `# a note\n${REFERENCE}` });
    await cg.sync();
    expect(addToCalls(cg)).toEqual({ 'table.column': ['Frame::column'], 'table.index': ['Frame::index'] });
  });

  it('keeps a guess the flow ruled out when putting it back fails', async () => {
    const tables = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition')
      .replace('class TableDefinition\n', 'class TableDefinition\n  attr_reader :index\n\n');
    const { root, cg } = await indexed({ ...BASE, 'lib/tables.rb': tables });
    expect(addToCalls(cg)).toEqual({ 'table.column': ['TableDefinition::column'] });
    const restore = vi.spyOn(QueryBuilder.prototype, 'replaceResolutionEdgesWithUnresolvedRefs').mockImplementation(() => { throw new Error('stopped'); });
    write(root, { 'lib/caller.rb': 'class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n' });
    await cg.sync();
    restore.mockRestore();
    write(root, { 'lib/guess.rb': `# a note\n${GUESS}` });
    await cg.sync();
    expect(addToCalls(cg)).toEqual(GUESSED);
  });
});

describe('a class with no such method', () => {
  const ATTRIBUTES = `class TableDefinition
  attr_reader :other,
              :index

  def references(name)
    Reference.new.add_to(self)
  end

  def column(name)
    name
  end
end
`;

  it('rules out the guess when the class reads the name as an attribute', async () => {
    const { cg } = await indexed({ ...BASE, 'lib/tables.rb': ATTRIBUTES });
    expect(addToCalls(cg)).toEqual({ 'table.column': ['TableDefinition::column'] });
  });

  it('rules out the guess on a class from outside the project', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/tables.rb': `class Caller\n  def run\n    Reference.new.add_to(StringScanner.new("x"))\n  end\nend\n`,
    });
    expect(addToCalls(cg)).toEqual({});
  });

  it.each<[string, string]>([
    ['it hands the call on', `class TableDefinition\n  extend Forwardable\n  def_delegators :@inner, :index\n\n  def references(name)\n    Reference.new.add_to(self)\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
    ['nothing says why', `class TableDefinition\n  def references(name)\n    Reference.new.add_to(self)\n  end\n\n  def column(name)\n    name\n  end\nend\n`],
  ])('leaves the guess when %s', async (_shape, tables) => {
    const { cg } = await indexed({ ...BASE, 'lib/tables.rb': tables });
    expect(addToCalls(cg)).toEqual({ 'table.column': ['TableDefinition::column'], 'table.index': ['Table::index'] });
  });

  it('gives no answer on a class method of a module-level attribute', async () => {
    const { cg } = await indexed({
      ...BASE,
      'lib/tables.rb': ATTRIBUTES.replace('Reference.new.add_to(self)', 'Reference.new.add_to(TableDefinition)'),
    });
    expect(addToCalls(cg)['table.index']).toEqual(['Table::index']);
  });
});

describe('a sync gives what a fresh index gives', () => {
  /** Every node, edge and parked reference of an index, by natural key. */
  function graphOf(cg: CodeGraph): { edges: string[] } {
    const keys = new Map(
      cg.getFiles()
        .flatMap((file) => cg.getNodesInFile(file.path))
        .map((n) => [n.id, `${n.kind} ${n.filePath}:${n.qualifiedName}:${n.startLine}`] as const),
    );
    const edges = cg.getOutgoingEdgesFrom([...keys.keys()]).map((e) =>
      `${e.kind} ${keys.get(e.source)} -> ${keys.get(e.target) ?? e.target} @${e.line}:${e.column} ${JSON.stringify(e.metadata ?? {})}`);
    return { edges: edges.sort() };
  }

  const FRESH_TIMEOUT = 60_000;

  /** Index `first`, apply `change` to the files, sync, and compare with a fresh index of the result. */
  async function converges(first: Record<string, string>, change: (root: string) => void): Promise<{ synced: CodeGraph; root: string }> {
    const { root, cg } = await indexed(first);
    change(root);
    await cg.sync();
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parameter-flow-fresh-'));
    roots.push(fresh);
    fs.cpSync(root, fresh, { recursive: true, filter: (src) => !src.includes('.codegraph') });
    const rebuilt = await CodeGraph.init(fresh, { index: true });
    open.push(rebuilt);
    expect(graphOf(cg)).toEqual(graphOf(rebuilt));
    return { synced: cg, root };
  }

  it('runs for a sync that touches the language, and no other', async () => {
    const { root, cg } = await indexed({ ...BASE, 'lib/app.ts': 'export const a = 1;\n' });
    const read = vi.spyOn(ParameterFlowQueries.prototype, 'getFilePathsByLanguage');
    write(root, { 'lib/app.ts': 'export const a = 2;\n' });
    await cg.sync();
    expect(read).not.toHaveBeenCalled();
    write(root, { 'lib/reference.rb': `${REFERENCE}\n` });
    await cg.sync();
    expect(read).toHaveBeenCalled();
    read.mockRestore();
  }, FRESH_TIMEOUT);

  it('a second call site passing another class takes the flow away', async () => {
    const { synced } = await converges(BASE, (root) => write(root, {
      'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n`,
    }));
    expect(addToCalls(synced)).toEqual(GUESSED);
  }, FRESH_TIMEOUT);

  it('removing the only call site takes the flow away', async () => {
    const { synced } = await converges(BASE, (root) => write(root, {
      'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name'),
    }));
    expect(addToCalls(synced)).toEqual(GUESSED);
  }, FRESH_TIMEOUT);

  it('deleting the file of the only call site takes the flow away', async () => {
    const files = { ...BASE, 'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name'), 'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n` };
    const { synced } = await converges(files, (root) => fs.rmSync(path.join(root, 'lib/caller.rb')));
    expect(addToCalls(synced)).toEqual(GUESSED);
  }, FRESH_TIMEOUT);

  it('changing what the call site passes moves the edges', async () => {
    const { synced } = await converges(BASE, (root) => write(root, {
      'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'Reference.new.add_to(OtherDefinition.new)'),
    }));
    expect(addToCalls(synced)).toEqual({ 'table.column': ['OtherDefinition::column'], 'table.index': ['OtherDefinition::index'] });
  }, FRESH_TIMEOUT);

  it('a call site that starts passing a known class brings the flow', async () => {
    const start = { ...BASE, 'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'Reference.new.add_to(name)') };
    const { synced } = await converges(start, (root) => write(root, { 'lib/tables.rb': TABLES }));
    expect(addToCalls(synced)).toEqual(FLOWED);
  }, FRESH_TIMEOUT);

  it('a mention in a third file takes the flow away, and removing it brings the flow back', async () => {
    const mention = { 'lib/extra.rb': `class A\n  def run(r, x)\n    r.send(:add_to, x)\n  end\nend\n` };
    const { root, synced } = await converges(BASE, (dir) => write(dir, mention));
    expect(addToCalls(synced)).toEqual(GUESSED);
    fs.rmSync(path.join(root, 'lib/extra.rb'));
    await synced.sync();
    expect(addToCalls(synced)).toEqual(FLOWED);
  }, FRESH_TIMEOUT);

  it('an edit of the method itself keeps the flow', async () => {
    const { synced } = await converges(BASE, (root) => write(root, {
      'lib/reference.rb': REFERENCE.replace('table.index(:a)', 'table.index(:b)\n    table.column(:b)'),
    }));
    expect(addToCalls(synced)['table.index']).toEqual(['TableDefinition::index']);
  }, FRESH_TIMEOUT);

  it('removing the method the flow reached puts the call back through resolution', async () => {
    const { synced } = await converges(BASE, (root) => write(root, {
      'lib/tables.rb': TABLES.replace('  def column(name)\n    name\n  end\n\n', ''),
    }));
    expect(addToCalls(synced)['table.column']).toEqual(['Table::column']);
  }, FRESH_TIMEOUT);

  it('a guess the flow ruled out comes back when the flow goes', async () => {
    const tables = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition')
      .replace('class TableDefinition\n', 'class TableDefinition\n  attr_reader :index\n\n');
    const { root, synced } = await converges({ ...BASE, 'lib/tables.rb': tables }, (dir) => write(dir, {
      'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to(OtherDefinition.new)\n  end\nend\n`,
    }));
    expect(addToCalls(synced)).toEqual(GUESSED);
    fs.rmSync(path.join(root, 'lib/caller.rb'));
    await synced.sync();
    expect(addToCalls(synced)).toEqual({ 'table.column': ['TableDefinition::column'] });
  }, FRESH_TIMEOUT);

  it('a guess the flow ruled out stays out across a sync of something else', async () => {
    const tables = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition')
      .replace('class TableDefinition\n', 'class TableDefinition\n  attr_reader :index\n\n');
    const { synced } = await converges({ ...BASE, 'lib/tables.rb': tables }, (dir) => write(dir, { 'lib/unrelated.rb': 'class Unrelated\nend\n' }));
    expect(addToCalls(synced)).toEqual({ 'table.column': ['TableDefinition::column'] });
  }, FRESH_TIMEOUT);

  it('a call on a parameter that had no edge goes back to failed when its flow goes', async () => {
    const names = (text: string): string => text.replace(/TableDefinition/g, 'Frame').replace(/OtherDefinition/g, 'Panel');
    const { cg: before } = await indexed({ 'lib/reference.rb': REFERENCE, 'lib/tables.rb': names(TABLES) });
    expect(addToCalls(before)).toEqual({ 'table.column': ['Frame::column'], 'table.index': ['Frame::index'] });
    const { synced } = await converges({ 'lib/reference.rb': REFERENCE, 'lib/tables.rb': names(TABLES) }, (root) => write(root, {
      'lib/caller.rb': `class A\n  def run\n    Reference.new.add_to(Panel.new)\n  end\nend\n`,
    }));
    expect(addToCalls(synced)).toEqual({});
  }, FRESH_TIMEOUT);

  describe('from what the last pass recorded', () => {
    const CALLER = `class Caller
  def run(name)
    name
  end

  def other(name)
    name
  end
end
`;
    /** A class no flow reads, for what a test leaves alone or writes into. */
    const WITH_CALLER: Record<string, string> = { ...BASE, 'lib/caller.rb': CALLER };

    /** Index `first`, apply `change`, sync and compare with a fresh index; `looked` says how the pass went. */
    async function synced(first: Record<string, string>, change: (root: string) => void): Promise<{ cg: CodeGraph; root: string; looked: 'the change' | 'the project'; files: number }> {
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      const { root, cg } = await indexed(first);
      project.mockClear();
      const adapter = rubyParameterFlow.adapter.bind(rubyParameterFlow);
      let files = 0;
      const made = vi.spyOn(rubyParameterFlow, 'adapter').mockImplementation((...args) => {
        const flow = adapter(...args);
        const written = flow.written.bind(flow);
        flow.written = (names, list) => {
          files = Math.max(files, list.length);
          return written(names, list);
        };
        return flow;
      });
      change(root);
      await cg.sync();
      const looked = project.mock.calls.length > 0 ? 'the project' : 'the change';
      project.mockRestore();
      made.mockRestore();
      const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parameter-flow-fresh-'));
      roots.push(fresh);
      fs.cpSync(root, fresh, { recursive: true, filter: (src) => !src.includes('.codegraph') });
      const rebuilt = await CodeGraph.init(fresh, { index: true });
      open.push(rebuilt);
      expect(graphOf(cg)).toEqual(graphOf(rebuilt));
      return { cg, root, looked, files };
    }

    const record = (cg: CodeGraph): string | null => (cg as unknown as { queries: QueryBuilder }).queries.getMetadata('parameter_flow_record_ruby');
    const setRecord = (cg: CodeGraph, value: string): void => (cg as unknown as { queries: QueryBuilder }).queries.setMetadata('parameter_flow_record_ruby', value);

    it('reads no file but the changed one, and leaves the flow', async () => {
      const { cg, looked, files } = await synced(WITH_CALLER, (root) => write(root, { 'lib/caller.rb': `# a note\n${CALLER}` }));
      expect(looked).toBe('the change');
      expect(files).toBe(1);
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('puts a flow back on an edit that lands its edges elsewhere', async () => {
      // The method and its edges are re-extracted, so they come back as guesses.
      const { cg, looked } = await synced(WITH_CALLER, (root) => write(root, { 'lib/reference.rb': `# a note\n${REFERENCE}` }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('moves a flow with the method it reached, when only that file changes', async () => {
      const files = {
        'lib/reference.rb': REFERENCE,
        'lib/tables.rb': `class TableDefinition\n  def references(name)\n    Reference.new.add_to(self)\n  end\nend\n`,
        'lib/columns.rb': `class TableDefinition\n  def column(name)\n    name\n  end\n\n  def index(name)\n    name\n  end\nend\n`,
        'lib/guess.rb': GUESS,
      };
      const { cg, looked } = await synced(files, (root) => write(root, { 'lib/columns.rb': `# a note\n${files['lib/columns.rb']}` }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('moves a flow off a method that moves to another class of the file', async () => {
      const index = '  def index(name)\n    name\n  end\n';
      const column = 'class TableDefinition\n  def column(name)\n    name\n  end\n';
      const spare = 'class Spare\n  def spare\n    1\n  end\n';
      const files = {
        'lib/reference.rb': REFERENCE,
        'lib/tables.rb': 'class TableDefinition\n  def references(name)\n    Reference.new.add_to(self)\n  end\nend\n',
        'lib/columns.rb': `${column}\n${index}end\n\n${spare}end\n`,
        'lib/guess.rb': GUESS,
      };
      const moved = `${column}end\n\n${spare}\n${index}end\n`;
      const { cg, looked } = await synced(files, (root) => write(root, { 'lib/columns.rb': moved }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual({ 'table.column': ['TableDefinition::column'], 'table.index': ['Table::index'] });
    }, FRESH_TIMEOUT);

    it('keeps a flow when a second call passes the same class', async () => {
      const { cg, looked } = await synced(WITH_CALLER, (root) => write(root, {
        'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    Reference.new.add_to(TableDefinition.new)'),
      }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('takes a flow away when a new call in an existing file passes something unknown', async () => {
      const { cg } = await synced(WITH_CALLER, (root) => write(root, {
        'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    Reference.new.add_to(name)'),
      }));
      expect(addToCalls(cg)).toEqual(GUESSED);
    }, FRESH_TIMEOUT);

    it('takes a flow away, and brings it back, when the only mention comes and goes', async () => {
      const mention = CALLER.replace('def run(name)\n    name', 'def run(name)\n    name.send(:add_to, name)');
      const added = await synced(WITH_CALLER, (root) => write(root, { 'lib/caller.rb': mention }));
      expect(added.looked).toBe('the change');
      expect(added.files).toBe(1);
      expect(addToCalls(added.cg)).toEqual(GUESSED);

      const removed = await synced({ ...WITH_CALLER, 'lib/caller.rb': mention }, (root) => write(root, { 'lib/caller.rb': CALLER }));
      expect(removed.looked).toBe('the change');
      expect(removed.files).toBe(1);
      expect(addToCalls(removed.cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('counts a mention in a class body, which the graph records nowhere', async () => {
      const inBody = CALLER.replace('class Caller\n', 'class Caller\n  alias_method :other_add_to, :add_to\n');
      const added = await synced(WITH_CALLER, (root) => write(root, { 'lib/caller.rb': inBody }));
      expect(added.looked).toBe('the change');
      expect(addToCalls(added.cg)).toEqual(GUESSED);
      const removed = await synced({ ...WITH_CALLER, 'lib/caller.rb': inBody }, (root) => write(root, { 'lib/caller.rb': CALLER }));
      expect(removed.looked).toBe('the change');
      expect(addToCalls(removed.cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('stops counting a mention when its file goes', async () => {
      const mention = { ...WITH_CALLER, 'lib/mention.rb': 'puts "add_to"\n' };
      const { cg, looked } = await synced(mention, (root) => fs.rmSync(path.join(root, 'lib/mention.rb')));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('finds the flow of a method that had no call until this one', async () => {
      const uncalled = { ...WITH_CALLER, 'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'name') };
      const { cg, looked } = await synced(uncalled, (root) => write(root, { 'lib/tables.rb': TABLES }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('finds the flow of a method a file starts to declare', async () => {
      const without = { ...WITH_CALLER, 'lib/reference.rb': 'class Reference\n  def other(name)\n    name\n  end\nend\n' };
      const { cg, looked } = await synced(without, (root) => write(root, {
        'lib/reference.rb': REFERENCE.replace('class Reference\n', 'class Reference\n  def other(name)\n    name\n  end\n\n'),
      }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('finds the flow a removed call was all that stood in the way of', async () => {
      const blocked = { ...WITH_CALLER, 'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    Reference.new.add_to(name)') };
      const { cg } = await synced(blocked, (root) => write(root, { 'lib/caller.rb': CALLER }));
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('finds the flow a call that now fits no longer stood in the way of', async () => {
      const untyped = CALLER.replace('def run(name)\n    name', 'def run(name)\n    name.add_to(name)');
      const { cg } = await synced({ ...WITH_CALLER, 'lib/caller.rb': untyped }, (root) => write(root, {
        'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    name.add_to(name, name)'),
      }));
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('finds the flow an edit of a same-named method stops: a `super`', async () => {
      const files = { ...WITH_CALLER, 'lib/caller.rb': `${CALLER}\nclass Sub < Reference\n  def add_to(table)\n    table\n  end\nend\n` };
      const { cg } = await synced(files, (root) => write(root, { 'lib/caller.rb': files['lib/caller.rb']!.replace('    table\n  end\nend\n', '    super\n  end\nend\n') }));
      expect(addToCalls(cg)).toEqual(GUESSED);
    }, FRESH_TIMEOUT);

    it('follows a flow through a method a changed file only reaches by a chain', async () => {
      const chain = {
        'lib/reference.rb': `class Reference\n  def add_to(table)\n    table.column(:a)\n    table.index(:a)\n  end\n\n  def relay(table)\n    add_to(table)\n  end\nend\n`,
        'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'Reference.new.relay(name)'),
        'lib/guess.rb': GUESS,
      };
      const { cg } = await synced(chain, (root) => write(root, { 'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'Reference.new.relay(self)') }));
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('follows a flow through a function that only passes it on', async () => {
      const chain = {
        'lib/reference.rb': REFERENCE,
        'lib/relay.rb': 'def relay(table)\n  Reference.new.add_to(table)\nend\n',
        'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'relay(name)'),
        'lib/guess.rb': GUESS,
      };
      const { cg } = await synced(chain, (root) => write(root, { 'lib/tables.rb': TABLES.replace('Reference.new.add_to(self)', 'relay(self)') }));
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('sees a call of a method the sync just defined', async () => {
      // No method was called this, so nothing looked at the parameter, and the
      // changed file says nothing of the method whose call it is.
      const part = 'class TableDefinition\n  def part\n    1\n  end\nend\n';
      const files = { ...BASE, 'lib/reference.rb': 'class Reference\n  def add_to(table)\n    table.resize(:a)\n  end\nend\n', 'lib/part.rb': part };
      const { cg, looked } = await synced(files, (root) => write(root, {
        'lib/part.rb': part.replace('  def part', '  def resize(name)\n    name\n  end\n\n  def part'),
      }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual({ 'table.resize': ['TableDefinition::resize'] });
    }, FRESH_TIMEOUT);

    it('sees a method the flow reaches appear on its class', async () => {
      const without = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition');
      const { cg, looked } = await synced({ ...BASE, 'lib/tables.rb': without }, (root) => write(root, { 'lib/tables.rb': TABLES }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('rules out a guess, and takes that back, when the class starts and stops reading the name', async () => {
      const without = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition');
      const reading = without.replace('class TableDefinition\n', 'class TableDefinition\n  attr_reader :index\n\n');
      const added = await synced({ ...BASE, 'lib/tables.rb': without }, (root) => write(root, { 'lib/tables.rb': reading }));
      expect(addToCalls(added.cg)).toEqual({ 'table.column': ['TableDefinition::column'] });
      const removed = await synced({ ...BASE, 'lib/tables.rb': reading }, (root) => write(root, { 'lib/tables.rb': without }));
      expect(addToCalls(removed.cg)).toEqual({ 'table.column': ['TableDefinition::column'], 'table.index': ['Table::index'] });
    }, FRESH_TIMEOUT);

    it('does the same when another file of the class reads the name', async () => {
      const without = TABLES.replace('  def index(name)\n    name\n  end\nend\n\nclass OtherDefinition', 'end\n\nclass OtherDefinition');
      const part = 'class TableDefinition\n  def part\n    1\n  end\nend\n';
      const files = { ...BASE, 'lib/tables.rb': without, 'lib/part.rb': part };
      const { cg, looked } = await synced(files, (root) => write(root, { 'lib/part.rb': part.replace('  def part', '  attr_reader :index\n\n  def part') }));
      expect(looked).toBe('the change');
      expect(addToCalls(cg)).toEqual({ 'table.column': ['TableDefinition::column'] });
    }, FRESH_TIMEOUT);

    it.each<[string, Record<string, string>, (root: string) => void]>([
      ['a class it reads appears', BASE, (root) => write(root, { 'lib/new.rb': 'class Unseen\nend\n' })],
      ['a constant appears', WITH_CALLER, (root) => write(root, { 'lib/caller.rb': `LIMIT = 1\n${CALLER}` })],
      ['a superclass changes', { ...WITH_CALLER, 'lib/caller.rb': `class A\nend\n\nclass B < A\nend\n` }, (root) => write(root, { 'lib/caller.rb': `class A\nend\n\nclass B\nend\n` })],
      ['a mixin goes', { ...WITH_CALLER, 'lib/caller.rb': `module M\nend\n\nclass B\n  include M\nend\n` }, (root) => write(root, { 'lib/caller.rb': `module M\nend\n\nclass B\nend\n` })],
      ['two mixins change places', { ...WITH_CALLER, 'lib/caller.rb': `module M\nend\nmodule N\nend\n\nclass B\n  include M\n  include N\nend\n` }, (root) => write(root, { 'lib/caller.rb': `module M\nend\nmodule N\nend\n\nclass B\n  include N\n  include M\nend\n` })],
      ['a module becomes a class', { ...WITH_CALLER, 'lib/caller.rb': 'module M\nend\n' }, (root) => write(root, { 'lib/caller.rb': 'class M\nend\n' })],
    ])('starts over when %s', async (_, files, change) => {
      const { cg, looked } = await synced(files, change);
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    const HOLDER_INIT = '  def initialize\n    @table = TableDefinition.new\n  end\n\n';

    it('follows an instance variable when its `initialize` moves into another file of the class', async () => {
      const here = IVAR_SITE.replace('Reference.new.add_to(name)', 'name').replace('class Holder\n', `class Holder\n${HOLDER_INIT}`);
      const { cg, looked } = await synced({ 'lib/reference.rb': REFERENCE, 'lib/guess.rb': GUESS, 'lib/tables.rb': here }, (root) => write(root, {
        'lib/holder.rb': `class Holder\n${HOLDER_INIT}end\n`,
      }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(GUESSED);
    }, FRESH_TIMEOUT);

    it('follows an instance variable when the other `initialize` of its class goes', async () => {
      const here = IVAR_SITE.replace('Reference.new.add_to(name)', 'name').replace('class Holder\n', `class Holder\n${HOLDER_INIT}`);
      const files = { 'lib/reference.rb': REFERENCE, 'lib/guess.rb': GUESS, 'lib/tables.rb': here, 'lib/holder.rb': `class Holder\n${HOLDER_INIT}  def other(name)\n    name\n  end\nend\n` };
      const { cg, looked } = await synced(files, (root) => write(root, { 'lib/holder.rb': 'class Holder\n  def other(name)\n    name\n  end\nend\n' }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);

    it('starts over for the count of a flow that moves a call for the first time', async () => {
      // Resolution answers the one call as the flow does, so nothing counted the name.
      const tables = 'class TableDefinition\n  def references(name)\n    Reference.new.add_to(self)\n  end\n\n  def both(name)\n    name\n  end\n\n  def column(name)\n    name\n  end\nend\n';
      const files = {
        'lib/reference.rb': 'class Reference\n  def add_to(table)\n    table.both(:a)\n  end\nend\n',
        'lib/tables.rb': tables,
        'lib/guess.rb': GUESS,
        'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    name.send(:add_to, name)'),
      };
      const { cg, looked } = await synced(files, (root) => write(root, {
        'lib/reference.rb': files['lib/reference.rb'].replace('table.both(:a)', 'table.both(:a)\n    table.column(:a)'),
      }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)['table.column']).toEqual(['Table::column']);
    }, FRESH_TIMEOUT);

    it('finds a flow an ancestor gave a same-named method a say in', async () => {
      const files = { ...WITH_CALLER, 'lib/caller.rb': `class Sub < Object\n  def add_to(table)\n    table\n  end\nend\n\nclass Call\n  def go\n    Sub.new.add_to(name)\n  end\nend\n` };
      const { cg, looked } = await synced(files, (root) => write(root, { 'lib/caller.rb': files['lib/caller.rb']!.replace('class Sub < Object', 'class Sub < Reference') }));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(GUESSED);
    }, FRESH_TIMEOUT);

    it.each<[string, string]>([
      ['none', ''],
      ['one it can\'t read', 'not json'],
      ['one of another shape', '{"flows":[{"names":[]}],"written":[]}'],
    ])('starts over with %s on record', async (_, value) => {
      const { root, cg } = await indexed(WITH_CALLER);
      setRecord(cg, value);
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      write(root, { 'lib/reference.rb': `# a note\n${REFERENCE}` });
      await cg.sync();
      expect(project).toHaveBeenCalled();
      project.mockRestore();
      expect(addToCalls(cg)).toEqual(FLOWED);
      expect(JSON.parse(record(cg)!).flows.length).toBeGreaterThan(0);
    }, FRESH_TIMEOUT);

    it('leaves no record behind a sync that stops short of its pass, so the next starts over', async () => {
      const { root, cg } = await indexed(WITH_CALLER);
      const stop = vi.spyOn(ReferenceResolver.prototype, 'resolveParameterFlows').mockRejectedValueOnce(new Error('stopped'));
      write(root, { 'lib/caller.rb': CALLER.replace('def run(name)\n    name', 'def run(name)\n    name.send(:add_to, name)') });
      await expect(cg.sync()).rejects.toThrow('stopped');
      stop.mockRestore();
      expect(record(cg)).toBe('');
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      write(root, { 'lib/guess.rb': `# a note\n${GUESS}` });
      await cg.sync();
      expect(project).toHaveBeenCalled();
      project.mockRestore();
      expect(addToCalls(cg)).toEqual(GUESSED);
    }, FRESH_TIMEOUT);

    it.each<[string, string]>([
      ['was killed', 'indexing'],
      ['failed', 'failed'],
    ])('starts over after an index that %s', async (_, state) => {
      const { root, cg } = await indexed(WITH_CALLER);
      (cg as unknown as { queries: QueryBuilder }).queries.setMetadata('index_state', state);
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      write(root, { 'lib/reference.rb': `# a note\n${REFERENCE}` });
      await cg.sync();
      expect(project).toHaveBeenCalled();
      project.mockRestore();
    }, FRESH_TIMEOUT);

    it('starts over when references were left pending', async () => {
      const { root, cg } = await indexed(WITH_CALLER);
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      queries.insertUnresolvedRefsBatch([{ fromNodeId: cg.getNodesInFile('lib/caller.rb')[0]!.id, referenceName: 'pending', referenceKind: 'calls', line: 1, column: 0, filePath: 'lib/caller.rb', language: 'ruby' }]);
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      write(root, { 'lib/reference.rb': `# a note\n${REFERENCE}` });
      await cg.sync();
      expect(project).toHaveBeenCalled();
      project.mockRestore();
    }, FRESH_TIMEOUT);

    it('runs the pass an interrupted sync owed, even for a change of another language', async () => {
      const { root, cg } = await indexed({ ...WITH_CALLER, 'lib/app.ts': 'export const a = 1;\n' });
      setRecord(cg, '');
      const project = vi.spyOn(ParameterFlowQueries.prototype, 'getReachedMethods');
      write(root, { 'lib/app.ts': 'export const a = 2;\n' });
      await cg.sync();
      expect(project).toHaveBeenCalled();
      project.mockRestore();
      expect(record(cg)).not.toBe('');
    }, FRESH_TIMEOUT);

    it('leaves a sync of no flow\'s language alone', async () => {
      const { root, cg } = await indexed({ ...WITH_CALLER, 'lib/app.ts': 'export const a = 1;\n' });
      const before = record(cg);
      write(root, { 'lib/app.ts': 'export const a = 2;\n' });
      await cg.sync();
      expect(record(cg)).toBe(before);
    }, FRESH_TIMEOUT);

    it('starts over rather than walk a sync through more files than a pass would read', async () => {
      const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`lib/many/f${i}.rb`, '# one\n']));
      const { cg, looked } = await synced({ ...WITH_CALLER, ...many }, (root) => write(root, Object.fromEntries(Object.keys(many).map((file) => [file, '# two\n']))));
      expect(looked).toBe('the project');
      expect(addToCalls(cg)).toEqual(FLOWED);
    }, FRESH_TIMEOUT);
  });
});
