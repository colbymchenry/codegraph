import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * The `function_signature` carrying a method's return type — unwrapped from a
 * `method_signature` wrapper (Dart nests the signature one level for methods).
 */
function dartInnerSignature(node: SyntaxNode): SyntaxNode {
  if (node.type === 'method_signature') {
    const inner = node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
    );
    if (inner) return inner;
  }
  return node;
}

/**
 * The factory/named-constructor signature inside a node, if any. A constructor
 * parses as `method_signature > {factory_,}constructor_signature` (e.g.
 * `factory Foo.create()` or `Foo._()`), whose children are the class identifier
 * and — for a named ctor — the constructor-name identifier.
 */
function dartConstructorSignature(node: SyntaxNode): SyntaxNode | undefined {
  if (node.type === 'factory_constructor_signature' || node.type === 'constructor_signature') {
    return node;
  }
  if (node.type === 'method_signature') {
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'factory_constructor_signature' || c.type === 'constructor_signature'
    );
  }
  return undefined;
}

/** The name of the class/mixin/extension/enum lexically enclosing `node`. */
function dartEnclosingTypeName(node: SyntaxNode): string | undefined {
  let p = node.parent;
  while (p) {
    if (
      p.type === 'class_definition' || p.type === 'mixin_declaration' ||
      p.type === 'extension_declaration' || p.type === 'enum_declaration'
    ) {
      return p.childForFieldName('name')?.text;
    }
    p = p.parent;
  }
  return undefined;
}

/**
 * Validated constructor info for `node`, or undefined if it isn't genuinely a
 * constructor. A constructor signature is structurally `<Class>` or
 * `<Class>.<name>`, but tree-sitter-dart MISPARSES `@override (T) m()` — the
 * annotation swallows the record return type `(T)`, leaving `m()` looking like a
 * single-identifier constructor_signature. We disambiguate by the class name:
 * a real ctor's class identifier matches the enclosing type; a misparsed method
 * (`reduce` inside class `Action`) doesn't, and is treated as the method it is.
 */
function dartCtorInfo(node: SyntaxNode): { className: string; ctorName: string } | undefined {
  const ctor = dartConstructorSignature(node);
  if (!ctor) return undefined;
  const ids = ctor.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier');
  const className = dartEnclosingTypeName(node);
  if (!className || !ids[0]) return undefined;
  if (ids[0].text !== className) return undefined; // misparsed method, not a ctor
  // `<Class>.<name>` is a named ctor; bare `<Class>` is the unnamed ctor.
  return { className, ctorName: ids[1]?.text ?? className };
}

/**
 * Capture a Dart method/function's declared return type as a bare type name, for
 * the chained static-factory / fluent call mechanism (#750). `Bar makeBar()`
 * yields `Bar`; a generic `List<Foo>` yields its container `List` (the method is
 * on the container, not the element); a prefixed `prefix.Bar` yields `Bar`. A
 * factory / named constructor returns its enclosing class implicitly, so its
 * "return type" is the class.
 */
function extractDartReturnType(node: SyntaxNode, source: string): string | undefined {
  const ctor = dartCtorInfo(node);
  if (ctor) return ctor.className;
  const sig = dartInnerSignature(node);
  // The return type precedes the method name; it's the first type_identifier
  // (generic args sit in a sibling `type_arguments`, so this is the container).
  const retType = sig.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
  if (!retType) return undefined;
  const text = getNodeText(retType, source).replace(/<[^>]*>/g, '').trim();
  const last = text.split('.').pop(); // prefixed `p.Bar` → `Bar`
  if (!last || !/^[A-Za-z_]\w*$/.test(last)) return undefined;
  return last;
}

/**
 * The callee name of the Dart call whose `argument_part` selector is `argPart`
 * — mirrors the main extractBareCall accessor logic so a chained receiver
 * (`Foo.create()` in `Foo.create().bar()`) can be reconstructed. Returns
 * `Foo.create`, a bare `create`, or `Foo` (constructor) — or undefined.
 */
function dartCalleeOfArgPart(argPart: SyntaxNode): string | undefined {
  const prev = argPart.previousNamedSibling;
  if (!prev) return undefined;
  if (prev.type === 'identifier') return prev.text; // bare `Foo()` / `create()`
  if (prev.type === 'selector') {
    const accessor = prev.namedChildren.find((c: SyntaxNode) =>
      c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
    );
    const methodId = accessor?.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (methodId) {
      const accessorPrev = prev.previousNamedSibling;
      if (accessorPrev?.type === 'identifier') return accessorPrev.text + '.' + methodId.text;
      return methodId.text;
    }
  }
  return undefined;
}

