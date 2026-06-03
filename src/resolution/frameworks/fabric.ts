/**
 * React Native Fabric / Codegen view components — Phase 6 of the
 * mixed-iOS/RN bridging effort.
 *
 * In the new RN architecture, JS-visible view components are declared via
 * Codegen TS spec files of the shape:
 *
 *   // src/fabric/MyComponentNativeComponent.ts
 *   import { codegenNativeComponent } from 'react-native';
 *   import type { ViewProps, CodegenTypes as CT } from 'react-native';
 *
 *   export interface NativeProps extends ViewProps {
 *     color?: ColorValue;
 *     onTap?: CT.DirectEventHandler<TapEvent>;
 *   }
 *
 *   export default codegenNativeComponent<NativeProps>('MyComponent');
 *
 * Codegen then generates a native ComponentDescriptor that wires the JS
 * component name to a native implementation class — by RN convention,
 * one of `MyComponent`, `MyComponentView`, `MyComponentComponentView`,
 * `MyComponentManager`, `MyComponentViewManager`. The actual implementation
 * lives in ObjC++ (.mm) on iOS or Kotlin/Java on Android.
 *
 * Without bridging, JSX `<MyComponent color="red"/>` in a consumer app has
 * nothing in the graph to land on — the JS-visible name `MyComponent` isn't
 * a node anywhere (only `MyComponentView` is, in the .mm), and the JSX
 * synthesizer matches strictly by name.
 *
 * What this extractor does:
 *   1. Parse the spec file's `codegenNativeComponent<Props>('Name', ...)`
 *      literal — emit a `component` node named `Name`, attributed to the
 *      spec file.
 *   2. Parse the `NativeProps` interface and emit one `property` node per
 *      prop, attributed to the spec file. Props like `onTap` /
 *      `onFinishTransitioning` are JS-callable event-handler bindings;
 *      surfacing them as nodes lets the agent discover the JS surface of
 *      the component.
 *
 * A companion synthesizer (`fabricNativeImplEdges` in
 * callback-synthesizer.ts) links the emitted component node to its
 * native implementation class via the convention-based name+suffix
 * lookup — that produces the cross-language hop the JSX synthesizer's
 * `<MyComponent>` edges naturally chain through.
 */
import type { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
} from '../types';

