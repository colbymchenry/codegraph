/**
 * A Ruby call on a constant written with its namespace —
 * `Billing::ChargeCard.call(…)`, `::Foo.call` — depends on the class it names
 * and calls that class's method, as `ChargeCard.call(…)` already did (#2503).
 * The constant is the one Ruby's lookup finds from where it is written: the
 * nearest namespace around the call that declares it, then the top level; a
 * name written from the top level (`::Foo`) is looked up there only. A
 * constant the project doesn't declare is a library's (`ActiveRecord::Base`)
 * and links nothing, never a project class or method sharing its last name.
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
  // The issue's three files.
  'app/services/billing/charge_card.rb': `module Billing
  class ChargeCard
    def self.call(**kw) = new(**kw).call
    def initialize(amount:) = @amount = amount
    def call = @amount
  end
end
`,
  'app/services/checkout/complete.rb': `module Checkout
  class Complete
    def call
      Billing::ChargeCard.call(amount: 1)
    end
  end
end
`,
  'app/services/billing/refund.rb': `module Billing
  class Refund
    def call
      ChargeCard.call(amount: 2)
    end
  end
end
`,
  // One class name in two namespaces: the caller names which one it means.
  'app/billing/create.rb': `module Billing
  class Create
    def self.call = 1
  end
end
`,
  'app/users/create.rb': `module Users
  class Create
    def self.call = 2
  end
end
`,
  'app/foo.rb': `class Foo
  def self.call = 3
end
`,
  'app/svc/foo.rb': `module Svc
  class Foo
    def self.call = 4
  end
end
`,
  'app/svc/runner.rb': `module Svc
  class Runner
    def billing = Billing::Create.call
    def users = Users::Create.call
    def users_safe = Users::Create&.call
    def rooted = ::Billing::Create.call
    def rooted_top = ::Foo.call
  end
end
`,
  // The same relative name under two API versions: the one around the call.
  'app/api/v1/users/create.rb': `module Api
  module V1
    module Users
      class Create
        def self.call = 5
      end
    end
  end
end
`,
  'app/api/v2/users/create.rb': `module Api
  module V2
    module Users
      class Create
        def self.call = 6
      end
    end
  end
end
`,
  'app/api/v2/users_controller.rb': `module Api
  module V2
    class UsersController
      def create
        Users::Create.call
      end
    end
  end
end
`,
  // A library constant whose last name a project class shares.
  'app/base.rb': `class Base
  def self.transaction = 7
end
`,
  'app/models/order.rb': `class Order
  def save!
    ActiveRecord::Base.transaction { }
    Stripe::Charge.create(amount: 1)
  end
end
`,
  // A test's stand-in for a library class, which production code never reaches.
  'spec/support/stripe.rb': `module Stripe
  class Charge
    def self.create(**) = 9
  end
end
`,
  'spec/models/order_spec.rb': `class OrderSpec
  def test_charge
    Stripe::Charge.create(amount: 1)
  end
end
`,
  // A module's method, a class method a superclass declares, a class declared
  // with a compact name, a method the class doesn't declare, a constant value.
  'app/billing/helpers.rb': `module Billing
  module Helpers
    def self.fmt(x) = x
  end
  class Document
    def self.build = new
  end
  class Invoice < Document
  end
  RATES = { usd: 1 }
end
`,
  'app/billing/statement.rb': `class Billing::Statement
  def self.render = 8
end
`,
  'app/billing/query.rb': `class Query
  def where(x) = x
end
`,
  'app/billing/report.rb': `class Report
  def run
    Billing::Helpers.fmt(1)
    Billing::Invoice.build
    Billing::Statement.render
    Billing::ChargeCard.where(amount: 1)
    Billing::RATES.fetch(:usd)
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

function write(files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
}

async function index(backend: string, files: Record<string, string> = FILES): Promise<CodeGraph> {
  savedKernel = process.env.CODEGRAPH_KERNEL;
  if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
  else delete process.env.CODEGRAPH_KERNEL;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-nsrecv-'));
  write(files);
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `<kind> <qualified name>:<line>` of every `calls`/`references` edge written on `line` of `file`. */
function edgesAt(graph: CodeGraph, file: string, line: number): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return graph
    .getOutgoingEdgesFrom(ids)
    .filter((e) => (e.kind === 'calls' || e.kind === 'references') && e.line === line)
    .map((e) => {
      const t = graph.getNode(e.target)!;
      return `${e.kind} ${t.qualifiedName}:${t.startLine}`;
    })
    .sort();
}

/** `<file>:<line>` of every `references` edge into the class or module `qualifiedName`. */
function referencedFrom(graph: CodeGraph, qualifiedName: string): string[] {
  const target = graph.getNodesByQualifiedName(qualifiedName).find((n) => n.kind === 'class' || n.kind === 'module')!;
  return graph
    .getIncomingEdgesTo([target.id])
    .filter((e) => e.kind === 'references')
    .map((e) => `${graph.getNode(e.source)!.filePath}:${e.line}`)
    .sort();
}

