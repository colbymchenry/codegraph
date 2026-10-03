/**
 * Java `record` declarations are first-class types.
 *
 * A record is a class: its body holds methods, constructors (including the
 * compact `Point { … }` form), static fields and nested types, and its header
 * declares components — each an implicit private field plus a public accessor
 * `x()`. Before, the grammar's `record_declaration` was not a class type, so a
 * record produced no node, its methods were orphaned onto the package, its
 * `implements` were lost, and `p.norm()` / `info.remoteAddress()` on a
 * record-typed receiver resolved to nothing (or to an interface's method).
 *
 * Runs through both extraction paths: the wasm extractor and the native
 * kernel (default routing when a kernel is staged).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

type NodeRow = { kind: string; name: string; qualified_name: string; signature: string | null; docstring: string | null };
type EdgeRow = { kind: string; src: string; tgt: string; tgtKind: string };

describe.each([
  ['wasm', '0'],
  ['default routing', undefined],
] as const)('Java records (%s)', (_label, kernelEnv) => {
  let dir: string;
  let savedKernel: string | undefined;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'java-records-'));
    savedKernel = process.env.CODEGRAPH_KERNEL;
    if (kernelEnv === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = kernelEnv;
  });
  afterEach(() => {
    if (savedKernel === undefined) delete process.env.CODEGRAPH_KERNEL;
    else process.env.CODEGRAPH_KERNEL = savedKernel;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  const load = async () => {
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const nodes: NodeRow[] = db
      .prepare(`SELECT kind, name, qualified_name, signature, docstring FROM nodes`)
      .all();
    const edges: EdgeRow[] = db
      .prepare(
        `SELECT e.kind kind, s.qualified_name src, t.qualified_name tgt, t.kind tgtKind FROM edges e
         JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`
      )
      .all();
    cg.close?.();
    const has = (kind: string, src: string, tgt: string) =>
      edges.some((e) => e.kind === kind && e.src === src && e.tgt === tgt);
    const node = (qn: string, kind: string) => nodes.filter((n) => n.qualified_name === qn && n.kind === kind);
    return { nodes, edges, has, node };
  };

  const fixture = () => {
    write('p/Shape.java', `package p;
public interface Shape { double norm(); }
`);
    write('p/Point.java', `package p;

public record Point(int x, int y) implements Shape {
    public static final Point ORIGIN = new Point(0, 0);
    public Point {
        if (x < 0) throw new IllegalArgumentException();
    }
    public Point(int v) { this(v, v); }
    public double norm() { return Math.sqrt(x * x + y * y); }
    record Inner(String name) {}
}
`);
    write('p/Pair.java', `package p;
public record Pair<A, B>(A first, B second) {
    public A left() { return first; }
}
`);
    write('p/Http.java', `package p;
public class Http {
    public record RemoteInfo(String remoteAddress, int port) {
        public String describe() { return remoteAddress + ":" + port; }
        public String remoteAddress() { return remoteAddress.trim(); }
    }
    private RemoteInfo info;
    public String use(Point p, RemoteInfo param) {
        Point local = new Point(1, 2);
        double a = local.norm();
        double b = p.norm();
        String c = info.remoteAddress();
        String d = param.describe();
        int e = p.x();
        Pair<String, Integer> pr = new Pair<>("a", 1);
        String f = pr.left();
        return c + d + a + b + e + f;
    }
}
`);
  };

  it('indexes a record as a class that contains its members and implements its interfaces', async () => {
    fixture();
    const { node, has } = await load();
    expect(node('p::Point', 'class')).toHaveLength(1);
    expect(node('p::Pair', 'class')).toHaveLength(1);
    // Nested records qualify under their outer type.
    expect(node('p::Http::RemoteInfo', 'class')).toHaveLength(1);
    expect(node('p::Point::Inner', 'class')).toHaveLength(1);
    expect(has('contains', 'p::Http', 'p::Http::RemoteInfo')).toBe(true);
    expect(has('contains', 'p::Point', 'p::Point::Inner')).toBe(true);

    // Body members hang off the record, not the package.
    expect(has('contains', 'p::Point', 'p::Point::norm')).toBe(true);
    expect(node('p::norm', 'function')).toHaveLength(0);
    expect(node('p::Point::ORIGIN', 'constant')).toHaveLength(1);
    // Both the compact and the explicit constructor.
    expect(node('p::Point::Point', 'method')).toHaveLength(2);

    expect(has('implements', 'p::Point', 'p::Shape')).toBe(true);
  });

  it('synthesizes a field and an accessor per component, never shadowing a declared accessor', async () => {
    fixture();
    const { node } = await load();
    expect(node('p::Point::x', 'field').map((n) => n.signature)).toEqual(['int x']);
    expect(node('p::Point::x', 'method').map((n) => n.signature)).toEqual(['int x()']);
    expect(node('p::Pair::first', 'field').map((n) => n.signature)).toEqual(['A first']);
    expect(node('p::Point::Inner::name', 'method')).toHaveLength(1);

    // RemoteInfo declares remoteAddress() itself — exactly one, the hand-written one.
    const accessor = node('p::Http::RemoteInfo::remoteAddress', 'method');
    expect(accessor).toHaveLength(1);
    expect(accessor[0]!.docstring).toBeNull();
    expect(node('p::Http::RemoteInfo::port', 'method')[0]!.docstring).toBe('Implicit record component accessor');
  });

  it('resolves calls on record-typed locals, fields and parameters to the record', async () => {
    fixture();
    const { has } = await load();
    expect(has('calls', 'p::Http::use', 'p::Point::norm')).toBe(true); // local + param
    expect(has('calls', 'p::Http::use', 'p::Shape::norm')).toBe(false);
    expect(has('calls', 'p::Http::use', 'p::Http::RemoteInfo::remoteAddress')).toBe(true); // field
    expect(has('calls', 'p::Http::use', 'p::Http::RemoteInfo::describe')).toBe(true); // param
    expect(has('calls', 'p::Http::use', 'p::Point::x')).toBe(true); // implicit accessor
    expect(has('calls', 'p::Http::use', 'p::Pair::left')).toBe(true); // generic record
    expect(has('instantiates', 'p::Http::use', 'p::Point')).toBe(true);
  });
});
