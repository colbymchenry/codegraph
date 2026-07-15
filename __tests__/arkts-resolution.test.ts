/**
 * ArkTS end-to-end resolution tests.
 *
 * Pins the precision contract for build()-DSL attribute chains: a chained
 * `.attr(...)` resolves ONLY to a decorator-marked attribute helper
 * (`@Extend`/`@Styles`/…) — a framework attribute like `.width(...)` must
 * NEVER link to an arbitrary same-named symbol elsewhere in the project
 * (measured on the OpenHarmony samples monorepo, that fallthrough produced
 * 36k wrong edges — single properties with thousands of false callers).
 *
 * Also pins the ohpm workspace bridge: a bare `import { X } from "data"`
 * follows the oh-package.json5 `file:` dependency to the member module.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('ArkTS attribute-chain resolution precision', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links .titleStyle() to the @Extend helper but never .width() to a decoy symbol', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkts-'));
    fs.mkdirSync(path.join(tmpDir, 'pages'));
    fs.mkdirSync(path.join(tmpDir, 'decoy'));

    // A decoy: symbols named after framework attributes, in another file.
    fs.writeFileSync(
      path.join(tmpDir, 'decoy/Decoy.ets'),
      'export class Decoy {\n' +
        '  width: number = 0;\n' +
        '}\n' +
        'export function height(v: number): number {\n' +
        '  return v * 2;\n' +
        '}\n'
    );

    fs.writeFileSync(
      path.join(tmpDir, 'pages/Home.ets'),
      '@Extend(Text) function titleStyle(size: number) {\n' +
        '  .fontSize(size)\n' +
        '}\n' +
        '\n' +
        '@Component\n' +
        'struct Home {\n' +
        '  build() {\n' +
        '    Column() {\n' +
        '      Text("hello")\n' +
        '        .titleStyle(24)\n' +
        '        .width(100)\n' +
        '    }\n' +
        '    .height(50)\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const titleStyle = fns.find((n) => n.name === 'titleStyle');
    expect(titleStyle).toBeDefined();
    expect(titleStyle?.decorators).toContain('Extend');

    const structs = cg.getNodesByKind('struct');
    const home = structs.find((n) => n.name === 'Home');
    expect(home).toBeDefined();

    // build -> titleStyle via the decorator-gated attribute strategy.
    const methods = cg.getNodesByKind('method');
    const build = methods.find((n) => n.qualifiedName === 'Home::build');
    expect(build).toBeDefined();
    const buildCallees = cg.getOutgoingEdges(build!.id).map((e) => e.target);
    expect(buildCallees).toContain(titleStyle!.id);

    // The decoys named after framework attributes must have NO callers.
    const decoyWidth = cg
      .getNodesByKind('property')
      .find((n) => n.name === 'width' && n.filePath.includes('Decoy'));
    expect(decoyWidth).toBeDefined();
    expect(cg.getIncomingEdges(decoyWidth!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);

    const decoyHeight = fns.find((n) => n.name === 'height' && n.filePath.includes('Decoy'));
    expect(decoyHeight).toBeDefined();
    expect(cg.getIncomingEdges(decoyHeight!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
  });
});

describe('ArkTS ohpm workspace import resolution', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves a bare workspace import through oh-package.json5 file: deps', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohpm-'));
    fs.mkdirSync(path.join(tmpDir, 'core/data/src/main/ets'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'feature/goods/src/main/ets'), { recursive: true });

    // Member module "data" with an Index.ets barrel (ohpm entry convention).
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/oh-package.json5'),
      '{\n  // ohpm module manifest\n  "name": "data",\n  "main": "Index.ets",\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/Index.ets'),
      "export { CartRepository } from './src/main/ets/CartRepository';\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/src/main/ets/CartRepository.ets'),
      'export class CartRepository {\n' +
        '  addToCart(id: string): void {\n' +
        '    console.log(id);\n' +
        '  }\n' +
        '}\n'
    );

    // Consumer module declares the sibling via a file: dependency and imports
    // it by bare name.
    fs.writeFileSync(
      path.join(tmpDir, 'feature/goods/oh-package.json5'),
      '{\n  "name": "goods",\n  "dependencies": {\n    "data": "file:../../core/data", // local module\n  },\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'feature/goods/src/main/ets/GoodsViewModel.ets'),
      'import { CartRepository } from "data";\n' +
        '\n' +
        'export class GoodsViewModel {\n' +
        '  private cart: CartRepository = new CartRepository();\n' +
        '\n' +
        '  add(id: string): void {\n' +
        '    this.cart.addToCart(id);\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const classes = cg.getNodesByKind('class');
    const repo = classes.find((n) => n.name === 'CartRepository');
    const vm = classes.find((n) => n.name === 'GoodsViewModel');
    expect(repo).toBeDefined();
    expect(vm).toBeDefined();

    // add() -> addToCart() across the module boundary.
    const methods = cg.getNodesByKind('method');
    const add = methods.find((n) => n.qualifiedName === 'GoodsViewModel::add');
    const addToCart = methods.find((n) => n.qualifiedName === 'CartRepository::addToCart');
    expect(add).toBeDefined();
    expect(addToCart).toBeDefined();
    const targets = cg.getOutgoingEdges(add!.id).map((e) => e.target);
    expect(targets).toContain(addToCart!.id);
  });
});

describe('ArkUI state → build() re-render bridge (assignment-gated)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links assigning methods to build(), but not read-only methods', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-state-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Page.ets'),
      '@Entry\n@Component\nstruct Page {\n' +
        '  @State todos: string[] = [];\n' +
        '  @State count: number = 0;\n' +
        '\n' +
        '  addTodo(t: string): void {\n' +
        '    this.todos.push(t);\n' +
        '  }\n' +
        '\n' +
        '  reset(): void {\n' +
        '    this.count = 0;\n' +
        '  }\n' +
        '\n' +
        '  describeCount(): string {\n' +
        '    return `count is ${this.count}`;\n' +
        '  }\n' +
        '\n' +
        '  build() {\n' +
        '    Column() {\n' +
        '      Text(this.describeCount())\n' +
        '    }\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const build = methods.find((n) => n.qualifiedName === 'Page::build')!;
    const addTodo = methods.find((n) => n.qualifiedName === 'Page::addTodo')!;
    const reset = methods.find((n) => n.qualifiedName === 'Page::reset')!;
    const describeCount = methods.find((n) => n.qualifiedName === 'Page::describeCount')!;

    const synthEdgesTo = (from: string) =>
      cg
        .getOutgoingEdges(from)
        .filter(
          (e) =>
            e.target === build.id &&
            (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'arkui-state'
        );

    // Array mutator and plain assignment both count as state writes.
    expect(synthEdgesTo(addTodo.id)).toHaveLength(1);
    expect(synthEdgesTo(reset.id)).toHaveLength(1);
    // A read-only method gets NO re-render edge — the precision line.
    expect(synthEdgesTo(describeCount.id)).toHaveLength(0);
  });
});

describe('ArkUI @ohos.events.emitter bridge', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links emit → on through a shared named constant, chased through a local EventsId', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-emitter-'));
    fs.writeFileSync(
      path.join(tmpDir, 'Bus.ets'),
      "import emitter from '@ohos.events.emitter';\n" +
        '\n' +
        'export class EmitterConst {\n' +
        '  static readonly ADD_EVENT_ID: number = 2;\n' +
        '}\n' +
        '\n' +
        'class EventsId {\n' +
        '  eventId: number;\n' +
        '  constructor(eventId: number) {\n' +
        '    this.eventId = eventId;\n' +
        '  }\n' +
        '}\n' +
        '\n' +
        'export class Bus {\n' +
        '  subscribeCart(callback: Function): void {\n' +
        '    let addGoodDataId: EventsId = new EventsId(EmitterConst.ADD_EVENT_ID);\n' +
        '    emitter.on(addGoodDataId, (eventData) => {\n' +
        '      callback(eventData);\n' +
        '    });\n' +
        '  }\n' +
        '\n' +
        '  publishAdd(goodId: number): void {\n' +
        '    let addToCartId: EventsId = new EventsId(EmitterConst.ADD_EVENT_ID);\n' +
        '    emitter.emit(addToCartId);\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const publishAdd = methods.find((n) => n.qualifiedName === 'Bus::publishAdd')!;
    const subscribeCart = methods.find((n) => n.qualifiedName === 'Bus::subscribeCart')!;
    const bridged = cg
      .getOutgoingEdges(publishAdd.id)
      .filter(
        (e) =>
          e.target === subscribeCart.id &&
          (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'arkui-emitter'
      );
    expect(bridged).toHaveLength(1);
  });

  it('numeric-literal event ids never pair across files', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-emitter2-'));
    fs.writeFileSync(
      path.join(tmpDir, 'A.ets'),
      "import emitter from '@ohos.events.emitter';\n" +
        'export function fireA(): void {\n' +
        '  emitter.emit({ eventId: 1 });\n' +
        '}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'B.ets'),
      "import emitter from '@ohos.events.emitter';\n" +
        'export function listenB(): void {\n' +
        '  emitter.on({ eventId: 1 }, () => {});\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const fireA = fns.find((n) => n.name === 'fireA')!;
    const listenB = fns.find((n) => n.name === 'listenB')!;
    const bridged = cg
      .getOutgoingEdges(fireA.id)
      .filter((e) => e.target === listenB.id);
    expect(bridged).toHaveLength(0);
  });
});

describe('ArkUI router bridge (pushUrl literal → @Entry struct)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('links the navigating method to the target page struct, standard layout only', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-arkui-router-'));
    fs.mkdirSync(path.join(tmpDir, 'entry/src/main/ets/pages'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'entry/src/main/ets/pages/Detail.ets'),
      '@Entry\n@Component\nstruct Detail {\n  build() {\n    Column() {\n      Text("detail")\n    }\n  }\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'entry/src/main/ets/pages/Home.ets'),
      "import router from '@ohos.router';\n" +
        '\n' +
        '@Entry\n@Component\nstruct Home {\n' +
        '  openDetail(id: string): void {\n' +
        "    router.pushUrl({ url: 'pages/Detail', params: { id: id } });\n" +
        '  }\n' +
        '\n' +
        '  build() {\n' +
        '    Column() {\n' +
        "      Button('go').onClick(this.openDetail)\n" +
        '    }\n' +
        '  }\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const openDetail = methods.find((n) => n.qualifiedName === 'Home::openDetail')!;
    const detail = cg.getNodesByKind('struct').find((n) => n.name === 'Detail')!;
    const bridged = cg
      .getOutgoingEdges(openDetail.id)
      .filter(
        (e) =>
          e.target === detail.id &&
          (e.metadata as Record<string, unknown> | undefined)?.synthesizedBy === 'arkui-route'
      );
    expect(bridged).toHaveLength(1);
  });
});

describe('ohpm main entry (custom barrel + .ts consumer)', () => {
  let tmpDir: string | undefined;
  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  it('resolves a bare import through a custom main, from an .ets AND a .ts consumer', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ohpm-main-'));
    fs.mkdirSync(path.join(tmpDir, 'core/data/src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'feature/goods/src'), { recursive: true });

    // Custom entry — NOT the Index.ets convention.
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/oh-package.json5'),
      '{\n  "name": "data",\n  "main": "src/entry.ets",\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/src/entry.ets'),
      "export { CartRepository } from './CartRepository';\n"
    );
    fs.writeFileSync(
      path.join(tmpDir, 'core/data/src/CartRepository.ets'),
      'export class CartRepository {\n  addToCart(id: string): void {\n    console.log(id);\n  }\n}\n'
    );

    fs.writeFileSync(
      path.join(tmpDir, 'feature/goods/oh-package.json5'),
      '{\n  "name": "goods",\n  "dependencies": {\n    "data": "file:../../core/data",\n  },\n}\n'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'feature/goods/src/GoodsVm.ets'),
      'import { CartRepository } from "data";\n' +
        'export class GoodsVm {\n' +
        '  private cart: CartRepository = new CartRepository();\n' +
        '  add(id: string): void {\n    this.cart.addToCart(id);\n  }\n' +
        '}\n'
    );
    // The .ts consumer — resolves through the manifest's entry, no `.ets`
    // in the TypeScript candidate list required.
    fs.writeFileSync(
      path.join(tmpDir, 'feature/goods/src/report.ts'),
      'import { CartRepository } from "data";\n' +
        'export function report(cart: CartRepository): string {\n' +
        '  return typeof cart;\n' +
        '}\n'
    );

    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const classes = cg.getNodesByKind('class');
    const repo = classes.find((n) => n.name === 'CartRepository')!;
    expect(repo).toBeDefined();

    // .ets consumer: cross-module method call connects.
    const methods = cg.getNodesByKind('method');
    const add = methods.find((n) => n.qualifiedName === 'GoodsVm::add')!;
    const addToCart = methods.find((n) => n.qualifiedName === 'CartRepository::addToCart')!;
    expect(cg.getOutgoingEdges(add.id).map((e) => e.target)).toContain(addToCart.id);

    // .ts consumer: the type annotation reference reaches the .ets class.
    const report = cg.getNodesByKind('function').find((n) => n.name === 'report')!;
    expect(cg.getOutgoingEdges(report.id).map((e) => e.target)).toContain(repo.id);
  });
});