const backends = [
  ['kernel', getKernel() === null],
  ['wasm', false],
] as const;

describe.each(backends)('Ruby call on a namespaced constant (%s)', (backend, skip) => {
  it.skipIf(skip)('links the caller to the class, as a bare constant receiver does', async () => {
    const graph = await index(backend);
    expect(referencedFrom(graph, 'Billing::ChargeCard')).toEqual([
      'app/billing/report.rb:6',
      'app/services/billing/refund.rb:4',
      'app/services/checkout/complete.rb:4',
    ]);
  });

  it.skipIf(skip)("calls the class's method", async () => {
    const graph = await index(backend);
    expect(edgesAt(graph, 'app/services/checkout/complete.rb', 4)).toEqual([
      'calls Billing::ChargeCard::call:3',
      'references Billing::ChargeCard:2',
    ]);
  });

  it.skipIf(skip)('reaches the class of the namespace the caller names', async () => {
    const graph = await index(backend);
    const runner = 'app/svc/runner.rb';
    expect(edgesAt(graph, runner, 3)).toEqual(['calls Billing::Create::call:3', 'references Billing::Create:2']);
    expect(edgesAt(graph, runner, 4)).toEqual(['calls Users::Create::call:3', 'references Users::Create:2']);
    expect(edgesAt(graph, runner, 5)).toEqual(['calls Users::Create::call:3', 'references Users::Create:2']);
  });

  it.skipIf(skip)('looks a ::-rooted name up at the top level only', async () => {
    const graph = await index(backend);
    const runner = 'app/svc/runner.rb';
    expect(edgesAt(graph, runner, 6)).toEqual(['calls Billing::Create::call:3', 'references Billing::Create:2']);
    // `::Foo` inside `module Svc` is the top-level Foo, not Svc::Foo.
    expect(edgesAt(graph, runner, 7)).toEqual(['calls Foo::call:2', 'references Foo:1']);
  });

  it.skipIf(skip)('looks a relative name up in the namespaces around the call first', async () => {
    const graph = await index(backend);
    expect(edgesAt(graph, 'app/api/v2/users_controller.rb', 5)).toEqual([
      'calls Api::V2::Users::Create::call:5',
      'references Api::V2::Users::Create:4',
    ]);
  });

  it.skipIf(skip)('links nothing for a constant the project does not declare', async () => {
    const graph = await index(backend);
    expect(edgesAt(graph, 'app/models/order.rb', 3)).toEqual([]);
    expect(referencedFrom(graph, 'Base')).toEqual([]);
  });

  it.skipIf(skip)('never links production code to a class only a test declares', async () => {
    const graph = await index(backend);
    expect(edgesAt(graph, 'app/models/order.rb', 4)).toEqual([]);
    expect(edgesAt(graph, 'spec/models/order_spec.rb', 3)).toEqual([
      'calls Stripe::Charge::create:3',
      'references Stripe::Charge:2',
    ]);
  });

  it.skipIf(skip)('calls module methods, inherited class methods and compact-named classes, and guesses no method', async () => {
    const graph = await index(backend);
    const report = 'app/billing/report.rb';
    expect(edgesAt(graph, report, 3)).toEqual(['calls Billing::Helpers::fmt:3', 'references Billing::Helpers:2']);
    expect(edgesAt(graph, report, 4)).toEqual(['calls Billing::Document::build:6', 'references Billing::Invoice:8']);
    expect(edgesAt(graph, report, 5)).toEqual(['calls Billing::Statement::render:2', 'references Billing::Statement:1']);
    // ChargeCard declares no `where`; Query's is not it.
    expect(edgesAt(graph, report, 6)).toEqual(['references Billing::ChargeCard:2']);
    // A constant holding a value: the call is the value's.
    expect(edgesAt(graph, report, 7)).toEqual(['references Billing::RATES:10']);
  });
});

describe('Ruby call on a namespaced constant, after a sync', () => {
  it('links the calls once a sync adds the class they name', async () => {
    const { 'app/services/billing/charge_card.rb': chargeCard, ...rest } = FILES;
    const graph = await index('default', rest);
    expect(edgesAt(graph, 'app/services/checkout/complete.rb', 4)).toEqual([]);

    write({ 'app/services/billing/charge_card.rb': chargeCard! });
    expect((await graph.sync()).filesAdded).toBe(1);
    // complete.rb did not change: only the retry of its parked refs links it.
    expect(edgesAt(graph, 'app/services/checkout/complete.rb', 4)).toEqual([
      'calls Billing::ChargeCard::call:3',
      'references Billing::ChargeCard:2',
    ]);
  }, 60_000);
});
