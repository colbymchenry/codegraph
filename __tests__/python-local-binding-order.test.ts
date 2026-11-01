/**
 * Whether a Python name is a local where a reference stands depends on where
 * the reference stands: above `view = wrap(view)` it's the function, below it
 * the local. The answer was remembered per function and name, so it was the
 * answer of whichever reference asked first, and with a pool that depends on
 * which worker gets which chunk: django's graph differed between runs of one
 * build. These ask in both orders.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ReferenceResolver } from '../src/resolution';
import { matchFunctionRef } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

type Queries = ConstructorParameters<typeof ReferenceResolver>[1];

const SOURCE = [
  'def wrap(fn):',
  '    return fn',
  '',
  'def outer(flag):',
  '    def view():',
  '        return 1',
  '    before = wrap(view)',
  '    view = wrap(view)',
  '    after = wrap(view)',
  '    return before, after',
  '',
  'def related():',
  '    def Fan():',
  '        return 1',
  '    first = wrap(',
  '        Fan, through="Invitation"',
  '    )',
  '    second = wrap(Fan)',
  '    return first, second',
  '',
].join('\n');

describe('a Python name bound partway through a function', () => {
  let root: string;
  let cg: CodeGraph;
  let context: () => ResolutionContext;
  let outerId: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-py-binding-'));
    fs.writeFileSync(path.join(root, 'views.py'), SOURCE);
    cg = await CodeGraph.init(root, { index: true });
    const queries = (cg as unknown as { queries: Queries }).queries;
    context = () => {
      const resolver = new ReferenceResolver(root, queries);
      resolver.initialize([]);
      return resolver.getResolutionContext();
    };
    outerId = cg.getNodesByKind('function').find((n) => n.name === 'outer')!.id;
  });

  afterEach(() => {
    cg.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const refAt = (line: number): UnresolvedRef => ({
    fromNodeId: outerId, referenceName: 'view', referenceKind: 'function_ref',
    line, column: 13, filePath: 'views.py', language: 'python',
  });
  const target = (line: number, ctx: ResolutionContext): string | undefined => matchFunctionRef(refAt(line), ctx)?.targetNodeId;

  it('is the function above the binding and the local below it, whichever reference asks first', () => {
    const view = cg.getNodesByKind('function').find((n) => n.name === 'view')!.id;

    const ascending = context();
    expect(target(7, ascending)).toBe(view);
    expect(target(9, ascending)).toBeUndefined();

    const descending = context();
    expect(target(9, descending)).toBeUndefined();
    expect(target(7, descending)).toBe(view);
  });

  it('takes no line inside a call for an assignment', () => {
    const fan = cg.getNodesByKind('function').find((n) => n.name === 'Fan')!.id;
    const relatedId = cg.getNodesByKind('function').find((n) => n.name === 'related')!.id;
    const second: UnresolvedRef = {
      fromNodeId: relatedId, referenceName: 'Fan', referenceKind: 'function_ref',
      line: 18, column: 18, filePath: 'views.py', language: 'python',
    };
    expect(matchFunctionRef(second, context())?.targetNodeId).toBe(fan);
  });

  it('counts the line of the binding as above it: `view = wrap(view)` hands on the function', () => {
    const view = cg.getNodesByKind('function').find((n) => n.name === 'view')!.id;
    const ctx = context();
    expect(target(9, ctx)).toBeUndefined();
    expect(target(8, ctx)).toBe(view);
  });
});
