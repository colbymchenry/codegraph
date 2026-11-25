import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * A Swift function's declared return type, normalized to the bare class name a
 * chained `Foo.make().draw()` could be called on (the #645/#608 mechanism).
 * tree-sitter-swift labels BOTH the function name (`simple_identifier`) and the
 * return type (a `user_type`) with the field `name`, so `childForFieldName`
 * returns the name; the return type is found positionally — the first type node
 * after the `simple_identifier` name, before the body. Optionals (`Foo?`) are
 * unwrapped; arrays/tuples/function types and `Void` yield undefined.
 */
function extractSwiftReturnType(node: SyntaxNode, source: string): string | undefined {
  let seenName = false;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'simple_identifier' && !seenName) {
      seenName = true;
      continue;
    }
    if (!seenName) continue;
    if (child.type === 'function_body') return undefined; // body reached: no return type
    let typeNode: SyntaxNode | null = null;
    if (child.type === 'user_type') typeNode = child;
    else if (child.type === 'optional_type') {
      typeNode = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? null;
    }
    if (typeNode) {
      // Use the whole type node's text, strip generics, then take the LAST
      // dotted segment — a member type `KF.Builder` resolves to `Builder` (its
      // first type_identifier is the OUTER `KF`, which would be wrong).
      const name = getNodeText(typeNode, source).trim().replace(/<[^>]*>/g, '');
      const last = name.split('.').pop()?.trim();
      if (!last || !/^[A-Za-z_]\w*$/.test(last) || last === 'Void') return undefined;
      return last;
    }
  }
  return undefined;
}

/**
 * A declaration in a body whose type may continue onto `&` lines:
 * `typealias X = A`, `let client: any A`. Indented — a top-level declaration
 * parses as written, and is left alone.
 */
const COMPOSITION_HEAD = /^[ \t]+(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:[a-z]+(?:\([a-z]+\))?\s+)*(?:typealias|let|var)\s/;
const COMPOSITION_CONTINUATION = /^([ \t]*)&([ \t]+)(?=\S)/;

/**
 * Move a protocol composition's line-leading `&` onto the line before it.
 *
 *     typealias EditorClient = AutocompleteService.Client
 *       & MediaUploadService.Client
 *
 * is valid Swift, but in a type's body tree-sitter-swift ends the declaration
 * at the newline and the `&` line is an ERROR that swallows the enclosing type
 * (IceCubesApp's 980-line `EditorStore` came out as loose variables, no class).
 * With the `&` trailing the previous line it parses. Same length and line
 * count; only the continuation line's tokens sit one column left. Applied to
 * an indented `typealias`/`let`/`var` statement's `&` lines only — a
 * line-leading `&&`, `&+` or inout `&x` is never touched.
 */
export function joinSwiftCompositionContinuations(source: string): string {
  if (!/\n[ \t]*&[ \t]/.test(source)) return source;
  const original = source.split('\n');
  const lines = original.slice();
  let changed = false;
  for (let i = 1; i < lines.length; i++) {
    const cont = COMPOSITION_CONTINUATION.exec(lines[i]!);
    if (!cont) continue;
    let head = i - 1;
    while (head > 0 && COMPOSITION_CONTINUATION.test(original[head]!)) head--;
    if (!COMPOSITION_HEAD.test(original[head]!)) continue;
    const prev = lines[i - 1]!;
    const cr = prev.endsWith('\r') ? '\r' : '';
    const body = cr ? prev.slice(0, -1) : prev;
    // The previous line must end on a type; a trailing comment would swallow the `&`.
    if (!/[\w>)\]?!]$/.test(body) || body.includes('//')) continue;
    lines[i - 1] = `${body}&${cr}`;
    lines[i] = `${cont[1]}${cont[2]}${lines[i]!.slice(cont[0].length)}`;
    changed = true;
  }
  return changed ? lines.join('\n') : source;
}

export const swiftExtractor: LanguageExtractor = {
  preParse: joinSwiftCompositionContinuations,
  functionTypes: ['function_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['function_declaration'], // Methods are functions inside classes
  interfaceTypes: ['protocol_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_entry'],
  typeAliasTypes: ['typealias_declaration'],
  importTypes: ['import_declaration'],
  callTypes: ['call_expression'],
  variableTypes: ['property_declaration', 'constant_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',
  returnField: 'return_type',
  getReturnType: extractSwiftReturnType,
  resolveName: (node, source) => {
    // A nested-type extension `extension KF.Builder { … }` parses as a
    // class_declaration whose `name` is a multi-segment `user_type` (`KF.Builder`
    // = type_identifiers `KF`, `Builder`). Name the node by the LAST segment
    // (`Builder`) so it shares the simple name of the extended type's own
    // declaration (`struct Builder` → `KF::Builder`) instead of becoming a
    // distinct `KF.Builder` node. Without this, the extension's conformances and
    // members are invisible to a chained call on the type — supertype lookup and
    // method matching both key off the simple name (#750). Simple names (regular
    // class/struct/enum, or `extension Plain`) fall through to default extraction.
    if (node.type !== 'class_declaration') return undefined;
    const nameNode = getChildByField(node, 'name');
    if (!nameNode || nameNode.type !== 'user_type') return undefined;
    const ids = nameNode.namedChildren.filter((c: SyntaxNode) => c.type === 'type_identifier');
    return ids.length > 1 ? getNodeText(ids[ids.length - 1]!, source) : undefined;
  },
  getSignature: (node, source) => {
    // Swift function signature: func name(params) -> ReturnType
    const params = getChildByField(node, 'parameter');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  getVisibility: (node) => {
    // Check for visibility modifiers in Swift
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        if (text.includes('public')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('internal')) return 'internal';
        if (text.includes('fileprivate')) return 'private';
      }
    }
    return 'internal'; // Swift defaults to internal
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        if (child.text.includes('static') || child.text.includes('class')) {
          return true;
        }
      }
    }
    return false;
  },
  classifyClassNode: (node) => {
    // Swift uses class_declaration for classes, structs, and enums
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'struct') return 'struct';
      if (child?.type === 'enum') return 'enum';
    }
    return 'class';
  },
  isAsync: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('async')) {
        return true;
      }
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const identifier = node.namedChildren.find((c: SyntaxNode) => c.type === 'identifier');
    if (identifier) {
      return { moduleName: source.substring(identifier.startIndex, identifier.endIndex), signature: importText };
    }
    return null;
  },
};
