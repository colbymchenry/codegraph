/**
 * Name Matcher
 *
 * Handles symbol name matching for reference resolution.
 */

import { Node } from '../types';
import { UnresolvedRef, ResolvedRef, ResolutionContext } from './types';
import { CPP_SINGLETON_ACCESSORS } from '../extraction/tree-sitter-types';

/**
 * Try to resolve a path-like reference (e.g., "snippets/drawer-menu.liquid")
 * by matching the filename against file nodes.
 */
export function matchByFilePath(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (!ref.referenceName.includes('/')) return null;

  // Extract the filename from the path
  const fileName = ref.referenceName.split('/').pop();
  if (!fileName) return null;

  // Search for file nodes with this name
  const candidates = context.getNodesByName(fileName);
  const fileNodes = candidates.filter(n => n.kind === 'file');

  if (fileNodes.length === 0) return null;

  // Prefer exact path match on qualified_name
  const exactMatch = fileNodes.find(n => n.qualifiedName === ref.referenceName || n.filePath === ref.referenceName);
  if (exactMatch) {
    return {
      original: ref,
      targetNodeId: exactMatch.id,
      confidence: 0.95,
      resolvedBy: 'file-path',
    };
  }

  // Fall back to suffix match (e.g., ref="snippets/foo.liquid" matches "src/snippets/foo.liquid")
  const suffixMatch = fileNodes.find(n => n.qualifiedName.endsWith(ref.referenceName) || n.filePath.endsWith(ref.referenceName));
  if (suffixMatch) {
    return {
      original: ref,
      targetNodeId: suffixMatch.id,
      confidence: 0.85,
      resolvedBy: 'file-path',
    };
  }

  // If only one file node with this name, use it with lower confidence
  if (fileNodes.length === 1) {
    return {
      original: ref,
      targetNodeId: fileNodes[0]!.id,
      confidence: 0.7,
      resolvedBy: 'file-path',
    };
  }

  return null;
}

/**
 * Try to resolve a reference by exact name match
 */
export function matchByExactName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const candidates = context.getNodesByName(ref.referenceName);

  if (candidates.length === 0) {
    return null;
  }

  // If only one match, use it — but penalize cross-language matches
  if (candidates.length === 1) {
    const isCrossLanguage = candidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: isCrossLanguage ? 0.5 : 0.9,
      resolvedBy: 'exact-match',
    };
  }

  // Multiple matches - try to narrow down
  const bestMatch = findBestMatch(ref, candidates, context);
  if (bestMatch) {
    // Lower confidence when the match is from a distant/unrelated module
    const proximity = computePathProximity(ref.filePath, bestMatch.filePath);
    const confidence = proximity >= 30 ? 0.7 : 0.4;
    return {
      original: ref,
      targetNodeId: bestMatch.id,
      confidence,
      resolvedBy: 'exact-match',
    };
  }

  return null;
}

/**
 * Try to resolve by qualified name
 */
