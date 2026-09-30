/**
 * Expo Modules framework — close the JS → native flow for Expo SDK packages.
 *
 * Expo Modules use a Swift / Kotlin DSL distinct from the React Native legacy
 * bridge. Each native module is a class extending `Module` whose
 * `definition()` body declares the JS surface via literal `Name(...)`,
 * `Function(...)`, `AsyncFunction(...)`, `Property(...)`, and `View {...}`
 * calls. Tree-sitter parses these as ordinary call_expressions with trailing
 * closures, so the JS-visible methods don't exist as named symbol nodes by
 * default — `Camera.takePictureAsync(...)` on the JS side has nothing to
 * resolve to.
 *
 * This framework extractor walks the file source for those declarative
 * literals and emits method nodes named `takePictureAsync` /
 * `notificationAsync` / `width` / etc., attributed to the Swift / Kotlin
 * file. The standard name-matcher then resolves JS `Foo.takePictureAsync(...)`
 * to them via the existing `obj.method` → method-name path — no separate
 * resolve() branch needed.
 *
 * Real-world shape (expo-haptics):
 *
 *   public class HapticsModule: Module {
 *     public func definition() -> ModuleDefinition {
 *       Name("ExpoHaptics")
 *       AsyncFunction("notificationAsync") { ... }
 *       AsyncFunction("impactAsync") { ... }
 *       AsyncFunction("selectionAsync") { ... }
 *     }
 *   }
 *
 * Kotlin Module declarations are the same DSL (the API mirrors Swift).
 *
 * Anti-goals (deferred):
 * - The trailing-closure BODY is not extracted as the method's body — it
 *   remains attributed to `definition()` in the existing extraction. Future
 *   work could synthesize a body-range for richer `trace` output, but the
 *   reachability (which is the bridge's main value) is already complete.
 * - `View { ... }` blocks expose JSX prop bindings; that overlaps with
 *   Fabric (Phase 6) and is left to that phase.
 */
