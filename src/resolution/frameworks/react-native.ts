/**
 * React Native cross-language bridge resolver.
 *
 * Closes the JS ↔ native flow gap in React Native projects. Covers:
 *
 * **Legacy bridge** (older / still-prevalent in mid-tier RN libs):
 *   - ObjC: `RCT_EXPORT_MODULE([opt_name])` declares a module; the module
 *     name defaults to the class name minus an `RCT` prefix when no
 *     argument is given. `RCT_EXPORT_METHOD(selector:(args))` declares a
 *     JS-callable method whose JS name is the selector's first keyword.
 *     `RCT_REMAP_METHOD(jsName, nativeSelector:(args))` overrides the JS
 *     name explicitly.
 *   - Java/Kotlin: `@ReactMethod` annotated methods on a
 *     `ReactContextBaseJavaModule` subclass; the module name comes from
 *     `getName()` returning a literal string.
 *
 * **TurboModules** (modern, used by react-native-svg, screens, FBSDK
 * Next-gen libraries):
 *   - TS spec interface declared in a `Native<X>.ts` file exporting
 *     `TurboModuleRegistry.getEnforcing<Spec>('<ModuleName>')` (or
 *     `.get<Spec>('<ModuleName>')`). The Spec interface methods are the
 *     JS-callable surface; the matching native implementation is a class
 *     whose method names match (selector first-keyword on ObjC,
 *     identifier on Kotlin/Java).
 *
 * The two mechanisms share an end shape: a map from `(moduleName,
 * jsMethodName)` to a native method node, plus a smaller map from
 * `jsMethodName` alone for cases where the JS callsite doesn't carry
 * the module qualifier (the most common JS pattern is
 * `import Geo from './NativeGeolocation'; Geo.getPosition()` — the
 * receiver is the default export, not literally `NativeModules.<Mod>`,
 * so name-by-method-only is what actually resolves in practice).
 *
 * **Not covered** (deferred to a follow-up phase, per design doc §6):
 *   - Fabric view components (`RCT_EXPORT_VIEW_PROPERTY` / Codegen view
 *     specs) — these connect JSX props to native renderers, a different
 *     flow shape that composes with the existing JSX synthesizer.
 *   - Native → JS events (`RCTEventEmitter` / `NativeEventEmitter`) —
 *     belongs in the callback synthesizer's cross-language channel.
 */
import type { Node } from '../../types';
import {
  FrameworkResolver,
  ResolutionContext,
} from '../types';

/**
 * One native RN method known to the resolver. Indexed by JS-visible name.
 */
interface NativeMethod {
  /** Module name as seen from JS (`Geolocation`, `RNSVGRenderableModule`, …). */
  moduleName: string;
  /** JS-visible method name. */
  jsName: string;
  /** Native implementation node (ObjC method / Java method / Kotlin function). */
  node: Node;
}

/** Per-context lazy map cache. */
const nativeMethodMaps: WeakMap<
  ResolutionContext,
  { byJsName: Map<string, NativeMethod[]> }
> = new WeakMap();

// ─── Native-side extraction ─────────────────────────────────────────────────

/**
 * Default ObjC module name when `RCT_EXPORT_MODULE()` has no argument:
 * strip a leading `RCT` prefix from the class name (Apple's convention)
 * and treat the rest as the JS-visible module name. `RCTGeolocation` →
 * `Geolocation`. Class names without an `RCT` prefix are returned
 * unchanged.
 */
function defaultObjcModuleName(className: string): string {
  return className.startsWith('RCT') && className.length > 3
    ? className.slice(3)
    : className;
}

