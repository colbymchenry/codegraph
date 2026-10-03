/**
 * A standard-library method called on a receiver of unknown type — Python
 * `options.setdefault(...)`, Scala `m.getOrElse(...)`, Java `m.put(...)` on a
 * `var` — does not bind by name to the one project method that shares the
 * name: the receiver's own words must name the method's type. A Go parameter
 * of a package-qualified library type (`conn net.Conn`) is that type's.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let dir: string;
let cg: CodeGraph;

const files: Record<string, string> = {
  'py/globals.py':
    'class Globals:\n' +
    '    def setdefault(self, key, value):\n' +
    '        return value\n' +
    '    def reset(self):\n' +
    '        return self.setdefault("a", 1)\n' +
    '\n' +
    'def build(options):\n' +
    '    options.setdefault("x", 1)\n' +
    '    return options.copy().setdefault("y", 2)\n',
  'go/log.go':
    'package main\n\nimport "net"\n\n' +
    'type ringLog struct{}\n\n' +
    'func (r *ringLog) Write(p []byte) (int, error) { return 0, nil }\n\n' +
    'func send(conn net.Conn) {\n\tconn.Write(nil)\n\tlogs := &ringLog{}\n\tlogs.Write(nil)\n}\n',
  'java/com/app/Registry.java':
    'package com.app;\n' +
    'public class Registry {\n' +
    '    public static final String KEY = "k";\n' +
    '    public Object get(String k) { return null; }\n' +
    '    public int size() { return 0; }\n' +
    '    public int hash() { return 0; }\n' +
    '    public boolean equals(Object o) { return false; }\n' +
    '    public String toString() { return "r"; }\n' +
    '    int count() { return size(); }\n' +
    '    Object own(String k) { return this.get(k); }\n' +
    '}\n',
  'sc/Registry.scala':
    'package app\n' +
    'class Registry {\n' +
    '  def getOrElse(d: Int): Int = d\n' +
    '}\n',
  'sc/Use.scala':
    'package app\n' +
    'object Use {\n' +
    '  def go(): Int = {\n' +
    '    val m = compute()\n' +
    '    m.getOrElse(0)\n' +
    '  }\n' +
    '  def compute() = Option(1)\n' +
    '  def viaName(): Int = { val registry = make(); registry.getOrElse(0) }\n' +
    '  def make() = new Registry\n' +
    '}\n',
  'java/com/app/Use.java':
    'package com.app;\n' +
    'import java.util.*;\n' +
    'public class Use {\n' +
    '    private Registry registry;\n' +
    '    Object untyped(String a) {\n' +
    '        var data = load();\n' +
    '        data.put(a, 1);\n' +
    '        return data.get(a);\n' +
    '    }\n' +
    '    Map<String, Object> load() { return null; }\n' +
    '    Object typed(String k) { return registry.get(k); }\n' +
    '    int named() { var userRegistry = make(); return userRegistry.size(); }\n' +
    '    Registry make() { return null; }\n' +
    '}\n',
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-libmethods-'));
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
});

afterAll(() => {
  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });
});

const node = (name: string, file: string) =>
  cg.getNodesByName(name).find((n) => n.filePath.endsWith(file) && (n.kind === 'function' || n.kind === 'method'))!;
const calleesOf = (name: string, file: string) =>
  cg.getCallees(node(name, file).id)
    .filter(({ edge }) => edge.kind === 'calls')
    .map(({ node: n }) => n.qualifiedName.split('::').slice(-2).join('::'))
    .sort();

describe('library-method calls on untyped receivers', () => {
  it('Python: `options.setdefault()` declines; `self.setdefault()` keeps its own method', () => {
    expect(calleesOf('build', 'globals.py')).toEqual([]);
    expect(calleesOf('reset', 'globals.py')).toEqual(['Globals::setdefault']);
  });

  it('Go: `conn.Write` on a net.Conn declines; the typed receiver keeps its method', () => {
    // Both calls name the same target, so check by line: only `logs.Write` (line 12) links.
    const lines = cg.getCallees(node('send', 'log.go').id)
      .filter(({ edge }) => edge.kind === 'calls')
      .map(({ edge }) => edge.line);
    expect(lines).toEqual([12]);
  });

  it('Scala: `m.getOrElse()` on an untyped value declines; a receiver named after the type keeps its method', () => {
    expect(calleesOf('go', 'Use.scala')).toEqual(['Use::compute']);
    expect(calleesOf('viaName', 'Use.scala')).toEqual(['Registry::getOrElse', 'Use::make']);
  });

  it('Java: `data.put()` / `data.get()` on an untyped `var` do not bind to a lone project method', () => {
    expect(calleesOf('untyped', 'Use.java')).toEqual(['Use::load']);
  });

  it('Java: a typed field, an own-class call and a receiver named after the type keep their method', () => {
    expect(calleesOf('typed', 'Use.java')).toEqual(['Registry::get']);
    expect(calleesOf('count', 'Registry.java')).toEqual(['Registry::size']);
    expect(calleesOf('own', 'Registry.java')).toEqual(['Registry::get']);
    expect(calleesOf('named', 'Use.java')).toEqual(['Registry::size', 'Use::make']);
  });
});