const CODEGEN_DECL_RE =
  /codegenNativeComponent\s*(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g;

/**
 * Legacy Paper view manager macros — older RN libs (still very common,
 * especially small libs that haven't migrated to Codegen) declare a
 * ViewManager class and expose props via these macros. Both shapes:
 *
 *   RCT_EXPORT_VIEW_PROPERTY(values, NSArray)
 *   RCT_EXPORT_VIEW_PROPERTY(onChange, RCTBubblingEventBlock)
 *   RCT_CUSTOM_VIEW_PROPERTY(text, NSString, RNCMyView) { … }
 *   RCT_REMAP_VIEW_PROPERTY(jsName, nativeKeyPath, NSString)
 *
 * Capture the FIRST argument — that's the JS-visible prop name.
 */
const RCT_VIEW_PROP_RE =
  /\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;

/**
 * ObjC `@implementation Foo` extraction. Used to identify the ViewManager
 * class so we can derive a JS-visible component name (strip the `Manager`
 * suffix and a leading `RCT` prefix, both standard conventions).
 */
const OBJC_IMPL_RE = /@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/;

/**
 * Derive the JS-visible component name from a native ViewManager class.
 * Strip a trailing `Manager` (and optionally `ViewManager`) — RN's view
 * registry maps `XXXManager` ↔ JS `<XXX/>` by this convention. The
 * leading `RCT` prefix is also stripped (matches what
 * `defaultObjcModuleName` does for RN's legacy bridge modules).
 */
function deriveComponentNameFromManager(className: string): string {
  let name = className.startsWith('RCT') ? className.slice(3) : className;
  // Trim ViewManager > Manager > View, in order.
  if (name.endsWith('ViewManager')) name = name.slice(0, -'ViewManager'.length);
  else if (name.endsWith('Manager')) name = name.slice(0, -'Manager'.length);
  return name;
}

/**
 * Cheap source-level detector — must contain `codegenNativeComponent` to
 * be worth parsing. The presence of that import is the canonical Fabric
 * spec signal.
 */
function isFabricSpec(source: string): boolean {
  return source.includes('codegenNativeComponent');
}

/**
 * Pull the `NativeProps` interface body out of a Fabric spec source.
 * Returns `null` when the interface isn't declared in the expected shape.
 */
function findNativePropsBody(source: string): string | null {
  // Permissive: `export interface NativeProps [extends X, Y] { … }`.
  const m = source.match(/export\s+interface\s+NativeProps\b[^{]*\{([\s\S]*?)\n\}/);
  return m?.[1] ?? null;
}

/**
 * Parse the NativeProps interface body and return prop names.
 * Each prop is `name?: Type;` or `name: Type;` on its own line.
 * We don't care about types — just the JS-visible name.
 */
function extractPropNames(body: string): string[] {
  const props: string[] = [];
  // Anchor to start-of-line (after optional whitespace), then capture an
  // identifier, then optional `?`, then `:`. Skip lines that look like
  // method declarations (`name(`) — those are TurboModule spec methods,
  // not view props.
  const regex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(body)) !== null) {
    const name = m[1]!;
    // Exclude any line that immediately turns into a function-shape (e.g.
    // `onTap?: () => void` is fine — it's a prop, not a method body —
    // but a literal `name(arg: T): R` is a method declaration).
    const after = body.slice(m.index + m[0].length, m.index + m[0].length + 80);
    if (/^\s*\(/.test(after)) continue; // method-shape, skip
    props.push(name);
  }
  return props;
}

/**
 * Extract legacy Paper view-manager declarations from a .m/.mm file.
 * Emits a `component` node named after the JS-visible name (derived from
 * the @implementation class) plus a `property` node per
 * `RCT_EXPORT_VIEW_PROPERTY(name, ...)` macro.
 *
 * Returns `[]` if the file doesn't look like a ViewManager (no
 * RCT_EXPORT_VIEW_PROPERTY macros).
 */
function extractLegacyViewManagerNodes(filePath: string, source: string): Node[] {
  // Cheap gate: no view-property macros at all → not a view manager.
  if (!source.includes('RCT_EXPORT_VIEW_PROPERTY') &&
      !source.includes('RCT_CUSTOM_VIEW_PROPERTY') &&
      !source.includes('RCT_REMAP_VIEW_PROPERTY')) {
    return [];
  }
  const implMatch = source.match(OBJC_IMPL_RE);
  if (!implMatch || !implMatch[1]) return [];
  const className = implMatch[1];
  // Only process actual ViewManagers — classes ending in Manager or
  // (legacy) ViewManager. Classes with view-property macros that don't
  // follow the naming convention are unusual; skip to keep precision.
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return [];
  const componentName = deriveComponentNameFromManager(className);
  if (!componentName) return [];

  const now = Date.now();
  const nodes: Node[] = [];

  // Component node — same shape as Codegen Fabric's, so the
  // fabricNativeImplEdges synthesizer linking component → native class
  // works for legacy too. The native class IS the manager itself in this
  // case; the convention-based suffix lookup in the synthesizer
  // (`Manager`, `ViewManager`) will find it.
  const before = source.slice(0, implMatch.index ?? 0);
  const startLine = before.split('\n').length;
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualifiedName: `${filePath}::${componentName}`,
    filePath,
    language: 'objc',
    startLine,
    endLine: startLine,
    startColumn: 0,
    endColumn: componentName.length,
    docstring: `Legacy Paper ViewManager component '${componentName}' (from @implementation ${className})`,
    signature: `RCT_EXPORT_MODULE() // ViewManager: ${className}`,
    isExported: true,
    updatedAt: now,
  });

  // Property nodes per RCT_EXPORT_VIEW_PROPERTY macro.
  const seen = new Set<string>();
  RCT_VIEW_PROP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = RCT_VIEW_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!;
    if (seen.has(propName)) continue;
    seen.add(propName);
    const propBefore = source.slice(0, m.index);
    const propLine = propBefore.split('\n').length;
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualifiedName: `${filePath}::${componentName}.${propName}`,
      filePath,
      language: 'objc',
      startLine: propLine,
      endLine: propLine,
      startColumn: 0,
      endColumn: propName.length,
      docstring: `Legacy Paper view prop '${propName}' on ${componentName}`,
      isExported: true,
      updatedAt: now,
    });
  }
  return nodes;
}

