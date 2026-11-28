/**
 * A large file indexes in the time its size asks for in the languages the
 * native kernel does not read, and when it is a framework's routes file.
 *
 * large-file-indexing.test.ts covers the languages the kernel reads. The
 * same shape of slowness, work for each symbol or route that goes through
 * the whole file, was in what it does not cover: the wasm extractor's own
 * language modules, the extractors that read a file without a grammar, and
 * the framework passes that turn a routes file into routes and link each to
 * its handler. At 1.2 MB an Express file of inline handlers took 58 seconds,
 * Liquid markup 41, a CodeIgniter routes file 31, ArkTS 21, a React Native
 * Fabric spec 20, a file of event listeners 16, and React Router, Angular and
 * Play route tables about 12.
 *
 * Each case here is one such file at 2 MB or more, where the square was
 * minutes. They pin that it is indexed in seconds, and that what the faster
 * path decides is what the slow one decided: a decorator on the declaration
 * under it, a tag on its own line and column, a route linked to its own
 * handler and no other, a nested route's path joined to its parent's, a
 * call that a local binding hides left unlinked.
 *
 * The time allowed is generous, for a loaded machine: every case takes a few
 * seconds.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

vi.setConfig({ testTimeout: 240_000, hookTimeout: 60_000 });

/** What a case may take. Each took minutes at this size, where it was indexed at all. */
const ALLOWED_MS = 60_000;

const MB = 1024 * 1024;

/** `unit(i)` repeated until the text is `bytes` long, between a head and a tail. */
function fill(bytes: number, unit: (i: number) => string, head = '', tail = ''): { text: string; count: number } {
  const parts = [head];
  let length = head.length + tail.length;
  let count = 0;
  for (; length < bytes; count++) {
    const part = unit(count);
    parts.push(part);
    length += part.length;
  }
  parts.push(tail);
  return { text: parts.join(''), count };
}
/** `unit(i)` for each of `count`. */
const each = (count: number, unit: (i: number) => string): string => Array.from({ length: count }, (_, i) => unit(i)).join('');

