/**
 * A JS/TS name the calling function binds itself — a parameter, or a `var` /
 * `let` / `const` above the reference — is that local, never a same-named
 * function declared elsewhere in the file. Every lodash helper lives inside
 * `runInContext`, so `baseHas(object, key)`'s `object` and `mixin`'s
 * `object(this.__wrapped__)` reached a `function object() {}` an IIFE declares
 * there. A function that calls itself through its own `const` still does, and
 * `if (handler) handler()` is not a parameter list.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-local-'));
  const files: Record<string, string> = {
    'lodash.js': `function runInContext(context) {
  var baseCreate = (function() {
    function object() {}
    return function(proto) {
      object.prototype = proto;
      return new object;
    };
  }());

  function baseHas(object, key) {
    return object != null && hasOwnProperty.call(object, key);
  }

  function mixin(object, source) {
    var result = object(this.__wrapped__);
    return result;
  }

  function handler() {}

  function run() {
    if (handler) {
      handler();
    }
    const walk = (node) => (node ? walk(node.next) : null);
    return walk(context);
  }

  return { baseCreate, baseHas, mixin, run };
}
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

const targetsFrom = (qualifiedName: string) => {
  const ids = cg.getNodesInFile('lodash.js').filter((n) => n.qualifiedName === qualifiedName).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('JS names the calling function binds', () => {
  it('are its parameters, not a same-named function elsewhere in the file', () => {
    expect(targetsFrom('runInContext::baseHas')).not.toContain('runInContext::object');
    expect(targetsFrom('runInContext::mixin')).not.toContain('runInContext::object');
  });

  it('leave unbound names and a const’s own recursion alone', () => {
    expect(targetsFrom('runInContext::run')).toContain('runInContext::handler');
    expect(targetsFrom('runInContext::run::walk')).toContain('runInContext::run::walk');
  });
});