/**
 * Parse an ObjC `.m`/`.mm` file's source for `RCT_EXPORT_MODULE` and
 * `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` declarations, returning the
 * inferred (moduleName, jsMethodName) pairs.
 *
 * The macro forms (a single `RCT_EXPORT_MODULE` per file conventionally
 * matched to a single `@implementation`):
 *   - `RCT_EXPORT_MODULE()` — module name = class name with `RCT` prefix
 *     stripped
 *   - `RCT_EXPORT_MODULE(jsName)` — explicit name
 *   - `RCT_EXPORT_METHOD(selector:(arg1)label1:(arg2)label2)` — JS name =
 *     `selector` (the first keyword)
 *   - `RCT_REMAP_METHOD(jsName, selector:(arg1)label1:(arg2)label2)` —
 *     JS name = literal `jsName`
 *
 * Regex-based scan is sufficient — these macros are highly stylized and
 * appear at top level. Pulling them out of the full AST would require a
 * macro-aware ObjC parse the tree-sitter grammar doesn't provide.
 */
function parseObjcRNExports(
  source: string,
  className: string | null
): Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string; line: number }> {
  const results: Array<{ moduleName: string; jsName: string; nativeSelectorFirstKw: string; line: number }> = [];

  // RCT_EXPORT_MODULE — one per file by convention. Capture the optional arg.
  const moduleMatch = source.match(/RCT_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/);
  // Need a module name to attribute methods. Prefer the explicit macro arg,
  // then the class name, then bail (no module = nothing useful to register).
  const moduleName =
    moduleMatch?.[1] ??
    (className ? defaultObjcModuleName(className) : null);
  if (!moduleName) return results;

  const lineOf = (idx: number): number => {
    let line = 1;
    for (let i = 0; i < idx && i < source.length; i++) if (source.charCodeAt(i) === 10) line++;
    return line;
  };

  // RCT_EXPORT_METHOD(selectorFirstKw:(args)…)
  // The first keyword (everything up to the first `:` or open paren) is the
  // JS-visible name. We don't try to parse full multi-keyword selectors —
  // RN's JS view of the method uses only the first keyword.
  const exportRegex = /RCT_EXPORT_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  let m: RegExpExecArray | null;
  while ((m = exportRegex.exec(source)) !== null) {
    const kw = m[1];
    if (kw) results.push({ moduleName, jsName: kw, nativeSelectorFirstKw: kw, line: lineOf(m.index) });
  }

  // RCT_REMAP_METHOD(jsName, nativeSelectorFirstKw:(args)…)
  const remapRegex =
    /RCT_REMAP_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*([A-Za-z_][A-Za-z0-9_]*)/g;
  while ((m = remapRegex.exec(source)) !== null) {
    const jsName = m[1];
    const nativeKw = m[2];
    if (jsName && nativeKw) {
      results.push({ moduleName, jsName, nativeSelectorFirstKw: nativeKw, line: lineOf(m.index) });
    }
  }

  return results;
}

/**
 * Find the `@implementation` class name in an ObjC file — used as the
 * fallback module name when `RCT_EXPORT_MODULE()` has no argument.
 * (Categories of the form `@implementation Foo (Bar)` are correctly
 * captured here as `Foo`, but a category file probably isn't where a
 * fresh `RCT_EXPORT_MODULE` lives anyway.)
 */
function findObjcClassName(source: string): string | null {
  const m = source.match(/@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1] ?? null;
}

/**
 * Parse a Java/Kotlin source file for `@ReactMethod` annotated methods
 * and the surrounding class's `getName()` return value (the JS-visible
 * module name).
 *
 * Java: `@ReactMethod public void getCurrentPosition(Callback cb) { … }`
 * Kotlin: `@ReactMethod fun getCurrentPosition(cb: Callback) { … }`
 *
 * Class name comes from `class XxxModule extends ReactContextBaseJavaModule`
 * (Java) or `class XxxModule : ReactContextBaseJavaModule(...)` (Kotlin).
 * The JS-visible module name comes from `getName()` returning a literal
 * string — fall back to the class name with a `Module` suffix stripped
 * when the literal isn't present.
 */
