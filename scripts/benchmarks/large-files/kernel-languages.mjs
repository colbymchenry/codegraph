// How long the engine takes to index one large file, for each language its native kernel
// reads and each of several shapes a large file takes. An extractor and resolver that are
// linear index any of these in about a second a megabyte; work that grows with the square of
// the file shows as tens of seconds. See docs/design/large-file-performance.md.
//
//   node scripts/benchmarks/large-files/kernel-languages.mjs <built engine: dist> <megabytes> [language,language…] [shape,shape…]
//
// Prints one line a case: seconds to index, and the symbols the large file yielded (0 means
// the file was given up on, or the shape has none to yield). Cases over 2 seconds a megabyte
// are marked and listed at the end. Set CODEGRAPH_KERNEL=0 to time the wasm extractor.
// BENCH_WRITE=<folder> writes the files out instead of timing them (for compare-graphs.mjs).
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { more } from './kernel-shapes.mjs';

const [distArg, megabytes = '0.5', onlyLanguages = '', onlyShapes = ''] = process.argv.slice(2);
if (!distArg) {
  console.error('usage: kernel-languages.mjs <built engine: dist> <megabytes> [languages] [shapes]');
  process.exit(2);
}
const dist = resolve(distArg);
// The benchmark times the index, not telemetry or a shared daemon.
Object.assign(process.env, { CODEGRAPH_TELEMETRY: '0', DO_NOT_TRACK: '1', CODEGRAPH_NO_DAEMON: '1' });
const require = createRequire(import.meta.url);
const { CodeGraph } = require(join(dist, 'index.js'));
const { MAX_SOURCE_FILE_SIZE_BYTES } = require(join(dist, 'file-limits.js'));
const bytes = +megabytes * 1024 * 1024;

/** Repeat `unit(i)` until the text is `bytes` long, between a head and a tail. */
const fill = (unit, head = '', tail = '', size = bytes) => {
  const parts = [head];
  let length = head.length + tail.length;
  for (let i = 0; length < size; i++) {
    const part = unit(i);
    parts.push(part);
    length += part.length;
  }
  parts.push(tail);
  return parts.join('');
};

