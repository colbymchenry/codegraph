/**
 * A Swift inheritance entry written with a qualifier lands on the type it
 * names, not on its first segment.
 *
 * The grammar gives `Kit.Runner` in `class QC: Kit.Runner {}` as one
 * `user_type` whose `type_identifier` children are flat siblings (`Kit`,
 * `Runner`); generic arguments sit in a separate `type_arguments` child. The
 * extracted ref is the dotted path of those `type_identifier`s, `Kit.Runner`
 * (generic arguments dropped), at the `user_type`'s position, and the
 * resolver places it on the declaration that path names rather than on
 * `enum Kit`. No source text is read back to recover the qualifier.
 *
 * Both extraction paths are covered: the wasm arm always, the kernel arm when
 * a kernel is staged. Each arm indexes one real temp project holding every
 * vector, so the index cost is paid once per arm.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { resetKernelForTests } from '../src/extraction/kernel';

const FILES: Record<string, string> = {
  'Sources/App/Kit.swift': `enum Kit {
    protocol Runner {}
    enum Inner {
        protocol Deep {}
    }
}
`,
  // An unrelated top-level type with the same last segment as Kit.Runner.
  'Sources/App/Runner.swift': `protocol Runner {}
`,
  // Shadows the standard library's Error by its last segment.
  'Sources/App/Errors.swift': `enum Error {}
`,
  // Shadows Foundation's Operation by its last segment.
  'Sources/App/Operation.swift': `class Operation {}
`,
  'Sources/App/Uses.swift': `class QC: Kit.Runner {}
class QG: Kit.Runner<Int> {}
class QD: Kit.Inner.Deep {}
class B {}
class A: B {}
class X: Foundation.NSObject {}
struct Y: Swift.Error {}
class Z: Foundation.Operation {}
`,
  // A module-qualified conformance to a name the project only extends: the
  // extension's members still reach the conformer through the failed ref.
  'Sources/App/View2.swift': `extension View2 { static func y() {} }
struct HV: SwiftUI.View2 {}
func c3() { HV.y() }
`,
};

const ENV_KEYS = ['CODEGRAPH_KERNEL', 'CODEGRAPH_KERNEL_LANGS'] as const;

const KERNEL_PATH = path.join(
  __dirname,
  '..',
  'codegraph-kernel',
  'prebuilds',
  `${process.platform}-${process.arch}`,
  'codegraph-kernel.node'
);

interface Super {
  kind: string;
  target: string | undefined;
  name: string | undefined;
  file: string | undefined;
}

/** The extends/implements edges leaving the Swift type `name`, by target qualifiedName. */
function supers(cg: CodeGraph, name: string): Super[] {
  const ids = cg.getNodesByName(name).filter((n) => n.language === 'swift').map((n) => n.id);
  expect(ids.length, `no Swift node named ${name}`).toBeGreaterThan(0);
  return cg.getOutgoingEdgesFrom(ids, ['extends', 'implements']).map((e) => {
    const t = cg.getNode(e.target);
    return { kind: e.kind, target: t?.qualifiedName, name: t?.name, file: t ? path.basename(t.filePath) : undefined };
  });
}

/**
 * Index the fixture project under the given env, run the vectors, restore env.
 * `env` values of `undefined` delete the key.
 */
