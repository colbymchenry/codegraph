import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import { matchReference, matchByQualifiedName, matchFuzzy, gateLanguageMatch } from '../src/resolution/name-matcher';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

describe('cross-language name resolution (#1986)', () => {
  let dir: string;
  let cg: CodeGraph | undefined;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-language-')); });
  afterEach(() => {
    cg?.close();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>) {
    for (const [file, source] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
      fs.writeFileSync(path.join(dir, file), source);
    }
    cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    return cg;
  }

  function targets(name: string) {
    const source = cg!.getNodesByName(name).find((n) => n.kind !== 'file');
    expect(source, name).toBeDefined();
    return cg!.getOutgoingEdges(source!.id)
      .filter((e) => ['calls', 'instantiates', 'extends', 'implements'].includes(e.kind))
      .map((e) => cg!.getNode(e.target)!.name);
  }

  it('rejects foreign calls, explicit constructors, extends and implements', async () => {
    await index({
      'lib.rs': 'pub fn parse() -> Result<u32, String> { Ok(1) }',
      'Ok.scala': 'object Ok { def apply(): Int = 1 }',
      'total.py': 'def total():\n    return round(1.2)\n',
      'round.ts': 'export function round() { return 1; }',
      'consumer.swift': 'func consumer() { mystery() }',
      'foreign.py': 'def mystery():\n    return 1\nclass ForeignThing:\n    pass\nclass ForeignBase:\n    pass\n',
      'contract.java': 'public interface ForeignContract {}',
      'App.tsx': 'export function App() { return <ForeignThing/>; }',
      'Page.vue': '<template><ForeignThing @click="mystery"/></template><script>export default {};</script>',
      'construct.ts': 'export function construct() { return new ForeignThing(); }\n' +
        'export class Child extends ForeignBase {}\nexport class Impl implements ForeignContract {}',
      'plain.go': 'package main\nfunc UnexportedABI() {}\n',
      'native.c': 'void nativeConsumer(void) { UnexportedABI(); }',
    });
    for (const name of ['parse', 'total', 'consumer', 'construct', 'Child', 'Impl', 'nativeConsumer']) {
      expect(targets(name), name).toEqual([]);
    }
    const app = cg!.getNodesByName('App').find((n) => n.kind === 'component' || n.kind === 'function')!;
    expect(app).toBeDefined();
    expect(cg!.getOutgoingEdges(app.id).filter((e) => cg!.getNode(e.target)?.language === 'python')).toEqual([]);
    const page = cg!.getNodesInFile('Page.vue').find((n) => n.kind === 'component')!;
    expect(page).toBeDefined();
    expect(cg!.getOutgoingEdges(page.id).filter((e) => cg!.getNode(e.target)?.language === 'python')).toEqual([]);
  });

  it('keeps foreign calls off Elixir functions (Phoenix assets/js next to lib/)', async () => {
    await index({
      'lib/app/notifier.ex': 'defmodule App.Notifier do\n  def push_event(x), do: x\nend\n',
      'assets/js/app.js': 'export function jsCaller() { return push_event(1); }',
      'tools/script.py': 'def pyCaller():\n    return push_event(1)\n',
    });
    expect(targets('jsCaller')).toEqual([]);
    expect(targets('pyCaller')).toEqual([]);
  });

  it('preserves web, JVM, native and .NET interoperability', async () => {
    await index({
      'helper.js': 'export function helper() { return 1; }\nexport class WebBase {}',
      'web.ts': "import { helper, WebBase } from './helper.js';\n" +
        'export function webCaller() { return helper(); }\nexport class WebChild extends WebBase {}',
      'JvmBase.java': 'public class JvmBase {}',
      'Child.kt': 'class JvmChild : JvmBase()',
      'native.c': 'int nativeHelper(void) { return 1; }',
      'Native.swift': 'func nativeCaller() { nativeHelper() }',
      'NetBase.cs': 'public class NetBase {}',
      'NetChild.vb': 'Public Class NetChild\n Inherits NetBase\nEnd Class',
      'widget.js': 'export function WebWidget() { return null; }',
      'View.vue': '<template><WebWidget @click="localHandler"/></template>' +
        '<script>import { WebWidget } from "./widget.js"; function localHandler() {} export default {};</script>',
    });
    expect(targets('webCaller')).toContain('helper');
    expect(targets('WebChild')).toContain('WebBase');
    expect(targets('JvmChild')).toContain('JvmBase');
    expect(targets('nativeCaller')).toContain('nativeHelper');
    expect(targets('NetChild')).toContain('NetBase');
    expect(targets('View')).toEqual(expect.arrayContaining(['WebWidget', 'localHandler']));
  });

  it('requires ABI evidence for free functions outside the native family', async () => {
    await index({
      'export.go': 'package main\nimport "C"\n//export StopGo\nfunc StopGo() {}\n',
      'export.rs': '#[no_mangle]\npub extern "C" fn stop_rust() {}\n',
      'Native.swift': 'func stopNative() {\n StopGo()\n stop_rust()\n}',
      'ordinary.py': 'def stop_python():\n    return 1\n',
      'Wrong.swift': 'func wrongNative() { stop_python() }',
      'cfunc.c': 'int cfunc(void) { return 1; }',
      'call.go': 'package main\n/* int cfunc(void); */\nimport "C"\nfunc useC() { C.cfunc() }',
      'wrong.py': 'def wrongC():\n    return cfunc()\n',
    });
    expect(targets('stopNative')).toEqual(expect.arrayContaining(['StopGo', 'stop_rust']));
    expect(targets('wrongNative')).toEqual([]);
    expect(targets('wrongC')).toEqual([]);
  });

  it('gates qualified, method and fuzzy winners without choosing a replacement', async () => {
    const graph = await index({
      'caller.swift': 'func caller() {}',
      'cfunc.c': 'int cfunc(void) { return 1; }',
      'call.go': 'package main\nimport "C"\nfunc useC() { C.cfunc() }',
      'call.rs': 'extern "C" { fn cfunc() -> i32; }\npub fn use_c() { unsafe { cfunc(); } }',
      'foreign.py': 'class Foreign:\n    def act(self):\n        pass\ndef fuzzyName():\n    pass\n',
      'near/pick.py': 'class Container:\n    class Winner:\n        pass\n',
      'far/Winner.swift': 'class Winner {}',
    });
    const files = ['caller.swift', 'foreign.py', 'near/pick.py', 'far/Winner.swift', 'cfunc.c', 'call.go', 'call.rs'];
    const context: ResolutionContext = {
      getNodesInFile: (file) => graph.getNodesInFile(file),
      getNodesByName: (name) => graph.getNodesByName(name),
      getNodesByQualifiedName: (name) => graph.getNodesByQualifiedName(name),
      getNodesByKind: (kind) => graph.getNodesByKind(kind),
      getNodeById: (id) => graph.getNode(id),
      getNodesByLowerName: (name) => files.flatMap((file) => graph.getNodesInFile(file)).filter((n) => n.name.toLowerCase() === name),
      fileExists: (file) => fs.existsSync(path.join(dir, file)),
      readFile: (file) => fs.existsSync(path.join(dir, file)) ? fs.readFileSync(path.join(dir, file), 'utf8') : null,
      getProjectRoot: () => dir,
      getAllFiles: () => files,
    };
    const caller = graph.getNodesByName('caller')[0]!;
    const ref = (referenceName: string): UnresolvedRef => ({
      fromNodeId: caller.id, referenceName, referenceKind: 'calls',
      filePath: caller.filePath, language: 'swift', line: 1, column: 0,
    });
    const method = graph.getNodesByName('act')[0]!;
    expect(matchByQualifiedName(ref(method.qualifiedName), context)?.targetNodeId).toBe(method.id);
    expect(matchReference(ref(method.qualifiedName), context)).toBeNull();
    expect(matchReference(ref('Foreign.act'), context)).toBeNull();
    // Fuzzy is case-sensitive outside PHP/Pascal/CFML/COBOL/VB.NET, so the
    // fuzzy winner here shares the exact name; the language gate still rejects it.
    expect(matchFuzzy(ref('fuzzyName'), context)).not.toBeNull();
    expect(matchReference(ref('fuzzyName'), context)).toBeNull();
    expect(matchFuzzy(ref('FUZZYNAME'), context)).toBeNull();
    // Exact qualified match selects Python even though a Swift type has the
    // same bare name. Rejection must not fall through to that Swift type.
    const foreign = graph.getNodesByName('Winner').find((n) => n.language === 'python')!;
    expect(foreign.qualifiedName).not.toBe('Winner');
    const constructor = { ...ref(foreign.qualifiedName), referenceKind: 'instantiates' as const };
    expect(matchByQualifiedName(constructor, context)?.targetNodeId).toBe(foreign.id);
    expect(matchReference(constructor, context)).toBeNull();

    // ABI declarations allow a C-function result if a strategy supplies it.
    // This does not invent an edge where the receiver matcher cannot find one.
    const cfunc = graph.getNodesByName('cfunc').find((n) => n.language === 'c')!;
    for (const language of ['go', 'rust'] as const) {
      const abiRef = { ...ref(language === 'go' ? 'C.cfunc' : 'cfunc'), language, filePath: language === 'go' ? 'call.go' : 'call.rs' };
      const result = { original: abiRef, targetNodeId: cfunc.id, confidence: 0.8, resolvedBy: 'exact-match' as const };
      expect(gateLanguageMatch(result, abiRef, context)).toEqual(result);
      expect(gateLanguageMatch(result, { ...abiRef, filePath: 'caller.swift' }, context)).toBeNull();
    }
  });
});
