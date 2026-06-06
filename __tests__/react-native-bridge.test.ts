import { describe, it, expect } from 'vitest';
import type { Node, Language } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import { reactNativeBridgeResolver } from '../src/resolution/frameworks/react-native';

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
