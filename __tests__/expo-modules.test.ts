import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { expoModulesResolver } from '../src/resolution/frameworks/expo-modules';

describe('Expo Modules framework extractor', () => {
  it('extracts AsyncFunction / Function / Property literals as method nodes', () => {
    const source = `
import ExpoModulesCore

public class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")

    AsyncFunction("notificationAsync") { (notificationType: NotificationType) in
      // body
    }

    AsyncFunction("impactAsync") { (style: ImpactStyle) in
      // body
    }

    Function("synchronousThing") {
      return 1
    }

    Property("isAvailable") {
      return true
    }
  }
}
`;
    const result = expoModulesResolver.extract?.('ios/HapticsModule.swift', source);
    expect(result).toBeDefined();
    const names = result!.nodes.map((n) => n.name);
    expect(names).toEqual(
      expect.arrayContaining(['notificationAsync', 'impactAsync', 'synchronousThing', 'isAvailable'])
    );
    expect(result!.nodes.every((n) => n.kind === 'method')).toBe(true);
    expect(result!.nodes.every((n) => n.qualifiedName.includes('ExpoHaptics.'))).toBe(true);
  });

  it('falls back to the class name when the Module has no Name("X") literal', () => {
    const source = `
public class BareModule: Module {
  public func definition() -> ModuleDefinition {
    Function("doX") { return 1 }
  }
}
`;
    const result = expoModulesResolver.extract?.('ios/BareModule.swift', source);
    // BareModule is used as the qualifier since there's no Name() literal.
    expect(result!.nodes[0]?.qualifiedName).toContain('BareModule.doX');
  });

  it('returns no nodes for a Swift file that is not an Expo Module', () => {
    const source = `
class Helper {
  func doX() { }
}
`;
    const result = expoModulesResolver.extract?.('Helper.swift', source);
    expect(result?.nodes).toHaveLength(0);
  });

  it('also extracts from Kotlin module files', () => {
    const source = `
class FooModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("ExpoFoo")
        AsyncFunction("doAsync") { name: String -> name.uppercase() }
        Function("doSync") { 42 }
    }
}
`;
    const result = expoModulesResolver.extract?.('FooModule.kt', source);
    expect(result?.nodes.length).toBe(2);
    expect(result?.nodes.map((n) => n.name).sort()).toEqual(['doAsync', 'doSync']);
    expect(result?.nodes.every((n) => n.language === 'kotlin')).toBe(true);
  });
});

describe('Expo Modules end-to-end — JS caller → native AsyncFunction', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-modules-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('JS callsite of a literal AsyncFunction("name") resolves to the native impl node', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"expo-modules-core":"^1.0.0"}}'
    );
    fs.mkdirSync(path.join(dir, 'ios'));
    fs.writeFileSync(
      path.join(dir, 'ios', 'HapticsModule.swift'),
      `
import ExpoModulesCore
public class HapticsModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoHaptics")
    AsyncFunction("uniqueExpoHapticCall") { in /* … */ }
  }
}
`
    );
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'index.ts'),
      `
import { requireNativeModule } from 'expo-modules-core';
const Haptics = requireNativeModule('ExpoHaptics');
export async function impactAsync() {
  return await Haptics.uniqueExpoHapticCall();
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The native method node should exist.
    const native = db
      .prepare(
        "SELECT * FROM nodes WHERE kind='method' AND name='uniqueExpoHapticCall' AND id LIKE 'expo-module:%'"
      )
      .all();
    expect(native).toHaveLength(1);

    // And the JS callsite should produce a call edge targeting it.
    const callEdge = db
      .prepare(
        `SELECT t.name target, t.id target_id
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'calls'
           AND s.file_path LIKE '%index.ts'
           AND t.name = 'uniqueExpoHapticCall'`
      )
      .all();
    cg.close?.();
    expect(callEdge.length).toBeGreaterThanOrEqual(1);
    expect(callEdge[0].target_id.startsWith('expo-module:')).toBe(true);
  });

  it('extracts GENERIC-typed Kotlin AsyncFunction<T> and pairs the iOS + Android impls', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"expo-modules-core":"^1.0.0"}}'
    );
    fs.mkdirSync(path.join(dir, 'ios'));
    fs.writeFileSync(
      path.join(dir, 'ios', 'BatteryModule.swift'),
      `import ExpoModulesCore
