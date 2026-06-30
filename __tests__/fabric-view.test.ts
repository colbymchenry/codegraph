import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { fabricViewResolver } from '../src/resolution/frameworks/fabric';

describe('Fabric view component extractor (codegenNativeComponent specs)', () => {
  it('extracts a component node + prop nodes from a Native*.ts spec', () => {
    const source = `
'use client';
import { codegenNativeComponent } from 'react-native';
import type { ViewProps, CodegenTypes as CT, ColorValue } from 'react-native';

type TapEvent = Readonly<{ x: number; y: number }>;

export interface NativeProps extends ViewProps {
  color?: ColorValue;
  onTap?: CT.DirectEventHandler<TapEvent>;
  caption?: string;
}

export default codegenNativeComponent<NativeProps>('MyView', {});
`;
    const result = fabricViewResolver.extract?.('src/MyViewNativeComponent.ts', source);
    expect(result).toBeDefined();
    const componentNodes = result!.nodes.filter((n) => n.kind === 'component');
    const propNodes = result!.nodes.filter((n) => n.kind === 'property');
    expect(componentNodes).toHaveLength(1);
    expect(componentNodes[0]?.name).toBe('MyView');
    expect(propNodes.map((n) => n.name).sort()).toEqual(['caption', 'color', 'onTap']);
  });

  it('returns nothing for a file without codegenNativeComponent', () => {
    const source = `export const x = 1;`;
    const result = fabricViewResolver.extract?.('plain.ts', source);
    expect(result?.nodes).toHaveLength(0);
  });

  it('handles a spec with no NativeProps interface (rare but valid)', () => {
    const source = `
import { codegenNativeComponent } from 'react-native';
export default codegenNativeComponent('BareComponent');
`;
    const result = fabricViewResolver.extract?.('Bare.ts', source);
    // Component node exists; no prop nodes.
    const components = result!.nodes.filter((n) => n.kind === 'component');
    const props = result!.nodes.filter((n) => n.kind === 'property');
    expect(components).toHaveLength(1);
    expect(components[0]?.name).toBe('BareComponent');
    expect(props).toHaveLength(0);
  });
});

describe('Fabric end-to-end: JSX consumer → Fabric component → native class', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fabric-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('connects <MyView/> JSX to the native ObjC class via Fabric synthesizer', async () => {
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"react-native":"^0.73"}}'
    );
    // Fabric spec.
    fs.mkdirSync(path.join(dir, 'spec'));
    fs.writeFileSync(
      path.join(dir, 'spec', 'MyViewNativeComponent.ts'),
      `import { codegenNativeComponent } from 'react-native';
import type { ViewProps } from 'react-native';
export interface NativeProps extends ViewProps { color?: string; }
export default codegenNativeComponent<NativeProps>('MyView');`
    );
    // Native iOS implementation — class named with the `View` suffix
    // convention.
    fs.mkdirSync(path.join(dir, 'ios'));
    fs.writeFileSync(
      path.join(dir, 'ios', 'MyView.mm'),
      `@interface MyViewView : UIView
@end
@implementation MyViewView
- (void)setColor:(NSString *)c { /* … */ }
@end`
    );
    // JSX consumer.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'App.tsx'),
      `import React from 'react';
import MyView from '../spec/MyViewNativeComponent';
export function App() {
  return <MyView color="red"/>;
}`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    // 1. The Fabric component node exists.
    const componentRows = db
      .prepare("SELECT id, name, kind FROM nodes WHERE id LIKE 'fabric-component:%' AND name='MyView'")
      .all();
    expect(componentRows).toHaveLength(1);

    // 2. The native class node exists.
    const nativeRows = db
      .prepare("SELECT id, name FROM nodes WHERE kind='class' AND language='objc' AND name='MyViewView'")
      .all();
    expect(nativeRows).toHaveLength(1);

    // 3. Fabric synthesizer bridges component → native class.
    const bridgeRows = db
      .prepare(
        `SELECT s.name comp, t.name native FROM edges e
         JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy')='fabric-native-impl'
           AND s.name='MyView' AND t.name='MyViewView'`
      )
      .all();
    expect(bridgeRows).toHaveLength(1);

    // 4. JSX synthesizer links the App function → the Fabric component
    //    (jsx-render edge keyed on the tag name 'MyView').
    const jsxRows = db
      .prepare(
        `SELECT s.name caller, t.name comp FROM edges e
         JOIN nodes s ON s.id=e.source JOIN nodes t ON t.id=e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy')='jsx-render'
           AND t.id LIKE 'fabric-component:%' AND t.name='MyView'`
      )
      .all();
    cg.close?.();
    expect(jsxRows.length).toBeGreaterThanOrEqual(1);
    expect(jsxRows[0].caller).toBe('App');
    // The full flow: App (TSX) → MyView (fabric-component) → MyViewView (ObjC native class)
  });
});