import type { Node } from '../../types';
import {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { resolveImportPath } from '../import-resolver';
import { stripCommentsForRegex } from '../strip-comments';

/**
 * Match `Function("name")`, `AsyncFunction("name")`, or `Property("name")`
 * at the start of an expression (line-anchored after optional whitespace).
 * The trailing closure that follows isn't captured — we just need the name
 * literal that becomes the JS-visible method.
 *
 * NOTE: the regex deliberately requires the open paren to live on the same
 * line as the keyword, which matches every real Expo Module declaration
 * style. Multi-line `AsyncFunction(\n"x"\n)` forms aren't a real shape in
 * the SDK; if any appear we'd extend the regex.
 *
 * The optional `<…>` covers Kotlin's GENERIC-typed declarations
 * (`AsyncFunction<Float>("getBatteryLevelAsync")`, `AsyncFunction<Int, String>(…)`)
 * — without it, every Android Expo Module method was silently dropped, so a JS
 * callsite resolved only to the iOS Swift impl and never the Android one.
 */
const EXPO_DECL_RE =
  /\b(Function|AsyncFunction|Property|Constants)\s*(?:<[^(]*>)?\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/g;

/**
 * Match the module name literal `Name("ExpoX")`. Used to enrich each emitted
 * method's qualifiedName so the same JS callsite to `Foo.fn` doesn't ambiguate
 * across multiple Expo modules in a monorepo.
 */
const EXPO_MODULE_NAME_RE = /\bName\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;

/**
 * Heuristic class-name match — used as a fallback if `Name(...)` literal
 * isn't found. Detects `class XxxModule: Module` (Swift) or
 * `class XxxModule : Module` (Kotlin / with whitespace tolerance).
 */
const EXPO_CLASS_RE =
  /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Module\b/;

/**
 * Detect whether a file is plausibly an Expo Module — looking for both
 * the `: Module` inheritance and at least one declarative `Function(...)`
 * / `AsyncFunction(...)` / `Property(...)` / `Name(...)` literal. Any one
 * of those alone produces too many false positives (random Swift code can
 * have `class X: Module` for unrelated reasons).
 */
function isExpoModuleSource(source: string): boolean {
  if (!EXPO_CLASS_RE.test(source)) return false;
  // Reset lastIndex defensively; EXPO_DECL_RE has the `g` flag.
  EXPO_DECL_RE.lastIndex = 0;
  return EXPO_DECL_RE.test(source);
}

/**
 * Extract Expo Module method declarations from a Swift / Kotlin source
 * file. Each `Function("X") { … }` / `AsyncFunction("X") { … }` /
 * `Property("X") { … }` literal becomes a method node named `X`,
 * attributed to the file at the line of the literal.
 */
function extractExpoMethods(filePath: string, source: string, language: 'swift' | 'kotlin'): Node[] {
  if (!isExpoModuleSource(source)) return [];
  const nodes: Node[] = [];

  const nameMatch = source.match(EXPO_MODULE_NAME_RE);
  const classMatch = source.match(EXPO_CLASS_RE);
  // Prefer the explicit `Name("X")` literal — that's the JS-visible
  // module name. Class name is the fallback.
  const moduleName = nameMatch?.[1] ?? classMatch?.[1] ?? 'ExpoModule';

  const now = Date.now();
  const seenAtLine = new Set<string>();
  EXPO_DECL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = EXPO_DECL_RE.exec(source)) !== null) {
    const kind = m[1]!;
    const methodName = m[2]!;
    // Compute line number from match index.
    const before = source.slice(0, m.index);
    const startLine = before.split('\n').length;
    // Avoid duplicates if the same method literal appears twice in one
    // file (e.g., declared and re-declared inside a `View {...}` block).
    const dedupKey = `${methodName}:${startLine}`;
    if (seenAtLine.has(dedupKey)) continue;
    seenAtLine.add(dedupKey);

    const startColumn = before.length - before.lastIndexOf('\n') - 1;
    nodes.push({
      id: `expo-module:${filePath}:${moduleName}:${methodName}:${startLine}`,
      kind: 'method',
      name: methodName,
      qualifiedName: `${filePath}::${moduleName}.${methodName}`,
      filePath,
      language,
      startLine,
      // We don't extract the closure body's end-line — use the literal's
      // line as a single-line range. trace/explore still surfaces the
      // declaration site, which is the main user-visible signal.
      endLine: startLine,
      startColumn,
      endColumn: startColumn + kind.length + 2 + methodName.length + 2,
      docstring: `Expo Modules ${kind}("${methodName}") in ${moduleName}`,
      signature: `${kind}("${methodName}")`,
      isExported: true,
      updatedAt: now,
    });
  }

  return nodes;
}

export const expoModulesResolver: FrameworkResolver = {
  name: 'expo-modules',
  languages: ['swift', 'kotlin'],

  /**
   * Detect Expo Modules by looking at the project's package.json or
   * a small scan of source files for the `: Module` + declarative-DSL
   * markers. Either signal suffices.
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']expo-modules-core["']\s*:/.test(pkg)) return true;
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f) continue;
      if (f.endsWith('.swift') || f.endsWith('.kt')) {
        const src = context.readFile(f);
        if (src && isExpoModuleSource(src)) return true;
      }
    }
    return false;
  },

  /**
   * Per-file extraction — the orchestrator invokes this for every
   * `.swift` / `.kt` file in the project. We only emit nodes when the
   * file looks like an Expo Module; otherwise return empty.
   */
  extract(filePath, source): FrameworkExtractionResult {
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'swift';
    return {
      nodes: extractExpoMethods(filePath, source, language),
      references: [],
    };
  },

  /**
   * No bespoke resolution needed — the synthetic method nodes emitted by
   * `extract()` get picked up by the standard name-matcher when a JS
   * callsite like `Foo.takePictureAsync(args)` resolves. Returning null
   * here is correct.
   */
  resolve() {
    return null;
  },
};

// =============================================================================
// The JS side: `ExpoCamera.scanFromURLAsync(…)` → the module's function
// =============================================================================

