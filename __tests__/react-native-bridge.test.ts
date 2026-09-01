import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Node, Language } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { reactNativeBridgeResolver } from '../src/resolution/frameworks/react-native';
import { CodeGraph } from '../src';

/**
 * Mock ResolutionContext for the React Native bridge resolver.
 */
function makeContext(nodes: Node[], fileContents: Record<string, string> = {}): ResolutionContext {
  const byName = new Map<string, Node[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  // Files = union of node files + any extra fileContents keys (for files that
  // have content like .mm bridge declarations but no extracted nodes yet).
  const allFiles = new Set<string>(
    [...nodes.map((n) => n.filePath), ...Object.keys(fileContents)]
  );
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => { throw new Error('not used'); },
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: () => { throw new Error('not used'); },
    fileExists: (fp) => allFiles.has(fp),
    readFile: (fp) => fileContents[fp] ?? null,
    getProjectRoot: () => '/test',
    getAllFiles: () => Array.from(allFiles),
    getImportMappings: () => [],
  };
}

function method(
  name: string,
  language: Language,
  filePath: string,
  startLine = 10
): Node {
  return {
    id: `${language}:${filePath}:${name}:${startLine}`,
    kind: 'method',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine,
    endLine: startLine + 5,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

function ref(name: string, language: Language, filePath: string): UnresolvedRef {
  return {
    fromNodeId: `caller:${filePath}`,
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath,
    language,
  };
}

describe('React Native bridge resolver', () => {
  describe('detect()', () => {
    it('returns true when package.json declares react-native', () => {
      const ctx = makeContext([], {
        'package.json':
          '{"name":"x","dependencies":{"react-native":"^0.73.0"}}',
      });
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns true when an ObjC file uses RCT_EXPORT_MODULE', () => {
      const ctx = makeContext([], {
        'NativeFoo.mm': '@implementation Foo\nRCT_EXPORT_MODULE()\n@end',
      });
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns true when a TS file uses TurboModuleRegistry', () => {
      const ctx = makeContext([], {
        'NativeFoo.ts':
          "import { TurboModuleRegistry } from 'react-native';\n" +
          "export default TurboModuleRegistry.getEnforcing<Spec>('Foo');",
      });
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(true);
    });

    it('returns false when none of the RN signals are present', () => {
      const ctx = makeContext([method('hi', 'objc', 'X.m')]);
      expect(reactNativeBridgeResolver.detect(ctx)).toBe(false);
    });
  });

  describe('legacy bridge — ObjC side', () => {
    it('resolves JS callsite via RCT_EXPORT_METHOD with default module name', () => {
      // RCTGeolocation → module name 'Geolocation' (RCT prefix stripped).
      const native = method('getCurrentPosition:', 'objc', 'RCTGeolocation.m');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'RCTGeolocation.m':
          '@implementation RCTGeolocation\n' +
          'RCT_EXPORT_MODULE()\n' +
          'RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb) {}\n' +
          '@end',
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('getCurrentPosition', 'javascript', 'App.js'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
      expect(result?.resolvedBy).toBe('framework');
    });

    it('resolves via explicit module name in RCT_EXPORT_MODULE(name)', () => {
      const native = method('startScan:', 'objc', 'Bluetooth.m');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'Bluetooth.m':
          '@implementation BluetoothImpl\n' +
          'RCT_EXPORT_MODULE(BluetoothManager)\n' +
          'RCT_EXPORT_METHOD(startScan:(RCTResponseSenderBlock)cb) {}\n' +
          '@end',
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('startScan', 'javascript', 'App.js'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
    });

    it('resolves RCT_REMAP_METHOD with JS-name override', () => {
      const native = method('doInternalCompute:', 'objc', 'Computer.m');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'Computer.m':
          '@implementation Computer\n' +
          'RCT_EXPORT_MODULE()\n' +
          'RCT_REMAP_METHOD(compute, doInternalCompute:(NSDictionary *)opts) {}\n' +
          '@end',
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('compute', 'javascript', 'App.js'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
    });
  });

  describe('legacy bridge — Java side', () => {
    it('resolves @ReactMethod with getName() literal', () => {
      const native = method('getCurrentPosition', 'java', 'GeolocationModule.java');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'GeolocationModule.java':
          'class GeolocationModule extends ReactContextBaseJavaModule {\n' +
          '  @Override public String getName() { return "Geolocation"; }\n' +
          '  @ReactMethod public void getCurrentPosition(Callback cb) {}\n' +
          '}',
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('getCurrentPosition', 'javascript', 'App.js'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
    });

    it('resolves Kotlin @ReactMethod fun', () => {
      const native = method('startScan', 'kotlin', 'BluetoothModule.kt');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'BluetoothModule.kt':
          'class BluetoothModule(ctx: ReactApplicationContext) : ReactContextBaseJavaModule(ctx) {\n' +
          '  override fun getName(): String = "BluetoothManager"\n' +
          '  @ReactMethod fun startScan(cb: Callback) {}\n' +
          '}',
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('startScan', 'javascript', 'App.js'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
    });
  });

  describe('TurboModule spec resolution', () => {
    it('matches spec method to native ObjC implementation by name', () => {
      // The Spec interface lists `getTotalLength`; ObjC has a method by the
      // same first keyword. Bridge matches by name.
      const native = method('getTotalLength:', 'objc', 'RNSVGRenderableManager.mm');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'NativeSvgRenderableModule.ts':
          "import { TurboModuleRegistry } from 'react-native';\n" +
          'export interface Spec extends TurboModule {\n' +
          '  getTotalLength(tag: number): number;\n' +
          '  isPointInFill(tag: number, options?: object): boolean;\n' +
          '}\n' +
          "export default TurboModuleRegistry.getEnforcing<Spec>('RNSVGRenderableModule');",
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('getTotalLength', 'tsx', 'SvgComponent.tsx'),
        ctx
      );
      expect(result?.targetNodeId).toBe(native.id);
    });

    it('returns null when spec method has no matching native impl', () => {
      const ctx = makeContext([], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'NativeFoo.ts':
          "import { TurboModuleRegistry } from 'react-native';\n" +
          'export interface Spec extends TurboModule {\n' +
          '  thingThatDoesntExist(): void;\n' +
          '}\n' +
          "export default TurboModuleRegistry.getEnforcing<Spec>('Foo');",
      });
      const result = reactNativeBridgeResolver.resolve(
        ref('thingThatDoesntExist', 'tsx', 'Caller.tsx'),
        ctx
      );
      expect(result).toBeNull();
    });
  });

  describe('qualified vs bare callsite names', () => {
    it('handles bare method name (post receiver-strip)', () => {
      const native = method('compute:', 'objc', 'Mod.m');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'Mod.m':
          '@implementation Mod\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(compute:(NSDictionary *)x) {}\n@end',
      });
      expect(
        reactNativeBridgeResolver.resolve(ref('compute', 'javascript', 'App.js'), ctx)
      ).not.toBeNull();
    });

    it('strips dot prefix on receiver-qualified callsite (NativeModules.Mod.compute → compute)', () => {
      const native = method('compute:', 'objc', 'Mod.m');
      const ctx = makeContext([native], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'Mod.m':
          '@implementation Mod\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(compute:(NSDictionary *)x) {}\n@end',
      });
      expect(
        reactNativeBridgeResolver.resolve(
          ref('NativeModules.Mod.compute', 'javascript', 'App.js'),
          ctx
        )
      ).not.toBeNull();
    });
  });

  it('does not resolve native-language callers (resolver is JS-side only)', () => {
    const native = method('compute:', 'objc', 'Mod.m');
    const ctx = makeContext([native]);
    expect(
      reactNativeBridgeResolver.resolve(ref('compute', 'objc', 'OtherMod.m'), ctx)
    ).toBeNull();
  });

  describe('RCTEventEmitter built-ins blocklist', () => {
    it('skips addListener / remove (every emitter exposes these — bridging them creates noise)', () => {
      // A repo with RCTEventEmitter subclass: defines `addListener:` and
      // `remove:` because that's what `[RCTEventEmitter addListener:]`
      // requires. JS callers of `.addListener(...)` should NOT resolve
      // here — they're hitting the JS-side `NativeEventEmitter`
      // abstraction, not the native emitter directly.
      const native1 = method('addListener:', 'objc', 'EventEmitter.m');
      const native2 = method('remove:', 'objc', 'EventEmitter.m');
      const ctx = makeContext([native1, native2], {
        'package.json': '{"dependencies":{"react-native":"^0.73"}}',
        'EventEmitter.m':
          '@implementation EventEmitter\n' +
          'RCT_EXPORT_MODULE()\n' +
          'RCT_EXPORT_METHOD(addListener:(NSString *)eventName) {}\n' +
          'RCT_EXPORT_METHOD(remove:(double)id) {}\n' +
          '@end',
      });
      expect(
        reactNativeBridgeResolver.resolve(ref('addListener', 'javascript', 'App.js'), ctx)
      ).toBeNull();
      expect(
        reactNativeBridgeResolver.resolve(ref('remove', 'typescript', 'App.ts'), ctx)
      ).toBeNull();
    });
  });
});

describe('React Native cross-platform pairing — end to end', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-xplat-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('links the Android (@ReactMethod) and iOS (RCT_EXPORT_METHOD) impls of a JS-called method', async () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"dependencies":{"react-native":"^0.74.0"}}');
    fs.writeFileSync(path.join(dir, 'index.ts'),
      "import { NativeModules } from 'react-native';\n" +
      "export function ping() { return NativeModules.RNThing.uniquePingMethod(); }\n");
    fs.writeFileSync(path.join(dir, 'RNThing.java'),
      "public class RNThing extends ReactContextBaseJavaModule {\n" +
      "  @Override public String getName() { return \"RNThing\"; }\n" +
      "  @ReactMethod public void uniquePingMethod(Callback cb) {}\n}\n");
    fs.writeFileSync(path.join(dir, 'RNThing.m'),
      "@implementation RNThing\n" +
      "RCT_EXPORT_MODULE()\n" +
      "RCT_EXPORT_METHOD(uniquePingMethod:(RCTResponseSenderBlock)cb) {}\n@end\n");

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The iOS `RCT_EXPORT_METHOD` is extracted as an ObjC method node (the macro
    // parses as a macro-expression, not a method, so it had no node before).
    const objc = db.prepare(
      "SELECT * FROM nodes WHERE name='uniquePingMethod' AND language='objc' AND id LIKE 'rn-export:%'"
    ).all();
    expect(objc).toHaveLength(1);

    // The Java and ObjC impls of `uniquePingMethod` are linked to each other, so
    // a JS call that resolves to one platform reaches the other.
    const pair = db.prepare(
      `SELECT count(*) c FROM edges e
       JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
       WHERE json_extract(e.metadata,'$.synthesizedBy')='rn-cross-platform'
         AND s.name LIKE 'uniquePingMethod%' AND t.name LIKE 'uniquePingMethod%'
         AND s.language != t.language`
    ).get();
    cg.close?.();
    expect(pair.c).toBeGreaterThanOrEqual(2); // java<->objc both directions
  });
});

