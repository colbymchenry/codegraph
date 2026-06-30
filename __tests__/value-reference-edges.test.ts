/**
 * Value-reference edges (TS/JS): same-file `references` edges from a reader
 * symbol to the file-scope const/var it reads, so impact analysis catches
 * "change this constant, affect its readers". Default on; CODEGRAPH_VALUE_REFS=0
 * disables. See TreeSitterExtractor.flushValueRefs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src';

function valueRefReaders(cg: CodeGraph, constName: string): string[] {
  // Aggregate across ALL nodes of this name — a conditionally-defined module
  // const (`try: X=…; except: X=…`) has more than one, and the edge targets
  // whichever one ended up in the target map.
  const targets = cg.searchNodes(constName).map((r) => r.node).filter((n) => n.name === constName);
  const readers = new Set<string>();
  for (const t of targets) {
    for (const e of cg.getIncomingEdges(t.id)) {
      if (e.kind === 'references' && (e.metadata as { valueRef?: boolean } | undefined)?.valueRef) {
        const r = cg.getNode(e.source)?.name;
        if (r) readers.add(r);
      }
    }
  }
  return [...readers];
}

describe('value-reference edges', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-valueref-'));
  });
  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function index(): CodeGraph {
    const g = CodeGraph.initSync(dir, { config: { include: ['**/*.ts', '**/*.tsx'], exclude: [] } });
    return g;
  }

  it('edges same-file readers to the file-scope const they read (default on)', async () => {
    fs.writeFileSync(
      path.join(dir, 'config.ts'),
      [
        'export const TABLE_CONFIG = { rows: 10, cols: 4 };',
        'export function rowCount() { return TABLE_CONFIG.rows; }',
        'export function describeTable() { return `${TABLE_CONFIG.rows}x${TABLE_CONFIG.cols}`; }',
        'export const HEADER = TABLE_CONFIG.cols;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const readers = valueRefReaders(cg, 'TABLE_CONFIG');
    // rowCount, describeTable, and the HEADER const all read TABLE_CONFIG.
    expect(readers).toEqual(expect.arrayContaining(['rowCount', 'describeTable', 'HEADER']));
  });

  it('surfaces those readers in the impact radius of the const', async () => {
    fs.writeFileSync(
      path.join(dir, 'palette.ts'),
      [
        'export const COLOR_PALETTE = { red: "#f00", blue: "#00f" };',
        'export function pickRed() { return COLOR_PALETTE.red; }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    const target = cg.searchNodes('COLOR_PALETTE').map((r) => r.node).find((n) => n.name === 'COLOR_PALETTE')!;
    const impacted = [...cg.getImpactRadius(target.id).nodes.values()].map((n) => n.name);
    expect(impacted).toContain('pickRed');
  });

  it('does NOT edge a shadowed const — inner re-declaration makes the name ambiguous', async () => {
    // The Emscripten/bundled pattern: a file-scope `const Module` re-declared as
    // an inner `var Module` / param. Nested readers resolve to the INNER binding,
    // so a file-scope edge would be a false positive. The shadow guard drops it.
    fs.writeFileSync(
      path.join(dir, 'bundled.ts'),
      [
        'const Module = (function () {',
        '  return function (Module) {',
        '    var Module = typeof Module !== "undefined" ? Module : {};',
        '    function locate() { return Module.path; }',
        '    function getFunc() { return Module.lookup; }',
        '    return { locate, getFunc };',
        '  };',
        '})();',
        'export default Module;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    // No reader should be edged to the outer `const Module`.
    expect(valueRefReaders(cg, 'Module')).toEqual([]);
  });

  it('edges readers that use the const only inside JSX (.tsx)', async () => {
    // The tsx-specific path: the const is read ONLY inside JSX expressions, so
    // the reader-scan must descend into the JSX subtree to find it.
    fs.writeFileSync(
      path.join(dir, 'widget.tsx'),
      [
        'export const THEME_TOKENS = { color: "red", size: 12 };',
        'export function Label() {',
        '  return <span style={{ color: THEME_TOKENS.color }}>hi</span>;',
        '}',
        'export const Box = () => <div data-size={THEME_TOKENS.size} />;',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'THEME_TOKENS')).toEqual(expect.arrayContaining(['Label', 'Box']));
  });

  it('edges same-file readers to a module-level const/static (Rust)', async () => {
    fs.writeFileSync(
      path.join(dir, 'lib.rs'),
      [
        'const MAX_RETRIES: u32 = 3;',
        'static DEFAULT_LABEL: &str = "prod";',
        '',
        'fn retry() -> u32 { MAX_RETRIES }',
        "fn label() -> &'static str { DEFAULT_LABEL }",
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_RETRIES')).toEqual(expect.arrayContaining(['retry']));
    expect(valueRefReaders(cg, 'DEFAULT_LABEL')).toEqual(expect.arrayContaining(['label']));
  });

  it('does NOT edge a Rust const shadowed by a local let of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'shadow.rs'),
      [
        'const TIMEOUT: u32 = 30;',
        '',
        'fn uses_const() -> u32 { TIMEOUT }',
        'fn shadows() -> u32 {',
        '    let TIMEOUT = 5;',
        '    TIMEOUT',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges same-file readers to a package-level const/var (Go)', async () => {
    fs.writeFileSync(
      path.join(dir, 'main.go'),
      [
        'package main',
        '',
        'const MaxRetries = 3',
        'var DefaultLabels = map[string]string{"env": "prod"}',
        '',
        'func retry() int { return MaxRetries }',
        'func labels() map[string]string { return DefaultLabels }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MaxRetries')).toEqual(expect.arrayContaining(['retry']));
    expect(valueRefReaders(cg, 'DefaultLabels')).toEqual(expect.arrayContaining(['labels']));
  });

  it('does NOT edge a Go package const shadowed by a local := of the same name', async () => {
    // `Timeout` is a package const AND a local `:=` (short_var_declaration) in
    // shadows(). The local read resolves to the inner binding, so a file-scope
    // edge would be a false positive — the shadow prune drops the whole target.
    fs.writeFileSync(
      path.join(dir, 'shadow.go'),
      [
        'package main',
        '',
        'const Timeout = 30',
        '',
        'func usesConst() int { return Timeout }',
        'func shadows() int {',
        '\tTimeout := 5',
        '\treturn Timeout',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'Timeout')).toEqual([]);
  });

  it('keeps a conditionally-defined module const (try/except), not a shadow (Python)', async () => {
    // `HAS_SSL` is defined twice but BOTH at module scope (a conditional def, a
    // very common Python idiom). It is one logical const, not a shadow, so its
    // reader must stay edged — and the two halves must not edge each other.
    fs.writeFileSync(
      path.join(dir, 'cond.py'),
      [
        'try:',
        '\tHAS_SSL = True',
        'except ImportError:',
        '\tHAS_SSL = False',
        '',
        'def uses_ssl():',
        '\treturn HAS_SSL',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'HAS_SSL')).toEqual(['uses_ssl']);
  });

  it('edges readers to a top-level AND a class-internal constant (Ruby)', async () => {
    // Ruby keeps almost all constants inside a class/module. Both the top-level
    // `MAX_RETRIES` and the class-internal `Config::TIMEOUT` must be targets, and
    // their same-file readers edged (TIMEOUT is read by two methods of Config).
    fs.writeFileSync(
      path.join(dir, 'app.rb'),
      [
        'MAX_RETRIES = 3',
        '',
        'def retry_count',
        '  MAX_RETRIES',
        'end',
        '',
        'class Config',
        '  TIMEOUT = 30',
        '  def self.get_timeout',
        '    TIMEOUT',
        '  end',
        '  def describe',
        '    "timeout=#{TIMEOUT}"',
        '  end',
        'end',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_RETRIES')).toEqual(expect.arrayContaining(['retry_count']));
    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual(expect.arrayContaining(['get_timeout', 'describe']));
  });

  it('edges same-file readers to a file-scope const/table (C)', async () => {
    // C keeps shareable values at file scope as `static const` — scalars and,
    // very commonly, pointer/array lookup tables. Both must be extracted as
    // nodes (the generic fallback misses C's nested init_declarator name) and
    // their same-file readers edged.
    fs.writeFileSync(
      path.join(dir, 'config.c'),
      [
        'static const int MAX_ITEMS = 100;',
        'static const char *const STATUS_NAMES[] = { "ok", "fail", "pending" };',
        '',
        'int capped(int n) { return n > MAX_ITEMS ? MAX_ITEMS : n; }',
        'const char *label(int i) { return STATUS_NAMES[i]; }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_ITEMS')).toEqual(expect.arrayContaining(['capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
  });

  it('does NOT edge a C file const shadowed by a function-local of the same name', async () => {
    // `TIMEOUT` is a file const AND a local `int TIMEOUT = 5` (init_declarator)
    // in shadows(). The local read resolves to the inner binding, so a
    // file-scope edge would be a false positive — the shadow prune drops it.
    fs.writeFileSync(
      path.join(dir, 'shadow.c'),
      [
        'static const int TIMEOUT = 30;',
        '',
        'int uses_const(void) { return TIMEOUT; }',
        'int shadows(void) {',
        '    int TIMEOUT = 5;',
        '    return TIMEOUT;',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('does NOT mint a value target from a macro-prefixed C prototype (return-type misparse)', async () => {
    // A prototype led by an unknown macro (`CURL_EXTERN CURLcode fn(args);`)
    // makes tree-sitter-c misparse it as a declaration whose "variable" is the
    // bare return-type identifier — which would mint a spurious `CURLcode`
    // value target read by every function of that type. The bare-identifier
    // skip prevents it, while real file-scope consts still edge their readers.
    fs.writeFileSync(
      path.join(dir, 'api.c'),
      [
        'typedef enum { CURLE_OK, CURLE_FAIL } CURLcode;',
        'CURL_EXTERN CURLcode curl_easy_init(int x);',
        'CURL_EXTERN CURLcode curl_easy_setopt(int y);',
        '',
        'static const int REAL_LIMIT = 42;',
        'int use_real(void) { return REAL_LIMIT; }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    // The return-type name is never extracted as a const/var, so it is not a
    // value-ref target at all.
    const curlcodeValues = cg
      .searchNodes('CURLcode')
      .map((r) => r.node)
      .filter((n) => n.name === 'CURLcode' && (n.kind === 'constant' || n.kind === 'variable'));
    expect(curlcodeValues).toEqual([]);
    // Real file-scope consts alongside the misparse-prone prototypes still work.
    expect(valueRefReaders(cg, 'REAL_LIMIT')).toEqual(expect.arrayContaining(['use_real']));
  });

  it('edges same-file methods to a class-scope static final constant (Java)', async () => {
    // Java keeps constants as `static final` fields inside a class. They extract
    // as `constant` kind (not `field`) so the value-ref gate targets them; a
    // plain instance `final` field is NOT a constant and must not be a target.
    fs.writeFileSync(
      path.join(dir, 'Limits.java'),
      [
        'class Limits {',
        '  public static final int MAX_ITEMS = 100;',
        '  static final String[] STATUS_NAMES = { "ok", "fail" };',
        '  final int instanceId = 1;',
        '  int capped(int n) { return n > MAX_ITEMS ? MAX_ITEMS : n; }',
        '  String label(int i) { return STATUS_NAMES[i]; }',
        '  int id() { return instanceId; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_ITEMS')).toEqual(expect.arrayContaining(['capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
    // An instance `final` field is mutable per-object state, not a shared
    // constant — it stays `field` kind and is never a value-ref target.
    expect(valueRefReaders(cg, 'instanceId')).toEqual([]);
  });

  it('does NOT edge a Java class const shadowed by a method-local of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'Shadow.java'),
      [
        'class Shadow {',
        '  static final int TIMEOUT = 30;',
        '  int usesConst() { return TIMEOUT; }',
        '  int shadows() { int TIMEOUT = 5; return TIMEOUT; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges same-file methods to a class const / static readonly (C#)', async () => {
    // C# constants are `const` (compile-time) or `static readonly` (runtime);
    // both extract as `constant`. An instance `readonly` field is per-object and
    // stays `field`.
    fs.writeFileSync(
      path.join(dir, 'Limits.cs'),
      [
        'class Limits {',
        '  const int MAX_ITEMS = 100;',
        '  static readonly string[] STATUS_NAMES = { "ok", "fail" };',
        '  readonly int instanceId = 1;',
        '  int Capped(int n) { return n > MAX_ITEMS ? MAX_ITEMS : n; }',
        '  string Label(int i) { return STATUS_NAMES[i]; }',
        '  int Id() { return instanceId; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_ITEMS')).toEqual(expect.arrayContaining(['Capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['Label']));
    expect(valueRefReaders(cg, 'instanceId')).toEqual([]);
  });

  it('does NOT edge a C# class const shadowed by a method-local of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'Shadow.cs'),
      [
        'class Shadow {',
        '  const int TIMEOUT = 30;',
        '  int UsesConst() { return TIMEOUT; }',
        '  int Shadows() { int TIMEOUT = 5; return TIMEOUT; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges same-file readers to a top-level and class const, incl. self:: / Class:: (PHP)', async () => {
    // PHP keeps constants at file scope (`const X`) and inside classes (`const
    // X`), both extracted as `constant`. A constant *reference* is a `name` node
    // (bare `X`, or the const half of `self::X` / `Foo::X`), so the reader-scan
    // must match `name`. A `$var` local is a different namespace and can never
    // shadow a bare constant — so there is nothing to prune.
    fs.writeFileSync(
      path.join(dir, 'Config.php'),
      [
        '<?php',
        'const APP_VERSION = "1.0";',
        'class Config {',
        '  const MAX_ITEMS = 100;',
        '  const STATUS_NAMES = ["ok", "fail"];',
        '  public static $counter = 0;',
        '  function capped($n) { return $n > self::MAX_ITEMS ? self::MAX_ITEMS : $n; }',
        '  function label($i) { return Config::STATUS_NAMES[$i]; }',
        '  function version() { return APP_VERSION; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_ITEMS')).toEqual(expect.arrayContaining(['capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
    expect(valueRefReaders(cg, 'APP_VERSION')).toEqual(expect.arrayContaining(['version']));
    // A static property is mutable class state, not a constant — never a target.
    expect(valueRefReaders(cg, 'counter')).toEqual([]);
  });

  it('edges readers to a top-level and object-scope val, not a class instance val (Scala)', async () => {
    // Scala has no `static`: an `object` is a singleton, so its `val`s are the
    // shared-constant idiom (extracted as `constant`, like a top-level val). A
    // `class` val is a per-instance immutable field (`field`, never a target).
    fs.writeFileSync(
      path.join(dir, 'Demo.scala'),
      [
        'val AppVersion = "1.0"',
        'object Config {',
        '  val TIMEOUT_MS = 30',
        '  val STATUS_NAMES = List("ok", "fail")',
        '  def capped(n: Int): Int = if (n > TIMEOUT_MS) TIMEOUT_MS else n',
        '  def label(i: Int): String = STATUS_NAMES(i)',
        '}',
        'class Widget {',
        '  val MaxItems = 100',
        '  def within(n: Int): Int = if (n < MaxItems) n else MaxItems',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT_MS')).toEqual(expect.arrayContaining(['capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
    // A class instance `val` is per-object state (kind `field`), not a shared
    // constant — never a value-ref target even though `within` reads it.
    expect(valueRefReaders(cg, 'MaxItems')).toEqual([]);
  });

  it('does NOT edge a Scala object val shadowed by a method-local val of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'Shadow.scala'),
      [
        'object Config {',
        '  val TIMEOUT = 30',
        '  def usesConst(): Int = TIMEOUT',
        '  def shadows(): Int = { val TIMEOUT = 5; TIMEOUT }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges readers to top-level, object, and companion-object constants, not a class val (Kotlin)', async () => {
    // Kotlin has no `static`: a top-level property, an `object` (singleton), and a
    // class's `companion object` all hold shared constants (`val`→constant). A
    // class instance `val` is per-object state (`field`, never a target). The
    // property name nests as variable_declaration→simple_identifier, and a const
    // reference is a `simple_identifier`.
    fs.writeFileSync(
      path.join(dir, 'Demo.kt'),
      [
        'const val TOP_LEVEL_MAX = 100',
        'object Config {',
        '  const val TIMEOUT_MS = 30',
        '  val STATUS_NAMES = listOf("ok", "fail")',
        '  fun capped(n: Int): Int = if (n > TIMEOUT_MS) TIMEOUT_MS else n',
        '  fun label(i: Int): String = STATUS_NAMES[i]',
        '}',
        'class Widget {',
        '  companion object { const val MAX_RETRIES = 3 }',
        '  val instanceField = 1',
        '  fun retries(): Int = MAX_RETRIES',
        '  fun within(n: Int): Int = if (n < TOP_LEVEL_MAX) n else TOP_LEVEL_MAX',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
    expect(valueRefReaders(cg, 'MAX_RETRIES')).toEqual(expect.arrayContaining(['retries']));
    expect(valueRefReaders(cg, 'TOP_LEVEL_MAX')).toEqual(expect.arrayContaining(['within']));
    // A class instance `val` is per-object state (kind `field`), never a target.
    expect(valueRefReaders(cg, 'instanceField')).toEqual([]);
  });

  it('does NOT edge a Kotlin object const shadowed by a method-local val of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'Shadow.kt'),
      [
        'object Config {',
        '  const val TIMEOUT = 30',
        '  fun usesConst(): Int = TIMEOUT',
        '  fun shadows(): Int { val TIMEOUT = 5; return TIMEOUT }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges readers to a top-level let and static let in enum/struct, not an instance let (Swift)', async () => {
    // Swift has no `static` keyword for globals; the shared-constant idiom is a
    // top-level `let` or a `static let` inside a type — Swift namespaces these in
    // `enum`/`struct`. Those extract as `constant`; an instance stored `let` is
    // per-object (`field`, never a target); a *computed* property is skipped.
    fs.writeFileSync(
      path.join(dir, 'Demo.swift'),
      [
        'let topLevelMax = 100',
        'enum Constants {',
        '  static let TIMEOUT_MS = 30',
        '  static let STATUS_NAMES = ["ok", "fail"]',
        '}',
        'struct Widget {',
        '  static let MAX_RETRIES = 3',
        '  let instanceField = 1',
        '  func retries() -> Int { return Widget.MAX_RETRIES }',
        '  func within(_ n: Int) -> Int { return n < topLevelMax ? n : topLevelMax }',
        '}',
        'func labels(_ i: Int) -> String { return Constants.STATUS_NAMES[i] }',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['labels']));
    expect(valueRefReaders(cg, 'MAX_RETRIES')).toEqual(expect.arrayContaining(['retries']));
    expect(valueRefReaders(cg, 'topLevelMax')).toEqual(expect.arrayContaining(['within']));
    // An instance `let` is per-object state (kind `field`), never a target.
    expect(valueRefReaders(cg, 'instanceField')).toEqual([]);
  });

  it('does NOT edge a Swift static const shadowed by a function-local let of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'Shadow.swift'),
      [
        'enum Config {',
        '  static let TIMEOUT = 30',
        '  static func usesConst() -> Int { return TIMEOUT }',
        '  static func shadows() -> Int { let TIMEOUT = 5; return TIMEOUT }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges readers to a top-level const and a class static const/final (Dart)', async () => {
    // Dart's grammar uses `static_final_declaration` for exactly the top-level
    // `const`/`final` and class `static const`/`static final` — the shared
    // constants — so those extract as `constant`. Instance fields and `var`
    // (`initialized_identifier`) and locals (`initialized_variable_definition`)
    // are NOT this node, so they never become targets. Dart attaches a method
    // body as a sibling of the signature, so the reader-scan pulls that in.
    fs.writeFileSync(
      path.join(dir, 'demo.dart'),
      [
        'const TOP_LEVEL_MAX = 100;',
        'class Config {',
        '  static const TIMEOUT_MS = 30;',
        '  static final STATUS_NAMES = ["ok", "fail"];',
        '  final int instanceField = 1;',
        '  int capped(int n) => n > TIMEOUT_MS ? TIMEOUT_MS : n;',
        '  String label(int i) { return STATUS_NAMES[i]; }',
        '  int withinLimit(int n) => n < TOP_LEVEL_MAX ? n : TOP_LEVEL_MAX;',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT_MS')).toEqual(expect.arrayContaining(['capped']));
    expect(valueRefReaders(cg, 'STATUS_NAMES')).toEqual(expect.arrayContaining(['label']));
    expect(valueRefReaders(cg, 'TOP_LEVEL_MAX')).toEqual(expect.arrayContaining(['withinLimit']));
    // An instance field is per-object state, never a value-ref target.
    expect(valueRefReaders(cg, 'instanceField')).toEqual([]);
  });

  it('does NOT edge a Dart const shadowed by a method-local const of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'shadow.dart'),
      [
        'const TIMEOUT = 30;',
        'class C {',
        '  int usesConst() => TIMEOUT;',
        '  int shadows() { const TIMEOUT = 5; return TIMEOUT; }',
        '}',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('edges same-file functions to a unit-scope const (Pascal)', async () => {
    // Pascal keeps shareable constants in a `const` section at unit (file) scope
    // (and class scope). They already extract as `constant`. A const reference is
    // an `identifier`; the catch is that Pascal attaches a proc body (`block`) as
    // a sibling of the proc header (`declProc`, the reader scope), so the
    // reader-scan pulls in that sibling.
    fs.writeFileSync(
      path.join(dir, 'demo.pas'),
      [
        'unit Demo;',
        'interface',
        'const',
        '  MAX_ITEMS = 100;',
        "  APP_NAME = 'MyApp';",
        'implementation',
        'function Capped(n: Integer): Integer;',
        'begin',
        '  if n > MAX_ITEMS then Capped := MAX_ITEMS else Capped := n;',
        'end;',
        'function AppLabel: string;',
        'begin',
        '  AppLabel := APP_NAME;',
        'end;',
        'end.',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'MAX_ITEMS')).toEqual(expect.arrayContaining(['Capped']));
    expect(valueRefReaders(cg, 'APP_NAME')).toEqual(expect.arrayContaining(['AppLabel']));
  });

  it('does NOT edge a Pascal unit const shadowed by a function-local const of the same name', async () => {
    fs.writeFileSync(
      path.join(dir, 'shadow.pas'),
      [
        'unit Shadow;',
        'interface',
        'const',
        '  TIMEOUT = 30;',
        'implementation',
        'function UsesConst: Integer;',
        'begin',
        '  UsesConst := TIMEOUT;',
        'end;',
        'function Shadows: Integer;',
        'const TIMEOUT = 5;',
        'begin',
        '  Shadows := TIMEOUT;',
        'end;',
        'end.',
      ].join('\n'),
    );
    cg = index();
    await cg.indexAll();

    expect(valueRefReaders(cg, 'TIMEOUT')).toEqual([]);
  });

  it('emits nothing when CODEGRAPH_VALUE_REFS=0', async () => {
    const prev = process.env.CODEGRAPH_VALUE_REFS;
    process.env.CODEGRAPH_VALUE_REFS = '0';
    try {
      fs.writeFileSync(
        path.join(dir, 'config.ts'),
        ['export const TABLE_CONFIG = { rows: 10 };', 'export function rowCount() { return TABLE_CONFIG.rows; }'].join('\n'),
      );
      cg = index();
      await cg.indexAll();
      expect(valueRefReaders(cg, 'TABLE_CONFIG')).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.CODEGRAPH_VALUE_REFS;
      else process.env.CODEGRAPH_VALUE_REFS = prev;
    }
  });
});