export const dartExtractor: LanguageExtractor = {
  functionTypes: ['function_signature'],
  classTypes: ['class_definition'],
  // `method_signature` covers regular methods AND factory constructors (which
  // parse as method_signature > factory_constructor_signature). A plain named
  // constructor `Foo._()` parses as a bare `constructor_signature`, so include
  // it too — resolveName names it by the ctor name and getReturnType gives it
  // the class as its return type, so `Foo._().bar()` chains resolve (#750).
  methodTypes: ['method_signature', 'constructor_signature'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: ['type_alias'],
  importTypes: ['import_or_export'],
  callTypes: [],  // Dart calls use identifier+selector, handled via extractBareCall
  variableTypes: [],
  extraClassNodeTypes: ['mixin_declaration', 'extension_declaration'],
  resolveBody: (node, bodyField) => {
    // Dart: function_body is a next sibling of function_signature/method_signature
    if (node.type === 'function_signature' || node.type === 'method_signature') {
      const next = node.nextNamedSibling;
      if (next?.type === 'function_body') return next;
      return null;
    }
    // For class/mixin/extension: try standard field, then class_body/extension_body
    const standard = node.childForFieldName(bodyField);
    if (standard) return standard;
    return node.namedChildren.find((c: SyntaxNode) =>
      c.type === 'class_body' || c.type === 'extension_body'
    ) || null;
  },
  nameField: 'name',
  bodyField: 'body', // class_definition uses 'body' field
  paramsField: 'formal_parameter_list',
  returnField: 'type',
  getReturnType: extractDartReturnType,
  isMisparsedFunction: (_name, node) => {
    // Skip the UNNAMED constructor `Foo()` (its ctor name equals the class). It's
    // ordinary construction — an `instantiates` edge to the class `Foo` — so
    // extracting it as a `Foo::Foo` method node would hijack instantiation
    // resolution (a `Foo(...)` call would resolve to the ctor method, not the
    // class). NAMED ctors `Foo.create()` / `Foo._()` ARE kept so their chains
    // resolve (#750). dartCtorInfo validates against the class name, so a method
    // tree-sitter misparsed as a ctor (`@override (T) m()`) is NOT skipped here.
    // (isMisparsedFunction skips node creation but still visits the body.)
    const ctor = dartCtorInfo(node);
    return ctor != null && ctor.ctorName === ctor.className;
  },
  getSignature: (node, source) => {
    // For function_signature: extract params + return type
    // For method_signature: delegate to inner function_signature
    let sig = node;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) sig = inner;
    }
    const params = sig.namedChildren.find((c: SyntaxNode) => c.type === 'formal_parameter_list');
    const retType = sig.namedChildren.find((c: SyntaxNode) =>
      c.type === 'type_identifier' || c.type === 'void_type'
    );
    if (!params && !retType) return undefined;
    let result = '';
    if (retType) result += getNodeText(retType, source) + ' ';
    if (params) result += getNodeText(params, source);
    return result.trim() || undefined;
  },
  getVisibility: (node) => {
    // Dart convention: _ prefix means private, otherwise public
    let nameNode: SyntaxNode | null = null;
    if (node.type === 'method_signature') {
      const inner = node.namedChildren.find((c: SyntaxNode) =>
        c.type === 'function_signature' || c.type === 'getter_signature' || c.type === 'setter_signature'
      );
      if (inner) nameNode = inner.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') || null;
    } else {
      nameNode = node.childForFieldName('name');
    }
    if (nameNode && nameNode.text.startsWith('_')) return 'private';
    return 'public';
  },
  isAsync: (node) => {
    // In Dart, 'async' is on the function_body (next sibling), not the signature
    const nextSibling = node.nextNamedSibling;
    if (nextSibling?.type === 'function_body') {
      for (let i = 0; i < nextSibling.childCount; i++) {
        const child = nextSibling.child(i);
        if (child?.type === 'async') return true;
      }
    }
    return false;
  },
  isStatic: (node) => {
    // For method_signature, check for 'static' child
    if (node.type === 'method_signature') {
      for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child?.type === 'static') return true;
      }
    }
    return false;
  },
  resolveName: (node) => {
    // Name a factory / named constructor by its constructor name — the 2nd
    // identifier (`create` in `factory Foo.create()`, `_` in `Foo._()`) — not
    // the class, so a call `Foo.create()` resolves to `Foo::create` (#750). The
    // default Dart naming returns the FIRST identifier (the class), which
    // collides every named ctor onto `Foo::Foo` and leaves `Foo.create()`
    // unresolvable. An unnamed ctor `Foo()` has a single identifier — fall
    // through (undefined) to the default class name. Letting the core's
    // extractMethod own the factory (rather than a custom visitNode) keeps the
    // body attribution intact: calls inside `factory Foo.create() { … }` are
    // attributed to `Foo::create`, and getReturnType gives it return type Foo.
    const ctor = dartCtorInfo(node);
    // A named ctor `Foo.create` → `create`; the unnamed ctor `Foo()` → undefined
    // (default naming gives the class name `Foo`, which is correct).
    if (ctor && ctor.ctorName !== ctor.className) return ctor.ctorName;
    return undefined;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    let moduleName = '';

    // Dart imports: import 'dart:async'; import 'package:foo/bar.dart' as bar;
    const libraryImport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_import');
    if (libraryImport) {
      const importSpec = libraryImport.namedChildren.find((c: SyntaxNode) => c.type === 'import_specification');
      if (importSpec) {
        const configurableUri = importSpec.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    // Also handle exports: export 'src/foo.dart';
    if (!moduleName) {
      const libraryExport = node.namedChildren.find((c: SyntaxNode) => c.type === 'library_export');
      if (libraryExport) {
        const configurableUri = libraryExport.namedChildren.find((c: SyntaxNode) => c.type === 'configurable_uri');
        if (configurableUri) {
          const uri = configurableUri.namedChildren.find((c: SyntaxNode) => c.type === 'uri');
          if (uri) {
            const stringLiteral = uri.namedChildren.find((c: SyntaxNode) => c.type === 'string_literal');
            if (stringLiteral) {
              moduleName = getNodeText(stringLiteral, source).replace(/['"]/g, '');
            }
          }
        }
      }
    }

    if (moduleName) {
      return { moduleName, signature: importText };
    }
    return null;
  },
  extractBareCall: (node, _source) => {
    // Dart calls are: identifier + selector(argument_part), not a dedicated call node.
    // Match on selector nodes that contain argument_part.
    if (node.type === 'selector') {
      const hasArgPart = node.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part');
      if (!hasArgPart) return undefined;

      const prev = node.previousNamedSibling;
      if (!prev) return undefined;

      // Simple function/constructor call: prev is identifier (e.g., runApp(...), MyWidget(...))
      if (prev.type === 'identifier') {
        return prev.text;
      }

      // Method call: prev is selector with accessor (e.g., obj.method(...), Navigator.push(...))
      if (prev.type === 'selector') {
        const accessor = prev.namedChildren.find((c: SyntaxNode) =>
          c.type === 'unconditional_assignable_selector' || c.type === 'conditional_assignable_selector'
        );
        if (accessor) {
          const methodId = accessor.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
          if (methodId) {
            // Include receiver for first call in chain (receiver is a direct identifier)
            const accessorPrev = prev.previousNamedSibling;
            if (accessorPrev?.type === 'identifier') {
              return accessorPrev.text + '.' + methodId.text;
            }
            // Chained static-factory / fluent call: the receiver is itself a call
            // (`Foo.create().bar()`), so accessorPrev is that call's argument_part
            // selector. Encode `<innerCallee>().<method>` so resolution can infer
            // bar's class from what `Foo.create` RETURNS (#645/#608 mechanism) —
            // but only when the chain starts with a capitalized type (a companion
            // factory / static method / constructor); an instance chain
            // (`obj.foo().bar()`) keeps the bare name (its receiver's type can't
            // be recovered here).
            if (accessorPrev?.type === 'selector' &&
                accessorPrev.namedChildren.some((c: SyntaxNode) => c.type === 'argument_part')) {
              const innerCallee = dartCalleeOfArgPart(accessorPrev);
              if (innerCallee && /^[A-Z]/.test(innerCallee)) {
                return `${innerCallee}().${methodId.text}`;
              }
            }
            return methodId.text;
          }
        }
      }

      // super.method() / this.method(): prev is bare unconditional_assignable_selector
      if (prev.type === 'unconditional_assignable_selector' || prev.type === 'conditional_assignable_selector') {
        const methodId = prev.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
        if (methodId) return methodId.text;
      }

      return undefined;
    }

    // new MyWidget() — explicit constructor call
    if (node.type === 'new_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      if (typeId) return typeId.text;
      return undefined;
    }

    // const EdgeInsets.all(8.0) — const constructor call
    if (node.type === 'const_object_expression') {
      const typeId = node.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
      const nameId = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
      if (typeId && nameId) return typeId.text + '.' + nameId.text;
      if (typeId) return typeId.text;
      return undefined;
    }

    return undefined;
  },
};