describe('a large file indexes in the time its size asks for, beyond the kernel\'s languages', () => {
  let dir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-large-framework-'));
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>): Promise<number> {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    cg = await CodeGraph.init(dir);
    const started = Date.now();
    await cg.indexAll();
    return Date.now() - started;
  }

  const inFile = (file: string, kind: Node['kind']): Node[] => cg!.getNodesInFile(file).filter((n) => n.kind === kind);
  const named = (file: string, name: string, kind?: Node['kind']): Node => {
    const found = cg!.getNodesInFile(file).filter((n) => n.name === name && (!kind || n.kind === kind));
    expect(found.map((n) => n.kind), `${name} in ${file}`).toHaveLength(1);
    return found[0]!;
  };
  /** What points at a node, as `kind from name`, in order. */
  const into = (node: Node, ...kinds: string[]): string[] =>
    cg!.getIncomingEdges(node.id)
      .filter((e) => kinds.includes(e.kind))
      .map((e) => `${e.kind} from ${cg!.getNode(e.source)?.name}`)
      .sort();

  it('ArkTS components: each decorator on the struct under it', async () => {
    const { text, count } = fill(2 * MB, (i) => `@Component\nstruct View${i} {\n  @State count: number = ${i}\n  build() {\n    Column() {\n      Text('x${i}')\n      View${i ? i - 1 : 0}()\n    }\n  }\n}\n\n`);
    expect(await index({ 'src/big.ets': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/big.ets', 'struct')).toHaveLength(count);
    for (const i of [0, 5, count - 1]) expect(named('src/big.ets', `View${i}`).decorators, `View${i}`).toEqual(['Component']);
    expect(into(named('src/big.ets', 'View5'), 'instantiates')).toEqual(['instantiates from build']);
  });

  it('Liquid markup: each tag on its own line and column', async () => {
    const { text, count } = fill(2 * MB, (i) => `{% render 'snippet${i % 50}', value: product.title %}\n{{ product.title | append: '${i}' }}\n{% assign v${i} = product.price | times: ${i} %}\n`);
    expect(await index({ 'sections/big.liquid': text })).toBeLessThan(ALLOWED_MS);
    const renders = inFile('sections/big.liquid', 'component');
    expect(renders).toHaveLength(count);
    // The k-th `render` opens line 3k + 1.
    for (const k of [0, 7, Math.floor(count / 2), count - 1]) {
      const at = renders.filter((n) => n.startLine === 3 * k + 1);
      expect(at.map((n) => [n.name, n.startColumn]), `render ${k}`).toEqual([[`snippet${k % 50}`, 0]]);
    }
    expect(named('sections/big.liquid', `v${count - 1}`, 'variable').startLine).toBe(3 * (count - 1) + 3);
  });

  it('a VB.NET module followed by nothing but comment lines', async () => {
    const comments = fill(2.5 * MB, (i) => `' a line of commentary, number ${i}\n`).text;
    const text = `Public Module Big\n  Public Function Helper(x As Integer) As Integer\n    Return x\n  End Function\n\n  Public Function Use() As Integer\n    Return Helper(1)\n  End Function\nEnd Module\n${comments}`;
    expect(await index({ 'src/Big.vb': text })).toBeLessThan(ALLOWED_MS);
    expect(into(named('src/Big.vb', 'Helper'), 'calls')).toEqual(['calls from Use']);
  });

  it('an Objective-C class whose methods send each other messages', async () => {
    const { text, count } = fill(2.5 * MB, (i) => `- (NSString *)thing${i}:(NSString *)name {\n  NSString *value = [self helper:name];\n  return [self thing${i ? i - 1 : 0}:value];\n}\n\n`,
      '#import <Foundation/Foundation.h>\n\n@interface Big : NSObject\n- (NSString *)helper:(NSString *)x;\n@end\n\n@implementation Big\n- (NSString *)helper:(NSString *)x { return x; }\n\n', '@end\n');
    expect(await index({ 'src/Big.m': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/Big.m', 'method').length).toBeGreaterThanOrEqual(count);
    expect(into(named('src/Big.m', 'thing5:'), 'calls')).toEqual(['calls from thing6:']);
  });

  it('a Vue component of many options-API methods: each call from the method it is in', async () => {
    const { text, count } = fill(2 * MB, (i) => `    thing${i}(name) {\n      const value = this.helper(name);\n      return this.thing${i ? i - 1 : 0}(value);\n    },\n`,
      '<script>\nexport default {\n  name: "Big",\n  methods: {\n    helper(x) { return x; },\n', '  },\n};\n</script>\n\n<template>\n  <div></div>\n</template>\n');
    expect(await index({ 'src/Big.vue': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/Big.vue', 'method')).toHaveLength(count + 1);
    expect(into(named('src/Big.vue', 'thing5'), 'calls')).toEqual(['calls from thing6']);
    expect(into(named('src/Big.vue', `thing${count - 2}`), 'calls')).toEqual([`calls from thing${count - 1}`]);
  });

  it('an Express file of inline route handlers', async () => {
    const { text, count } = fill(2.5 * MB, (i) => `app.get('/x${i}', (req, res) => {\n  res.json(helper(${i}));\n});\n\n`,
      "const express = require('express');\nconst app = express();\nfunction helper(x) { return x; }\n\n", 'module.exports = app;\n');
    expect(await index({ 'package.json': '{"name":"big","dependencies":{"express":"^4.0.0"}}\n', 'server.js': text })).toBeLessThan(ALLOWED_MS);
    const routes = inFile('server.js', 'route');
    expect(routes).toHaveLength(count);
    expect(routes.filter((r) => r.name.endsWith(' /x5') || r.name === '/x5')).toHaveLength(1);
  });

  it('a routes file and its controller, in CodeIgniter, Rails and Play: each route to its own action', async () => {
    const n = 30_000;
    expect(await index({
      'index.php': "<?php\ndefine('BASEPATH', 'system/');\n",
      'system/core/CodeIgniter.php': '<?php\n',
      'application/controllers/Big.php': `<?php\nclass Big extends CI_Controller {\n${each(n, (i) => `  public function x${i}() { return ${i}; }\n`)}}\n`,
      'application/config/routes.php': `<?php\n$route['default_controller'] = 'big';\n${each(n, (i) => `$route['x${i}'] = 'big/x${i}';\n`)}`,
    })).toBeLessThan(ALLOWED_MS);
    expect(into(named('application/controllers/Big.php', 'x5'), 'references')).toEqual(['references from ANY /big/x5', 'references from ANY /x5']);
    expect(into(named('application/controllers/Big.php', `x${n - 1}`), 'references')).toContain(`references from ANY /x${n - 1}`);
    cg!.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);

    expect(await index({
      'Gemfile': "source 'https://rubygems.org'\ngem 'rails'\n",
      'config/application.rb': "require 'rails/all'\n",
      'app/controllers/big_controller.rb': `class BigController < ApplicationController\n${each(n, (i) => `  def x${i}\n  end\n\n`)}end\n`,
      'config/routes.rb': `Rails.application.routes.draw do\n${each(n, (i) => `  get '/x${i}', to: 'big#x${i}'\n`)}end\n`,
    })).toBeLessThan(ALLOWED_MS);
    expect(into(named('app/controllers/big_controller.rb', 'x5'), 'references')).toEqual(['references from GET /x5']);
    expect(into(named('app/controllers/big_controller.rb', `x${n - 1}`), 'references')).toEqual([`references from GET /x${n - 1}`]);
    cg!.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);

    expect(await index({
      'build.sbt': 'lazy val root = (project in file(".")).enablePlugins(PlayScala)\n',
      'app/controllers/Big.scala': `package controllers\n\nimport play.api.mvc._\n\nclass Big extends BaseController {\n${each(n, (i) => `  def x${i} = Action { Ok("${i}") }\n`)}}\n`,
      'conf/routes': each(n, (i) => `GET     /x${i}     controllers.Big.x${i}\n`),
    })).toBeLessThan(ALLOWED_MS);
    expect(into(named('app/controllers/Big.scala', 'x5'), 'references')).toEqual(['references from GET /x5']);
    expect(into(named('app/controllers/Big.scala', `x${n - 1}`), 'references')).toEqual([`references from GET /x${n - 1}`]);
  });

  it('a Spring controller of request mappings', async () => {
    const { text, count } = fill(2.5 * MB, (i) => `  @RequestMapping(value = "/x${i}", method = RequestMethod.POST)\n  public ResponseEntity<String> x${i}(@RequestBody String body) {\n    return ResponseEntity.ok(service.handle(body));\n  }\n\n`,
      'package x;\n\nimport org.springframework.http.ResponseEntity;\nimport org.springframework.web.bind.annotation.*;\n\n@RestController\npublic class BigController {\n  private final BigService service = new BigService();\n\n',
      '}\n\nclass BigService {\n  String handle(String body) { return body; }\n}\n');
    expect(await index({
      'pom.xml': '<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>\n',
      'src/main/java/x/BigController.java': text,
    })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/main/java/x/BigController.java', 'route')).toHaveLength(count);
    expect(into(named('src/main/java/x/BigController.java', 'x5'), 'references')).toEqual(['references from POST /x5']);
    expect(cg!.getCallers(named('src/main/java/x/BigController.java', 'handle').id)).toHaveLength(count);
  });

  it('a React Router table: each route to its page, a nested route under its parent\'s path', async () => {
    const n = 18_000;
    const text = `import React from 'react';\nimport { Routes, Route, useNavigate } from 'react-router-dom';\n\n${each(n, (i) => `function Page${i}() { return <div>${i}</div>; }\n`)}\n` +
      `export function Nav() {\n  const navigate = useNavigate();\n${each(500, (i) => `  const go${i} = () => navigate('/x${i}');\n`)}  return null;\n}\n\n` +
      `export function App() {\n  return (\n    <Routes>\n${each(n, (i) => `      <Route path="/x${i}" element={<Page${i} />} />\n`)}` +
      `      <Route path="/shop">\n        <Route path="cart" element={<Page0 />} />\n      </Route>\n    </Routes>\n  );\n}\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(1.5 * MB);
    expect(await index({ 'package.json': '{"name":"big","dependencies":{"react":"^18.0.0","react-router-dom":"^6.0.0"}}\n', 'src/routes.tsx': text })).toBeLessThan(ALLOWED_MS);
    const routes = inFile('src/routes.tsx', 'route').map((r) => r.name);
    // The parent is a route of its own; its child's path is joined to it.
    expect(routes).toHaveLength(n + 2);
    expect(routes).toContain('/shop');
    expect(routes).toContain('/shop/cart');
    expect(into(named('src/routes.tsx', 'Page5'), 'references')).toEqual(['references from /x5']);
    expect(into(named('src/routes.tsx', '/x5'), 'navigates')).toEqual(['navigates from go5']);
    expect(into(named('src/routes.tsx', `Page${n - 1}`), 'references')).toEqual([`references from /x${n - 1}`]);
  });

  it('an Angular routes file of components', async () => {
    const n = 16_000;
    const text = `import { Component } from '@angular/core';\nimport { Routes } from '@angular/router';\n\n${each(n, (i) => `@Component({ selector: 'p-${i}', template: '' })\nexport class Page${i}Component {}\n`)}\n` +
      `export const routes: Routes = [\n${each(n, (i) => `  { path: 'x${i}', component: Page${i}Component },\n`)}];\n`;
    expect(Buffer.byteLength(text)).toBeGreaterThan(1.5 * MB);
    expect(await index({ 'package.json': '{"name":"big","dependencies":{"@angular/core":"^17.0.0","@angular/router":"^17.0.0"}}\n', 'src/app/app.routes.ts': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/app/app.routes.ts', 'route')).toHaveLength(n);
    expect(into(named('src/app/app.routes.ts', 'Page5Component'), 'references')).toEqual(['references from /x5']);
    expect(into(named('src/app/app.routes.ts', `Page${n - 1}Component`), 'references')).toEqual([`references from /x${n - 1}`]);
  });

  it('a file of event listeners: each emit to the listener of its event', async () => {
    const { text, count } = fill(2 * MB, (i) => `function on${i}(x) { return x; }\nemitter.on('e${i}', on${i});\nfunction fire${i}() { emitter.emit('e${i}', ${i}); }\n`,
      "const { EventEmitter } = require('events');\nconst emitter = new EventEmitter();\n\n");
    expect(await index({ 'package.json': '{"name":"big"}\n', 'src/events.js': text })).toBeLessThan(ALLOWED_MS);
    expect(inFile('src/events.js', 'function')).toHaveLength(count * 2);
    expect(into(named('src/events.js', 'on5'), 'calls')).toEqual(['calls from fire5']);
    expect(into(named('src/events.js', `on${count - 1}`), 'calls')).toEqual([`calls from fire${count - 1}`]);
  });

  it('a React Native Fabric spec of many props: each where its name first stands', async () => {
    const { text, count } = fill(2 * MB, (i) => `  prop${i}?: string;\n  onEvent${i}?: CT.DirectEventHandler<Readonly<{ value: string }>>;\n`,
      "import { codegenNativeComponent } from 'react-native';\nimport type { ViewProps, CodegenTypes as CT } from 'react-native';\n\nexport interface NativeProps extends ViewProps {\n" +
      // Named in a type before it is declared: a prop is placed where its name first occurs.
      '  first?: Wrapper<late>;\n',
      "  late?: string;\n}\n\nexport default codegenNativeComponent<NativeProps>('Big');\n");
    expect(await index({
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/BigView.mm': '#import <React/RCTViewComponentView.h>\n\n@interface BigView : RCTViewComponentView\n@end\n\n@implementation BigView\n@end\n',
      'src/BigNativeComponent.ts': text,
    })).toBeLessThan(ALLOWED_MS);
    const props = cg!.getNodesInFile('src/BigNativeComponent.ts').filter((n) => n.id.startsWith('fabric-prop:'));
    expect(props).toHaveLength(count * 2 + 2);
    const lineOf = (name: string): number[] => props.filter((n) => n.name === name).map((n) => n.startLine);
    // Four lines above the interface's first prop; then two lines to each pair.
    for (const k of [0, 1, 10, Math.floor(count / 2), count - 1]) {
      expect(lineOf(`prop${k}`), `prop${k}`).toEqual([6 + 2 * k]);
      expect(lineOf(`onEvent${k}`), `onEvent${k}`).toEqual([7 + 2 * k]);
    }
    expect(lineOf('first')).toEqual([5]);
    expect(lineOf('late')).toEqual([5]);
    expect(inFile('src/BigNativeComponent.ts', 'component').map((n) => n.name)).toEqual(['Big']);
  });

  it('an Objective-C file of messages to a Swift class: each to the `@objc` method it names, and to no other', async () => {
    const n = 14_000;
    // Windows line endings, which the lines above a declaration are read through.
    const swift = `import Foundation\n\n@objc class Big: NSObject {\n${each(n, (i) => `  @objc func thing${i}(name: String) -> String {\n    return name\n  }\n\n`)}` +
      '  func hidden(name: String) -> String {\n    return name\n  }\n\n  @objc\n  func above(name: String) -> String {\n    return name\n  }\n}\n';
    const objc = `#import "Big-Swift.h"\n\n@interface Use : NSObject\n@end\n\n@implementation Use\n- (void)use:(Big *)big {\n${each(n, (i) => `  [big thing${i}WithName:@"x"];\n`)}` +
      '  [big hiddenWithName:@"x"];\n  [big aboveWithName:@"x"];\n}\n@end\n';
    expect(await index({ 'Sources/Big.swift': swift.replace(/\n/g, '\r\n'), 'Sources/Use.m': objc })).toBeLessThan(ALLOWED_MS);
    expect(inFile('Sources/Big.swift', 'method')).toHaveLength(n + 2);
    for (const i of [0, 5, n - 1]) expect(into(named('Sources/Big.swift', `thing${i}`), 'calls'), `thing${i}`).toEqual(['calls from use:']);
    // `@objc` on the line above counts; a method with none is not Objective-C's to call.
    expect(into(named('Sources/Big.swift', 'above'), 'calls')).toEqual(['calls from use:']);
    expect(into(named('Sources/Big.swift', 'hidden'), 'calls')).toEqual([]);
  });

  it('a file of calls on a React Native TurboModule: each to the native method of its name', async () => {
    const n = 14_000;
    expect(await index({
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'src/NativeBig.ts': `import type { TurboModule } from 'react-native';\nimport { TurboModuleRegistry } from 'react-native';\n\nexport interface Spec extends TurboModule {\n${each(n, (i) => `  thing${i}(name: string): string;\n`)}}\n\nexport default TurboModuleRegistry.getEnforcing<Spec>('Big');\n`,
      'ios/Big.mm': `#import "Big.h"\n\n@implementation Big\nRCT_EXPORT_MODULE()\n\n${each(n, (i) => `- (NSString *)thing${i}:(NSString *)name {\n  return name;\n}\n\n`)}@end\n`,
      'src/use.ts': `import Big from './NativeBig';\n\nexport function use() {\n${each(n, (i) => `  Big.thing${i}('x');\n`)}}\n`,
    })).toBeLessThan(ALLOWED_MS);
    for (const i of [0, 5, n - 1]) expect(into(named('ios/Big.mm', `thing${i}:`), 'calls'), `thing${i}:`).toEqual(['calls from use']);
    expect(cg!.getCallees(named('src/use.ts', 'use').id).length).toBeGreaterThanOrEqual(n);
  });

  it('a React Native shim that exposes a Swift class of many methods: the shim is read, and each call arrives', async () => {
    // The grammar cannot parse `RCT_EXTERN_METHOD(…)` under `@interface`, and
    // its recovery took the square of these lines inside the parser: at this
    // many the parse ran out its budget and the shim was left with nothing.
    // The parser is given the implementation the macros expand to instead.
    const n = 30_000;
    expect(await index({
      'package.json': '{"name":"big","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/Big.m': `#import <React/RCTBridgeModule.h>\n\n@interface RCT_EXTERN_MODULE(Big, NSObject)\n${each(n, (i) => `RCT_EXTERN_METHOD(thing${i}:(NSString *)name)\n`)}+ (BOOL)requiresMainQueueSetup { return NO; }\n@end\n`,
      'ios/Big.swift': `import Foundation\n\n@objc(Big)\nclass Big: NSObject {\n${each(n, (i) => `  @objc func thing${i}(_ name: String) {\n  }\n\n`)}}\n`,
      'src/use.js': `import { NativeModules } from 'react-native';\n\nexport function use() {\n${each(n, (i) => `  NativeModules.Big.thing${i}('x');\n`)}}\n`,
    })).toBeLessThan(ALLOWED_MS);
    expect(named('ios/Big.m', 'Big').kind).toBe('class');
    // Three lines above the first macro, then one line to each.
    expect(named('ios/Big.m', 'requiresMainQueueSetup', 'method').startLine).toBe(n + 4);
    for (const i of [0, 5, n - 1]) expect(into(named('ios/Big.swift', `thing${i}`), 'calls'), `thing${i}`).toEqual(['calls from use']);
  });

  it('a Tauri front end of many invokes: each to its command, but not one a local binding hides', async () => {
    const n = 25_000;
    const core = `${each(n, (i) => `#[tauri::command]\nfn cmd${i}(x: i32) -> i32 {\n    x\n}\n\n`)}fn main() {\n    tauri::Builder::default().invoke_handler(tauri::generate_handler![${Array.from({ length: n }, (_, i) => `cmd${i}`).join(', ')}]).run();\n}\n`;
    const front = `import { invoke } from '@tauri-apps/api/core';\n\nexport async function use() {\n${each(n, (i) => `  await invoke('cmd${i}', { x: 1 });\n`)}}\n\n` +
      // Its own \`invoke\`, taken from what it is handed, some thousand lines into a function of other calls.
      `export async function local(api: { invoke: (name: string) => Promise<void> }) {\n${each(3000, (i) => `  await api.invoke('other${i}');\n`)}  const { invoke } = api;\n  await invoke('cmd7');\n}\n\n` +
      'export async function before(api: { invoke: (name: string) => Promise<void> }) {\n  await invoke(\'cmd8\');\n  const { invoke: mine } = api;\n  await mine(\'cmd9\');\n}\n';
    expect(await index({
      'package.json': '{"name":"big","dependencies":{"@tauri-apps/api":"^2.0.0"}}\n',
      'src-tauri/Cargo.toml': '[package]\nname = "big"\nversion = "0.1.0"\n\n[dependencies]\ntauri = "2"\n',
      'src-tauri/src/main.rs': core,
      'src/use.ts': front,
    })).toBeLessThan(ALLOWED_MS);
    expect(into(named('src-tauri/src/main.rs', 'cmd5'), 'calls')).toEqual(['calls from use']);
    expect(into(named('src-tauri/src/main.rs', `cmd${n - 1}`), 'calls')).toEqual(['calls from use']);
    // Hidden by the function's own binding where it is called; not where it is called above the binding.
    expect(into(named('src-tauri/src/main.rs', 'cmd7'), 'calls')).toEqual(['calls from use']);
    expect(into(named('src-tauri/src/main.rs', 'cmd8'), 'calls')).toEqual(['calls from before', 'calls from use']);
  });
});