function parseJvmRNExports(
  source: string
): Array<{ moduleName: string; jsName: string }> {
  const results: Array<{ moduleName: string; jsName: string }> = [];

  // getName() literal — Java + Kotlin both look something like:
  //   public String getName() { return "Geolocation"; }
  //   fun getName(): String = "Geolocation"
  //   fun getName() = "Geolocation"
  const getName = source.match(
    /\bgetName\s*\([^)]*\)\s*(?::\s*String)?\s*(?:=\s*|\{[^}]*return\s*)"([^"]+)"/
  );
  // Class name fallback.
  const classMatch =
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactContextBaseJavaModule/) ??
    source.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b[^{]*ReactPackage/);
  const moduleName =
    getName?.[1] ?? (classMatch?.[1] ? classMatch[1].replace(/Module$/, '') : null);
  if (!moduleName) return results;

  // @ReactMethod annotations — followed (after optional modifiers / args /
  // newlines) by either `void <name>(` (Java) or `fun <name>(` (Kotlin).
  const methodRegex =
    /@ReactMethod\b[^{]*?(?:\bfun\s+|\bvoid\s+|\bpublic\s+\w[\w<>\[\]]*\s+)([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(source)) !== null) {
    const jsName = m[1];
    if (jsName) results.push({ moduleName, jsName });
  }

  return results;
}

/**
 * Parse a TS file for a TurboModule spec declaration. The spec file is
 * the JS↔native source-of-truth in the new architecture — its interface
 * lists every JS-visible method, and a `TurboModuleRegistry.get*<Spec>(...)`
 * default export pins the module name.
 *
 * Returns `null` when the file isn't a TurboModule spec.
 */
function parseTurboModuleSpec(
  source: string
): { moduleName: string; methods: string[] } | null {
  // `TurboModuleRegistry.getEnforcing<Spec>('ModuleName')` or
  // `TurboModuleRegistry.get<Spec>('ModuleName')`. The literal must be a
  // single-or-double-quoted string.
  const regMatch = source.match(
    /TurboModuleRegistry\.(?:getEnforcing|get)\s*<[^>]*>\s*\(\s*['"]([^'"]+)['"]\s*\)/
  );
  if (!regMatch || !regMatch[1]) return null;
  const moduleName = regMatch[1];

  // Find `export interface Spec extends TurboModule { … }` and pull each
  // method declaration's name. We don't need types — just names.
  const ifaceMatch = source.match(
    /export\s+interface\s+Spec\b[^{]*\{([\s\S]*?)\n\}/
  );
  if (!ifaceMatch || !ifaceMatch[1]) return null;
  const body = ifaceMatch[1];

  const methods: string[] = [];
  // Method shape: `name(args): ReturnType;` or `name(): void;`. Skip
  // properties (no parens before colon).
  const methodRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(body)) !== null) {
    const name = m[1];
    if (name) methods.push(name);
  }
  return { moduleName, methods };
}

// ─── Map building ───────────────────────────────────────────────────────────

/**
 * RCTEventEmitter built-ins that every emitter subclass inherits. JS code
 * doesn't directly call these — they're internal plumbing for the
 * `NativeEventEmitter` abstraction. If we leave them in the bridge map,
 * every JS `addListener` / `remove` call (Firestore subscribers, RxJS
 * pipelines, plain Array.remove, etc.) gets mis-bridged to whichever
 * emitter happens to define them. Skip during map building.
 */
const RN_EMITTER_BUILTINS = new Set([
  'addListener',
  'removeListeners',
  'remove',
  'invalidate',
  'startObserving',
  'stopObserving',
]);