// =============================================================================
// Swift modules via RCT_EXTERN_MODULE, and receiver evidence
// =============================================================================

import { parseObjcRNExterns, collectNativeModuleAliases } from '../src/resolution/frameworks/react-native';

function swiftMethod(name: string, owner: string, filePath: string, startLine: number): Node {
  return {
    id: `swift:${filePath}:${name}:${startLine}`,
    kind: 'method',
    name,
    qualifiedName: `${owner}::${name}`,
    filePath,
    language: 'swift',
    startLine,
    endLine: startLine + 4,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  } as Node;
}

const SHIM = `
#import <React/RCTBridgeModule.h>
#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(CaptureView, RCTViewManager)

RCT_EXTERN_METHOD(syncSettings:(NSDictionary *)settings)
RCT_EXTERN_METHOD(finalizeCaptureSession)
RCT_EXTERN_REMAP_METHOD(pause, pauseInferenceNow)

@end
`;

describe('React Native bridge resolver — RCT_EXTERN (Swift) modules', () => {
  const finalize = swiftMethod('finalizeCaptureSession', 'CaptureView', 'ios/CaptureView+ReactBridge.swift', 26);
  const sync = swiftMethod('syncSettings', 'CaptureView', 'ios/CaptureView.swift', 40);
  const pause = swiftMethod('pauseInferenceNow', 'CaptureView', 'ios/CaptureView.swift', 60);
  // Same method name on another Swift type — never the bridge target.
  const decoy = swiftMethod('syncSettings', 'CaptureSettings', 'ios/CaptureSettings.swift', 12);

  const files = {
    'package.json': '{"name":"app","dependencies":{"react-native":"0.76"}}',
    'ios/CaptureView.m': SHIM,
    'src/components/capture/capture-view.tsx':
      "import { NativeModules, NativeEventEmitter } from 'react-native'\n" +
      'export const { CaptureEvents } = NativeModules\n' +
      'export const captureView = NativeModules.CaptureView\n',
  };
  const ctx = makeContext([finalize, sync, pause, decoy], files);

  it('parses the shim: module, class, first keyword, remap', () => {
    expect(parseObjcRNExterns(SHIM).map((e) => [e.moduleName, e.className, e.jsName, e.nativeSelectorFirstKw])).toEqual([
      ['CaptureView', 'CaptureView', 'syncSettings', 'syncSettings'],
      ['CaptureView', 'CaptureView', 'finalizeCaptureSession', 'finalizeCaptureSession'],
      ['CaptureView', 'CaptureView', 'pause', 'pauseInferenceNow'],
    ]);
    const remapped = parseObjcRNExterns('@interface RCT_EXTERN_REMAP_MODULE(Camera, CameraModule, NSObject)\nRCT_EXTERN_METHOD(snap)');
    expect(remapped).toEqual([
      { moduleName: 'Camera', className: 'CameraModule', jsName: 'snap', nativeSelectorFirstKw: 'snap', line: 2 },
    ]);
  });

  it('collects the local names bound to NativeModules', () => {
    const aliases = new Map<string, string>();
    const ambiguous = new Set<string>();
    collectNativeModuleAliases(
      'const captureView = NativeModules.CaptureView\n' +
        'export const { CaptureEvents, Geo: geolocation } = NativeModules\n' +
        'let typed: Spec = NativeModules.Typed\n',
      aliases,
      ambiguous
    );
    // Direct bindings first (one pass), then the destructured ones.
    expect([...aliases]).toEqual([
      ['captureView', 'CaptureView'],
      ['typed', 'Typed'],
      ['CaptureEvents', 'CaptureEvents'],
      ['geolocation', 'Geo'],
    ]);
    // The same name bound to two modules is dropped, not guessed.
    collectNativeModuleAliases('const captureView = NativeModules.Other', aliases, ambiguous);
    expect(aliases.has('captureView')).toBe(false);
    expect(ambiguous.has('captureView')).toBe(true);
  });

  it('detects a project from the RCT_EXTERN_MODULE marker alone', () => {
    expect(reactNativeBridgeResolver.detect(makeContext([], { 'ios/CaptureView.m': SHIM }))).toBe(true);
  });

  it('resolves an aliased receiver to the Swift method of the named class at 0.95', () => {
    const r = reactNativeBridgeResolver.resolve(
      ref('captureView.finalizeCaptureSession', 'tsx', 'src/hooks/use-review-handlers.ts'),
      ctx
    );
    expect(r?.targetNodeId).toBe(finalize.id);
    expect(r?.confidence).toBe(0.95);
    expect(r?.metadata).toEqual({ bridge: 'react-native', module: 'CaptureView' });
  });

  it('resolves NativeModules.Module.method the same way, class-scoped past a same-named decoy', () => {
    const r = reactNativeBridgeResolver.resolve(ref('NativeModules.CaptureView.syncSettings', 'tsx', 'src/a.tsx'), ctx);
    expect(r?.targetNodeId).toBe(sync.id);
    expect(r?.confidence).toBe(0.95);
  });

  it('follows RCT_EXTERN_REMAP_METHOD to the Swift implementation under the JS name', () => {
    const r = reactNativeBridgeResolver.resolve(ref('captureView.pause', 'tsx', 'src/a.tsx'), ctx);
    expect(r?.targetNodeId).toBe(pause.id);
  });

  it('keeps a bare method name at the by-name confidence, and refuses a named module that lacks the method', () => {
    const bare = reactNativeBridgeResolver.resolve(ref('syncSettings', 'tsx', 'src/a.tsx'), ctx);
    expect(bare?.targetNodeId).toBe(sync.id);
    expect(bare?.confidence).toBe(0.6);
    expect(reactNativeBridgeResolver.resolve(ref('captureView.nothingHere', 'tsx', 'src/a.tsx'), ctx)).toBeNull();
    // A receiver that is NOT a module alias falls back to by-name evidence.
    const other = reactNativeBridgeResolver.resolve(ref('somethingElse.syncSettings', 'tsx', 'src/a.tsx'), ctx);
    expect(other?.confidence).toBe(0.6);
  });

  it('never redirects a native caller', () => {
    expect(reactNativeBridgeResolver.resolve(ref('captureView.finalizeCaptureSession', 'swift', 'ios/x.swift'), ctx)).toBeNull();
  });
});
