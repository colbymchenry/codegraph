/**
 * PHP method names are case-insensitive (#3297): a call that spells the
 * method differently from its declaration still resolves, for both static
 * (`PriceConverter::CalcBasePrice`) and instance (`$c->GetRate()`) calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-method-case-'));
  fs.writeFileSync(path.join(root, 'lib.php'), `<?php
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
}
`);
  fs.writeFileSync(path.join(root, 'case.php'), `<?php
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
`);
  cg = await CodeGraph.init(root, { silent: true });
  await cg.indexAll();
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function nodeByQualifiedName(qualifiedName: string) {
  const node = cg.searchNodes(qualifiedName.split('::').pop()!)
    .map((result) => result.node)
    .find((n) => n.qualifiedName === qualifiedName);
  expect(node, qualifiedName).toBeDefined();
  return node!;
}

function functionNode(name: string) {
  const node = cg.searchNodes(name)
    .map((result) => result.node)
    .find((n) => n.kind === 'function' && n.name === name);
  expect(node, name).toBeDefined();
  return node!;
}

function callerIds(qualifiedName: string): string[] {
  return cg.getCallers(nodeByQualifiedName(qualifiedName).id).map(({ node }) => node.id);
}

describe('PHP method case-insensitivity (#3297)', () => {
  it('lists all three callers of calcBasePrice', () => {
    const callers = callerIds('PriceConverter::calcBasePrice');
    expect(callers).toContain(functionNode('exact_case').id);
    expect(callers).toContain(functionNode('static_other_case').id);
    expect(callers).toContain(functionNode('class_other_case').id);
  });

  it('lists both functions as callers of getRate', () => {
    const callers = callerIds('PriceConverter::getRate');
    expect(callers).toContain(functionNode('exact_case').id);
    expect(callers).toContain(functionNode('instance_other_case').id);
  });
});
