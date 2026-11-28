/**
 * React Native's Objective-C shim for a Swift module is read as what its
 * macros expand to.
 *
 * `@interface RCT_EXTERN_MODULE(Name, Super)` opens, after expansion, the
 * implementation of `Name`: the lines under it are that implementation's
 * body, which is why a method there has one. The grammar read an interface
 * named `RCT_EXTERN_MODULE` and then recovered from every macro line under
 * it. The class was named for the macro, a method written after the macros
 * was a function on the first macro's line or was not there at all, and a
 * shim of some thousand `RCT_EXTERN_METHOD` lines took the square of their
 * number inside the parser, until the parse budget ran out and the file had
 * nothing.
 *
 * The parser is now given the implementation, at the same length
 * (src/extraction/languages/objc-rn-extern.ts). These pin the rewrite itself,
 * what the extractor then reads, and that the calls JavaScript makes into the
 * Swift class still arrive, since those are found from the file as written.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { rewriteRctExternShims } from '../src/extraction/languages/objc-rn-extern';
import type { Node } from '../src/types';

const MODULE_SHIM = [
  '#import <React/RCTBridgeModule.h>',
  '#import <React/RCTEventEmitter.h>',
  '',
  '@interface RCT_EXTERN_MODULE(CaptureView, RCTEventEmitter)',
  '',
  'RCT_EXTERN_METHOD(start:(NSString *)name',
  '                  resolver:(RCTPromiseResolveBlock)resolve',
  '                  rejecter:(RCTPromiseRejectBlock)reject)',
  'RCT_EXTERN_METHOD(stop)',
  'RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(getValue)',
  'RCT_EXTERN_METHOD(configure:(NSDictionary *)options);',
  '',
  '+ (BOOL)requiresMainQueueSetup',
  '{',
  '  return NO;',
  '}',
  '',
  '@end',
  '',
].join('\n');

const VIEW_MANAGER_SHIM = [
  '#import <React/RCTViewManager.h>',
  '',
  '@interface RCT_EXTERN_REMAP_MODULE (CameraView, CameraViewManager, RCTViewManager)',
  '',
  '// Module Functions',
  'RCT_EXTERN_METHOD(getCameraPermissionStatus : (RCTPromiseResolveBlock)resolve reject : (RCTPromiseRejectBlock)reject);',
  '',
  '// Camera View Properties',
  'RCT_EXPORT_VIEW_PROPERTY(isActive, BOOL);',
  'RCT_EXPORT_VIEW_PROPERTY(onError, RCTDirectEventBlock);',
  'RCT_REMAP_VIEW_PROPERTY(zoom, zoomFactor, NSNumber)',
  '',
  'RCT_EXTERN_METHOD(startRecording : (nonnull NSNumber*)node options : (NSDictionary*)options);',
  '',
  '@end',
  '',
].join('\n');

/** Everything but line ends, as the rewrite blanks it. */
const blank = (text: string): string => text.replace(/[^\n\r]/g, ' ');