export function matchByQualifiedName(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Check if the reference name looks qualified (contains :: or .)
  if (!ref.referenceName.includes('::') && !ref.referenceName.includes('.')) {
    return null;
  }

  const candidates = context.getNodesByQualifiedName(ref.referenceName);

  if (candidates.length === 1) {
    return {
      original: ref,
      targetNodeId: candidates[0]!.id,
      confidence: 0.95,
      resolvedBy: 'qualified-name',
    };
  }

  // Try partial qualified name match
  const parts = ref.referenceName.split(/[:.]/);
  const lastName = parts[parts.length - 1];
  if (lastName) {
    const partialCandidates = context.getNodesByName(lastName);
    for (const candidate of partialCandidates) {
      if (candidate.qualifiedName.endsWith(ref.referenceName)) {
        return {
          original: ref,
          targetNodeId: candidate.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  return null;
}

function resolveMethodOnType(
  typeName: string,
  methodName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  confidence: number,
  resolvedBy: ResolvedRef['resolvedBy'],
  /**
   * Optional FQN that identifies WHICH class declaration `typeName`
   * refers to in the caller's file. When multiple candidates share
   * the same qualifiedName (`FooConverter::convert` in both
   * `dao/converter/` and `service/converter/`), the FQN's
   * file-path-suffix picks the right one — the disambiguation
   * signal Java imports carry but the call site doesn't (#314).
   */
  preferredFqn?: string,
): ResolvedRef | null {
  // Look up methods by name and match by qualifiedName ending in
  // `<typeName>::<methodName>`. This works whether the method is defined
  // in-class (`class Foo { int bar() { ... } }`) or out-of-line in a separate
  // file (`int Foo::bar() { ... }` in foo.cpp while class Foo is in foo.hpp).
  // The previous same-file approach missed the latter — the typical C++ layout.
  const methodCandidates = context.getNodesByName(methodName);
  const want = `${typeName}::${methodName}`;
  const matches: Node[] = [];
  for (const m of methodCandidates) {
    if (m.kind !== 'method') continue;
    if (m.language !== ref.language) continue;
    const qn = m.qualifiedName;
    if (qn === want || qn.endsWith(`::${want}`)) {
      matches.push(m);
    }
  }
  if (matches.length === 0) return null;

  if (matches.length > 1 && preferredFqn) {
    const ext = ref.language === 'kotlin' ? '.kt' : '.java';
    const fqnPath = preferredFqn.replace(/\./g, '/') + ext;
    const chosen = matches.find((m) => {
      const fp = m.filePath.replace(/\\/g, '/');
      return fp.endsWith(fqnPath) || fp.endsWith('/' + fqnPath);
    });
    if (chosen) {
      return {
        original: ref,
        targetNodeId: chosen.id,
        confidence,
        resolvedBy,
      };
    }
  }

  return {
    original: ref,
    targetNodeId: matches[0]!.id,
    confidence,
    resolvedBy,
  };
}

// C++ keywords/control-flow tokens that can appear right before a receiver
// (e.g. `return ptr->m()`) and must NOT be treated as a type.
const CPP_NON_TYPE_TOKENS = new Set([
  'return', 'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default',
  'break', 'continue', 'goto', 'throw', 'new', 'delete', 'co_await', 'co_yield',
  'co_return', 'static_cast', 'const_cast', 'dynamic_cast', 'reinterpret_cast',
  'sizeof', 'alignof', 'typeid', 'and', 'or', 'not', 'xor',
]);

function normalizeCppTypeName(typeName: string): string | null {
  const normalized = typeName
    .replace(/\b(const|volatile|mutable|typename|class|struct)\b/g, ' ')
    .replace(/[&*]+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) return null;
  const parts = normalized.split(/::/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (!last) return null;
  if (CPP_NON_TYPE_TOKENS.has(last)) return null;
  return last;
}

// Declarator regex: matches `Type receiver`, `Type* receiver`, `Type *receiver`,
// `Type*receiver`, `Type<X> receiver`, etc., REQUIRING a declarator terminator
// (`;`, `=`, `,`, `)`, `[`, `{`, `(`, or end-of-line) after the receiver. The
// terminator rules out uses like `return receiver->m()` where the preceding
// token is a keyword, not a type.
function buildDeclaratorRegex(escapedReceiver: string): RegExp {
  return new RegExp(
    `([A-Za-z_][\\w:]*(?:\\s*<[^;=(){}]+>)?(?:\\s*[*&]+)?)\\s*\\b${escapedReceiver}\\b\\s*(?=[;=,)\\[{(]|$)`,
  );
}

/** Bare last `::`-segment of a possibly-qualified C++ name (`ns::Foo` → `Foo`). */
function lastCppSegment(qualified: string): string | null {
  const parts = qualified.split('::').filter(Boolean);
  const last = parts[parts.length - 1];
  return last || null;
}

/**
 * Whether a qualified name matches `suffix` at a `::` boundary — exact, or a
 * deeper namespace (`ns::Foo::bar` matches suffix `Foo::bar`). Crucially does
 * NOT match `OtherFoo::bar`, which a plain `endsWith('Foo::bar')` would. Mirrors
 * the boundary check in `resolveMethodOnType`.
 */
function cppQualifiedMatchesSuffix(qualifiedName: string, suffix: string): boolean {
  return qualifiedName === suffix || qualifiedName.endsWith(`::${suffix}`);
}

/**
 * Infer the type of an `auto` local from the text of its initializer, when the
 * type is syntactically evident (Tier 1) or comes from a self-returning
 * singleton accessor (Tier 2). Returns a bare type name, or null when the
 * initializer needs real return-type inference (free function, member chain,
 * generic factory — Tier 3, deliberately uncovered: silent beats wrong).
 *
 * `init` is the source text to the right of `=` in the declaration.
 */
export function inferCppTypeFromInitializer(init: string): string | null {
  const s = init.trim();
  if (!s) return null;

  // make_unique<Foo>() / make_shared<Foo>() (with or without a std:: prefix).
  let m = s.match(/\bmake_(?:unique|shared)\s*<\s*([A-Za-z_][\w:]*)/);
  if (m) return lastCppSegment(m[1]!);

  // new Foo(...) / new Foo<...>(...) / new Foo{...}
  m = s.match(/\bnew\s+([A-Za-z_][\w:]*)/);
  if (m) return lastCppSegment(m[1]!);

  // static_cast<Foo*>(...) / dynamic_cast / reinterpret_cast / const_cast
  m = s.match(/\b(?:static|dynamic|reinterpret|const)_cast\s*<\s*([A-Za-z_][\w:]*)/);
  if (m) return lastCppSegment(m[1]!);

  // Foo::instance() — self-returning singleton accessor (qualifier IS the type).
  // Checked before bare construction so `Foo::instance()` doesn't fall into it.
  m = s.match(/^([A-Za-z_][\w:]*)::([A-Za-z_]\w*)\s*\(/);
  if (m && CPP_SINGLETON_ACCESSORS.has(m[2]!.toLowerCase())) return lastCppSegment(m[1]!);

  // Direct construction: Foo(...) or Foo{...}. Require an upper-case initial
  // (C++ type convention) so a lower-case free-function call — `helper()` —
  // isn't mistaken for a constructor. No `::`, so a scoped accessor call that
  // wasn't a known singleton above can't slip through here either. (Lower-case
  // std types like `string(...)` are missed, but they're never user-defined
  // nodes the resolver could match anyway, so nothing is lost.)
  m = s.match(/^([A-Z]\w*)\s*[({]/);
  if (m) return m[1]!;

  return null;
}

/** Pseudo-receivers that name no inferable local/field type. */
const CPP_SKIP_RECEIVERS: ReadonlySet<string> = new Set(['this', 'self', 'super']);

/** C++ built-in / non-class return types that can't be a method receiver. */
const CPP_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  'void', 'bool', 'char', 'short', 'int', 'long', 'float', 'double', 'unsigned',
  'signed', 'wchar_t', 'char8_t', 'char16_t', 'char32_t', 'size_t', 'ssize_t',
  'ptrdiff_t', 'intptr_t', 'uintptr_t', 'int8_t', 'int16_t', 'int32_t', 'int64_t',
  'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'auto',
]);

/**
 * Normalize a C++ return-type string to the bare user-defined class name it
 * yields a receiver of, or null. Unwraps the common smart-pointer wrappers
 * (`std::shared_ptr<Foo>` → `Foo`) — a `ptr->method()` call on the result
 * dispatches to the pointee — and rejects primitives/`void`.
 */
function normalizeCppReturnType(raw: string): string | null {
  if (!raw) return null;
  const smart = raw.match(/\b(?:shared_ptr|unique_ptr|weak_ptr|auto_ptr)\s*<\s*([A-Za-z_][\w:]*)/);
  if (smart) {
    const inner = lastCppSegment(smart[1]!);
    return inner && !CPP_PRIMITIVE_TYPES.has(inner) ? inner : null;
  }
  const base = normalizeCppTypeName(raw);
  if (!base || CPP_PRIMITIVE_TYPES.has(base)) return null;
  return base;
}

/**
 * Pull the `-> ReturnType` suffix out of a C++ signature (built by
 * `extractCppSignature` as `(params) -> ReturnType`) and normalize it.
 */
export function parseCppReturnType(signature: string | undefined | null): string | null {
  if (!signature) return null;
  const idx = signature.lastIndexOf('->');
  if (idx < 0) return null;
  return normalizeCppReturnType(signature.slice(idx + 2).trim());
}

/**
 * Return type (as a bare class name) of a C++ callable named by `callee` — a
 * qualified `Foo::bar` or a bare free function `makeFoo` — read from the
 * resolved node's signature. Null when the callable isn't indexed, has no
 * captured return type, or returns a primitive/void.
 */
function cppReturnTypeOf(callee: string, context: ResolutionContext): string | null {
  let candidates: Node[] = [];
  if (callee.includes('::')) {
    candidates = context.getNodesByQualifiedName(callee);
    if (candidates.length === 0) {
      // Namespaced definition (`ns::Foo::bar`) won't match the class-qualified
      // `Foo::bar` exactly — fall back to a suffix match on the bare name.
      const last = lastCppSegment(callee);
      if (last) {
        candidates = context
          .getNodesByName(last)
          .filter((n) => cppQualifiedMatchesSuffix(n.qualifiedName, callee));
      }
    }
  } else {
    candidates = context
      .getNodesByName(callee)
      .filter((n) => n.kind === 'function' || n.kind === 'method');
  }
  for (const n of candidates) {
    if (n.language !== 'cpp') continue;
    const rt = parseCppReturnType(n.signature);
    if (rt) return rt;
  }
  return null;
}

/**
 * Return type (bare class name) of method `methodName` declared on C++ class
 * `typeName` — i.e. the type of `objOfTypeName.methodName()`. Strictly scoped to
 * methods whose qualified name ends in `typeName::methodName`, so a same-named
 * method on an unrelated class can't leak in. Inherited methods (defined on a
 * base class) are not followed — a deliberate single-level limit.
 */
function cppReturnTypeOfMethodOnType(
  typeName: string,
  methodName: string,
  context: ResolutionContext,
): string | null {
  const suffix = `${typeName}::${methodName}`;
  const methods = context
    .getNodesByName(methodName)
    .filter(
      (n) =>
        n.kind === 'method' &&
        n.language === 'cpp' &&
        cppQualifiedMatchesSuffix(n.qualifiedName, suffix),
    );
  for (const m of methods) {
    const rt = parseCppReturnType(m.signature);
    if (rt) return rt;
  }
  return null;
}

function inferCppReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
  depth = 0,
): string | null {
  const source = context.readFile(ref.filePath);
  if (!source) return null;

  const lines = source.split(/\r?\n/);
  const callLineIndex = Math.max(0, Math.min(lines.length - 1, ref.line - 1));
  const escapedReceiver = receiverName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const receiverPattern = new RegExp(`\\b${escapedReceiver}\\b`);
  const declaratorRegex = buildDeclaratorRegex(escapedReceiver);

  for (let i = callLineIndex; i >= 0; i--) {
    const line = lines[i];
    if (!line || !receiverPattern.test(line)) continue;

    const declaratorMatch = line.match(declaratorRegex);
    if (declaratorMatch) {
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized && normalized !== 'auto') return normalized;
      if (normalized === 'auto') {
        // `auto[&*] recv = <init>;` — the declared type is deduced, so recover
        // it from the initializer.
        const eqIdx = line.indexOf('=', (declaratorMatch.index ?? 0) + declaratorMatch[0].length);
        if (eqIdx >= 0) {
          const init = line.slice(eqIdx + 1);
          // Tier 1/2: type is syntactically evident (new/make_*/cast) or a
          // named self-returning accessor.
          const syntactic = inferCppTypeFromInitializer(init);
          if (syntactic) return syntactic;
          // Tier 3: the initializer is a plain call — use the callee's captured
          // return type (`auto w = makeWidget()`, `auto w = Factory::create()`).
          const initText = init.trim();
          const callMatch = initText.match(/^([A-Za-z_][\w:]*)\s*\(/);
          if (callMatch) {
            const rt = cppReturnTypeOf(callMatch[1]!, context);
            if (rt) return rt;
          }
          // Tier 3, single-level member chain: `auto x = obj.getThing();`.
          // Resolve obj's type (one recursion, depth-bounded), then read the
          // return type of getThing on that type.
          const memberMatch = initText.match(/^([A-Za-z_]\w*)\s*(?:\.|->)\s*([A-Za-z_]\w*)\s*\(/);
          if (memberMatch && depth < 2 && !CPP_SKIP_RECEIVERS.has(memberMatch[1]!)) {
            const objType = inferCppReceiverType(memberMatch[1]!, ref, context, depth + 1);
            if (objType) {
              const rt = cppReturnTypeOfMethodOnType(objType, memberMatch[2]!, context);
              if (rt) return rt;
            }
          }
        }
        // Un-inferable auto initializer (deep chain / unindexed callee): keep
        // scanning earlier lines in case the receiver was also declared with an
        // explicit type elsewhere — rare, but cheap and strictly more precise.
      }
    }
  }

  const headerCandidates = [
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.h'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hpp'),
    ref.filePath.replace(/\.(?:c|cc|cpp|cxx)$/i, '.hxx'),
  ].filter((candidate, index, arr) => arr.indexOf(candidate) === index && candidate !== ref.filePath);

  for (const headerPath of headerCandidates) {
    if (!context.fileExists(headerPath)) continue;
    const headerSource = context.readFile(headerPath);
    if (!headerSource) continue;

    for (const line of headerSource.split(/\r?\n/)) {
      if (!receiverPattern.test(line)) continue;
      const declaratorMatch = line.match(declaratorRegex);
      if (!declaratorMatch) continue;
      const normalized = normalizeCppTypeName(declaratorMatch[1] ?? '');
      if (normalized) return normalized;
    }
  }

  return null;
}

/**
 * Java/Kotlin: infer a receiver's declared type by walking field declarations
 * in the class enclosing the call site. The field's `signature` is already in
 * the form "<TypeName> <fieldName>" (set by tree-sitter.ts extractField), so we
 * pull the type from there. Handles Spring `@Resource UserBO userbo;` /
 * `@Autowired private UserService userService;` where the receiver field name
 * doesn't match the class name by Java naming convention.
 *
 * Returns the bare type name (generics stripped, dotted package stripped) or
 * null when no matching field is in the enclosing class.
 */
function inferJavaFieldReceiverType(
  receiverName: string,
  ref: UnresolvedRef,
  context: ResolutionContext,
): string | null {
  const inFile = context.getNodesInFile(ref.filePath);
  if (inFile.length === 0) return null;

  // Find the class enclosing the call line (tightest match by latest start).
  let enclosing: Node | null = null;
  for (const n of inFile) {
    if (n.kind !== 'class' && n.kind !== 'interface') continue;
    if (n.language !== ref.language) continue;
    const end = n.endLine ?? n.startLine;
    if (n.startLine <= ref.line && end >= ref.line) {
      if (!enclosing || n.startLine >= enclosing.startLine) enclosing = n;
    }
  }
  if (!enclosing) return null;

  const enclosingEnd = enclosing.endLine ?? enclosing.startLine;
  const field = inFile.find(
    (n) =>
      n.kind === 'field' &&
      n.name === receiverName &&
      n.language === ref.language &&
      n.startLine >= enclosing.startLine &&
      (n.endLine ?? n.startLine) <= enclosingEnd,
  );
  if (!field || !field.signature) return null;

  // Signature shape: "<TypeName> <fieldName>" (extractField). Pull the type,
  // strip generics + dotted package, drop array/varargs markers.
  const beforeName = field.signature.slice(
    0,
    field.signature.lastIndexOf(field.name),
  );
  const typeRaw = beforeName.trim();
  if (!typeRaw) return null;

  const typeNoGenerics = typeRaw.replace(/<[^>]*>/g, '').trim();
  const typeNoArray = typeNoGenerics.replace(/\[\s*\]/g, '').replace(/\.\.\.$/, '').trim();
  const parts = typeNoArray.split(/[.\s]+/).filter(Boolean);
  const lastPart = parts[parts.length - 1];
  if (!lastPart) return null;
  if (!/^[A-Z]/.test(lastPart)) return null; // primitives / lowercase → skip
  return lastPart;
}

/**
 * Resolve a C++ call chained off another call's result, which extraction
 * encodes as `Recv().method` (see `cppChainedCallReceiverCallee`):
 *
 *   Foo::instance().bar()   → ref `Foo::instance().bar`
 *   WidgetFactory::create().draw() → ref `WidgetFactory::create().draw`
 *   makeWidget()->run()     → ref `makeWidget().run`
 *
 * Primary path is return-type driven: whatever `Recv()` actually returns is the
 * receiver type, so a factory that returns a *different* class resolves to that
 * class — something the name-only heuristic can't do. Fallback (when the
 * callee's return type isn't indexed, e.g. an external accessor) treats a
 * self-returning-accessor *name* as evidence the qualifier is the type.
 */
export function matchCppChainedAccessor(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  if (ref.language !== 'cpp') return null;

  // Single-level member chain: `obj.getThing().method` — infer obj's type, then
  // the return type of getThing on it, then resolve method on that. Matched
  // before the simpler form because its two `()`-free segments are dot-joined.
  const chain = ref.referenceName.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)\(\)\.([A-Za-z_]\w*)$/);
  if (chain) {
    const [, objVar, midMethod, finalMethod] = chain;
    if (CPP_SKIP_RECEIVERS.has(objVar!)) return null;
    const objType = inferCppReceiverType(objVar!, ref, context);
    if (!objType) return null;
    const midType = cppReturnTypeOfMethodOnType(objType, midMethod!, context);
    if (!midType) return null;
    return resolveMethodOnType(midType, finalMethod!, ref, context, 0.85, 'instance-method');
  }

  const m = ref.referenceName.match(/^([A-Za-z_][\w:]*)\(\)\.([A-Za-z_]\w*)$/);
  if (!m) return null;
  const callee = m[1]!;
  const method = m[2]!;

  // Return-type-driven: what does the receiver call actually return?
  const returnType = cppReturnTypeOf(callee, context);
  if (returnType) {
    const hit = resolveMethodOnType(returnType, method, ref, context, 0.9, 'instance-method');
    if (hit) return hit;
  }

  // Fallback: a known self-returning accessor name (`Foo::instance()`) means the
  // qualifier is the receiver type, even when we couldn't read its return type.
  if (callee.includes('::')) {
    const parts = callee.split('::').filter(Boolean);
    const accessor = parts[parts.length - 1]!;
    const klass = parts[parts.length - 2];
    if (klass && CPP_SINGLETON_ACCESSORS.has(accessor.toLowerCase())) {
      const hit = resolveMethodOnType(klass, method, ref, context, 0.85, 'instance-method');
      if (hit) return hit;
    }
  }

  return null;
}

/**
 * Try to resolve by method name on a class/object
 */
export function matchMethodCall(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Parse method call patterns like "obj.method" or "Class::method"
  const dotMatch = ref.referenceName.match(/^(\w+)\.(\w+)$/);
  const colonMatch = ref.referenceName.match(/^(\w+)::(\w+)$/);

  const match = dotMatch || colonMatch;
  if (!match) {
    return null;
  }

  const [, objectOrClass, methodName] = match;

  if (ref.language === 'cpp' && dotMatch) {
    const inferredType = inferCppReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Java/Kotlin: receiver may be a field whose name doesn't match the type by
  // Java naming convention (`userbo` → class `UserBO`, abbreviated). Look up
  // the field in the enclosing class to get its declared type, then resolve
  // the method on that type. Covers Spring `@Resource`/`@Autowired` field
  // injection where the field type is the concrete bean class.
  if ((ref.language === 'java' || ref.language === 'kotlin') && dotMatch) {
    const inferredType = inferJavaFieldReceiverType(objectOrClass!, ref, context);
    if (inferredType) {
      // When two classes share the same simple name, the caller file's
      // import is the only signal that names WHICH one — pass the
      // imported FQN so resolveMethodOnType can disambiguate (#314).
      const imports = context.getImportMappings(ref.filePath, ref.language);
      const importedFqn = imports.find((i) => i.localName === inferredType)?.source;
      const typedMatch = resolveMethodOnType(
        inferredType,
        methodName!,
        ref,
        context,
        0.9,
        'instance-method',
        importedFqn,
      );
      if (typedMatch) {
        return typedMatch;
      }
    }
  }

  // Strategy 1: Direct class name match (existing logic)
  const classCandidates = context.getNodesByName(objectOrClass!);

  for (const classNode of classCandidates) {
    if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
      // Skip cross-language class matches
      if (classNode.language !== ref.language) continue;

      const nodesInFile = context.getNodesInFile(classNode.filePath);
      const methodNode = nodesInFile.find(
        (n) =>
          n.kind === 'method' &&
          n.name === methodName &&
          n.qualifiedName.includes(classNode.name)
      );

      if (methodNode) {
        return {
          original: ref,
          targetNodeId: methodNode.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        };
      }
    }
  }

  // Strategy 2: Instance variable receiver - try capitalized form to find class
  // e.g., "permissionEngine" → look for classes containing "PermissionEngine"
  const capitalizedReceiver = objectOrClass!.charAt(0).toUpperCase() + objectOrClass!.slice(1);
  if (capitalizedReceiver !== objectOrClass) {
    const fuzzyClassCandidates = context.getNodesByName(capitalizedReceiver);
    for (const classNode of fuzzyClassCandidates) {
      if (classNode.kind === 'class' || classNode.kind === 'struct' || classNode.kind === 'interface') {
        // Skip cross-language class matches
        if (classNode.language !== ref.language) continue;

        const nodesInFile = context.getNodesInFile(classNode.filePath);
        const methodNode = nodesInFile.find(
          (n) =>
            n.kind === 'method' &&
            n.name === methodName &&
            n.qualifiedName.includes(classNode.name)
        );

        if (methodNode) {
          return {
            original: ref,
            targetNodeId: methodNode.id,
            confidence: 0.8,
            resolvedBy: 'instance-method',
          };
        }
      }
    }
  }

  // Strategy 3: Find methods by name across the codebase, match by receiver
  // name similarity with the containing class. Handles abbreviated variable
  // names like permissionEngine → PermissionRuleEngine.
  if (methodName) {
    const methodCandidates = context.getNodesByName(methodName!);
    const methods = methodCandidates.filter(
      (n) => n.kind === 'method' && n.name === methodName
    );

    // Filter to same-language candidates first
    const sameLanguageMethods = methods.filter(m => m.language === ref.language);
    const targetMethods = sameLanguageMethods.length > 0 ? sameLanguageMethods : methods;

    // If only one same-language method with this name exists, use it
    if (targetMethods.length === 1 && targetMethods[0]!.language === ref.language) {
      return {
        original: ref,
        targetNodeId: targetMethods[0]!.id,
        confidence: 0.7,
        resolvedBy: 'instance-method',
      };
    }

    // Multiple methods: score by receiver name word overlap with class name
    if (targetMethods.length > 1) {
      const receiverWords = splitCamelCase(objectOrClass!);
      let bestMatch: typeof targetMethods[0] | undefined;
      let bestScore = 0;

      for (const method of targetMethods) {
        const classWords = splitCamelCase(method.qualifiedName);
        let score = receiverWords.filter(w =>
          classWords.some(cw => cw.toLowerCase() === w.toLowerCase())
        ).length;
        // Bonus for same language
        if (method.language === ref.language) score += 1;
        if (score > bestScore) {
          bestScore = score;
          bestMatch = method;
        }
      }

      if (bestMatch && bestScore >= 2) {
        return {
          original: ref,
          targetNodeId: bestMatch.id,
          confidence: 0.65,
          resolvedBy: 'instance-method',
        };
      }
    }
  }

  return null;
}

/**
 * Split a camelCase or PascalCase string into words.
 */
function splitCamelCase(str: string): string[] {
  return str.replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s._:\/\\]+/)
    .filter(w => w.length > 1);
}

/**
 * Compute directory proximity between two file paths.
 * Returns a score based on the number of shared directory segments.
 * Higher score = closer in directory tree.
 */
function computePathProximity(filePath1: string, filePath2: string): number {
  const dir1 = filePath1.split('/').slice(0, -1);
  const dir2 = filePath2.split('/').slice(0, -1);

  let shared = 0;
  for (let i = 0; i < Math.min(dir1.length, dir2.length); i++) {
    if (dir1[i] === dir2[i]) {
      shared++;
    } else {
      break;
    }
  }

  // Each shared directory segment contributes 15 points, capped at 80
  return Math.min(shared * 15, 80);
}

/**
 * Find the best matching node when there are multiple candidates
 */
function findBestMatch(
  ref: UnresolvedRef,
  candidates: Node[],
  _context: ResolutionContext
): Node | null {
  // Prioritization rules:
  // 1. Same file > different file
  // 2. Directory proximity (same module/package > different module)
  // 3. Same language > different language
  // 4. Functions/methods > classes/types (for call references)
  // 5. Exported > non-exported

  let bestScore = -1;
  let bestNode: Node | null = null;

  for (const candidate of candidates) {
    let score = 0;

    // Same file bonus
    if (candidate.filePath === ref.filePath) {
      score += 100;
    }

    // Directory proximity bonus — strongly prefer same module/package
    score += computePathProximity(ref.filePath, candidate.filePath);

    // Language matching: strongly prefer same language, penalize cross-language
    if (candidate.language === ref.language) {
      score += 50;
    } else {
      score -= 80;
    }

    // For call references, prefer functions/methods
    if (ref.referenceKind === 'calls') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      }
    }

    // For instantiation references (`new Foo()`), prefer class-like
    // targets — without this, a function named `Foo` in another module
    // could outscore the actual class.
    if (ref.referenceKind === 'instantiates') {
      if (
        candidate.kind === 'class' ||
        candidate.kind === 'struct' ||
        candidate.kind === 'interface'
      ) {
        score += 25;
      }
    }

    // For decorator references (`@Foo`), prefer functions. Class
    // decorators (Python `@SomeClass`, Java annotation interfaces)
    // also resolve here, hence the smaller class bonus.
    if (ref.referenceKind === 'decorates') {
      if (candidate.kind === 'function' || candidate.kind === 'method') {
        score += 25;
      } else if (candidate.kind === 'class' || candidate.kind === 'interface') {
        score += 15;
      }
    }

    // Exported bonus
    if (candidate.isExported) {
      score += 10;
    }

    // Closer line number (within same file)
    if (candidate.filePath === ref.filePath && candidate.startLine) {
      const distance = Math.abs(candidate.startLine - ref.line);
      score += Math.max(0, 20 - distance / 10);
    }

    if (score > bestScore) {
      bestScore = score;
      bestNode = candidate;
    }
  }

  return bestNode;
}

