// More shapes for kernel-languages.mjs: the ones real large files take (a table of rows, one
// statement that is the whole file, one line that is the whole file, one long string, some
// thousand imports, long runs of comments). `more(fill)` returns, by language, shape -> () => text.
const p = (i) => (i ? i - 1 : 0);

// [unit, head, tail] for a file of functions that each declare a local, call a helper and
// call the function before them.
const MIXED = {
  python: [(i) => `def thing${i}(name):\n    value = helper(name)\n    return thing${p(i)}(value)\n\n`, 'def helper(x):\n    return x\n\n'],
  ruby: [(i) => `def thing${i}(name)\n  value = helper(name)\n  thing${p(i)}(value)\nend\n\n`, 'def helper(x)\n  x\nend\n\n'],
  typescript: [(i) => `export function thing${i}(name: string): string {\n  const value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'function helper(x: string) { return x; }\n\n'],
  javascript: [(i) => `function thing${i}(name) {\n  const value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'function helper(x) { return x; }\n\n'],
  go: [(i) => `func Thing${i}(name string) string {\n\tvalue := helper(name)\n\treturn Thing${p(i)}(value)\n}\n\n`, 'package big\n\nfunc helper(x string) string { return x }\n\n'],
  java: [(i) => `  String thing${i}(String name) {\n    String value = helper(name);\n    return thing${p(i)}(value);\n  }\n\n`, 'public class Big {\n  static String helper(String x) { return x; }\n\n', '}\n'],
  csharp: [(i) => `  string Thing${i}(string name) {\n    var value = Helper(name);\n    return Thing${p(i)}(value);\n  }\n\n`, 'public class Big {\n  static string Helper(string x) { return x; }\n\n', '}\n'],
  php: [(i) => `function thing${i}($name) {\n  $value = helper($name);\n  return thing${p(i)}($value);\n}\n\n`, '<?php\nfunction helper($x) { return $x; }\n\n'],
  kotlin: [(i) => `fun thing${i}(name: String): String {\n    val value = helper(name)\n    return thing${p(i)}(value)\n}\n\n`, 'fun helper(x: String): String { return x }\n\n'],
  swift: [(i) => `func thing${i}(name: String) -> String {\n    let value = helper(name)\n    return thing${p(i)}(name: value)\n}\n\n`, 'func helper(_ x: String) -> String { return x }\n\n'],
  scala: [(i) => `  def thing${i}(name: String): String = {\n    val value = helper(name)\n    thing${p(i)}(value)\n  }\n\n`, 'object Big {\n  def helper(x: String): String = x\n\n', '}\n'],
  dart: [(i) => `String thing${i}(String name) {\n  final value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'String helper(String x) { return x; }\n\n'],
  rust: [(i) => `fn thing${i}(name: &str) -> String {\n    let value = helper(name);\n    thing${p(i)}(&value)\n}\n\n`, 'fn helper(x: &str) -> String { x.to_string() }\n\n'],
  c: [(i) => `int thing${i}(int name) {\n  int value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'int helper(int x) { return x; }\n\n'],
  cpp: [(i) => `int thing${i}(int name) {\n  int value = helper(name);\n  return thing${p(i)}(value);\n}\n\n`, 'int helper(int x) { return x; }\n\n'],
  lua: [(i) => `local function thing${i}(name)\n  local value = helper(name)\n  return thing${p(i)}(value)\nend\n\n`, 'local function helper(x) return x end\n\n'],
  r: [(i) => `thing${i} <- function(name) {\n  value <- helper(name)\n  thing${p(i)}(value)\n}\n\n`, 'helper <- function(x) x\n\n'],
};

// A class whose methods call each other through the object.
const MEMBERS = {
  python: [(i) => `    def thing${i}(self, name):\n        value = self.helper(name)\n        return self.thing${p(i)}(value)\n\n`, 'class Big:\n    def helper(self, x):\n        return x\n\n'],
  ruby: [(i) => `  def thing${i}(name)\n    value = self.helper(name)\n    self.thing${p(i)}(value)\n  end\n\n`, 'class Big\n  def helper(x)\n    x\n  end\n\n', 'end\n'],
  typescript: [(i) => `  thing${i}(name: string): string {\n    const value = this.helper(name);\n    return this.thing${p(i)}(value);\n  }\n\n`, 'export class Big {\n  helper(x: string) { return x; }\n\n', '}\n'],
  javascript: [(i) => `  thing${i}(name) {\n    const value = this.helper(name);\n    return this.thing${p(i)}(value);\n  }\n\n`, 'class Big {\n  helper(x) { return x; }\n\n', '}\n'],
  go: [(i) => `func (b *Big) Thing${i}(name string) string {\n\tvalue := b.helper(name)\n\treturn b.Thing${p(i)}(value)\n}\n\n`, 'package big\n\ntype Big struct{}\n\nfunc (b *Big) helper(x string) string { return x }\n\n'],
  java: [(i) => `  String thing${i}(String name) {\n    String value = this.helper(name);\n    return this.thing${p(i)}(value);\n  }\n\n`, 'public class Big {\n  String helper(String x) { return x; }\n\n', '}\n'],
  csharp: [(i) => `  string Thing${i}(string name) {\n    var value = this.Helper(name);\n    return this.Thing${p(i)}(value);\n  }\n\n`, 'public class Big {\n  string Helper(string x) { return x; }\n\n', '}\n'],
  php: [(i) => `  function thing${i}($name) {\n    $value = $this->helper($name);\n    return $this->thing${p(i)}($value);\n  }\n\n`, '<?php\nclass Big {\n  function helper($x) { return $x; }\n\n', '}\n'],
  kotlin: [(i) => `    fun thing${i}(name: String): String {\n        val value = this.helper(name)\n        return this.thing${p(i)}(value)\n    }\n\n`, 'class Big {\n    fun helper(x: String): String { return x }\n\n', '}\n'],
  swift: [(i) => `    func thing${i}(name: String) -> String {\n        let value = self.helper(name)\n        return self.thing${p(i)}(name: value)\n    }\n\n`, 'class Big {\n    func helper(_ x: String) -> String { return x }\n\n', '}\n'],
  scala: [(i) => `  def thing${i}(name: String): String = {\n    val value = this.helper(name)\n    this.thing${p(i)}(value)\n  }\n\n`, 'class Big {\n  def helper(x: String): String = x\n\n', '}\n'],
  dart: [(i) => `  String thing${i}(String name) {\n    final value = this.helper(name);\n    return this.thing${p(i)}(value);\n  }\n\n`, 'class Big {\n  String helper(String x) { return x; }\n\n', '}\n'],
  rust: [(i) => `    fn thing${i}(&self, name: &str) -> String {\n        let value = self.helper(name);\n        self.thing${p(i)}(&value)\n    }\n\n`, 'struct Big;\n\nimpl Big {\n    fn helper(&self, x: &str) -> String { x.to_string() }\n\n', '}\n'],
  cpp: [(i) => `  int thing${i}(int name) {\n    int value = this->helper(name);\n    return this->thing${p(i)}(value);\n  }\n\n`, 'class Big {\npublic:\n  int helper(int x) { return x; }\n\n', '};\n'],
  lua: [(i) => `function Big:thing${i}(name)\n  local value = self:helper(name)\n  return self:thing${p(i)}(value)\nend\n\n`, 'local Big = {}\n\nfunction Big:helper(x) return x end\n\n', 'return Big\n'],
};

// One large enumeration.
const ENUM = {
  typescript: [(i) => `  Member${i} = ${i},\n`, 'export enum Big {\n', '}\n'],
  java: [(i) => `  MEMBER_${i},\n`, 'public enum Big {\n', '}\n'],
  csharp: [(i) => `  Member${i} = ${i},\n`, 'public enum Big {\n', '}\n'],
  kotlin: [(i) => `    MEMBER_${i},\n`, 'enum class Big {\n', '}\n'],
  swift: [(i) => `    case member${i}\n`, 'enum Big {\n', '}\n'],
  rust: [(i) => `    Member${i},\n`, 'pub enum Big {\n', '}\n'],
  c: [(i) => `  MEMBER_${i} = ${i},\n`, 'enum big {\n', '};\n'],
  cpp: [(i) => `  Member${i} = ${i},\n`, 'enum class Big {\n', '};\n'],
  dart: [(i) => `  member${i},\n`, 'enum Big {\n', '}\n'],
  go: [(i) => `\tMember${i} = ${i}\n`, 'package big\n\nconst (\n', ')\n'],
  php: [(i) => `  case Member${i} = ${i};\n`, '<?php\nenum Big: int {\n', '}\n'],
  python: [(i) => `    MEMBER_${i} = ${i}\n`, 'import enum\n\nclass Big(enum.Enum):\n'],
  scala: [(i) => `  case Member${i}\n`, 'enum Big {\n', '}\n'],
};

// One function that is one large switch.
const SWITCH = {
  typescript: [(i) => `    case ${i}:\n      return helper(${i});\n`, 'function helper(x: number) { return x; }\nexport function run(key: number): number {\n  switch (key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  javascript: [(i) => `    case ${i}:\n      return helper(${i});\n`, 'function helper(x) { return x; }\nfunction run(key) {\n  switch (key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  java: [(i) => `      case ${i}:\n        return helper(${i});\n`, 'public class Big {\n  static int helper(int x) { return x; }\n  int run(int key) {\n    switch (key) {\n', '      default:\n        return 0;\n    }\n  }\n}\n'],
  csharp: [(i) => `      case ${i}:\n        return Helper(${i});\n`, 'public class Big {\n  static int Helper(int x) { return x; }\n  int Run(int key) {\n    switch (key) {\n', '      default:\n        return 0;\n    }\n  }\n}\n'],
  go: [(i) => `\tcase ${i}:\n\t\treturn helper(${i})\n`, 'package big\n\nfunc helper(x int) int { return x }\n\nfunc Run(key int) int {\n\tswitch key {\n', '\t}\n\treturn 0\n}\n'],
  rust: [(i) => `        ${i} => helper(${i}),\n`, 'fn helper(x: i32) -> i32 { x }\n\nfn run(key: i32) -> i32 {\n    match key {\n', '        _ => 0,\n    }\n}\n'],
  c: [(i) => `    case ${i}:\n      return helper(${i});\n`, 'int helper(int x) { return x; }\n\nint run(int key) {\n  switch (key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  cpp: [(i) => `    case ${i}:\n      return helper(${i});\n`, 'int helper(int x) { return x; }\n\nint run(int key) {\n  switch (key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  php: [(i) => `    case ${i}:\n      return helper(${i});\n`, '<?php\nfunction helper($x) { return $x; }\nfunction run($key) {\n  switch ($key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  kotlin: [(i) => `        ${i} -> helper(${i})\n`, 'fun helper(x: Int): Int { return x }\n\nfun run(key: Int): Int {\n    return when (key) {\n', '        else -> 0\n    }\n}\n'],
  swift: [(i) => `    case ${i}:\n        return helper(${i})\n`, 'func helper(_ x: Int) -> Int { return x }\n\nfunc run(key: Int) -> Int {\n    switch key {\n', '    default:\n        return 0\n    }\n}\n'],
  dart: [(i) => `    case ${i}:\n      return helper(${i});\n`, 'int helper(int x) { return x; }\n\nint run(int key) {\n  switch (key) {\n', '    default:\n      return 0;\n  }\n}\n'],
  scala: [(i) => `      case ${i} => helper(${i})\n`, 'object Big {\n  def helper(x: Int): Int = x\n  def run(key: Int): Int = {\n    key match {\n', '      case _ => 0\n    }\n  }\n}\n'],
  python: [(i) => `    elif key == ${i}:\n        return helper(${i})\n`, 'def helper(x):\n    return x\n\ndef run(key):\n    if key == -1:\n        return 0\n'],
  ruby: [(i) => `  when ${i}\n    helper(${i})\n`, 'def helper(x)\n  x\nend\n\ndef run(key)\n  case key\n', '  end\nend\n'],
  lua: [(i) => `  elseif key == ${i} then\n    return helper(${i})\n`, 'local function helper(x) return x end\n\nlocal function run(key)\n  if key == -1 then\n    return 0\n', '  end\nend\n'],
};

// Nothing but imports.
const IMPORTS = {
  python: [(i) => `from pkg.mod${i} import name${i}\n`],
  typescript: [(i) => `import { name${i} } from './mod${i}';\n`],
  javascript: [(i) => `const name${i} = require('./mod${i}');\n`],
  java: [(i) => `import pkg.mod${i}.Name${i};\n`, '', 'public class Big {}\n'],
  go: [(i) => `\tname${i} "example.com/pkg/mod${i}"\n`, 'package big\n\nimport (\n', ')\n'],
  rust: [(i) => `use crate::mod${i}::Name${i};\n`],
  kotlin: [(i) => `import pkg.mod${i}.Name${i}\n`],
  csharp: [(i) => `using Pkg.Mod${i};\n`],
  php: [(i) => `use Pkg\\Mod${i}\\Name${i};\n`, '<?php\n'],
  swift: [(i) => `import Mod${i}\n`],
  dart: [(i) => `import 'mod${i}.dart';\n`],
  scala: [(i) => `import pkg.mod${i}.Name${i}\n`],
  c: [(i) => `#include "mod${i}.h"\n`],
  cpp: [(i) => `#include "mod${i}.h"\n`],
  ruby: [(i) => `require_relative 'mod${i}'\n`],
  lua: [(i) => `local name${i} = require("mod${i}")\n`],
};

// Each function under a comment of several lines.
const COMMENTED = {
  python: [(i) => `def thing${i}(name):\n    """Thing ${i}.\n\n    Takes a name and returns it.\n    """\n    return name\n\n`],
  typescript: [(i) => `/**\n * Thing ${i}.\n *\n * Takes a name and returns it.\n */\nexport function thing${i}(name: string): string {\n  return name;\n}\n\n`],
  javascript: [(i) => `/**\n * Thing ${i}.\n *\n * Takes a name and returns it.\n */\nfunction thing${i}(name) {\n  return name;\n}\n\n`],
  java: [(i) => `  /**\n   * Thing ${i}.\n   *\n   * Takes a name and returns it.\n   */\n  String thing${i}(String name) {\n    return name;\n  }\n\n`, 'public class Big {\n', '}\n'],
  go: [(i) => `// Thing${i} is thing ${i}.\n//\n// It takes a name and returns it.\nfunc Thing${i}(name string) string {\n\treturn name\n}\n\n`, 'package big\n\n'],
  rust: [(i) => `/// Thing ${i}.\n///\n/// Takes a name and returns it.\nfn thing${i}(name: &str) -> &str {\n    name\n}\n\n`],
  c: [(i) => `/*\n * Thing ${i}.\n *\n * Takes a name and returns it.\n */\nint thing${i}(int name) {\n  return name;\n}\n\n`],
  cpp: [(i) => `// Thing ${i}.\n//\n// Takes a name and returns it.\nint thing${i}(int name) {\n  return name;\n}\n\n`],
  ruby: [(i) => `# Thing ${i}.\n#\n# Takes a name and returns it.\ndef thing${i}(name)\n  name\nend\n\n`],
  php: [(i) => `/**\n * Thing ${i}.\n *\n * Takes a name and returns it.\n */\nfunction thing${i}($name) {\n  return $name;\n}\n\n`, '<?php\n'],
  kotlin: [(i) => `/**\n * Thing ${i}.\n *\n * Takes a name and returns it.\n */\nfun thing${i}(name: String): String {\n    return name\n}\n\n`],
  swift: [(i) => `/// Thing ${i}.\n///\n/// Takes a name and returns it.\nfunc thing${i}(name: String) -> String {\n    return name\n}\n\n`],
  csharp: [(i) => `  /// <summary>\n  /// Thing ${i}.\n  /// </summary>\n  string Thing${i}(string name) {\n    return name;\n  }\n\n`, 'public class Big {\n', '}\n'],
  dart: [(i) => `/// Thing ${i}.\n///\n/// Takes a name and returns it.\nString thing${i}(String name) {\n  return name;\n}\n\n`],
  scala: [(i) => `  /** Thing ${i}.\n    *\n    * Takes a name and returns it.\n    */\n  def thing${i}(name: String): String = name\n\n`, 'object Big {\n', '}\n'],
  lua: [(i) => `--- Thing ${i}.\n--\n-- Takes a name and returns it.\nlocal function thing${i}(name)\n  return name\nend\n\n`],
};

// One object or table of named entries, each a small function or a call.
const OBJECT = {
  typescript: [(i) => `  thing${i}(name: string): string {\n    return helper(name);\n  },\n`, 'function helper(x: string) { return x; }\nexport const api = {\n', '};\n'],
  javascript: [(i) => `  thing${i}: function (name) {\n    return helper(name);\n  },\n`, 'function helper(x) { return x; }\nmodule.exports = {\n', '};\n'],
  python: [(i) => `    "thing${i}": lambda name: helper(name),\n`, 'def helper(x):\n    return x\n\nTABLE = {\n', '}\n'],
  ruby: [(i) => `  thing${i}: ->(name) { helper(name) },\n`, 'def helper(x)\n  x\nend\n\nTABLE = {\n', '}\n'],
  lua: [(i) => `  thing${i} = function(name) return helper(name) end,\n`, 'local function helper(x) return x end\n\nlocal TABLE = {\n', '}\n\nreturn TABLE\n'],
  go: [(i) => `\t"thing${i}": func(name string) string { return helper(name) },\n`, 'package big\n\nfunc helper(x string) string { return x }\n\nvar Table = map[string]func(string) string{\n', '}\n'],
  php: [(i) => `  'thing${i}' => fn($name) => helper($name),\n`, '<?php\nfunction helper($x) { return $x; }\n$table = [\n', '];\n'],
  rust: [(i) => `    ("thing${i}", |name| helper(name)),\n`, 'fn helper(x: i32) -> i32 { x }\n\nstatic TABLE: &[(&str, fn(i32) -> i32)] = &[\n', '];\n'],
  kotlin: [(i) => `    "thing${i}" to { name: String -> helper(name) },\n`, 'fun helper(x: String): String { return x }\n\nval table = mapOf(\n', ')\n'],
  swift: [(i) => `    "thing${i}": { name in helper(name) },\n`, 'func helper(_ x: String) -> String { return x }\n\nlet table: [String: (String) -> String] = [\n', ']\n'],
  dart: [(i) => `  'thing${i}': (String name) => helper(name),\n`, 'String helper(String x) { return x; }\n\nfinal table = <String, String Function(String)>{\n', '};\n'],
  scala: [(i) => `    "thing${i}" -> ((name: String) => helper(name)),\n`, 'object Big {\n  def helper(x: String): String = x\n  val table = Map(\n', '  )\n}\n'],
  csharp: [(i) => `    { "thing${i}", name => Helper(name) },\n`, 'using System;\nusing System.Collections.Generic;\npublic class Big {\n  static string Helper(string x) { return x; }\n  static readonly Dictionary<string, Func<string, string>> Table = new() {\n', '  };\n}\n'],
  java: [(i) => `    TABLE.put("thing${i}", name -> helper(name));\n`, 'import java.util.*;\nimport java.util.function.*;\npublic class Big {\n  static String helper(String x) { return x; }\n  static final Map<String, Function<String, String>> TABLE = new HashMap<>();\n  static {\n', '  }\n}\n'],
  cpp: [(i) => `  {"thing${i}", [](int name) { return helper(name); }},\n`, '#include <map>\n#include <string>\n#include <functional>\nint helper(int x) { return x; }\n\nstatic std::map<std::string, std::function<int(int)>> table = {\n', '};\n'],
  c: [(i) => `  {"thing${i}", helper},\n`, 'int helper(int x) { return x; }\n\nstruct entry { const char *name; int (*fn)(int); };\n\nstatic const struct entry table[] = {\n', '};\n'],
};

// A test file: one suite holding many small tests.
const TESTS = {
  typescript: [(i) => `  it('does thing ${i}', () => {\n    const value = helper(${i});\n    expect(value).toBe(${i});\n  });\n\n`, "import { describe, it, expect } from 'vitest';\nfunction helper(x: number) { return x; }\n\ndescribe('big', () => {\n", '});\n'],
  javascript: [(i) => `  it('does thing ${i}', function () {\n    const value = helper(${i});\n    assert.equal(value, ${i});\n  });\n\n`, "const assert = require('assert');\nfunction helper(x) { return x; }\n\ndescribe('big', function () {\n", '});\n'],
  python: [(i) => `    def test_thing_${i}(self):\n        value = helper(${i})\n        self.assertEqual(value, ${i})\n\n`, 'import unittest\n\ndef helper(x):\n    return x\n\nclass BigTest(unittest.TestCase):\n'],
  ruby: [(i) => `  it "does thing ${i}" do\n    value = helper(${i})\n    expect(value).to eq(${i})\n  end\n\n`, "def helper(x)\n  x\nend\n\nRSpec.describe 'big' do\n", 'end\n'],
  go: [(i) => `func TestThing${i}(t *testing.T) {\n\tvalue := helper(${i})\n\tif value != ${i} {\n\t\tt.Fatal(value)\n\t}\n}\n\n`, 'package big\n\nimport "testing"\n\nfunc helper(x int) int { return x }\n\n'],
  rust: [(i) => `    #[test]\n    fn thing_${i}() {\n        let value = helper(${i});\n        assert_eq!(value, ${i});\n    }\n\n`, 'fn helper(x: i32) -> i32 { x }\n\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n', '}\n'],
  java: [(i) => `  @Test\n  void thing${i}() {\n    int value = helper(${i});\n    assertEquals(${i}, value);\n  }\n\n`, 'import org.junit.jupiter.api.Test;\nimport static org.junit.jupiter.api.Assertions.*;\n\nclass BigTest {\n  static int helper(int x) { return x; }\n\n', '}\n'],
  kotlin: [(i) => `    @Test\n    fun thing${i}() {\n        val value = helper(${i})\n        assertEquals(${i}, value)\n    }\n\n`, 'import kotlin.test.Test\nimport kotlin.test.assertEquals\n\nfun helper(x: Int): Int { return x }\n\nclass BigTest {\n', '}\n'],
  scala: [(i) => `  test("thing ${i}") {\n    val value = helper(${i})\n    assert(value == ${i})\n  }\n\n`, 'class BigSuite extends munit.FunSuite {\n  def helper(x: Int): Int = x\n\n', '}\n'],
  swift: [(i) => `    func testThing${i}() {\n        let value = helper(${i})\n        XCTAssertEqual(value, ${i})\n    }\n\n`, 'import XCTest\n\nfunc helper(_ x: Int) -> Int { return x }\n\nfinal class BigTests: XCTestCase {\n', '}\n'],
  dart: [(i) => `  test('thing ${i}', () {\n    final value = helper(${i});\n    expect(value, ${i});\n  });\n\n`, "import 'package:test/test.dart';\n\nint helper(int x) { return x; }\n\nvoid main() {\n", '}\n'],
  csharp: [(i) => `  [Fact]\n  public void Thing${i}() {\n    var value = Helper(${i});\n    Assert.Equal(${i}, value);\n  }\n\n`, 'using Xunit;\n\npublic class BigTests {\n  static int Helper(int x) { return x; }\n\n', '}\n'],
  php: [(i) => `  public function testThing${i}() {\n    $value = helper(${i});\n    $this->assertSame(${i}, $value);\n  }\n\n`, '<?php\nfunction helper($x) { return $x; }\n\nclass BigTest extends TestCase {\n', '}\n'],
  cpp: [(i) => `TEST(Big, Thing${i}) {\n  int value = helper(${i});\n  EXPECT_EQ(value, ${i});\n}\n\n`, '#include <gtest/gtest.h>\n\nint helper(int x) { return x; }\n\n'],
  lua: [(i) => `  it("does thing ${i}", function()\n    local value = helper(${i})\n    assert.equal(value, ${i})\n  end)\n\n`, 'local function helper(x) return x end\n\ndescribe("big", function()\n', 'end)\n'],
};

export function more(fill, bytes) {
  const out = {};
  const add = (shape, table) => {
    for (const [language, [unit, head = '', tail = '']] of Object.entries(table)) {
      (out[language] ??= {})[shape] = () => fill(unit, head, tail);
    }
  };
  add('mixed', MIXED);
  add('members', MEMBERS);
  add('enum', ENUM);
  add('switch', SWITCH);
  add('imports', IMPORTS);
  add('commented', COMMENTED);
  add('object', OBJECT);
  add('tests', TESTS);
  // A script on one line, as a bundler leaves it.
  out.javascript.minified = () => fill((i) => `function t${i}(n){var v=h(n);return t${p(i)}(v)}`, 'function h(x){return x}', '\n');
  // One long string, as an embedded asset is.
  const blob = () => 'QUJD'.repeat(Math.floor(bytes / 4));
  out.javascript.blob = () => `const BLOB = "${blob()}";\nfunction use() { return BLOB.length; }\n`;
  out.typescript.blob = () => `export const BLOB = "${blob()}";\nexport function use() { return BLOB.length; }\n`;
  out.python.blob = () => `BLOB = "${blob()}"\n\ndef use():\n    return len(BLOB)\n`;
  out.go.blob = () => `package big\n\nconst Blob = "${blob()}"\n\nfunc Use() int { return len(Blob) }\n`;
  out.c.blob = () => `static const char BLOB[] = "${blob()}";\n\nint use(void) { return sizeof BLOB; }\n`;
  // The same with other long runs: hex digits, blanks, and one line of numbers.
  const wrap = {
    javascript: (v) => `const BLOB = ${v};\nfunction use() { return BLOB.length; }\n`,
    typescript: (v) => `export const BLOB = ${v};\nexport function use() { return BLOB.length; }\n`,
    python: (v) => `BLOB = ${v}\n\ndef use():\n    return len(BLOB)\n`,
    go: (v) => `package big\n\nvar Blob = ${v}\n\nfunc Use() int { return len(Blob) }\n`,
    c: (v) => `static const char BLOB[] = ${v};\n\nint use(void) { return sizeof BLOB; }\n`,
    ruby: (v) => `BLOB = ${v}\n\ndef use\n  BLOB.length\nend\n`,
    java: (v) => `public class Big {\n  static final Object BLOB = ${v};\n  static int use() { return 1; }\n}\n`,
    csharp: (v) => `public class Big {\n  static readonly object Blob = ${v};\n  static int Use() { return 1; }\n}\n`,
    php: (v) => `<?php\n$blob = ${v};\nfunction useIt() { return 1; }\n`,
    rust: (v) => `static BLOB: &str = ${v};\n\nfn use_it() -> usize { BLOB.len() }\n`,
    kotlin: (v) => `val BLOB = ${v}\n\nfun use(): Int { return 1 }\n`,
    swift: (v) => `let blob = ${v}\n\nfunc use() -> Int { return 1 }\n`,
    scala: (v) => `object Big {\n  val blob = ${v}\n  def use(): Int = 1\n}\n`,
    dart: (v) => `const blob = ${v};\n\nint use() { return 1; }\n`,
    cpp: (v) => `static const char BLOB[] = ${v};\n\nint use() { return sizeof BLOB; }\n`,
    lua: (v) => `local BLOB = ${v}\n\nlocal function use() return #BLOB end\n`,
  };
  for (const [language, around] of Object.entries(wrap)) {
    out[language].blob = () => around('"' + blob() + '"');
    out[language].hex = () => around('"' + '0f3a'.repeat(Math.floor(bytes / 4)) + '"');
    out[language].blanks = () => around('"' + ' '.repeat(bytes) + '"');
    out[language].dots = () => around('"' + 'a.b.'.repeat(Math.floor(bytes / 4)) + '"');
    out[language].words = () => around('"' + 'lorem ipsum dolor sit amet, '.repeat(Math.floor(bytes / 28)) + '"');
  }
  // One function, then nothing but comment lines: a long run of them is a flat list of siblings.
  const mark = { python: '#', ruby: '#', r: '#', lua: '--' };
  for (const [language, around] of Object.entries(wrap)) {
    const comment = mark[language] ?? '//';
    out[language].commentrun = () => around('"x"') + fill((i) => `${comment} a line of commentary, number ${i}\n`);
  }
  return out;
}
