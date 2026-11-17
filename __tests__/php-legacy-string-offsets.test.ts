/**
 * PHP before 8.0 also wrote a string offset with braces, `$code{0}`. The
 * grammar knows only `$code[0]`, and its error recovery could drop the whole
 * enclosing function: `first_two` below had no node, and its call to `helper`
 * was counted as the file's (#3299). The braces of such an offset now read as
 * brackets before parsing, offsets kept, so the function survives with its
 * calls. Braces inside strings, comments and heredocs, `{$x}` interpolation,
 * `${x}` and `$obj->{$name}` are left alone.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { phpExtractor } from '../src/extraction/languages/php';

let root = '';
let cg: CodeGraph;

const CURLY = `<?php
function helper($v)
{
    return $v;
}

function first_two($code)
{
    $a = $code{0} . $code{1};
    return helper($a);
}

function after()
{
    return helper(2);
}
`;

const SHAPES = `<?php
class Name
{
    private $name = 'x';

    public function initial()
    {
        return strtoupper($this->name{0}) . $this->tail();
    }

    public function tail()
    {
        $s = $this->name;
        return $s{strlen($s) - 1} . $s{$s{0}};
    }
}
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-curly-offsets-'));
  fs.writeFileSync(path.join(root, 'curly.php'), CURLY);
  fs.writeFileSync(path.join(root, 'shapes.php'), SHAPES);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function query<T>(sql: string, ...args: unknown[]): T[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): T[] } } } }).db;
  return db.getDb().prepare(sql).all(...args);
}

describe('PHP legacy brace string offsets (#3299)', () => {
  it("keeps the function around `$code{0}` and gives it its own calls (the issue's repro)", () => {
    const fns = query<{ n: string; s: number; e: number }>(
      "SELECT name n, start_line s, end_line e FROM nodes WHERE kind = 'function' AND file_path = 'curly.php' ORDER BY s");
    expect(fns).toEqual([{ n: 'helper', s: 2, e: 5 }, { n: 'first_two', s: 7, e: 11 }, { n: 'after', s: 13, e: 16 }]);
    const callers = query<{ k: string; n: string }>(`
      SELECT s.kind k, s.name n FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' AND t.name = 'helper' ORDER BY s.name`);
    expect(callers).toEqual([{ k: 'function', n: 'after' }, { k: 'function', n: 'first_two' }]);
  });

  it('reads a property, an expression and a nested offset too', () => {
    const calls = query<{ s: string; t: string }>(`
      SELECT s.qualified_name s, t.qualified_name t FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' AND s.file_path = 'shapes.php'`);
    expect(calls).toContainEqual({ s: 'Name::initial', t: 'Name::tail' });
    expect(query<{ n: string }>("SELECT name n FROM nodes WHERE kind = 'method' AND file_path = 'shapes.php' ORDER BY n").map((r) => r.n))
      .toEqual(['initial', 'tail']);
  });

  it('rewrites only offset braces, at the same offsets', () => {
    const pre = phpExtractor.preParse!;
    const source = `<?php
$a = $s{0} . $t->p{1} . $u{$i + 1};
$b = "{$s} \${s} $s{0}" . '$s{0}';
$c = $obj->{$name} . \${'v'};
// $s{0} in a comment
$d = <<<EOT
$s{0} {$s}
EOT;
?>
<p>$html{0}</p>
`;
    const out = pre(source);
    expect(out.length).toBe(source.length);
    expect(out).toBe(source
      .replace('$s{0} . $t->p{1} . $u{$i + 1}', '$s[0] . $t->p[1] . $u[$i + 1]'));
    // A file without the legacy syntax is returned as it is.
    expect(pre(CURLY.replace(/\{(\d)\}/g, '[$1]'))).toBe(CURLY.replace(/\{(\d)\}/g, '[$1]'));
  });
});
