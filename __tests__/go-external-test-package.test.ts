/**
 * A package's external tests (`package a_test`) share its directory but are
 * a package of their own. A name one of them declares at the top level
 * reaches the other only through an import: written `a.Real`, or bare after
 * `import . "…/a"`, and then only an exported one. Before, a bare call in an
 * external test bound to package `a`'s test helper of the same name (#2581).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const GO_MOD = 'module example.com/a\n\ngo 1.22\n';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2581-xtest-'));
  for (const [rel, source] of Object.entries({ 'go.mod': GO_MOD, ...files })) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  return cg;
}

/** `<kind> <target> <target file>` of every call or type use out of the function `fromName`, sorted. */
function edgesFrom(graph: CodeGraph, fromName: string): string[] {
  const from = graph.getNodesByKind('function').find((n) => n.name === fromName);
  expect(from, fromName).toBeDefined();
  return graph
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'references')
    .map((e) => {
      const target = graph.getNode(e.target);
      return `${e.kind} ${target?.qualifiedName} ${target?.filePath}`;
    })
    .sort();
}

const PACKAGE_A = `package a

func Real() {}

func helper() {}

type fixture struct{}
`;

describe('Go external test packages (#2581)', () => {
  it("binds the issue's external test to its own package's helper", async () => {
    const graph = await index({
      'a.go': 'package a\n\nfunc Real() {}\n',
      'a_internal_test.go': `package a

import "testing"

func corpus(t *testing.T) []string { return nil }

func TestInternal(t *testing.T) { _ = corpus(t) }
`,
      'b_ext_helpers_test.go': `package a_test

import "testing"

func corpus(t *testing.T, root string) []string { return nil }
`,
      'a_ext_test.go': `package a_test

import "testing"

func TestExt(t *testing.T) { _ = corpus(t, "") }
`,
    });
    expect(edgesFrom(graph, 'TestExt')).toEqual(['calls corpus b_ext_helpers_test.go']);
    expect(edgesFrom(graph, 'TestInternal')).toEqual(['calls corpus a_internal_test.go']);
  });

  it('reaches the package under test only through its import', async () => {
    const graph = await index({
      'a.go': PACKAGE_A,
      'qualified_test.go': `package a_test

import (
	"testing"

	"example.com/a"
)

func TestQualified(t *testing.T) { a.Real() }
`,
      'dot_test.go': `package a_test

import (
	"testing"

	. "example.com/a"
)

func TestDot(t *testing.T) { Real() }

func TestUnexported(t *testing.T) { helper() }
`,
      'plain_test.go': `package a_test

type fixture struct{ name string }
`,
      'use_test.go': `package a_test

func check(f fixture) {}
`,
    });
    expect(edgesFrom(graph, 'TestQualified')).toEqual(['calls Real a.go']);
    expect(edgesFrom(graph, 'TestDot')).toEqual(['calls Real a.go']);
    // A dot import brings only the exported names.
    expect(edgesFrom(graph, 'TestUnexported')).toEqual([]);
    expect(edgesFrom(graph, 'check')).toEqual(['references fixture plain_test.go']);
  });

  it("does not bind package a's code to a name only its external tests declare", async () => {
    const graph = await index({
      'a.go': 'package a\n\nfunc Real() {}\n',
      'a_internal_test.go': `package a

import "testing"

func TestInternal(t *testing.T) { extOnly() }
`,
      'ext_test.go': `package a_test

func extOnly() {}
`,
    });
    expect(edgesFrom(graph, 'TestInternal')).toEqual([]);
  });
});