/** `requireNativeModule('ExpoCamera')`, typed or not, optional or not. */
const REQUIRE_NATIVE = /\brequire(?:Optional)?NativeModule\s*(?:<\s*([A-Za-z_$][\w$]*)[^>]*>)?\s*\(\s*['"]([A-Za-z_$][\w$]*)['"]\s*\)/;

interface NativeBinding {
  /** The `Name("…")` the module declares. */
  module: string;
  /** The declared JS type, from `requireNativeModule<CameraNativeModule>(…)`. */
  type: string | null;
  /** The file the binding (and its type) is written in. */
  file: string;
}

const bindingMemo = new WeakMap<ResolutionContext, Map<string, NativeBinding | null>>();

/**
 * What `name` is bound to in `file`: `const X = requireNativeModule('N')`
 * here, or the import of a module whose default export (or a named export)
 * is one — expo-camera's `import CameraManager from './ExpoCameraManager'`,
 * whose whole body is `export default requireNativeModule<CameraNativeModule>('ExpoCamera')`.
 */
function nativeBinding(name: string, file: string, context: ResolutionContext): NativeBinding | null {
  let memo = bindingMemo.get(context);
  if (!memo) bindingMemo.set(context, (memo = new Map()));
  const key = `${file}\0${name}`;
  if (memo.has(key)) return memo.get(key)!;
  let found: NativeBinding | null = null;
  const own = context.readFile(file);
  if (own && own.includes('NativeModule')) {
    const local = new RegExp(String.raw`\b(?:const|let|var)\s+${name}\s*(?::[^=]+)?=\s*` + REQUIRE_NATIVE.source).exec(stripCommentsForRegex(own, 'typescript'));
    if (local) found = { type: local[1] ?? null, module: local[2]!, file };
  }
  if (!found) {
    const language = /\.tsx$/.test(file) ? 'tsx' : /\.[cm]?ts$/.test(file) ? 'typescript' : /\.jsx$/.test(file) ? 'jsx' : 'javascript';
    const binding = context.getImportMappings(file, language).find((m) => m.localName === name);
    const target = binding && binding.source.startsWith('.') ? resolveImportPath(binding.source, file, language, context) : null;
    const content = target ? context.readFile(target) : null;
    if (target && content && content.includes('NativeModule')) {
      const safe = stripCommentsForRegex(content, 'typescript');
      const pattern = binding!.isDefault
        ? new RegExp(String.raw`\bexport\s+default\s+` + REQUIRE_NATIVE.source)
        : new RegExp(String.raw`\bexport\s+(?:const|let)\s+${binding!.exportedName}\s*(?::[^=]+)?=\s*` + REQUIRE_NATIVE.source);
      const m = pattern.exec(safe);
      if (m) found = { type: m[1] ?? null, module: m[2]!, file: target };
    }
  }
  memo.set(key, found);
  return found;
}

/**
 * JS calls into an Expo module, bound by the module's NAME, not by the
 * method name alone: expo-camera calls its module `CameraManager`, so
 * `CameraManager.isAvailableAsync()` went to `CameraView`'s own static
 * `isAvailableAsync` in the same file. The native functions the module
 * declares are the targets — Swift first, Kotlin beside it — and when it
 * declares none of that name, the method on the type the binding is given
 * (`requireNativeModule<CameraNativeModule>`).
 */
export const expoModulesJsResolver: FrameworkResolver = {
  name: 'expo-modules-js',
  languages: ['typescript', 'tsx', 'javascript', 'jsx'],

  detect(context) {
    return expoModulesResolver.detect(context);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceKind !== 'calls') return null;
    const m = /^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/.exec(ref.referenceName);
    if (!m) return null;
    const binding = nativeBinding(m[1]!, ref.filePath, context);
    if (!binding) return null;
    const fn = m[2]!;
    const declared = context
      .getNodesByName(fn)
      .filter((n) => n.id.startsWith('expo-module:') && n.qualifiedName.endsWith(`::${binding.module}.${fn}`))
      .sort((a, b) => (a.language === 'swift' ? 0 : 1) - (b.language === 'swift' ? 0 : 1));
    if (declared.length > 0) {
      return {
        original: ref,
        targetNodeId: declared[0]!.id,
        ...(declared.length > 1 ? { alsoTargets: declared.slice(1).map((n) => ({ targetNodeId: n.id })) } : {}),
        confidence: 0.95,
        resolvedBy: 'framework',
      };
    }
    if (binding.type) {
      const typed = context
        .getNodesByName(fn)
        .find((n) => (n.kind === 'method' || n.kind === 'property' || n.kind === 'field') && n.qualifiedName.endsWith(`${binding.type}::${fn}`));
      if (typed) return { original: ref, targetNodeId: typed.id, confidence: 0.9, resolvedBy: 'framework' };
    }
    return null;
  },
};