describe('the rewrite of a React Native extern shim', () => {
  it('writes the head as the implementation of the class, the name where it stood', () => {
    const out = rewriteRctExternShims(MODULE_SHIM);
    const lines = out.split('\n');
    const head = '@interface RCT_EXTERN_MODULE(CaptureView, RCTEventEmitter)';
    expect(lines[3]).toBe(`@implementation${' '.repeat(head.indexOf('CaptureView') - '@implementation'.length)}CaptureView${' '.repeat(', RCTEventEmitter)'.length)}`);
    expect(lines[3]!.indexOf('CaptureView')).toBe(head.indexOf('CaptureView'));
  });

  it('blanks each bodiless macro under it, with its own `;`, and nothing else', () => {
    const out = rewriteRctExternShims(MODULE_SHIM);
    const before = MODULE_SHIM.split('\n');
    const after = out.split('\n');
    expect(after).toHaveLength(before.length);
    // The macro lines, one of them over three lines and one ended with `;`.
    for (const i of [5, 6, 7, 8, 9, 10]) expect(after[i], `line ${i + 1}`).toBe(blank(before[i]!));
    // The imports, the method and `@end` are as written.
    for (const i of [0, 1, 2, 4, 11, 12, 13, 14, 15, 16, 17]) expect(after[i], `line ${i + 1}`).toBe(before[i]);
  });

  it('names the native class of a remapped module, its second argument, and blanks view properties too', () => {
    const out = rewriteRctExternShims(VIEW_MANAGER_SHIM);
    const before = VIEW_MANAGER_SHIM.split('\n');
    const after = out.split('\n');
    expect(after[2]!.trim().split(/\s+/)).toEqual(['@implementation', 'CameraViewManager']);
    expect(after[2]!.indexOf('CameraViewManager')).toBe(before[2]!.indexOf('CameraViewManager'));
    for (const i of [5, 8, 9, 10, 12]) expect(after[i], `line ${i + 1}`).toBe(blank(before[i]!));
    // Comments stay: they are what documents the lines under them.
    expect(after[4]).toBe('// Module Functions');
    expect(after[7]).toBe('// Camera View Properties');
    expect(after[14]).toBe('@end');
  });

  for (const [what, source] of [
    ['a module shim', MODULE_SHIM],
    ['a view manager shim', VIEW_MANAGER_SHIM],
    ['two shims and an ordinary implementation', `${MODULE_SHIM}\n${VIEW_MANAGER_SHIM}\n@implementation Other\nRCT_EXPORT_MODULE()\nRCT_EXPORT_VIEW_PROPERTY(color, UIColor)\n- (void)run { }\n@end\n`],
  ] as const) {
    for (const crlf of [false, true]) {
      it(`keeps the length and every line end: ${what}${crlf ? ' (CRLF)' : ''}`, () => {
        const text = crlf ? source.replace(/\n/g, '\r\n') : source;
        const out = rewriteRctExternShims(text);
        expect(out).not.toBe(text);
        expect(out).toHaveLength(text.length);
        for (let i = 0; i < text.length; i++) {
          const c = text[i]!;
          if (c === '\n' || c === '\r') expect(out[i], `offset ${i}`).toBe(c);
        }
        expect(out).not.toContain('RCT_EXTERN_');
      });
    }
  }

  it('leaves alone what follows the shim, an ordinary implementation and its macros', () => {
    const ordinary = '@implementation Other\nRCT_EXPORT_MODULE()\nRCT_EXPORT_VIEW_PROPERTY(color, UIColor)\nRCT_EXTERN_METHOD(odd)\n- (void)run { }\n@end\n';
    const out = rewriteRctExternShims(`${MODULE_SHIM}\n${ordinary}`);
    expect(out.endsWith(ordinary)).toBe(true);
  });

  it('leaves a macro that has a body, and reads on to the `@end` after it', () => {
    const source = '@interface RCT_EXTERN_MODULE(Box, RCTViewManager)\nRCT_CUSTOM_VIEW_PROPERTY(color, UIColor, BoxView)\n{\n  view.color = json;\n}\nRCT_EXTERN_METHOD(open)\n@end\n';
    const after = rewriteRctExternShims(source).split('\n');
    expect(after[1]).toBe('RCT_CUSTOM_VIEW_PROPERTY(color, UIColor, BoxView)');
    expect(after[5]).toBe(blank('RCT_EXTERN_METHOD(open)'));
    expect(after[6]).toBe('@end');
  });

  it('leaves a macro written inside a method: it is that method\'s code', () => {
    const source = [
      '@interface RCT_EXTERN_MODULE(Timer, NSObject)',
      'RCT_EXTERN_METHOD(tick)',
      '- (NSNumber *)elapsed',
      '{',
      '  RCT_PROFILE_BEGIN_EVENT(0, @"elapsed", nil);',
      '  return RCT_IS_READY(self) ? @1 : @0;',
      '}',
      'RCT_EXTERN_METHOD(tock)',
      '@end',
      '',
    ].join('\n');
    const before = source.split('\n');
    const after = rewriteRctExternShims(source).split('\n');
    for (const i of [2, 3, 4, 5, 6, 8]) expect(after[i], `line ${i + 1}`).toBe(before[i]);
    for (const i of [1, 7]) expect(after[i], `line ${i + 1}`).toBe(blank(before[i]!));
  });

  it('steps over comments and strings: a macro or an `@end` only mentioned is not one', () => {
    const source = [
      '@interface RCT_EXTERN_MODULE(Notes, NSObject)',
      '// RCT_EXTERN_METHOD(old:(NSString *)x) was removed; @end is further down',
      '/* RCT_EXTERN_METHOD(older)',
      '   @end */',
      'RCT_EXTERN_METHOD(current)',
      '- (NSString *)label { return @"RCT_EXTERN_METHOD(text) @end"; }',
      '@end',
      '',
    ].join('\n');
    const before = source.split('\n');
    const after = rewriteRctExternShims(source).split('\n');
    for (const i of [1, 2, 3, 5, 6]) expect(after[i], `line ${i + 1}`).toBe(before[i]);
    expect(after[4]).toBe(blank(before[4]!));
  });

  it('returns the source itself when there is no shim to rewrite', () => {
    for (const source of [
      '',
      '@interface Plain : NSObject\n- (void)run;\n@end\n',
      // The macros with no extern module around them.
      '@implementation Plain\nRCT_EXPORT_MODULE()\nRCT_EXTERN_METHOD(odd)\n- (void)run { }\n@end\n',
      // Only mentioned.
      '// @interface RCT_EXTERN_MODULE(Foo, NSObject)\n@interface Foo : NSObject\n@end\n',
      '/* @interface RCT_EXTERN_MODULE(Foo, NSObject)\nRCT_EXTERN_METHOD(x)\n@end */\n',
      'NSString *doc = @"@interface RCT_EXTERN_MODULE(Foo, NSObject) @end";\n',
      // Not closed, not named, or with a macro that does not close.
      '@interface RCT_EXTERN_MODULE(Foo, NSObject)\nRCT_EXTERN_METHOD(x)\n',
      '@interface RCT_EXTERN_MODULE()\nRCT_EXTERN_METHOD(x)\n@end\n',
      '@interface RCT_EXTERN_MODULE(1Foo, NSObject)\n@end\n',
      '@interface RCT_EXTERN_REMAP_MODULE(OnlyOne)\n@end\n',
      '@interface RCT_EXTERN_MODULE(Foo, NSObject)\nRCT_EXTERN_METHOD(x:(NSString *)y\n@end\n',
      '@interface RCT_EXTERN_MODULE(Foo, NSObject\n@end\n',
    ]) {
      expect(rewriteRctExternShims(source), JSON.stringify(source)).toBe(source);
    }
  });

  it('reads a head written over two lines, and a remapped module with no JavaScript name', () => {
    const twoLines = '@interface RCT_EXTERN_MODULE(Wide,\n                             NSObject)\nRCT_EXTERN_METHOD(go)\n@end\n';
    const rewritten = rewriteRctExternShims(twoLines).split('\n');
    expect(rewritten.map((l) => l.trim().replace(/\s+/g, ' '))).toEqual(['@implementation Wide', '', '', '@end', '']);
    expect(rewritten[0]!.indexOf('Wide')).toBe(twoLines.indexOf('Wide'));
    expect(rewritten.map((l) => l.length)).toEqual(twoLines.split('\n').map((l) => l.length));
    const unnamed = '@interface RCT_EXTERN_REMAP_MODULE(, Inner, NSObject)\n@end\n';
    expect(rewriteRctExternShims(unnamed).split('\n')[0]!.trim().split(/\s+/)).toEqual(['@implementation', 'Inner']);
  });

  it('takes the time of the file, not of its square', () => {
    const big = `@interface RCT_EXTERN_MODULE(Big, NSObject)\n${Array.from({ length: 120_000 }, (_, i) => `RCT_EXTERN_METHOD(thing${i}:(NSString *)name)\n`).join('')}@end\n`;
    const started = Date.now();
    const out = rewriteRctExternShims(big);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(out).toHaveLength(big.length);
    expect(out.split('\n').slice(1, -2).every((line) => line.trim() === '')).toBe(true);
  });
});

