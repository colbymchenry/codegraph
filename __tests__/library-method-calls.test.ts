/**
 * A standard-library method called on a receiver of unknown type — Rust
 * `data.len()` / `name.trim().len()`, Kotlin `entries.isEmpty()`, Python
 * `options.setdefault(...)`, Go `conn.Write(...)`, C# `Task.Run(...)` — does
 * not bind by name to the one project method that shares the name. The
 * name-only fallbacks (a lone same-named method for an untyped `recv.m`, and
 * exact-name matching of a chained call that reaches the resolver as the bare
 * method name) now need the receiver's own words to name the method's type.
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
  'rs/src/logging.rs':
    'pub struct AppLog;\n' +
    'impl AppLog {\n' +
    '    pub fn len(&self) -> usize { 0 }\n' +
    '    pub fn is_empty(&self) -> bool { true }\n' +
    '    pub fn clear(&self) {}\n' +
    '    pub fn info(&self, _m: &str) {}\n' +
    '}\n',
  'rs/src/state.rs':
    'use crate::logging::AppLog;\n' +
    'pub struct State { pub log: AppLog }\n' +
    'pub fn sizes(data: Vec<u8>, name: String, st: &State) -> usize {\n' +
    '    let a = data.len();\n' +
    '    let b = name.trim().len();\n' +
    '    st.log.clear();\n' +
    '    st.log.info("x");\n' +
    '    a + b\n' +
    '}\n' +
    'pub fn typed(log: &AppLog) -> bool { log.is_empty() }\n',
  'kt/DiagOutbox.kt':
    'class DiagOutbox {\n' +
    '    fun isEmpty(): Boolean = true\n' +
    '    fun size(): Int = if (isEmpty()) 0 else 1\n' +
    '}\n' +
    'enum class GpsMode { ON, OFF; fun next(): GpsMode = OFF }\n',
  'kt/Use.kt':
    'fun check(entries: List<String>): Boolean {\n' +
    '    GpsMode.ON.next()\n' +
    '    return entries.isEmpty()\n' +
    '}\n',
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
  'cs/Runner.cs':
    'using System.Threading.Tasks;\n' +
    'class Runner { public void Run() {} }\n' +
    'class Use {\n' +
    '    void Go(Runner runner) {\n' +
    '        Task.Run(() => {});\n' +
    '        runner.Run();\n' +
    '    }\n' +
    '}\n',
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
  'java/com/app/Maps.java':
    'package com.app;\n' +
    'public class Maps {\n' +
    '    public static Object emptyMap() { return null; }\n' +
    '}\n',
  'java/com/app/Use.java':
    'package com.app;\n' +
    'import java.util.*;\n' +
    'public class Use {\n' +
    '    private Registry registry;\n' +
    '    Object untyped(List<String> list, Object s, String a) {\n' +
    '        Object first = list.get(0);\n' +
    '        s.toString();\n' +
    '        Objects.hash(a);\n' +
    '        Collections.emptyMap();\n' +
    '        Registry.KEY.equals(a);\n' +
    '        return first;\n' +
    '    }\n' +
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
  it('Rust: `data.len()` and `name.trim().len()` do not bind to a project `len`', () => {
    expect(calleesOf('sizes', 'state.rs')).toEqual(['AppLog::clear', 'AppLog::info']);
  });

  it('Rust: a typed receiver still resolves the library-named method', () => {
    expect(calleesOf('typed', 'state.rs')).toEqual(['AppLog::is_empty']);
  });

  it('Kotlin: `entries.isEmpty()` declines; an implicit-this call and a type-rooted chain keep theirs', () => {
    expect(calleesOf('check', 'Use.kt')).toEqual(['GpsMode::next']);
    expect(calleesOf('size', 'DiagOutbox.kt')).toEqual(['DiagOutbox::isEmpty']);
  });

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

  it('C#: `Task.Run` does not bind to a project `Run`; the typed receiver does', () => {
    const lines = cg.getCallees(node('Go', 'Runner.cs').id)
      .filter(({ edge }) => edge.kind === 'calls')
      .map(({ edge }) => edge.line);
    expect(lines).toEqual([6]);
  });

  it('Java: `list.get(0)`, `s.toString()`, `Objects.hash(a)`, `Collections.emptyMap()` and a constant\'s `equals` do not bind to a lone project method', () => {
    expect(calleesOf('untyped', 'Use.java')).toEqual([]);
  });

  it('Java: a typed field, an own-class call and a receiver named after the type keep their method', () => {
    expect(calleesOf('typed', 'Use.java')).toEqual(['Registry::get']);
    expect(calleesOf('count', 'Registry.java')).toEqual(['Registry::size']);
    expect(calleesOf('own', 'Registry.java')).toEqual(['Registry::get']);
    expect(calleesOf('named', 'Use.java')).toEqual(['Registry::size', 'Use::make']);
  });
});
