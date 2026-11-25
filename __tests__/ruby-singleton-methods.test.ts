/**
 * A Ruby class method — `def self.build`, `def Widget.build`, or a `def`
 * inside `class << self` — is the class's own, not one its instances answer
 * to. They were indexed as instance methods under the same qualified name as
 * an instance method of that name (`Widget::build` twice), so a call picked
 * whichever the class declared first: `Widget.build` could land on
 * `def build`, and `widget.build` on `def self.build`. Class methods are now
 * marked static, and a call reaches the one of the right kind: a call on the
 * class (`Widget.build`, `Billing::Payout.call`) its class method, a call on
 * an instance (`w = Widget.new; w.build`) its instance method, and a bare
 * call the one of the calling method's kind. Only such pairs are split: a
 * block may run on another object, so a bare call with no same-named method
 * of the other kind keeps the target it had. A receiver known by its name
 * alone (`widget.build`) may hold the class itself, so it splits nothing.
 *
 * Runs on the native kernel (skipped when none is built) and the wasm
 * extractor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel } from '../src/extraction/kernel/loader';

const FILES: Record<string, string> = {
  // The instance method first, so declaration order alone picks it.
  'app/widget.rb': `class Widget
  def build
    self
  end

  def self.build(opts)
    new
  end

  class << self
    def make
      new
    end

    def build_all
      build(1)
    end
  end

  def run
    build
    Widget.build(1)
  end

  def self.go
    build(2)
  end
end
`,
  'app/user.rb': `class User
  def x
    w = Widget.new
    w.build
    Widget.build(3)
    Widget.make
  end
end
`,
  // #2503's control: an instance of a class whose class method comes first.
  'app/services/billing/charge_card.rb': `module Billing
  class ChargeCard
    def self.call(**kw) = new(**kw).call
    def initialize(amount:) = @amount = amount
    def call = @amount
  end
end
`,
  // A class method's block (a test DSL's) calls what an instance method and a
  // top-level function are both named: no pair of one class, so no split.
  'app/spec_like.rb': `class SpecLike
  def self.parses
    run_case do
      mock_app
    end
  end

  def mock_app = 1
end
`,
  'app/helpers.rb': `def mock_app = 2
`,
  // A receiver named after a class that holds classes, as rubocop's
  // `cop.cop_name` over its registry's cop classes does.
  'app/cop.rb': `class Cop
  def self.cop_name = 'Style/Foo'
  def cop_name = self.class.cop_name
end
`,
  'app/registry.rb': `class Registry
  def names(cops)
    cops.map { |cop| cop.cop_name }
  end
end
`,
  // A namespaced class whose instance method comes first.
  'app/services/billing/payout.rb': `module Billing
  class Payout
    def call = 1
    def self.call(**kw) = new.call
  end
end
`,
  'app/services/checkout/start.rb': `module Checkout
  class Start
    def call
      card = Billing::ChargeCard.new(amount: 3)
      card.call
      Billing::Payout.call(amount: 4)
      payout = Billing::Payout.new
      payout.call
    end
  end
end
`,
};

let root = '';
let cg: CodeGraph | undefined;
let savedKernel: string | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
  if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = savedKernel;
});

async function index(backend: string): Promise<CodeGraph> {
  savedKernel = process.env.CODEGRAPH_KERNEL;
  if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
  else delete process.env.CODEGRAPH_KERNEL;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-singleton-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `<qualified name>:<line>` of the method each `calls` edge written on `line` of `file` reaches. */
function callsAt(graph: CodeGraph, file: string, line: number): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return graph.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls' && e.line === line)
    .map((e) => { const t = graph.getNode(e.target)!; return `${t.qualifiedName}:${t.startLine}`; })
    .sort();
}

const backends = [
  ['kernel', getKernel() === null],
  ['wasm', false],
] as const;

describe.each(backends)('Ruby class methods (%s)', (backend, skip) => {
  it.skipIf(skip)('are static, and instance methods are not', async () => {
    const graph = await index(backend);
    const statics = graph.getNodesInFile('app/widget.rb')
      .filter((n) => n.kind === 'method')
      .map((n) => `${n.name}:${n.startLine}:${n.isStatic === true ? 'static' : 'instance'}`)
      .sort();
    expect(statics).toEqual([
      'build:2:instance',
      'build:6:static',
      'build_all:15:static',
      'go:25:static',
      'make:11:static',
      'run:20:instance',
    ]);
  });

  it.skipIf(skip)('a call on the class reaches its class method', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/user.rb', 5)).toEqual(['Widget::build:6']);
    expect(callsAt(graph, 'app/user.rb', 6)).toEqual(['Widget::make:11']);
    expect(callsAt(graph, 'app/widget.rb', 22)).toEqual(['Widget::build:6']);
    expect(callsAt(graph, 'app/services/checkout/start.rb', 6)).toEqual(['Billing::Payout::call:4']);
  });

  it.skipIf(skip)('a call on an instance reaches its instance method', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/user.rb', 4)).toEqual(['Widget::build:2']);
    expect(callsAt(graph, 'app/services/checkout/start.rb', 5)).toEqual(['Billing::ChargeCard::call:5']);
    expect(callsAt(graph, 'app/services/checkout/start.rb', 8)).toEqual(['Billing::Payout::call:3']);
  });

  it.skipIf(skip)('a bare call reaches the method of the calling method kind', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/widget.rb', 21)).toEqual(['Widget::build:2']);
    expect(callsAt(graph, 'app/widget.rb', 26)).toEqual(['Widget::build:6']);
    expect(callsAt(graph, 'app/widget.rb', 16)).toEqual(['Widget::build:6']);
  });

  it.skipIf(skip)('a receiver known by its name alone splits nothing: it may hold the class', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/registry.rb', 3)).toEqual(['Cop::cop_name:2']);
  });

  it.skipIf(skip)('a bare call with no method of the other kind by its name keeps its target', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/spec_like.rb', 4)).toEqual(['SpecLike::mock_app:8']);
  });
});
