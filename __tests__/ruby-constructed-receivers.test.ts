/**
 * Ruby calls on a typed receiver whose method name ends in `!` or `?`, and
 * calls on what `.new` made (#684).
 *
 * `writer.flush!` and `writer.ready?` after `writer = CacheWriter.new` linked
 * nothing, while `writer.write_cache` linked: the method-call pattern took no
 * `!` or `?`. `CacheWriter.create!` linked nothing where `CacheWriter.create`
 * did, for the same reason.
 *
 * `CacheWriter.new(key).write_cache` was recorded with the receiver's text,
 * arguments and all, so it never linked. It is now `new CacheWriter()
 * .write_cache`, and links an instance method of the class Ruby's constant
 * lookup finds for `CacheWriter` where the call is written, its own or one
 * its ancestry declares. A class the project doesn't declare links nothing:
 * rack-protection's `Request.new(env)` is rack's `Rack::Request`, not the
 * project's `Sinatra::Request`.
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
  def self.create(key)
    new
  end

  def self.create!(key)
    new
  end

  def write_cache(key)
    key
  end

  def flush!
    nil
  end

  def ready?
    true
  end
end

class OtherWriter
  def write_cache(key)
    key
  end

  def flush!
    nil
  end

  def ready?
    false
  end
end
`,
  'app/billing.rb': `module Billing
  class Card
    def charge!(amount)
      amount
    end
  end

  class Ledger < Card
    def post
      Card.new.charge!(1)
    end
  end
end

module Admin
  class Card
    def charge!(amount)
      amount
    end
  end
end
`,
  'app/counter.rb': `class Counter
  def bang
    writer = CacheWriter.new
    writer.flush!
  end

  def question
    writer = CacheWriter.new
    writer.ready?
  end

  def chained(key)
    CacheWriter.new.write_cache(key)
  end

  def chained_args(key)
    CacheWriter.new(key).write_cache(key)
  end

  def chained_bang
    CacheWriter.new(1).flush!
  end

  def namespaced
    Billing::Ledger.new.charge!(2)
  end

  def top_level
    ::CacheWriter.new.ready?
  end

  def class_bang
    CacheWriter.create!(1)
  end

  def outside(env)
    Request.new(env).preferred_type
  end
end
`,
  'lib/rack/show_exceptions.rb': `module Rack
  module Protection
    class ShowExceptions
      def call(env)
        Request.new(env).preferred_type("text/html")
      end
    end
  end
end
`,
  'lib/sinatra/request.rb': `module Sinatra
  class Request
    def preferred_type(*types)
      types.first
    end
  end
end
`,
  // A module a call returns is no mixin of the constant the call starts at:
  // UrlForHelper doesn't get RouteSet's methods (actionpack's url_for tests).
  'app/url_helper.rb': `class RouteSet
  def url_for(options)
    options
  end

  def url_helpers
    Module.new
  end
end

class UrlForHelper
  include RouteSet.new.url_helpers
end

class UrlForTest
  def test_url
    UrlForHelper.new.url_for(1)
  end
end
`,
  // Two project methods named `key?`: a `?` call on an untyped receiver is not
  // guessed between them by the receiver's words.
  'lib/options.rb': `class InheritableOptions
  def key?(key)
    true
  end
end

class FlashHash
  def key?(name)
    false
  end
end

class Store
  def merged(options)
    options.key?(:namespace)
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
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-made-'));
  write(files);
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

describe.each(backends)('Ruby bang and question methods, and calls on .new (%s, #684)', (backend, skip) => {
  it.skipIf(skip)('links a `!` or `?` method called on a typed local', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/counter.rb', 4)).toEqual(['CacheWriter::flush!:14']);
    expect(callsAt(graph, 'app/counter.rb', 9)).toEqual(['CacheWriter::ready?:18']);
  });

  it.skipIf(skip)('links a `!` class method', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/counter.rb', 33)).toEqual(['CacheWriter::create!:6']);
  });

  it.skipIf(skip)('links a call on what `.new` made, with or without arguments', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/counter.rb', 13)).toEqual(['CacheWriter::write_cache:10']);
    expect(callsAt(graph, 'app/counter.rb', 17)).toEqual(['CacheWriter::write_cache:10']);
    expect(callsAt(graph, 'app/counter.rb', 21)).toEqual(['CacheWriter::flush!:14']);
    expect(callsAt(graph, 'app/counter.rb', 29)).toEqual(['CacheWriter::ready?:18']);
  });

  it.skipIf(skip)('finds the class by Ruby constant lookup, and the method in its ancestry', async () => {
    const graph = await index(backend);
    // `Card` inside `Billing::Ledger` is Billing::Card, not Admin::Card.
    expect(callsAt(graph, 'app/billing.rb', 10)).toEqual(['Billing::Card::charge!:3']);
    // Billing::Ledger has no `charge!`; its superclass Billing::Card does.
    expect(callsAt(graph, 'app/counter.rb', 25)).toEqual(['Billing::Card::charge!:3']);
  });

  it.skipIf(skip)('links nothing for a class the project does not declare', async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/counter.rb', 37)).toEqual([]);
    expect(callsAt(graph, 'lib/rack/show_exceptions.rb', 5)).toEqual([]);
  });

  it.skipIf(skip)("finds no method in a module a call returns, which the class's ancestry doesn't name", async () => {
    const graph = await index(backend);
    expect(callsAt(graph, 'app/url_helper.rb', 17)).toEqual([]);
  });

  it.skipIf(skip)('guesses no `?` method by the receiver word among several of the name', async () => {
    const graph = await index(backend);
    // `options` shares a word with InheritableOptions, but a Hash answers `key?` too.
    expect(callsAt(graph, 'lib/options.rb', 15)).toEqual([]);
  });
});

describe('Ruby call on .new, after a sync (#684)', () => {
  it('links the call once a sync adds the class it constructs', async () => {
    const { 'app/writer.rb': writer, ...rest } = FILES;
    const graph = await index('default', rest);
    expect(callsAt(graph, 'app/counter.rb', 17)).toEqual([]);

    write({ 'app/writer.rb': writer! });
    expect((await graph.sync()).filesAdded).toBe(1);
    // counter.rb did not change: only the retry of its parked refs links it.
    expect(callsAt(graph, 'app/counter.rb', 17)).toEqual(['CacheWriter::write_cache:10']);
  }, 60_000);
});