/**
 * Java/Kotlin `@ReactProp("name")` extraction. The annotation precedes a
 * setter method on a class that extends `ViewManager` /
 * `SimpleViewManager` (or in Kotlin, `:` syntax).
 *
 * Returns `[]` if no @ReactProp annotations are found.
 */
function extractJvmViewManagerNodes(filePath: string, source: string): Node[] {
  if (!source.includes('@ReactProp')) return [];

  // Class name — looking for `class FooManager [extends ViewManager...]`
  // (Java) or `class FooManager : ViewManager...` (Kotlin). Either gates
  // us into a ViewManager file; non-Manager classes with @ReactProp are
  // unusual.
  const classMatch = source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/);
  if (!classMatch || !classMatch[1]) return [];
  const className = classMatch[1];
  if (!className.endsWith('Manager') && !className.endsWith('ViewManager')) return [];
  const componentName = deriveComponentNameFromManager(className);
  if (!componentName) return [];

  const language: 'java' | 'kotlin' = filePath.endsWith('.kt') ? 'kotlin' : 'java';
  const now = Date.now();
  const nodes: Node[] = [];

  const classBefore = source.slice(0, classMatch.index ?? 0);
  const startLine = classBefore.split('\n').length;
  nodes.push({
    id: `fabric-component:${filePath}:${componentName}:${startLine}`,
    kind: 'component',
    name: componentName,
    qualifiedName: `${filePath}::${componentName}`,
    filePath,
    language,
    startLine,
    endLine: startLine,
    startColumn: 0,
    endColumn: componentName.length,
    docstring: `Android view-manager component '${componentName}' (from class ${className})`,
    signature: `class ${className} : ViewManager`,
    isExported: true,
    updatedAt: now,
  });

  // @ReactProp("name") followed (after optional modifiers / args) by a
  // setter declaration. The annotation argument is the JS-visible prop
  // name. Permissive about the rest — we only need the literal.
  const REACT_PROP_RE = /@ReactProp\s*\(\s*(?:name\s*=\s*)?"([^"]+)"/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = REACT_PROP_RE.exec(source)) !== null) {
    const propName = m[1]!;
    if (seen.has(propName)) continue;
    seen.add(propName);
    const propBefore = source.slice(0, m.index);
    const propLine = propBefore.split('\n').length;
    nodes.push({
      id: `fabric-prop:${filePath}:${propName}:${propLine}`,
      kind: 'property',
      name: propName,
      qualifiedName: `${filePath}::${componentName}.${propName}`,
      filePath,
      language,
      startLine: propLine,
      endLine: propLine,
      startColumn: 0,
      endColumn: propName.length,
      docstring: `Android @ReactProp prop '${propName}' on ${componentName}`,
      isExported: true,
      updatedAt: now,
    });
  }
  return nodes;
}