function buildRNMaps(context: ResolutionContext): { byJsName: Map<string, NativeMethod[]> } {
  const cached = nativeMethodMaps.get(context);
  if (cached) return cached;

  const byJsName = new Map<string, NativeMethod[]>();
  const allFiles = context.getAllFiles();
  // Pre-index native methods by name for fast lookup when matching to
  // their bridge exports.
  const objcMethodsByFirstKw = new Map<string, Node[]>();
  const jvmMethodsByName = new Map<string, Node[]>();
  for (const node of context.getNodesByKind('method')) {
    if (node.language === 'objc') {
      const firstKw = node.name.includes(':') ? node.name.split(':')[0] : node.name;
      if (firstKw) {
        const arr = objcMethodsByFirstKw.get(firstKw);
        if (arr) arr.push(node);
        else objcMethodsByFirstKw.set(firstKw, [node]);
      }
    } else if (node.language === 'java' || node.language === 'kotlin') {
      const arr = jvmMethodsByName.get(node.name);
      if (arr) arr.push(node);
      else jvmMethodsByName.set(node.name, [node]);
    }
  }

  for (const file of allFiles) {
    // Legacy bridge — ObjC side.
    if (file.endsWith('.m') || file.endsWith('.mm')) {
      const source = context.readFile(file);
      if (!source) continue;
      const className = findObjcClassName(source);
      const exports = parseObjcRNExports(source, className);
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue;
        // Resolve to the native node by selector first-keyword. Multiple
        // ObjC methods may share a first keyword across modules; filter by
        // file path to attribute the export to this module's
        // implementation file.
        const candidates = objcMethodsByFirstKw.get(exp.nativeSelectorFirstKw) ?? [];
        const node = candidates.find((c) => c.filePath === file) ?? candidates[0];
        if (!node) continue;
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node };
        const arr = byJsName.get(exp.jsName);
        if (arr) arr.push(entry);
        else byJsName.set(exp.jsName, [entry]);
      }
    }

    // Legacy bridge — Java/Kotlin side.
    if (file.endsWith('.java') || file.endsWith('.kt')) {
      const source = context.readFile(file);
      if (!source) continue;
      const exports = parseJvmRNExports(source);
      for (const exp of exports) {
        if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue;
        const candidates = jvmMethodsByName.get(exp.jsName) ?? [];
        const node = candidates.find((c) => c.filePath === file) ?? candidates[0];
        if (!node) continue;
        const entry: NativeMethod = { moduleName: exp.moduleName, jsName: exp.jsName, node };
        const arr = byJsName.get(exp.jsName);
        if (arr) arr.push(entry);
        else byJsName.set(exp.jsName, [entry]);
      }
    }

    // TurboModule spec — TS side.
    if (file.endsWith('.ts') || file.endsWith('.tsx')) {
      const source = context.readFile(file);
      if (!source) continue;
      const spec = parseTurboModuleSpec(source);
      if (!spec) continue;
      // For each spec method, find a matching native implementation by
      // name. The spec's module name doesn't determine the native file
      // path (Codegen wires it via name convention), so we match across
      // all native methods of the right name.
      for (const methodName of spec.methods) {
        if (RN_EMITTER_BUILTINS.has(methodName)) continue;
        // ObjC first-keyword match, then JVM bare-name match. Don't
        // require module-name match for ObjC because the native side may
        // have stripped a prefix.
        const objcCands = objcMethodsByFirstKw.get(methodName) ?? [];
        const jvmCands = jvmMethodsByName.get(methodName) ?? [];
        for (const node of [...objcCands, ...jvmCands]) {
          const entry: NativeMethod = { moduleName: spec.moduleName, jsName: methodName, node };
          const arr = byJsName.get(methodName);
          if (arr) arr.push(entry);
          else byJsName.set(methodName, [entry]);
        }
      }
    }
  }

  const result = { byJsName };
  nativeMethodMaps.set(context, result);
  return result;
}

// ─── Resolver ───────────────────────────────────────────────────────────────

