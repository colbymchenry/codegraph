/**
 * PHP method names ignore case, as its function and class names do: a call
 * spelled `PriceConverter::CalcBasePrice(1)` or `$c->GetRate()` runs
 * `calcBasePrice()` / `getRate()` (#3297). The method lookups compared names
 * exactly, so every call written in another case linked nothing and its caller
 * was missing from `callers` and impact. A spelling that matches exactly still
 * wins over another case.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  // The issue's repro.
  'lib.php': `<?php
class PriceConverter
{
    public static function calcBasePrice($amount)
    {
        return $amount * 2;
    }

    public function getRate()
    {
        return 1;
    }

    public function viaThis()
    {
        return $this->GETRATE() + self::CALCBASEPRICE(1) + static::calcbaseprice(2);
    }
}

class ChildConverter extends PriceConverter
{
}
`,
  'case.php': `<?php
require_once 'lib.php';

function exact_case()
{
    $c = new PriceConverter();
    return $c->getRate() + PriceConverter::calcBasePrice(1);
}

function static_other_case()
{
    return PriceConverter::CalcBasePrice(1);
}

function instance_other_case()
{
    $c = new PriceConverter();
    return $c->GetRate();
}

function class_other_case()
{
    return priceconverter::calcBasePrice(1);
}

function inherited_other_case()
{
    $c = new ChildConverter();
    return $c->GetRATE() + ChildConverter::CalcBasePrice(3);
}
`,
  // Two classes in one file, one method spelled differently in each.
  'pair.php': `<?php
class Lower { public function run() { return 1; } }
class Upper { public function RUN() { return 2; } }
function pair() { $l = new Lower(); $u = new Upper(); return $l->RUN() + $u->run(); }
`,
  // A class reached through a use import and through its fully qualified name.
  'src/Money/Conv.php': `<?php
namespace App\\Money;

class Conv
{
    public static function toCents($amount) { return $amount * 100; }
}
`,
  'src/Shop/Cart.php': `<?php
namespace App\\Shop;

use App\\Money\\Conv;

class Cart
{
    public function imported() { return Conv::TOCENTS(1); }
    public function qualified() { return \\App\\Money\\Conv::ToCents(2); }
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-method-case-'));
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

/** The qualified names of what `calls` edges from `caller` reach. */
function callees(caller: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.qualified_name = ?`).all(caller).map((r) => r.q).sort();
}

describe('PHP method names are matched without regard to case (#3297)', () => {
  it("the issue's repro: all four functions call the methods", () => {
    expect(callees('exact_case')).toEqual(['PriceConverter::calcBasePrice', 'PriceConverter::getRate']);
    expect(callees('static_other_case')).toEqual(['PriceConverter::calcBasePrice']);
    expect(callees('instance_other_case')).toEqual(['PriceConverter::getRate']);
    expect(callees('class_other_case')).toEqual(['PriceConverter::calcBasePrice']);
  });

  it('an inherited method, and $this, self and static, in another case', () => {
    expect(callees('inherited_other_case')).toEqual(['PriceConverter::calcBasePrice', 'PriceConverter::getRate']);
    expect(callees('PriceConverter::viaThis')).toEqual(['PriceConverter::calcBasePrice', 'PriceConverter::calcBasePrice', 'PriceConverter::getRate']);
    expect(callees('pair')).toEqual(['Lower::run', 'Upper::RUN']);
  });

  it('a static call through a use import or a fully qualified class name, in another case', () => {
    expect(callees('App\\Shop::Cart::imported')).toEqual(['App\\Money::Conv::toCents']);
    expect(callees('App\\Shop::Cart::qualified')).toEqual(['App\\Money::Conv::toCents']);
  });
});
