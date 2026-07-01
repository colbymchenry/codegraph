/**
 * TS/JS `this.<field>.method()` resolution via the field's declared type.
 *
 * A method call on an injected/declared field, like `this.userService.findAll()`,
 * used to degrade to the bare name `findAll`, which (a) misbound to a
 * same-named method on an unrelated class when several existed, and (b) left
 * the real target with zero callers. The receiver `this.<field>` is now
 * re-encoded as `<field>.method` and resolved on the field's declared type,
 * recovered from the constructor parameter property or a class-body field.
 *
 * This is the static-analysis case that dominates NestJS (controllers calling
 * injected services, services calling injected repositories) and any typed TS
 * OOP code. resolveMethodOnType validates the method exists on the inferred
 * type, so the typed path only ever REPLACES a wrong/ambiguous bare-name
 * binding with the correct one. It never forces an unvalidated edge.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

let tmpDir: string;
let cg: CodeGraph;

/** `Class::method` qualified names every `calls` edge out of the method `fromQn` points at. */
const callTargetsFrom = (fromQn: string): string[] => {
  const from = cg.getNodesByName(fromQn.split('::').pop()!).find((n) => n.qualifiedName === fromQn);
  if (!from) return [];
  return cg
    .getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)?.qualifiedName)
    .filter((qn): qn is string => Boolean(qn));
};

const callerCount = (methodQn: string): number => {
  const node = cg
    .getNodesByName(methodQn.split('::').pop()!)
    .find((n) => n.qualifiedName === methodQn);
  if (!node) return -1;
  return cg.getIncomingEdges(node.id).filter((e) => e.kind === 'calls').length;
};

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tsdi-'));
  const mk = (rel: string, content: string): void => {
    const p = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  };

  // Two services share findAll() and create(); the bare name alone can't tell
  // them apart. wipe() exists only on ProductService.
  mk(
    'src/user.service.ts',
    ['export class UserService {', '  findAll() { return ["u"]; }', '  create() { return "u"; }', '}'].join('\n')
  );
  mk(
    'src/product.service.ts',
    [
      'export class ProductService {',
      '  findAll() { return ["p"]; }',
      '  create() { return "p"; }',
      '  wipe() { return "gone"; }',
      '}',
    ].join('\n')
  );
  // Constructor parameter property injection (the NestJS norm).
  mk(
    'src/user.controller.ts',
    [
      "import { UserService } from './user.service';",
      'export class UserController {',
      '  constructor(private readonly userService: UserService) {}',
      '  list() { return this.userService.findAll(); }',
      '  add() { return this.userService.create(); }',
      '}',
    ].join('\n')
  );
  // Class-body field injection with an explicit type annotation.
  mk(
    'src/product.controller.ts',
    [
      "import { ProductService } from './product.service';",
      'export class ProductController {',
      '  private readonly productService: ProductService;',
      '  constructor(productService: ProductService) { this.productService = productService; }',
      '  list() { return this.productService.findAll(); }',
      '  purge() { return this.productService.wipe(); }',
      '}',
    ].join('\n')
  );

  cg = CodeGraph.initSync(tmpDir);
  await cg.indexAll();
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('TS this.<field>.method() resolves on the field type', () => {
  it('constructor-injected service: shared method names bind to the injected type', () => {
    expect(callTargetsFrom('UserController::list')).toContain('UserService::findAll');
    expect(callTargetsFrom('UserController::add')).toContain('UserService::create');
    // The wrong-class bindings the bare-name path produced are gone.
    expect(callTargetsFrom('UserController::list')).not.toContain('ProductService::findAll');
    expect(callTargetsFrom('UserController::add')).not.toContain('ProductService::create');
  });

  it('class-body typed field is resolved the same way', () => {
    expect(callTargetsFrom('ProductController::list')).toContain('ProductService::findAll');
    expect(callTargetsFrom('ProductController::list')).not.toContain('UserService::findAll');
  });

  it('the real targets gain their caller (no more zero-caller false positive)', () => {
    expect(callerCount('UserService::findAll')).toBe(1);
    expect(callerCount('UserService::create')).toBe(1);
    expect(callerCount('ProductService::findAll')).toBe(1);
  });

  it('a method unique to the injected type still resolves', () => {
    expect(callTargetsFrom('ProductController::purge')).toContain('ProductService::wipe');
    expect(callerCount('ProductService::wipe')).toBe(1);
  });
});