describe('what the extractor reads from an extern shim', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['objc']);
  });

  const read = (file: string, source: string): { nodes: string[]; calls: string[] } => {
    const result = extractFromSource(file, source, 'objc');
    return {
      nodes: result.nodes
        .filter((n) => n.kind !== 'file' && n.kind !== 'import')
        .map((n) => `${n.kind} ${n.qualifiedName} ${n.startLine}-${n.endLine}${n.isStatic ? ' static' : ''}`),
      calls: result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => `${r.referenceName} line ${r.line}`),
    };
  };

  for (const crlf of [false, true]) {
    const eol = (s: string): string => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`the class by its own name, and the method under the macros on its own lines${label}`, () => {
      expect(read('CaptureView.m', eol(MODULE_SHIM)).nodes).toEqual([
        'class CaptureView 4-18',
        'method CaptureView::requiresMainQueueSetup 13-16 static',
      ]);
    });

    it(`the native class of a view manager's shim, and nothing for its macros${label}`, () => {
      expect(read('CameraViewManager.m', eol(VIEW_MANAGER_SHIM)).nodes).toEqual(['class CameraViewManager 3-15']);
    });
  }

  it('every method written in the shim, with what its body calls', () => {
    const source = [
      '#import "React/RCTEventEmitter.h"',
      '',
      'static NSString *const kEvent = @"onCount";',
      '',
      '@interface RCT_EXTERN_MODULE(Counter, RCTEventEmitter)',
      'RCT_EXTERN_METHOD(increment)',
      'RCT_EXTERN_METHOD(decrement:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject)',
      '- (dispatch_queue_t)methodQueue',
      '{',
      '  return dispatch_get_main_queue();',
      '}',
      '+ (BOOL)requiresMainQueueSetup',
      '{',
      '  return YES;',
      '}',
      '- (NSDictionary *)constantsToExport',
      '{',
      '  return @{ @"event": kEvent };',
      '}',
      '@end',
      '',
      '@interface Helper : NSObject',
      '- (void)help;',
      '@end',
      '',
      '@implementation Helper',
      '- (void)help { NSLog(@"x"); }',
      '@end',
      '',
    ].join('\n');
    const { nodes, calls } = read('Counter.m', source);
    expect(nodes).toEqual([
      'variable kEvent 3-3',
      'class Counter 5-20',
      'method Counter::methodQueue 8-11',
      'method Counter::requiresMainQueueSetup 12-15 static',
      'method Counter::constantsToExport 16-19',
      'class Helper 22-24',
      'method Helper::help 27-27',
    ]);
    expect(calls).toEqual(['dispatch_get_main_queue line 10', 'NSLog line 27']);
  });

  it('each of two shims in one file', () => {
    const source = '@interface RCT_EXTERN_MODULE(First, NSObject)\nRCT_EXTERN_METHOD(one)\n@end\n\n@interface RCT_EXTERN_MODULE(Second, NSObject)\nRCT_EXTERN_METHOD(two:(NSString *)x)\n+ (BOOL)requiresMainQueueSetup { return NO; }\n@end\n';
    expect(read('Both.m', source).nodes).toEqual(['class First 1-3', 'class Second 5-8', 'method Second::requiresMainQueueSetup 7-7 static']);
  });

  it('no class named for the macro, in a `.mm` file as in a `.m` one', () => {
    for (const file of ['Shim.m', 'Shim.mm']) {
      const names = extractFromSource(file, MODULE_SHIM, 'objc').nodes.map((n) => n.name);
      expect(names, file).toContain('CaptureView');
      expect(names.filter((name) => name.startsWith('RCT_')), file).toEqual([]);
    }
  });
});

