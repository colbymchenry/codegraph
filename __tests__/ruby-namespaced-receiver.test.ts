/**
 * A Ruby call on a namespaced constant (`Billing::ChargeCard.call`) is a
 * dependency on that class, the same as the bare `ChargeCard.call` (#1110).
 * The reference carries the qualified name, so same-named classes in other
 * namespaces (`Billing::Create` / `Users::Create`) and external constants
 * (`ActiveRecord::Base`) are not mistaken for it.
 *
 * Runs against the native kernel (skipped when none is built) and the wasm
 * extractor.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { getKernel } from '../src/extraction/kernel/loader';

const FILES: Record<string, string> = {
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
  // Same class name in two namespaces; the caller names which one it means.
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
  'app/callers.rb': `class Callers
  def billing = Billing::Create.call
  def users = Users::Create.call
  def users_safe = Users::Create&.call
  def rooted = ::Billing::Create.call
  def rooted_top = ::Foo.call
  def external = ActiveRecord::Base.transaction { }
end
`,
  'app/foo.rb': `class Foo
  def self.call = 3
end
`,
  // A partly qualified receiver, resolved from inside the enclosing module.
  'app/svc/deep/op.rb': `module Svc
  module Deep
    class Op
      def self.call = 4
    end
  end
end
`,
  'app/svc/runner.rb': `module Svc
  class Runner
    def run = Deep::Op.call
  end
end
`,
  // A project class that merely shares the last segment of an external constant.
  'app/base.rb': `class Base
end
`,
};

let root = '';
let cg: CodeGraph | undefined;
let kernel: string | undefined;

afterEach(() => {
  cg?.close();
  cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (kernel === undefined) delete process.env.CODEGRAPH_KERNEL;
  else process.env.CODEGRAPH_KERNEL = kernel;
});

async function index(backend: string): Promise<CodeGraph> {
  kernel = process.env.CODEGRAPH_KERNEL;
  if (backend === 'wasm') process.env.CODEGRAPH_KERNEL = '0';
  else delete process.env.CODEGRAPH_KERNEL;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-nsrecv-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `file:caller` of every node with a `references` edge into the class `name` defined in `file`. */
function referencedBy(graph: CodeGraph, name: string, file: string): string[] {
  const cls = graph.searchNodes(name).map((r) => r.node).find((n) => n.kind === 'class' && n.filePath === file)!;
  return graph
    .getIncomingEdgesTo([cls.id])
    .filter((e) => e.kind === 'references')
    .map((e) => { const n = graph.getNode(e.source)!; return `${n.filePath}:${n.name}`; })
    .sort();
}

describe('Ruby namespaced-constant receiver', () => {
  const backends = [
    ['kernel', getKernel() === null],
    ['wasm', false],
  ] as const;

  describe.each(backends)('%s', (backend, skip) => {
    it.skipIf(skip)('records a references edge to the class, like a bare constant receiver', async () => {
      const graph = await index(backend);
      const files = referencedBy(graph, 'ChargeCard', 'app/services/billing/charge_card.rb').map((r) => r.split(':')[0]);
      expect([...new Set(files)]).toEqual([
        'app/services/billing/refund.rb',
        'app/services/checkout/complete.rb',
      ]);
    });

    it.skipIf(skip)('sends each namespaced caller to the class of its own namespace', async () => {
      const graph = await index(backend);
      expect(referencedBy(graph, 'Create', 'app/billing/create.rb')).toEqual([
        'app/callers.rb:billing',
        'app/callers.rb:rooted',
      ]);
      expect(referencedBy(graph, 'Create', 'app/users/create.rb')).toEqual([
        'app/callers.rb:users',
        'app/callers.rb:users_safe',
      ]);
    });

    it.skipIf(skip)('links a ::-rooted top-level receiver to its class', async () => {
      const graph = await index(backend);
      expect(referencedBy(graph, 'Foo', 'app/foo.rb')).toEqual(['app/callers.rb:rooted_top']);
    });

    it.skipIf(skip)('links a partly qualified receiver written inside its enclosing module', async () => {
      const graph = await index(backend);
      expect(referencedBy(graph, 'Op', 'app/svc/deep/op.rb')).toEqual(['app/svc/runner.rb:run']);
    });

    it.skipIf(skip)('does not link an external namespaced constant to a project class of the same last name', async () => {
      const graph = await index(backend);
      expect(referencedBy(graph, 'Base', 'app/base.rb')).toEqual([]);
    });
  });
});