function extractFabricNodes(filePath: string, source: string): Node[] {
  if (!isFabricSpec(source)) return [];

  const now = Date.now();
  const nodes: Node[] = [];

  CODEGEN_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CODEGEN_DECL_RE.exec(source)) !== null) {
    const componentName = m[1]!;
    const before = source.slice(0, m.index);
    const startLine = before.split('\n').length;
    const startColumn = before.length - before.lastIndexOf('\n') - 1;

    // The component itself — kind: 'component' so the existing
    // reactJsxChildEdges synthesizer matches `<MyComponent>` JSX tags to
    // it (its name+kind filter is the gate).
    const componentId = `fabric-component:${filePath}:${componentName}:${startLine}`;
    nodes.push({
      id: componentId,
      kind: 'component',
      name: componentName,
      qualifiedName: `${filePath}::${componentName}`,
      filePath,
      // The spec file is .ts or .tsx; use the file's apparent language
      // by extension. Trim to a known Language value.
      language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
      startLine,
      endLine: startLine,
      startColumn,
      endColumn: startColumn + 'codegenNativeComponent'.length,
      docstring: `Fabric/Codegen native component '${componentName}'`,
      signature: `codegenNativeComponent<NativeProps>('${componentName}')`,
      isExported: true,
      updatedAt: now,
    });
  }

  // Props from the NativeProps interface. These are not "method" semantic
  // — they're JS-visible bindings the consumer sets via JSX attributes —
  // so use `property` kind. (The JSX synthesizer doesn't currently
  // produce per-attribute edges, but surfacing the prop names as nodes
  // lets `codegraph_search('onFinishTransitioning')` discover them.)
  const body = findNativePropsBody(source);
  if (body) {
    const props = extractPropNames(body);
    for (const propName of props) {
      const propBefore = source.indexOf(propName, source.indexOf(body));
      const propLine =
        propBefore >= 0 ? source.slice(0, propBefore).split('\n').length : 1;
      nodes.push({
        id: `fabric-prop:${filePath}:${propName}:${propLine}`,
        kind: 'property',
        name: propName,
        qualifiedName: `${filePath}::NativeProps.${propName}`,
        filePath,
        language: filePath.endsWith('.tsx') ? 'tsx' : 'typescript',
        startLine: propLine,
        endLine: propLine,
        startColumn: 0,
        endColumn: propName.length,
        docstring: `Fabric NativeProps prop '${propName}'`,
        isExported: true,
        updatedAt: now,
      });
    }
  }

  return nodes;
}

export const fabricViewResolver: FrameworkResolver = {
  name: 'fabric-view',
  languages: ['typescript', 'tsx', 'objc', 'java', 'kotlin'],

  detect(context) {
    // Root package.json is the common case. The indexer only tracks
    // SOURCE files in getAllFiles(), so package.jsons in subpackages
    // aren't enumerable that way — we have to probe them explicitly via
    // listDirectories() for monorepos.
    const checkPkg = (relativePath: string) => {
      const pkg = context.readFile(relativePath);
      return pkg ? /["']react-native["']\s*:/.test(pkg) : false;
    };
    if (checkPkg('package.json')) return true;
    // Monorepo escape hatch — react-native-skia and similar workspace
    // repos have the RN dep only in `packages/<sub>/package.json`. Walk
    // the common workspace roots one level deep.
    const list = context.listDirectories;
    if (!list) return false;
    for (const root of ['packages', 'apps', 'modules', 'libraries']) {
      for (const sub of list(root) ?? []) {
        if (checkPkg(`${root}/${sub}/package.json`)) return true;
      }
    }
    return false;
  },

  extract(filePath, source): FrameworkExtractionResult {
    // Pick the right extractor by file language. The framework registry
    // already filters by `languages` so we only see relevant files.
    let nodes: Node[] = [];
    if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) {
      nodes = extractFabricNodes(filePath, source);
    } else if (filePath.endsWith('.m') || filePath.endsWith('.mm')) {
      nodes = extractLegacyViewManagerNodes(filePath, source);
    } else if (filePath.endsWith('.java') || filePath.endsWith('.kt')) {
      nodes = extractJvmViewManagerNodes(filePath, source);
    }
    return { nodes, references: [] };
  },

  resolve() {
    // The companion synthesizer (`fabricNativeImplEdges`) handles
    // cross-language edges; standard name resolution handles
    // <MyComponent> → component-node via the JSX synthesizer.
    return null;
  },
};
