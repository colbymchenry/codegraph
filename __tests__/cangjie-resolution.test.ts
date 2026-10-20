/**
 * Cangjie end-to-end resolution tests.
 *
 * Pins the package/import contract: every top-level declaration lives under
 * its file's `package` namespace (`demo.model::User`), and an `import
 * demo.model.User` binds `User` to exactly that FQN — a same-named class in
 * another package is never the target. Also pins that a call on a local of a
 * standard-library type (`let list = ArrayList<…>(); list.add(x)`) never
 * lands on a project method that merely shares the name.
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

describe('Cangjie package/import resolution', () => {
  let tmpDir: string | undefined;
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  });

  const write = (rel: string, text: string): void => {
    fs.mkdirSync(path.dirname(path.join(tmpDir!, rel)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir!, rel), text);
  };

  it('binds an imported class and its method to the imported package, not a same-named decoy', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/model/user_model.cj',
      'package demo.model\n\n' +
      'public class User {\n' +
      '    public init(name: String) {}\n' +
      '    public func greet(): String { "hi" }\n' +
      '}\n');
    // A decoy with the same class and method names in another package.
    write('src/other/decoy.cj',
      'package demo.other\n\n' +
      'public class User {\n' +
      '    public func greet(): String { "decoy" }\n' +
      '}\n');
    write('src/app/main.cj',
      'package demo.app\n\n' +
      'import demo.model.User\n\n' +
      'public func run(): String {\n' +
      '    let u = User("a")\n' +
      '    u.greet()\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const byQn = (qn: string) =>
      [...cg!.getNodesByKind('class'), ...cg!.getNodesByKind('method'), ...cg!.getNodesByKind('function')]
        .find((n) => n.qualifiedName === qn);
    const run = byQn('demo.app::run');
    const user = byQn('demo.model::User');
    const greet = byQn('demo.model::User::greet');
    const decoy = byQn('demo.other::User');
    const decoyGreet = byQn('demo.other::User::greet');
    expect(run && user && greet && decoy && decoyGreet).toBeTruthy();

    const out = cg.getOutgoingEdges(run!.id);
    expect(out.find((e) => e.target === user!.id)?.kind).toBe('instantiates');
    expect(out.find((e) => e.target === greet!.id)?.kind).toBe('calls');
    expect(cg.getIncomingEdges(decoy!.id).filter((e) => e.kind !== 'contains')).toHaveLength(0);
    expect(cg.getIncomingEdges(decoyGreet!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);

    // The import itself resolves to the imported class.
    const importEdges = cg.getIncomingEdges(user!.id).filter((e) => e.kind === 'imports');
    expect(importEdges.length).toBeGreaterThan(0);
  });

  it('never links a std-collection call to a same-named project method', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/coll/empty.cj',
      'package demo.coll\n\n' +
      'public class EmptyList {\n' +
      '    public func add(x: Int64): Unit {}\n' +
      '}\n');
    write('src/app/fill.cj',
      'package demo.app\n\n' +
      'import std.collection.*\n\n' +
      'public func fill(): Unit {\n' +
      '    let list = ArrayList<Int64>()\n' +
      '    list.add(1)\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const add = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'demo.coll::EmptyList::add');
    expect(add).toBeDefined();
    expect(cg.getIncomingEdges(add!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
  });

  it('gates UI attributes to builder helpers and bridges @State writes to build()', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    // A decoy: a method that merely shares a framework attribute's name.
    write('src/model/sizes.cj',
      'package demo.model\n\n' +
      'public class Sizes {\n' +
      '    public func width(w: Int64): Int64 { w }\n' +
      '}\n');
    write('src/ui/page.cj',
      'package demo.ui\n\n' +
      '@Component\n' +
      'public class CounterPage {\n' +
      '    @State var count: Int64 = 0\n\n' +
      '    @Builder func titleStyle(): Unit {}\n\n' +
      '    func inc(): Unit {\n' +
      '        count += 1\n' +
      '    }\n\n' +
      '    func readOnly(): Int64 {\n' +
      '        count\n' +
      '    }\n\n' +
      '    func build() {\n' +
      '        Column {\n' +
      '            Text("n").width(100).titleStyle()\n' +
      '            Button("+").onClick({ _ => this.inc() })\n' +
      '        }\n' +
      '    }\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const m = (qn: string) => methods.find((n) => n.qualifiedName === qn)!;
    const build = m('demo.ui::CounterPage::build');
    const width = m('demo.model::Sizes::width');
    const titleStyle = m('demo.ui::CounterPage::titleStyle');
    expect(cg.getIncomingEdges(width.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
    expect(cg.getOutgoingEdges(build.id).map((e) => e.target)).toContain(titleStyle.id);

    // inc writes @State count → re-renders build(); readOnly only reads it.
    const toBuild = cg.getIncomingEdges(build.id).filter((e) => e.kind === 'calls').map((e) => e.source);
    expect(toBuild).toContain(m('demo.ui::CounterPage::inc').id);
    expect(toBuild).not.toContain(m('demo.ui::CounterPage::readOnly').id);
  });

  it('dispatches through an extend in another file, and never lands a type reference on it', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/geo/point.cj',
      'package demo.geo\n\n' +
      'public interface Printable {\n' +
      '    func show(): String\n' +
      '}\n\n' +
      'public struct Point {\n' +
      '    public init(x: Int64, y: Int64) {}\n' +
      '}\n');
    write('src/geo/point_ext.cj',
      'package demo.geo\n\n' +
      'extend Point <: Printable {\n' +
      '    public func show(): String { "p" }\n' +
      '}\n\n' +
      'extend Int64 <: Printable {\n' +
      '    public func show(): String { "i" }\n' +
      '}\n');
    write('src/app/main.cj',
      'package demo.app\n\n' +
      'import demo.geo.*\n\n' +
      'public func render(p: Printable): String {\n' +
      '    p.show()\n' +
      '}\n\n' +
      'public func make(): Int64 {\n' +
      '    let p = Point(1, 2)\n' +
      '    Int64(3)\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const ext = cg.getNodesByKind('class').filter((n) => (n.decorators ?? []).includes('extend'));
    expect(ext.map((n) => n.name).sort()).toEqual(['Int64', 'Point']);
    const point = cg.getNodesByKind('struct').find((n) => n.name === 'Point')!;
    const make = cg.getNodesByKind('function').find((n) => n.name === 'make')!;
    const made = cg.getOutgoingEdges(make.id).filter((e) => e.kind === 'instantiates' || e.kind === 'calls');
    expect(made.map((e) => e.target)).toContain(point.id);
    for (const e of ext) expect(made.map((x) => x.target)).not.toContain(e.id);

    // Both extensions implement Printable, so its `show` reaches theirs.
    const ifaceShow = cg.getNodesByKind('method').find((n) => n.qualifiedName === 'demo.geo::Printable::show')!;
    const impls = cg.getOutgoingEdges(ifaceShow.id).map((e) => cg!.getNode(e.target)?.qualifiedName);
    expect(impls).toEqual(expect.arrayContaining(['demo.geo::Point::show', 'demo.geo::Int64::show']));
  });

  it('never binds a UI component call to a same-named enum case of an unrelated file', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/svc/kinds.cj',
      'package demo.svc\n\n' +
      'public enum HeaderKind {\n' +
      '    | Text | Media\n' +
      '}\n');
    write('src/ui/page.cj',
      'package demo.ui\n\n' +
      'import demo.svc.*\n\n' +
      '@Component\n' +
      'public class Page {\n' +
      '    func build() {\n' +
      '        Text("hello")\n' +
      '    }\n' +
      '}\n');
    write('src/svc/use.cj',
      'package demo.svc\n\n' +
      'public func pick(): HeaderKind {\n' +
      '    Text\n' +
      '}\n\n' +
      'public func make(): HeaderKind {\n' +
      '    Media()\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const members = cg.getNodesByKind('enum_member');
    const media = members.find((n) => n.name === 'Media')!;
    const text = members.find((n) => n.name === 'Text')!;
    const build = cg.getNodesByKind('method').find((n) => n.name === 'build')!;
    expect(cg.getOutgoingEdges(build.id).map((e) => e.target)).not.toContain(text.id);
    // A file that names the enum still reaches its cases.
    expect(cg.getIncomingEdges(media.id).filter((e) => e.kind !== 'contains').length).toBeGreaterThan(0);
  });

  it('types a local or chain bound from a factory function by its declared return type', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/svc/iface.cj',
      'package demo.svc\n\n' +
      'public interface IAuthService {\n' +
      '    func sendCode(phone: String): Bool\n' +
      '}\n');
    write('src/svc/real.cj',
      'package demo.svc\n\n' +
      'public class RealAuthService {\n' +
      '    public func sendCode(phone: String): Bool { true }\n' +
      '}\n\n' +
      'let _auth = RealAuthService()\n\n' +
      'public func getRealAuthService(): RealAuthService {\n' +
      '    _auth\n' +
      '}\n');
    write('src/svc/stream.cj',
      'package demo.svc\n\n' +
      'public class RawStream {\n' +
      '    public func handshake(): Bool { true }\n' +
      '}\n\n' +
      'public class OtherStream {\n' +
      '    public func handshake(): Bool { false }\n' +
      '}\n\n' +
      'public class Context {\n' +
      '    public func createStream(): RawStream { RawStream() }\n' +
      '}\n');
    write('src/ui/connect.cj',
      'package demo.ui\n\n' +
      'import demo.svc.*\n\n' +
      'public func connect(context: Context): Bool {\n' +
      '    let stream = context.createStream()\n' +
      '    stream.handshake()\n' +
      '}\n');
    write('src/ui/login.cj',
      'package demo.ui\n\n' +
      'import demo.svc.*\n\n' +
      'public func submit(): Unit {\n' +
      '    let authService = getRealAuthService()\n' +
      '    authService.sendCode("1")\n' +
      '}\n\n' +
      'public func submitChained(): Unit {\n' +
      '    getRealAuthService().sendCode("2")\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const methods = cg.getNodesByKind('method');
    const real = methods.find((n) => n.qualifiedName === 'demo.svc::RealAuthService::sendCode')!;
    const iface = methods.find((n) => n.qualifiedName === 'demo.svc::IAuthService::sendCode')!;
    // A local bound from a method call has that method's return type.
    const connect = cg.getNodesByKind('function').find((n) => n.name === 'connect')!;
    const rawHandshake = methods.find((n) => n.qualifiedName === 'demo.svc::RawStream::handshake')!;
    expect(cg.getOutgoingEdges(connect.id).filter((e) => e.kind === 'calls').map((e) => e.target)).toContain(rawHandshake.id);
    for (const name of ['submit', 'submitChained']) {
      const fn = cg.getNodesByKind('function').find((n) => n.name === name)!;
      const targets = cg.getOutgoingEdges(fn.id).filter((e) => e.kind === 'calls').map((e) => e.target);
      expect(targets).toContain(real.id);
      expect(targets).not.toContain(iface.id);
    }
  });

  it('bridges a foreign func to the C function that implements it', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cangjie-'));
    write('src/tls/stream.cj',
      'package demo.tls\n\n' +
      'foreign {\n' +
      '    func CJ_TLS_Handshake(ssl: CPointer<Unit>): Int32\n' +
      '}\n\n' +
      'public func handshake(ssl: CPointer<Unit>): Int32 {\n' +
      '    unsafe { CJ_TLS_Handshake(ssl) }\n' +
      '}\n');
    write('src/tls/native/tls.h', 'int CJ_TLS_Handshake(void* ssl);\n');
    write('src/tls/native/tls.c',
      '#include "tls.h"\n' +
      'static int doHandshake(void* ssl) { return 1; }\n' +
      'int CJ_TLS_Handshake(void* ssl) {\n' +
      '    return doHandshake(ssl);\n' +
      '}\n');

    cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const fns = cg.getNodesByKind('function');
    const decl = fns.find((n) => n.name === 'CJ_TLS_Handshake' && n.language === 'cangjie')!;
    const impl = fns.find((n) => n.name === 'CJ_TLS_Handshake' && n.language === 'c' && n.filePath.endsWith('.c'))!;
    const handshake = fns.find((n) => n.name === 'handshake')!;
    expect(cg.getOutgoingEdges(handshake.id).map((e) => e.target)).toContain(decl.id);
    const bridge = cg.getOutgoingEdges(decl.id).filter((e) => e.kind === 'calls');
    expect(bridge.map((e) => e.target)).toEqual([impl.id]);
    expect(bridge[0]!.provenance).toBe('heuristic');
  });
});