public class BatteryModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoBattery")
    AsyncFunction("getBatteryLevelAsync") { () -> Float in return 1.0 }
  }
}
`
    );
    fs.mkdirSync(path.join(dir, 'android'));
    fs.writeFileSync(
      path.join(dir, 'android', 'BatteryModule.kt'),
      `import expo.modules.kotlin.modules.Module
class BatteryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoBattery")
    AsyncFunction<Float>("getBatteryLevelAsync") { 1.0f }
  }
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // The Android (Kotlin) GENERIC AsyncFunction<Float> is extracted — before the
    // fix the `<Float>` defeated the regex and it was silently dropped.
    const kt = db.prepare(
      "SELECT * FROM nodes WHERE name='getBatteryLevelAsync' AND language='kotlin' AND id LIKE 'expo-module:%'"
    ).all();
    expect(kt).toHaveLength(1);

    // The iOS (Swift) and Android (Kotlin) impls of the same JS method are linked
    // to each other, so a JS call that resolves to one platform reaches the other.
    const pair = db.prepare(
      `SELECT count(*) c FROM edges e
       JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
       WHERE s.name='getBatteryLevelAsync' AND t.name='getBatteryLevelAsync'
         AND s.language != t.language`
    ).get();
    cg.close?.();
    expect(pair.c).toBeGreaterThanOrEqual(2); // swift->kotlin AND kotlin->swift
  });
});

describe('Expo Modules — a JS binding named for its role, not its module', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-modules-binding-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('expo-camera: `CameraManager.fn()` on `export default requireNativeModule<T>("ExpoCamera")` reaches the module’s functions', async () => {
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('package.json', '{"dependencies":{"expo-modules-core":"^1.0.0","expo":"*"}}');
    write('ios/CameraViewModule.swift', `import ExpoModulesCore
public final class CameraViewModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCamera")
    AsyncFunction("launchScanner") { (options: ScannerOptions) in }
    AsyncFunction("dismissScanner") { }
  }
}
`);
    write('android/src/main/java/expo/modules/camera/CameraViewModule.kt', `package expo.modules.camera
class CameraViewModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("ExpoCamera")
    AsyncFunction("launchScanner") { options: ScannerOptions -> }
    AsyncFunction("dismissScanner") { }
  }
}
`);
    write('src/Camera.types.ts', `import { NativeModule } from 'expo';
export declare class CameraNativeModule extends NativeModule {
  readonly isAvailableAsync: () => Promise<boolean>;
}
`);
    write('src/ExpoCameraManager.ts', `import { requireNativeModule } from 'expo';
import type { CameraNativeModule } from './Camera.types';

export default requireNativeModule<CameraNativeModule>('ExpoCamera');
`);
    write('src/CameraView.tsx', `import CameraManager from './ExpoCameraManager';

export default class CameraView {
  static async isAvailableAsync(): Promise<boolean> {
    return CameraManager.isAvailableAsync();
  }
  static async launchScanner(options: object): Promise<void> {
    await CameraManager.launchScanner(options);
  }
}
`);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      const view = cg.getNodesInFile('src/CameraView.tsx');
      const from = (name: string) => view.find((n) => n.name === name && n.kind === 'method')!;
      const callees = (name: string) =>
        cg
          .getOutgoingEdges(from(name).id)
          .filter((e) => e.kind === 'calls')
          .map((e) => cg.getNode(e.target)!)
          .map((n) => `${n.language}:${n.qualifiedName.split('::').pop()}`)
          .sort();
      // Both platforms' `launchScanner`, not CameraView's own.
      expect(callees('launchScanner')).toEqual(['kotlin:ExpoCamera.launchScanner', 'swift:ExpoCamera.launchScanner']);
      // Declared natively nowhere here: the type the binding is given, never the caller itself.
      expect(callees('isAvailableAsync')).toEqual(['typescript:isAvailableAsync']);
      const target = cg.getOutgoingEdges(from('isAvailableAsync').id).find((e) => e.kind === 'calls')!;
      expect(cg.getNode(target.target)!.filePath).toBe('src/Camera.types.ts');
    } finally {
      cg.close();
    }
  });
});
