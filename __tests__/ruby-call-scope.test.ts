/**
 * Ruby has nothing that types a receiver, so a method reached by name alone
 * must earn it:
 *
 * - `receiver.m()` through an untyped receiver takes the one project method
 *   named `m` only when the receiver is named after its owner
 *   (`web_push_request.legacy_encrypt` → WebPushRequest). rubocop's
 *   `node.loc` — a rubocop-ast node — went to the project's lone `loc` 1,201
 *   times; lobsters' `value.to_s` to a short-id class's `to_s`.
 * - a bare `m()` inside a class is a call on self: the class's own methods,
 *   its superclasses', and those of modules mixed into any of them. rubocop's
 *   `format(…)` — Kernel's — went to the LSP runtime's `format` 411 times.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ruby-scope-'));
  const files: Record<string, string> = {
    'lib/app/ext/regexp.rb': `module App
  module Ext
    module Expression
      def loc
        @loc
      end
    end
  end
end
`,
    'lib/app/lsp/runtime.rb': `module App
  module LSP
    class Runtime
      def format(text)
        text
      end
    end
  end
end
`,
    'lib/app/web_push_request.rb': `class WebPushRequest
  def legacy_encrypt(payload)
    payload
  end
end
`,
    'lib/app/cop/base.rb': `module App
  module Cop
    module RangeHelp
      def range_between(a, b)
        [a, b]
      end
    end

    class Base
      def add_offense(node)
        node
      end
    end
  end
end
`,
    'lib/app/cop/style/foo.rb': `module App
  module Cop
    module Style
      class Foo < Base
        include RangeHelp

        MSG = 'Use %<x>s.'

        def on_send(node, web_push_request)
          selector = node.loc
          web_push_request.legacy_encrypt(selector)
          add_offense(node)
          range_between(1, 2)
          format(MSG, x: 1)
        end
      end
    end
  end
end
`,
    'lib/app/greeting.rb': `module Greeting
  def greet
    "Hello, " + display_name()
  end
end
`,
    'lib/app/person.rb': `class Person
  include Greeting

  def display_name
    'Ada'
  end
end
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** `Owner::method` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Ruby calls reached by name alone', () => {
  it('keep the inherited and mixed-in methods, and the receiver named after its class', () => {
    expect(callsFrom('lib/app/cop/style/foo.rb')).toEqual([
      'App::Cop::Base::add_offense',
      'App::Cop::RangeHelp::range_between',
      'WebPushRequest::legacy_encrypt',
    ]);
  });

  it('leave a call in a module body alone: a module runs on whatever includes it', () => {
    expect(callsFrom('lib/app/greeting.rb')).toEqual(['Person::display_name']);
  });
});