describe('a Swift module behind an extern shim, indexed', () => {
  let dir: string;
  let cg: CodeGraph | null = null;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-rn-extern-'));
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function index(files: Record<string, string>): Promise<void> {
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(dir, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    cg = await CodeGraph.init(dir);
    const result = await cg.indexAll();
    expect(result.errors ?? []).toEqual([]);
  }

  const inFile = (file: string, name: string): Node[] => cg!.getNodesInFile(file).filter((n) => n.name === name);
  const callersOf = (node: Node): string[] =>
    cg!.getIncomingEdges(node.id)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg!.getNode(e.source)?.name ?? '?')
      .sort();

  it('JavaScript still reaches the Swift methods the shim exposes, by their own and by remapped names', async () => {
    await index({
      'package.json': '{"name":"app","dependencies":{"react-native":"^0.74.0"}}\n',
      'ios/CaptureView.swift': [
        'import Foundation',
        '',
        '@objc(CaptureView)',
        'class CaptureView: RCTEventEmitter {',
        '  @objc func start(_ name: String, resolver resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {',
        '  }',
        '',
        '  @objc func stop() {',
        '  }',
        '}',
        '',
      ].join('\n'),
      'ios/CaptureView.m': MODULE_SHIM,
      'ios/RNTrackPlayer.swift': [
        'import Foundation',
        '',
        '@objc(RNTrackPlayer)',
        'public class RNTrackPlayer: NSObject {',
        '  @objc func begin(_ resolve: RCTPromiseResolveBlock, rejecter reject: RCTPromiseRejectBlock) {',
        '  }',
        '}',
        '',
      ].join('\n'),
      'ios/RNTrackPlayerBridge.m': [
        '#import <React/RCTBridgeModule.h>',
        '',
        '@interface RCT_EXTERN_REMAP_MODULE(TrackPlayerModule, RNTrackPlayer, NSObject)',
        'RCT_EXTERN_REMAP_METHOD(play, begin:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject);',
        '+ (BOOL)requiresMainQueueSetup { return YES; }',
        '@end',
        '',
      ].join('\n'),
      'src/use.ts': [
        "import { NativeModules } from 'react-native';",
        '',
        'export async function capture() {',
        "  await NativeModules.CaptureView.start('x');",
        '  NativeModules.CaptureView.stop();',
        '}',
        '',
        'export function play() {',
        '  NativeModules.TrackPlayerModule.play();',
        '}',
        '',
      ].join('\n'),
    });

    // The calls arrive at Swift: the bridge reads the shim as it is written.
    expect(callersOf(inFile('ios/CaptureView.swift', 'start')[0]!)).toEqual(['capture']);
    expect(callersOf(inFile('ios/CaptureView.swift', 'stop')[0]!)).toEqual(['capture']);
    expect(callersOf(inFile('ios/RNTrackPlayer.swift', 'begin')[0]!)).toEqual(['play']);

    // The shims hold the class by its name and the method written in them.
    expect(inFile('ios/CaptureView.m', 'CaptureView').map((n) => n.kind)).toEqual(['class']);
    expect(inFile('ios/CaptureView.m', 'requiresMainQueueSetup').map((n) => [n.kind, n.startLine])).toEqual([['method', 13]]);
    expect(inFile('ios/RNTrackPlayerBridge.m', 'RNTrackPlayer').map((n) => n.kind)).toEqual(['class']);
    expect(inFile('ios/RNTrackPlayerBridge.m', 'requiresMainQueueSetup').map((n) => [n.kind, n.startLine])).toEqual([['method', 5]]);
    for (const file of ['ios/CaptureView.m', 'ios/RNTrackPlayerBridge.m']) {
      expect(cg!.getNodesInFile(file).filter((n) => n.name.startsWith('RCT_')), file).toEqual([]);
    }
  });
});