function vectors(env: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  let cg: CodeGraph;
  let root: string;
  let saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    for (const k of ENV_KEYS) {
      if (env[k] === undefined) delete process.env[k];
      else process.env[k] = env[k];
    }
    resetKernelForTests();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-qual-inherit-'));
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetKernelForTests();
  });

  it('a. lands `Kit.Runner` on the nested protocol, not on enum Kit', () => {
    const s = supers(cg, 'QC');
    expect(s.map((e) => e.target), JSON.stringify(s)).toHaveLength(1);
    expect(s[0]!.target, JSON.stringify(s)).toMatch(/(^|::)Kit::Runner$/);
    expect(s.some((e) => e.target === 'Kit'), JSON.stringify(s)).toBe(false);
  });

  it('b. lands `Kit.Runner<Int>` on the nested protocol', () => {
    const s = supers(cg, 'QG');
    expect(s, JSON.stringify(s)).toHaveLength(1);
    expect(s[0]!.target, JSON.stringify(s)).toMatch(/(^|::)Kit::Runner$/);
  });

  it('c. lands `Kit.Inner.Deep` on the doubly nested protocol', () => {
    const s = supers(cg, 'QD');
    expect(s, JSON.stringify(s)).toHaveLength(1);
    expect(s[0]!.target, JSON.stringify(s)).toMatch(/(^|::)Kit::Inner::Deep$/);
  });

  it('d. does not land `Kit.Runner` on an unrelated top-level Runner', () => {
    const s = supers(cg, 'QC');
    expect(s.filter((e) => e.file === 'Runner.swift'), JSON.stringify(s)).toEqual([]);
    // The one edge names a `Runner`, and it is the one declared inside Kit.
    expect(s.map((e) => `${e.name} (${e.file})`), JSON.stringify(s)).toEqual(['Runner (Kit.swift)']);
  });

  it('e. keeps an unqualified superclass: `A: B` extends B', () => {
    const s = supers(cg, 'A');
    expect(s.map((e) => e.target), JSON.stringify(s)).toEqual(['B']);
  });

  it('f. gives no edge for a module-qualified external type with no project declaration', () => {
    expect(supers(cg, 'X')).toEqual([]);
  });

  // The ref is `Swift.Error`, and its qualifier `Swift` names no project
  // type, so it names an external module's type: a supertype written that
  // way gets no edge rather than landing on the project's `enum Error`.
  it('g. gives no edge from `Swift.Error` to a project enum Error', () => {
    expect(supers(cg, 'Y')).toEqual([]);
  });

  // Same rule from a class declaration: `Foundation` names no project type, so
  // the project's `class Operation` is not Z's superclass.
  it('h. gives no edge from `Foundation.Operation` to a project class Operation', () => {
    expect(supers(cg, 'Z')).toEqual([]);
  });

  // Known limit, pinned as failing in both arms: a module-qualified
  // conformance to a type the project only extends (`struct HV:
  // SwiftUI.View2` with a project `extension View2`) records `SwiftUI.View2`;
  // the extension-only walk matches supertype names exactly, so the
  // extension's members do not reach HV. Listed with the known limits in
  // src/resolution/swift-type-visibility.ts.
  it.fails('a module-qualified conformance to an extended-only name still reaches the extension member', () => {
    const c3 = cg.getNodesByName('c3').filter((n) => n.language === 'swift').map((n) => n.id);
    expect(c3).toHaveLength(1);
    const targets = cg.getOutgoingEdgesFrom(c3, ['calls']).map((e) => cg.getNode(e.target)?.qualifiedName);
    expect(targets, JSON.stringify(targets)).toContain('View2::y');
  });

  // The extraction itself carries the qualifier: the ref is the user_type's
  // dotted type_identifier path, generic arguments dropped, at the user_type's
  // position (line 1-based, column 0-based).
  it('i. extracts a qualified entry as its dotted path at the entry\'s position', () => {
    const rel = 'Sources/App/Uses.swift';
    const result = extractFromSource(path.join(root, rel), FILES[rel]!, 'swift');
    const fromName = new Map(result.nodes.map((n) => [n.id, n.name]));
    const ext = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends' && ['QC', 'QG', 'QD', 'A'].includes(fromName.get(r.fromNodeId) ?? ''))
      .map((r) => ({ from: fromName.get(r.fromNodeId), name: r.referenceName, line: r.line, column: r.column }))
      .sort((a, b) => a.line - b.line);
    expect(ext).toEqual([
      { from: 'QC', name: 'Kit.Runner', line: 1, column: 10 },
      { from: 'QG', name: 'Kit.Runner', line: 2, column: 10 },
      { from: 'QD', name: 'Kit.Inner.Deep', line: 3, column: 10 },
      { from: 'A', name: 'B', line: 5, column: 9 },
    ]);
  });
}

describe('Swift qualified inheritance, wasm arm', () => {
  vectors({ CODEGRAPH_KERNEL: '0', CODEGRAPH_KERNEL_LANGS: undefined });
});

describe.skipIf(!fs.existsSync(KERNEL_PATH))('Swift qualified inheritance, kernel arm', () => {
  vectors({ CODEGRAPH_KERNEL: undefined, CODEGRAPH_KERNEL_LANGS: 'all' });
});
