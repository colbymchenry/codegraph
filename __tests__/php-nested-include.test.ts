/**
 * A PHP `require`/`include` with a static path inside a function or method
 * body includes its file there, so the function depends on it, the way a call
 * from the function is the function's (#3296). Only top-level includes were
 * extracted, so a pipeline step a function runs by requiring a file left no
 * edge, and impact from the step's code stopped at the included file. Both
 * engines, the wasm extractor and the native kernel, emit it.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'lib.php': `<?php
class PriceConverter
{
    public static function calcBasePrice($amount)
    {
        return $amount * 2;
    }
}
`,
  'steps/create.php': `<?php
$total = PriceConverter::calcBasePrice($amount);
`,
  'steps/finish.php': `<?php
$done = true;
`,
  'book.php': `<?php
require_once 'lib.php';

function book_order($amount)
{
    require 'steps/create.php';
    return $total;
}

function entry_point()
{
    return book_order(10);
}

class Pipeline
{
    public function finish($path)
    {
        include_once('steps/finish.php');
        require $path;
        return true;
    }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-nested-include-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function imports(): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ s: string; t: string; l: number }> } } } }).db;
  return db.getDb().prepare(`
    SELECT s.kind || ' ' || s.qualified_name s, t.file_path t, e.line l FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'imports' AND t.kind = 'file'`).all().map((r) => `${r.s} -> ${r.t} @${r.l}`).sort();
}

describe('a PHP include inside a function body (#3296)', () => {
  it('links the function, or the method, to the file it includes; a top-level include stays the file\'s', () => {
    expect(imports()).toEqual([
      'file book.php -> lib.php @2',
      'function book_order -> steps/create.php @6',
      'method Pipeline::finish -> steps/finish.php @19',
    ]);
  });

  it("lets impact climb from the included file's code to the function and its callers (the issue's repro)", () => {
    const method = cg.getNodesByKind('method').find((n) => n.name === 'calcBasePrice')!;
    expect(method).toBeDefined();
    const reached = [...cg.getImpactRadius(method.id, 4).nodes.values()].map((n) => n.name).sort();
    expect(reached).toEqual(expect.arrayContaining(['book_order', 'entry_point']));
  });
});