export const reactNativeBridgeResolver: FrameworkResolver = {
  name: 'react-native-bridge',
  // objc/mm included so `extract()` sees the native files — `resolve()` still
  // only redirects JS callers (it returns null for native languages).
  languages: ['javascript', 'typescript', 'tsx', 'jsx', 'objc'],

  /**
   * Extract `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` declarations as method
   * nodes. These macros parse as a macro-expression (an ERROR node), NOT a
   * `method_definition`, so the ObjC extractor never made a node for them — the
   * iOS half of a native module was invisible, so a JS call couldn't resolve to
   * it and the cross-platform pairing had nothing to pair. The node is named by
   * the JS-visible name (the selector's first keyword, or the explicit
   * `RCT_REMAP_METHOD` JS name) so it matches the Android `@ReactMethod` method.
   */
  extract(filePath, source) {
    if (!filePath.endsWith('.m') && !filePath.endsWith('.mm')) return { nodes: [], references: [] };
    if (!/RCT_EXPORT_MODULE\b/.test(source)) return { nodes: [], references: [] };
    const exports = parseObjcRNExports(source, findObjcClassName(source));
    const now = Date.now();
    const nodes: Node[] = [];
    const seen = new Set<string>();
    for (const e of exports) {
      if (seen.has(e.jsName)) continue;
      seen.add(e.jsName);
      nodes.push({
        id: `rn-export:${filePath}:${e.moduleName}.${e.jsName}`,
        kind: 'method',
        name: e.jsName,
        qualifiedName: `${filePath}::${e.moduleName}.${e.jsName}`,
        filePath,
        language: 'objc',
        startLine: e.line,
        endLine: e.line,
        startColumn: 0,
        endColumn: 0,
        isExported: true,
        docstring: `RCT_EXPORT_METHOD ${e.nativeSelectorFirstKw} (module ${e.moduleName})`,
        signature: `RCT_EXPORT_METHOD(${e.nativeSelectorFirstKw}:…)`,
        updatedAt: now,
      });
    }
    return { nodes, references: [] };
  },

  /**
   * Detect: package.json depends on `react-native`, OR any source file
   * uses the `RCT_EXPORT_MODULE` / `RCT_EXPORT_METHOD` /
   * `TurboModuleRegistry` markers. Either signal is enough — different
   * libraries split the JS package from the native code (`react-native-svg`'s
   * apple/ + android/ directories vs its src/), so we don't require both.
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']react-native["']\s*:/.test(pkg)) return true;
    // Fallback: scan a small number of files for the macro markers — only
    // looking at the first ones returned by getAllFiles to keep detect()
    // fast on huge repos.
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f) continue;
      if (f.endsWith('.mm') || f.endsWith('.m')) {
        const src = context.readFile(f);
        if (src && /RCT_EXPORT_MODULE\b/.test(src)) return true;
      }
      if (f.endsWith('.ts') || f.endsWith('.tsx')) {
        const src = context.readFile(f);
        if (src && /TurboModuleRegistry\.(?:get|getEnforcing)\s*</.test(src)) return true;
      }
    }
    return false;
  },

  claimsReference(_name) {
    // JS-visible method names are ordinary identifiers and are typically
    // already in `knownNames` (every TurboModule spec method, every
    // RCT_EXPORT_METHOD, has a node somewhere). So we don't need to
    // claim through the pre-filter — the ref reaches us via the normal
    // hasAnyPossibleMatch path.
    return false;
  },

  resolve(ref, context) {
    // We only redirect JS callers — native callers don't need this resolver.
    if (
      ref.language !== 'javascript' &&
      ref.language !== 'typescript' &&
      ref.language !== 'tsx' &&
      ref.language !== 'jsx'
    ) {
      return null;
    }

    // JS callsites of `obj.method()` reach the resolver as either
    // `obj.method` (qualified) or `method` (bare). Strip a single dot
    // prefix to get the JS-visible method name.
    const name = ref.referenceName.includes('.')
      ? ref.referenceName.slice(ref.referenceName.lastIndexOf('.') + 1)
      : ref.referenceName;

    const maps = buildRNMaps(context);
    const entries = maps.byJsName.get(name);
    if (!entries || entries.length === 0) return null;

    // Prefer the iOS (ObjC) target over Android when both exist — iOS is
    // the conventional first-class platform for RN library docs and most
    // graph queries. We still record only one edge; a JVM-only resolution
    // is fine when no ObjC target exists.
    const objc = entries.find((e) => e.node.language === 'objc');
    const target = objc ?? entries[0];
    if (!target) return null;
    return {
      original: ref,
      targetNodeId: target.node.id,
      confidence: 0.6,
      resolvedBy: 'framework',
    };
  },
};