/**
 * Fuzzy match - last resort with lower confidence
 */
export function matchFuzzy(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  const lowerName = ref.referenceName.toLowerCase();

  // Use pre-built lowercase index for O(1) lookup instead of scanning all nodes
  const candidates = context.getNodesByLowerName(lowerName);

  // Filter to callable kinds only (function, method, class)
  const callableKinds = new Set(['function', 'method', 'class']);
  const callableCandidates = candidates.filter((n) => callableKinds.has(n.kind));

  // Prefer same-language matches
  const sameLanguageCandidates = callableCandidates.filter(n => n.language === ref.language);
  const finalCandidates = sameLanguageCandidates.length > 0 ? sameLanguageCandidates : callableCandidates;

  if (finalCandidates.length === 1) {
    const isCrossLanguage = finalCandidates[0]!.language !== ref.language;
    return {
      original: ref,
      targetNodeId: finalCandidates[0]!.id,
      confidence: isCrossLanguage ? 0.3 : 0.5,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/**
 * Match all strategies in order of confidence
 */
export function matchReference(
  ref: UnresolvedRef,
  context: ResolutionContext
): ResolvedRef | null {
  // Try strategies in order of confidence
  let result: ResolvedRef | null;

  // 0. File path match (e.g., "snippets/drawer-menu.liquid" → file node)
  result = matchByFilePath(ref, context);
  if (result) return result;

  // 0.5. C++ chained accessor/factory call (`Foo::instance().bar`) — resolved
  // via the receiver call's return type. Runs before qualified-name match,
  // whose partial matcher would otherwise mis-handle the `()` in the name.
  result = matchCppChainedAccessor(ref, context);
  if (result) return result;

  // 1. Qualified name match (highest confidence)
  result = matchByQualifiedName(ref, context);
  if (result) return result;

  // 2. Method call pattern
  result = matchMethodCall(ref, context);
  if (result) return result;

  // 3. Exact name match
  result = matchByExactName(ref, context);
  if (result) return result;

  // 4. Fuzzy match (lowest confidence)
  result = matchFuzzy(ref, context);
  if (result) return result;

  return null;
}
