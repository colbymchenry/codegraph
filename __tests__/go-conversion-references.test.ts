/**
 * A Go call whose callee is a type is a conversion: `Category(s)` with
 * `type Category string`, `(*Pair)(p)`, `model.Kind(3)`. It uses the type,
 * and calls or instantiates nothing, so it is recorded as a `references`
 * edge to the type. Before, it was a `calls` edge to a named non-struct type
 * and an `instantiates` edge to a struct (#2581).
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const GO_MOD = 'module example.com/app\n\ngo 1.22\n';

let tempDir: string;
let cg: CodeGraph | null = null;

afterEach(() => {
  cg?.close();
  cg = null;
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-2581-conv-'));
  for (const [rel, source] of Object.entries({ 'go.mod': GO_MOD, ...files })) {
    fs.mkdirSync(path.dirname(path.join(tempDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(tempDir, rel), source);
  }
  cg = await CodeGraph.init(tempDir, { index: true });
  cg.resolveReferences();
  return cg;
}

/** `<kind> <target kind> <target> :<line>` of every edge out of the function `fromName`, sorted. */
function edgesFrom(graph: CodeGraph, fromName: string): string[] {
  const from = graph.getNodesByKind('function').find((n) => n.name === fromName);
  expect(from, fromName).toBeDefined();
  return graph
    .getOutgoingEdges(from!.id)
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates' || e.kind === 'references')
    .map((e) => {
      const target = graph.getNode(e.target);
      return `${e.kind} ${target?.kind} ${target?.qualifiedName} :${e.line}`;
    })
    .sort();
}

describe('Go type conversions (#2581)', () => {
  it("records the issue's `Category(s)` as a use of the type, not a call", async () => {
    const graph = await index({
      'main.go': `package main

type Category string

func use(s string) Category {
	return Category(s) // a conversion, not a call
}

func main() { use("") }
`,
    });
    expect(edgesFrom(graph, 'use')).toEqual([
      'references type_alias Category :5',
      'references type_alias Category :6',
    ]);
  });

  it('records conversions to struct, pointer, slice and imported types the same way, and keeps real calls', async () => {
    const graph = await index({
      'model/model.go': `package model

type Kind int

type Point struct{ X, Y int }

func Make() Kind { return 0 }
`,
      'main.go': `package main

import "example.com/app/model"

type Celsius float64

type Pair struct{ X, Y int }

type Names []string

func convert(p *Pair, raw []string, v float64, pt model.Point) {
	_ = Celsius(v)
	_ = (*Pair)(p)
	_ = Names(raw)
	_ = model.Kind(3)
	_ = Pair(pt)
	_ = model.Make()
	_ = Pair{X: 1}
}

func main() { convert(nil, nil, 0, model.Point{}) }
`,
    });
    const edges = edgesFrom(graph, 'convert');
    expect(edges.filter((e) => /:1[2-8]$/.test(e))).toEqual([
      'calls function Make :17',
      'instantiates struct Pair :18',
      'references struct Pair :13',
      'references struct Pair :16',
      'references type_alias Celsius :12',
      'references type_alias Kind :15',
      'references type_alias Names :14',
    ]);
  });
});
