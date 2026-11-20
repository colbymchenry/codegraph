/**
 * A Ruby call on an instance variable, like `@writer.flush`, links to the
 * method of the class the class's `initialize` gives the variable:
 * `@writer = CacheWriter.new` makes it a `CacheWriter`. Before, no call on an
 * instance variable linked at all.
 *
 * Only `initialize` is read, and only a lone `Const.new(…)` types the
 * variable there: one assigned two classes, a conditional, a value passed
 * through `.tap`, or anything but `.new` leaves it untyped, and a class the
 * project doesn't declare (`Logger.new($stdout)`) links nothing. A class
 * method's `@x` is the class's own, and a module's methods run on whatever
 * includes it, so neither is typed.
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
  'app/writer.rb': `class CacheWriter
  def flush
    nil
  end

  def ready?
    true
  end
end

class OtherWriter
  def flush
    nil
  end
end

module Billing
  class Card
    def charge!(amount)
      amount
    end
  end

  class Ledger < Card
  end
end
`,
  'app/holder.rb': `class Holder
  def initialize(key)
    @writer = CacheWriter.new
    @lazy ||= OtherWriter.new(
      key
    )
    @either = key ? CacheWriter.new : OtherWriter.new
    @twice = CacheWriter.new
    @twice = OtherWriter.new if key
    @ledger = Billing::Ledger.new key do |l|
      l
    end
    @tapped = CacheWriter.new.tap { |w| w }
    @outside = Logger.new($stdout)
    @a, @b = CacheWriter.new, OtherWriter.new
  end

  def via_ivar
    @writer.flush
    @writer.ready?
    @lazy.flush
    @either.flush
    @twice.flush
    @ledger.charge!(1)
    @tapped.flush
    @outside.info("x")
    @b.flush
    @unset.flush
  end

  def self.klass
    @writer.flush
  end
end

module Mixin
  def mixed
    @writer.flush
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-ivar-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
  return cg;
}

/** `<qualified name>:<line>` of every `calls` edge written on `line` of `file`. */
function callsAt(graph: CodeGraph, file: string, line: number): string[] {
  const ids = graph.getNodesInFile(file).map((n) => n.id);
  return graph
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls' && e.line === line)
    .map((e) => {
      const t = graph.getNode(e.target)!;
      return `${t.qualifiedName}:${t.startLine}`;
    })
    .sort();
}

const backends = [
  ['kernel', getKernel() === null],
  ['wasm', false],
] as const;

describe.each(backends)('Ruby calls on an instance variable initialize types (%s)', (backend, skip) => {
  it.skipIf(skip)('links the method of the class initialize constructs', async () => {
    const graph = await index(backend);
    const holder = 'app/holder.rb';
    expect(callsAt(graph, holder, 19)).toEqual(['CacheWriter::flush:2']);
    expect(callsAt(graph, holder, 20)).toEqual(['CacheWriter::ready?:6']);
    // `||=` with its arguments over several lines.
    expect(callsAt(graph, holder, 21)).toEqual(['OtherWriter::flush:12']);
    // A namespaced class, built with a block: the method its superclass has.
    expect(callsAt(graph, holder, 24)).toEqual(['Billing::Card::charge!:19']);
  });

  it.skipIf(skip)('types nothing initialize leaves ambiguous', async () => {
    const graph = await index(backend);
    const holder = 'app/holder.rb';
    for (const line of [22, 23, 25, 27, 28]) expect(callsAt(graph, holder, line)).toEqual([]);
  });

  it.skipIf(skip)('links nothing for a class the project does not declare', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/holder.rb', 26)).toEqual([]);
  });

  it.skipIf(skip)("leaves a class method's and a module's instance variables untyped", async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/holder.rb', 32)).toEqual([]);
    expect(callsAt(graph, 'app/holder.rb', 38)).toEqual([]);
  });
});