// Each language: its file extension and the shapes it has. A shape is the whole file's text.
const LANGUAGES = {
  python: {
    ext: 'py',
    functions: () => fill((i) => `def thing${i}(name):\n    return name + "${i}"\n\n`),
    decorated: () => fill((i) => `@cached\ndef thing${i}(name):\n    return name + "${i}"\n\n`, 'def cached(f):\n    return f\n\n'),
    methods: () => fill((i) => `    def thing${i}(self, name):\n        return name + "${i}"\n\n`, 'class Big:\n'),
    variables: () => fill((i) => `VALUE_${i} = "${i}" + str(${i})\n`),
    data: () => fill((i) => `    ("name${i}", ${i}, helper(${i})),\n`, 'def helper(x):\n    return x\n\nROWS = [\n', ']\n'),
    calls: () => fill((i) => `    helper(${i}, "name${i}")\n`, 'def helper(x, y):\n    return x\n\ndef run():\n'),
    classes: () => fill((i) => `class Thing${i}:\n    def run(self):\n        return ${i}\n\n`),
  },
  ruby: {
    ext: 'rb',
    functions: () => fill((i) => `def thing${i}(name)\n  name.to_s + "${i}"\nend\n\n`),
    methods: () => fill((i) => `  def thing${i}(name)\n    name.to_s + "${i}"\n  end\n\n`, 'class Big\n', 'end\n'),
    variables: () => fill((i) => `VALUE_${i} = "${i}" + ${i}.to_s\n`),
    data: () => fill((i) => `  ["name${i}", ${i}, helper(${i})],\n`, 'def helper(x)\n  x\nend\n\nROWS = [\n', ']\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}")\n`, 'def helper(x, y)\n  x\nend\n\ndef run\n', 'end\n'),
    classes: () => fill((i) => `class Thing${i}\n  def run\n    ${i}\n  end\nend\n\n`),
  },
  typescript: {
    ext: 'ts',
    functions: () => fill((i) => `function thing${i}(name: string): string {\n  return name + "${i}";\n}\n\n`),
    exported: () => fill((i) => `export function thing${i}(name: string): string {\n  return name + "${i}";\n}\n\n`),
    methods: () => fill((i) => `  thing${i}(name: string): string {\n    return name + "${i}";\n  }\n\n`, 'export class Big {\n', '}\n'),
    decorated: () => fill((i) => `  @cached()\n  thing${i}(name: string): string {\n    return name + "${i}";\n  }\n\n`, 'declare function cached(): any;\nexport class Big {\n', '}\n'),
    variables: () => fill((i) => `export const VALUE_${i} = "${i}" + String(${i});\n`),
    data: () => fill((i) => `  ["name${i}", ${i}, helper(${i})],\n`, 'function helper(x: number) { return x; }\nexport const ROWS = [\n', '];\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, 'function helper(x: number, y: string) { return x; }\nexport function run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  run() {\n    return ${i};\n  }\n}\n\n`),
  },
  javascript: {
    ext: 'js',
    functions: () => fill((i) => `function thing${i}(name) {\n  return name + "${i}";\n}\n\n`),
    methods: () => fill((i) => `  thing${i}(name) {\n    return name + "${i}";\n  }\n\n`, 'class Big {\n', '}\n'),
    variables: () => fill((i) => `const VALUE_${i} = "${i}" + String(${i});\n`),
    data: () => fill((i) => `  ["name${i}", ${i}, helper(${i})],\n`, 'function helper(x) { return x; }\nconst ROWS = [\n', '];\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, 'function helper(x, y) { return x; }\nfunction run() {\n', '}\n'),
  },
  go: {
    ext: 'go',
    functions: () => fill((i) => `func Thing${i}(name string) string {\n\treturn name + "${i}"\n}\n\n`, 'package big\n\n'),
    methods: () => fill((i) => `func (b *Big) Thing${i}(name string) string {\n\treturn name + "${i}"\n}\n\n`, 'package big\n\ntype Big struct{}\n\n'),
    variables: () => fill((i) => `var Value${i} = "${i}" + "x"\n`, 'package big\n\n'),
    data: () => fill((i) => `\t{"name${i}", ${i}, helper(${i})},\n`, 'package big\n\ntype row struct {\n\tname string\n\tn int\n\th int\n}\n\nfunc helper(x int) int { return x }\n\nvar Rows = []row{\n', '}\n'),
    calls: () => fill((i) => `\thelper(${i}, "name${i}")\n`, 'package big\n\nfunc helper(x int, y string) int { return x }\n\nfunc Run() {\n', '}\n'),
    types: () => fill((i) => `type Thing${i} struct {\n\tName string\n}\n\n`, 'package big\n\n'),
  },
  java: {
    ext: 'java',
    methods: () => fill((i) => `  String thing${i}(String name) {\n    return name + "${i}";\n  }\n\n`, 'public class Big {\n', '}\n'),
    decorated: () => fill((i) => `  @Deprecated\n  String thing${i}(String name) {\n    return name + "${i}";\n  }\n\n`, 'public class Big {\n', '}\n'),
    variables: () => fill((i) => `  static final String VALUE_${i} = "${i}" + "x";\n`, 'public class Big {\n', '}\n'),
    data: () => fill((i) => `    {"name${i}", "${i}", helper(${i})},\n`, 'public class Big {\n  static String helper(int x) { return "" + x; }\n  static final String[][] ROWS = {\n', '  };\n}\n'),
    calls: () => fill((i) => `    helper(${i}, "name${i}");\n`, 'public class Big {\n  static int helper(int x, String y) { return x; }\n  void run() {\n', '  }\n}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  int run() {\n    return ${i};\n  }\n}\n\n`),
  },
  csharp: {
    ext: 'cs',
    methods: () => fill((i) => `  string Thing${i}(string name) {\n    return name + "${i}";\n  }\n\n`, 'public class Big {\n', '}\n'),
    decorated: () => fill((i) => `  [Obsolete]\n  string Thing${i}(string name) {\n    return name + "${i}";\n  }\n\n`, 'public class Big {\n', '}\n'),
    variables: () => fill((i) => `  const string Value${i} = "${i}" + "x";\n`, 'public class Big {\n', '}\n'),
    calls: () => fill((i) => `    Helper(${i}, "name${i}");\n`, 'public class Big {\n  static int Helper(int x, string y) { return x; }\n  void Run() {\n', '  }\n}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  int Run() {\n    return ${i};\n  }\n}\n\n`),
  },
  php: {
    ext: 'php',
    functions: () => fill((i) => `function thing${i}($name) {\n  return $name . "${i}";\n}\n\n`, '<?php\n'),
    methods: () => fill((i) => `  function thing${i}($name) {\n    return $name . "${i}";\n  }\n\n`, '<?php\nclass Big {\n', '}\n'),
    data: () => fill((i) => `  ["name${i}", ${i}, helper(${i})],\n`, '<?php\nfunction helper($x) { return $x; }\n$rows = [\n', '];\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, '<?php\nfunction helper($x, $y) { return $x; }\nfunction run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  function run() {\n    return ${i};\n  }\n}\n\n`, '<?php\n'),
  },
  kotlin: {
    ext: 'kt',
    functions: () => fill((i) => `fun thing${i}(name: String): String {\n    return name + "${i}"\n}\n\n`),
    decorated: () => fill((i) => `@Deprecated("x")\nfun thing${i}(name: String): String {\n    return name + "${i}"\n}\n\n`),
    methods: () => fill((i) => `    fun thing${i}(name: String): String {\n        return name + "${i}"\n    }\n\n`, 'class Big {\n', '}\n'),
    variables: () => fill((i) => `val VALUE_${i} = "${i}" + "x"\n`),
    calls: () => fill((i) => `    helper(${i}, "name${i}")\n`, 'fun helper(x: Int, y: String): Int { return x }\n\nfun run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\n    fun run(): Int {\n        return ${i}\n    }\n}\n\n`),
  },
  swift: {
    ext: 'swift',
    functions: () => fill((i) => `func thing${i}(name: String) -> String {\n    return name + "${i}"\n}\n\n`),
    decorated: () => fill((i) => `@discardableResult\nfunc thing${i}(name: String) -> String {\n    return name + "${i}"\n}\n\n`),
    methods: () => fill((i) => `    func thing${i}(name: String) -> String {\n        return name + "${i}"\n    }\n\n`, 'class Big {\n', '}\n'),
    variables: () => fill((i) => `let value${i} = "${i}" + "x"\n`),
    calls: () => fill((i) => `    helper(${i}, "name${i}")\n`, 'func helper(_ x: Int, _ y: String) -> Int { return x }\n\nfunc run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\n    func run() -> Int {\n        return ${i}\n    }\n}\n\n`),
  },
  scala: {
    ext: 'scala',
    functions: () => fill((i) => `  def thing${i}(name: String): String = {\n    name + "${i}"\n  }\n\n`, 'object Big {\n', '}\n'),
    decorated: () => fill((i) => `  @deprecated\n  def thing${i}(name: String): String = {\n    name + "${i}"\n  }\n\n`, 'object Big {\n', '}\n'),
    variables: () => fill((i) => `  val value${i} = "${i}" + "x"\n`, 'object Big {\n', '}\n'),
    calls: () => fill((i) => `    helper(${i}, "name${i}")\n`, 'object Big {\n  def helper(x: Int, y: String): Int = x\n  def run(): Unit = {\n', '  }\n}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  def run(): Int = ${i}\n}\n\n`),
  },
  dart: {
    ext: 'dart',
    functions: () => fill((i) => `String thing${i}(String name) {\n  return name + "${i}";\n}\n\n`),
    decorated: () => fill((i) => `@deprecated\nString thing${i}(String name) {\n  return name + "${i}";\n}\n\n`),
    methods: () => fill((i) => `  String thing${i}(String name) {\n    return name + "${i}";\n  }\n\n`, 'class Big {\n', '}\n'),
    variables: () => fill((i) => `const value${i} = "${i}" + "x";\n`),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, 'int helper(int x, String y) { return x; }\n\nvoid run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\n  int run() {\n    return ${i};\n  }\n}\n\n`),
  },
  rust: {
    ext: 'rs',
    functions: () => fill((i) => `fn thing${i}(name: &str) -> String {\n    format!("{}${i}", name)\n}\n\n`),
    decorated: () => fill((i) => `#[inline]\nfn thing${i}(name: &str) -> String {\n    format!("{}${i}", name)\n}\n\n`),
    methods: () => fill((i) => `    fn thing${i}(&self, name: &str) -> String {\n        format!("{}${i}", name)\n    }\n\n`, 'struct Big;\n\nimpl Big {\n', '}\n'),
    variables: () => fill((i) => `const VALUE_${i}: &str = "${i}";\n`),
    data: () => fill((i) => `    ("name${i}", ${i}, helper(${i})),\n`, 'const fn helper(x: i32) -> i32 { x }\n\nstatic ROWS: &[(&str, i32, i32)] = &[\n', '];\n'),
    calls: () => fill((i) => `    helper(${i}, "name${i}");\n`, 'fn helper(x: i32, y: &str) -> i32 { x }\n\nfn run() {\n', '}\n'),
    types: () => fill((i) => `struct Thing${i} {\n    name: String,\n}\n\n`),
  },
  c: {
    ext: 'c',
    functions: () => fill((i) => `int thing${i}(int name) {\n  return name + ${i};\n}\n\n`),
    variables: () => fill((i) => `static const int VALUE_${i} = ${i} + 1;\n`),
    data: () => fill((i) => `  {"name${i}", ${i}, ${i} * 2},\n`, 'struct row { const char *name; int n; int h; };\n\nstatic const struct row ROWS[] = {\n', '};\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, 'int helper(int x, const char *y) { return x; }\n\nvoid run(void) {\n', '}\n'),
    types: () => fill((i) => `struct thing${i} {\n  int name;\n};\n\n`),
  },
  cpp: {
    ext: 'cpp',
    functions: () => fill((i) => `int thing${i}(int name) {\n  return name + ${i};\n}\n\n`),
    methods: () => fill((i) => `  int thing${i}(int name) {\n    return name + ${i};\n  }\n\n`, 'class Big {\npublic:\n', '};\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}");\n`, 'int helper(int x, const char *y) { return x; }\n\nvoid run() {\n', '}\n'),
    classes: () => fill((i) => `class Thing${i} {\npublic:\n  int run() {\n    return ${i};\n  }\n};\n\n`),
  },
  lua: {
    ext: 'lua',
    functions: () => fill((i) => `local function thing${i}(name)\n  return name .. "${i}"\nend\n\n`),
    methods: () => fill((i) => `function Big.thing${i}(name)\n  return name .. "${i}"\nend\n\n`, 'local Big = {}\n\n', 'return Big\n'),
    variables: () => fill((i) => `VALUE_${i} = "${i}" .. "x"\n`),
    data: () => fill((i) => `  {"name${i}", ${i}, helper(${i})},\n`, 'local function helper(x) return x end\n\nROWS = {\n', '}\n'),
    calls: () => fill((i) => `  helper(${i}, "name${i}")\n`, 'local function helper(x, y) return x end\n\nlocal function run()\n', 'end\n'),
  },
  r: {
    ext: 'R',
    functions: () => fill((i) => `thing${i} <- function(name) {\n  paste0(name, "${i}")\n}\n\n`),
    variables: () => fill((i) => `value${i} <- paste0("${i}", "x")\n`),
    calls: () => fill((i) => `  helper(${i}, "name${i}")\n`, 'helper <- function(x, y) x\n\nrun <- function() {\n', '}\n'),
  },
};

for (const [language, shapes] of Object.entries(more(fill, bytes))) Object.assign(LANGUAGES[language], shapes);

if (process.env.BENCH_WRITE) {
  for (const [language, { ext, ...shapes }] of Object.entries(LANGUAGES)) {
    for (const [shape, text] of Object.entries(shapes)) {
      if (onlyShapes && !onlyShapes.split(',').includes(shape)) continue;
      const dir = join(process.env.BENCH_WRITE, language, shape);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `big.${ext}`), text());
    }
  }
  process.exit(0);
}

// A small first run, so the first case timed does not pay for loading the engine.
{
  const dir = mkdtempSync(join(tmpdir(), 'cg-bench-warm-'));
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src', 'warm.ts'), 'export function warm() { return 1; }\n');
  (await CodeGraph.init(dir, { index: true })).close();
  rmSync(dir, { recursive: true, force: true });
}

const languages = onlyLanguages ? onlyLanguages.split(',') : Object.keys(LANGUAGES);
const slow = [];
for (const language of languages) {
  const { ext, ...shapes } = LANGUAGES[language];
  for (const [shape, text] of Object.entries(shapes)) {
    if (onlyShapes && !onlyShapes.split(',').includes(shape)) continue;
    const dir = mkdtempSync(join(tmpdir(), 'cg-bench-big-'));
    mkdirSync(join(dir, 'src'));
    const source = text();
    writeFileSync(join(dir, 'src', `big.${ext}`), source);
    const started = Date.now();
    const cg = await CodeGraph.init(dir, { index: true });
    const seconds = (Date.now() - started) / 1000;
    const symbols = cg.getNodesInFile(`src/big.${ext}`).filter((n) => n.kind !== 'file').length;
    cg.close();
    rmSync(dir, { recursive: true, force: true });
    const perMb = seconds / (source.length / 1024 / 1024);
    // A file over the engine's limit is left out of the index, so its time says nothing.
    const over = Buffer.byteLength(source) > MAX_SOURCE_FILE_SIZE_BYTES;
    const mark = over ? '  <-- NOT MEASURED: over the size limit' : perMb > 2 ? '  <-- slow' : symbols === 0 ? '  (no symbols)' : '';
    if (over || perMb > 2) slow.push(`${language}/${shape}`);
    console.log(`${language.padEnd(11)} ${shape.padEnd(10)} ${seconds.toFixed(1).padStart(6)} s  ${String(symbols).padStart(7)} symbols${mark}`);
  }
}
console.log(slow.length ? `\nslow (over 2 s a megabyte) or not measured: ${slow.join(', ')}` : '\nnothing over 2 s a megabyte');
