/** Source-only Rust half of the LuaJIT FFI bridge. No symbol-name conventions or
 * project configuration are used: ABI exports, argument forwarding and literal
 * dispatch arms must all be present in the parsed source. Unknown transforms,
 * receivers and ambiguous function names deliberately stop the proof. */
import type { Parser } from 'web-tree-sitter';
import { getParser, loadGrammarsForLanguages } from '../extraction/grammars';
import { parseWithinBudget } from '../extraction/parse-budget';
import { mirrorTree, type SyntaxMirror as SyntaxNode } from './syntax-mirror';

export interface RustFunctionSummary {
  id: string;
  filePath: string;
  name: string;
  owner?: string;
  /** A trait's default method: an impl may override it, so no call proves this body. */
  trait?: boolean;
  line: number;
  column: number;
  parameters: string[];
  hasSelf: boolean;
  returnType?: string;
  modulePath: string;
  imports: Record<string, string>;
  invokedParameters: number[];
  isMacro?: boolean;
  macroExport?: boolean;
}
export interface RustFfiExport {
  symbolName: string;
  functionId: string;
  filePath: string;
  line: number;
}
export interface RustCallSummary {
  id: string;
  fromFunctionId: string;
  targetName: string;
  targetOwner?: string;
  argumentOrigins: number[][];
  argumentPossibilities: number[][];
  method: boolean;
  resultInvoked: boolean;
  invocationProofs?: RustInvocationProof[];
  requiredCallbacks?: RustCallbackRequirement[];
  line: number;
}
export interface RustDispatchSummary {
  functionId: string;
  operation: string;
  parameterIndex: number;
  targetName: string;
  targetOwner?: string;
  line: number;
  /** A reference arm is useful only when the returned function is invoked. */
  returnsFunction: boolean;
  guarded?: boolean;
  unresolved?: boolean;
  requiredCallbacks?: RustCallbackRequirement[];
}
export interface RustCallbackRequirement { callerId: string; targetName: string; targetOwner?: string; parameterIndex: number; method?: boolean }
export interface RustInvocationProof {
  callbacks: RustCallbackRequirement[];
  macro?: { callerId: string; name: string; shape: 'pairs' | 'list' | 'single'; slot: number };
}
export interface RustMacroContract {
  declaration: RustFunctionSummary;
  shape: 'pairs' | 'list' | 'single';
  forwardedSlots: number[];
}
export interface RustFfiFileAnalysis {
  filePath: string;
  functions: RustFunctionSummary[];
  exports: RustFfiExport[];
  calls: RustCallSummary[];
  dispatches: RustDispatchSummary[];
  potentialDispatchParameters: Record<string, number[]>;
  macroContracts: RustMacroContract[];
  macroDefinitions: RustFunctionSummary[];
  /** No grammar, or a parse ran past its budget: the analysis may miss facts, and no cache keeps it. */
  partial?: true;
}
export interface RustFfiDispatchRoute {
  export: RustFfiExport;
  operation: string;
  exportParameterIndex: number;
  target: RustFunctionSummary;
  dispatcher: RustFunctionSummary;
  callPath: RustFunctionSummary[];
  dispatchLine: number;
}
interface Value {
  origins: number[];
  type?: string;
  tuple?: Value[];
  callResults?: string[];
  dispatchResults?: RustDispatchSummary[];
  closure?: { node: SyntaxNode; scope: Env };
  borrowContainer?: boolean;
  borrowedType?: string;
  threadLocal?: boolean;
  wrapped?: boolean;
  possibleOrigins?: number[];
  importPath?: string;
  namespace?: boolean;
}
type Env = Map<string, Value>;
const unknown = (): Value => ({ origins: [] });
const possibleOrigins = (value: Value): number[] => [...new Set([...value.origins, ...(value.possibleOrigins ?? [])])].sort((a, b) => a - b);
const forget = (value: Value | undefined): Value => ({ origins: [], type: value?.type,
  possibleOrigins: value ? possibleOrigins(value) : [] });
const NON_MUTATING_RECEIVER_METHODS = new Set(['as_str', 'as_bytes', 'as_ptr', 'len', 'is_empty', 'starts_with', 'ends_with', 'clone', 'to_owned', 'to_string']);
const field = (node: SyntaxNode, name: string): SyntaxNode | null => node.childForFieldName(name);
const significant = (node: SyntaxNode): SyntaxNode[] => node.namedChildren.filter(n => !n.type.endsWith('comment'));
function literal(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'raw_string_literal') {
    const match = /^r(#+)?"([\s\S]*)"\1$/.exec(node.text);
    return match?.[2];
  }
  if (node.type !== 'string_literal') return undefined;
  try { return JSON.parse(node.text) as string; } catch { return undefined; }
}
/** The literals a pattern matches when it is only literals (`"a"` or `"a" | "b"`). */
function literalAlternatives(node: SyntaxNode | null): string[] | null {
  if (!node) return null;
  const value = literal(node);
  if (value !== undefined) return [value];
  if (node.type !== 'or_pattern') return null;
  const parts = significant(node).map(literalAlternatives);
  return parts.every((part): part is string[] => part !== null) ? parts.flat() : null;
}
function typeName(node: SyntaxNode | null): string | undefined {
  if (!node) return undefined;
  if (node.type === 'reference_type' || node.type === 'pointer_type') return typeName(field(node, 'type'));
  if (node.type === 'array_type' && !field(node, 'length')) return `[${field(node, 'element')?.text ?? ''}]`;
  if (node.type === 'generic_type') {
    const base = field(node, 'type')?.text;
    return base;
  }
  return ['type_identifier', 'scoped_type_identifier', 'identifier', 'primitive_type'].includes(node.type) ? node.text : undefined;
}
function target(node: SyntaxNode | null, env: Env, owner?: string): { name: string; owner?: string; method: boolean; receiver?: Value } | undefined {
  if (!node) return undefined;
  if (node.type === 'generic_function') return target(field(node, 'function'), env, owner);
  if (node.type === 'identifier') {
    const imported = env.get(node.text)?.importPath;
    if (imported) { const parts = imported.split('::'); return { name: parts.pop()!, owner: parts.join('::') || undefined, method: false }; }
    return { name: node.text, method: false };
  }
  if (node.type === 'scoped_identifier') {
    let path = field(node, 'path')?.text;
    const name = field(node, 'name')?.text;
    if (!name || !path) return undefined;
    const parts = path.split('::');
    const imported = env.get(parts[0]!)?.importPath;
    if (imported) path = [imported, ...parts.slice(1)].join('::');
    return { name, owner: path === 'Self' ? owner : path, method: false };
  }
  if (node.type === 'field_expression') {
    const receiver = field(node, 'value');
    const name = field(node, 'field')?.text;
    if (!name || !receiver || !['identifier', 'self'].includes(receiver.type)) return undefined;
    const value = env.get(receiver.text);
    return { name, owner: value?.type, method: true, receiver: value };
  }
  return undefined;
}
function dispatchArm(node: SyntaxNode | null, wrappers: Set<string>): { node: SyntaxNode; returnsFunction: boolean } | undefined {
  if (!node) return undefined;
  if (['block', 'return_expression', 'expression_statement', 'parenthesized_expression'].includes(node.type)) {
    const children = significant(node);
    return children.length === 1 ? dispatchArm(children[0]!, wrappers) : undefined;
  }
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    const args = field(node, 'arguments')?.namedChildren ?? [];
    if (callee?.type === 'identifier' && wrappers.has(callee.text) && args.length === 1) return dispatchArm(args[0]!, wrappers);
    return callee ? { node: callee, returnsFunction: false } : undefined;
  }
  return ['identifier', 'scoped_identifier'].includes(node.type) ? { node, returnsFunction: true } : undefined;
}
function bind(pattern: SyntaxNode | null, value: Value, env: Env): void {
  if (!pattern) return;
  if (pattern.type === 'match_pattern') {
    // A guard reads bindings; it does not bind the scrutinee to them.
    const guard = field(pattern, 'condition');
    for (const child of significant(pattern)) if (child.id !== guard?.id) bind(child, value, env);
    return;
  }
  if (pattern.type === 'struct_pattern' || pattern.type === 'slice_pattern') {
    // Each destructured field is a part of the value, never the whole operation.
    for (const child of significant(pattern)) bind(child, unknown(), env);
    return;
  }
  if (pattern.type === 'identifier' || pattern.type === 'self') {
    const previous = env.get(pattern.text);
    env.set(pattern.text, previous ? { ...value, possibleOrigins: [...new Set([...possibleOrigins(previous), ...possibleOrigins(value)])] } : value);
    return;
  }
  if (pattern.type === 'tuple_pattern') {
    significant(pattern).forEach((child, index) => bind(child, value.tuple?.[index] ?? unknown(), env));
    return;
  }
  if (pattern.type === 'tuple_struct_pattern') {
    // Successful Result/Option patterns preserve the contained value, while an
    // error pattern cannot prove forwarding of the successful payload.
    const tag = field(pattern, 'type');
    for (const child of significant(pattern)) if (child.id !== tag?.id) {
      bind(child, tag && ['Ok', 'Some'].includes(tag.text) ? value : unknown(), env);
    }
    return;
  }
  for (const child of significant(pattern)) bind(child, value, env);
}
function invalidateWrites(node: SyntaxNode, scope: Env): void {
  if (node.type === 'function_item') return;
  if (node.type === 'assignment_expression' || node.type === 'compound_assignment_expr') {
    const left = field(node, 'left');
    if (left?.type === 'identifier' && scope.has(left.text)) scope.set(left.text, forget(scope.get(left.text)));
  }
  if (node.type === 'reference_expression' && node.namedChildren.some(n => n.type === 'mutable_specifier')) {
    const referenced = field(node, 'value');
    if (referenced?.type === 'identifier' && scope.has(referenced.text)) scope.set(referenced.text, forget(scope.get(referenced.text)));
  }
  if (node.type === 'call_expression') {
    const callee = field(node, 'function');
    if (callee?.type === 'field_expression' && !NON_MUTATING_RECEIVER_METHODS.has(field(callee, 'field')?.text ?? '')) {
      const receiver = field(callee, 'value');
      if (receiver && ['identifier', 'self'].includes(receiver.type) && scope.has(receiver.text)) scope.set(receiver.text, forget(scope.get(receiver.text)));
    }
  }
  for (const child of node.namedChildren) invalidateWrites(child, scope);
}
/** A content key for a value; a closure is its body plus what it captured. */
function valueKey(value: Value | undefined): string {
  return JSON.stringify(value ?? null, (key, item) => {
    if (key === 'closure') return { node: item.node.id, scope: [...(item.scope as Env)] };
    if (key === 'dispatchResults') return (item as RustDispatchSummary[]).map(dispatch => `${dispatch.functionId}:${dispatch.operation}:${dispatch.line}`);
    return item;
  });
}
function merge(values: Value[]): Value {
  if (!values.length) return unknown();
  const first = values[0]!;
  // An origin is retained only when every reachable result agrees. A union of
  // unrelated inputs is not proof of an operation parameter.
  return {
    origins: values.every(v => v.origins.length === first.origins.length && v.origins.every((o, i) => o === first.origins[i])) ? first.origins : [],
    type: values.every(v => v.type === first.type) ? first.type : undefined,
    callResults: [...new Set(values.flatMap(v => v.callResults ?? []))],
    dispatchResults: [...new Set(values.flatMap(v => v.dispatchResults ?? []))],
    possibleOrigins: [...new Set(values.flatMap(possibleOrigins))],
  };
}

/** Parse and copy `text`; the tree-sitter tree is released immediately. */
function parseMirror(parser: Parser, text: string): SyntaxNode | null {
  const tree = parseWithinBudget(parser, text);
  if (!tree) return null;
  try { return mirrorTree(tree, text); } finally { tree.delete(); }
}

export async function analyzeRustFfiFile(filePath: string, source: string): Promise<RustFfiFileAnalysis> {
  const result: RustFfiFileAnalysis = { filePath, functions: [], exports: [], calls: [], dispatches: [], potentialDispatchParameters: {}, macroContracts: [], macroDefinitions: [] };
  await loadGrammarsForLanguages(['rust']);
  const parser = getParser('rust');
  if (!parser) return { ...result, partial: true };
  const parse = (text: string): SyntaxNode | null => {
    const node = parseMirror(parser, text);
    if (!node) result.partial = true;
    return node;
  };
  const root = parse(source);
  if (!root) return result;
  const statics: Env = new Map();
  const unitStructs = new Set<string>();
  const declaredTypes = new Set<string>();
  const imports = new Map<string, Map<string, string>>();
  function collectUse(node: SyntaxNode, names: Map<string, string>, prefix = ''): void {
    if (node.type === 'scoped_use_list') {
      const path = field(node, 'path')?.text ?? '';
      const list = field(node, 'list');
      if (list) collectUse(list, names, `${prefix}${path}::`);
    } else if (node.type === 'use_list') {
      for (const child of node.namedChildren) collectUse(child, names, prefix);
    } else if (node.type === 'self') { const path = prefix.replace(/::$/, ''); names.set(path.split('::').pop()!, path); }
    else if (['identifier', 'scoped_identifier'].includes(node.type)) names.set(node.text.split('::').pop()!, `${prefix}${node.text}`);
    else if (node.type === 'use_as_clause') {
      const path = field(node, 'path'); const alias = field(node, 'alias');
      if (path && alias) names.set(alias.text, `${prefix}${path.text}`);
    }
  }
  const localMacros = new Map<string, Set<string>>();
  const localModules = new Map<string, Set<string>>();
  const wildcardImports = new Set<string>();
  // Imports are order-independent, and a local macro can shadow the prelude.
  // Collect these bindings before interpreting any thread-local declaration.
  function collectNamespaceBindings(node: SyntaxNode, modulePath = ''): void {
    if (node.type === 'function_item') return;
    if (node.type === 'mod_item') {
      const name = field(node, 'name')?.text;
      if (name) { const names = localModules.get(modulePath) ?? new Set<string>(); names.add(name); localModules.set(modulePath, names); modulePath += `::${name}`; }
    }
    if (node.type === 'macro_definition') {
      const name = field(node, 'name')?.text;
      if (name) { const names = localMacros.get(modulePath) ?? new Set<string>(); names.add(name); localMacros.set(modulePath, names); }
      return;
    }
    if (node.type === 'use_declaration') {
      const argument = field(node, 'argument'); const names = imports.get(modulePath) ?? new Map<string, string>();
      if (argument) {
        collectUse(argument, names);
        if (argument.type === 'use_wildcard' || argument.descendantsOfType('use_wildcard').length) wildcardImports.add(modulePath);
      }
      imports.set(modulePath, names);
    }
    for (const child of node.namedChildren) collectNamespaceBindings(child, modulePath);
  }
  function standardNamespace(path: string, modulePath: string, lexical?: Env): boolean {
    const head = path.replace(/^::/, '').split('::')[0];
    if (head !== 'std' && head !== 'core' && head !== 'alloc') return false;
    const binding = lexical?.get(head);
    if (lexical?.has('*') || (binding && binding.importPath !== head && binding.importPath !== `::${head}`)) return false;
    for (let scope = modulePath;; scope = scope.slice(0, scope.lastIndexOf('::'))) {
      if (localModules.get(scope)?.has(head) || wildcardImports.has(scope)) return false;
      const imported: string | undefined = imports.get(scope)?.get(head);
      if (imported && imported !== head && imported !== `::${head}`) return false;
      if (!scope) break;
    }
    return true;
  }
  function standardThreadLocal(name: string, modulePath: string): boolean {
    const scopes: string[] = [];
    for (let scope = modulePath;; scope = scope.slice(0, scope.lastIndexOf('::'))) { scopes.push(scope); if (!scope) break; }
    if (scopes.some(scope => wildcardImports.has(scope))) return false;
    const parts = name.replace(/^::/, '').split('::');
    const head = parts[0]!;
    if (parts.length === 1 && scopes.some(scope => localMacros.get(scope)?.has(head))) return false;
    const imported = scopes.map(scope => imports.get(scope)?.get(head)).find(value => value !== undefined);
    const canonical = imported ? [imported, ...parts.slice(1)].join('::') : parts.join('::');
    if (canonical === 'thread_local' && !imported) return true;
    if (canonical !== 'std::thread_local') return false;
    return standardNamespace(canonical, modulePath);
  }
  const functions: Array<{ node: SyntaxNode; summary: RustFunctionSummary }> = [];
  const callById = new Map<string, RustCallSummary>();
  function collect(node: SyntaxNode, owner?: string, modulePath = '', threadLocal = false, trait = false): void {
    if (node.type === 'mod_item') modulePath = `${modulePath}::${field(node, 'name')?.text ?? ''}`;
    if (node.type === 'use_declaration') {
      const argument = field(node, 'argument'); const names = imports.get(modulePath) ?? new Map<string, string>();
      if (argument) collectUse(argument, names); imports.set(modulePath, names);
    }
    if (['struct_item', 'enum_item', 'type_item'].includes(node.type)) { const name = field(node, 'name')?.text; if (name) declaredTypes.add(name); }
    if (node.type === 'struct_item' && !field(node, 'body')) {
      const name = field(node, 'name')?.text; if (name) unitStructs.add(`${modulePath}\0${name}`);
    }
    if (node.type === 'impl_item') { owner = typeName(field(node, 'type')); trait = false; }
    if (node.type === 'trait_item') { owner = field(node, 'name')?.text; trait = true; }
    if (node.type === 'static_item' || node.type === 'const_item') {
      const name = field(node, 'name')?.text;
      if (name) {
        const annotation = field(node, 'type');
        const base = annotation?.type === 'generic_type' ? field(annotation, 'type')?.text ?? '' : '';
        const canonical = imports.get(modulePath)?.get(base) ?? base;
        statics.set(`${modulePath}\0${name}`, { origins: [], type: typeName(annotation), threadLocal, borrowContainer: ['std::cell::RefCell', 'core::cell::RefCell'].includes(canonical) && standardNamespace(canonical, modulePath), borrowedType: annotation ? typeName(field(annotation, 'type_arguments')?.namedChildren[0] ?? null) : undefined });
      }
    }
    // thread_local!'s body consists of ordinary Rust static declarations.
    // Parse those tokens rather than inferring a receiver from its spelling.
    if (node.type === 'macro_invocation' && standardThreadLocal(field(node, 'macro')?.text ?? '', modulePath)) {
      const tokens = node.namedChildren.find(n => n.type === 'token_tree');
      const expanded = tokens ? parse(tokens.text.slice(1, -1)) : null;
      for (const child of expanded?.namedChildren ?? []) if (child.type === 'static_item') collect(child, undefined, modulePath, true);
    }
    if (node.type === 'macro_definition') {
      const name = field(node, 'name')?.text;
      if (!name) return;
      let previous = node.previousNamedSibling;
      let macroExport = false;
      while (previous?.type === 'attribute_item') { macroExport ||= /^#\[\s*macro_export\s*\]$/.test(previous.text); previous = previous.previousNamedSibling; }
      const declaration: RustFunctionSummary = { id: `${filePath}:${node.startIndex}`, filePath, name, modulePath, imports: {}, invokedParameters: [], parameters: [], hasSelf: false, line: node.startPosition.row + 1, column: node.startPosition.column, isMacro: true, macroExport };
      result.macroDefinitions.push(declaration);
      let unsupportedRule = false;
      for (const rule of node.namedChildren.filter(n => n.type === 'macro_rule')) {
        const left = field(rule, 'left'); const right = field(rule, 'right');
        if (!left || !right) continue;
        const pattern = left.text.slice(1, -1).replace(/\s+/g, '');
        const pairs = /^\$\(\$(\w+):expr=>\$(\w+):expr\),[+*](?:\$\(,\)\?)?$/.exec(pattern);
        const list = /^\$\(\$(\w+):expr\),[+*](?:\$\(,\)\?)?$/.exec(pattern);
        const single = /^\$(\w+):expr$/.exec(pattern);
        const slots = pairs ? [pairs[1]!, pairs[2]!] : list ? [list[1]!] : single ? [single[1]!] : [];
        if (!slots.length) { unsupportedRule ||= pattern.length > 0; continue; }
        const render = (part: SyntaxNode): string => {
          if (part.type === 'metavariable') return part.text === '$crate' ? 'crate' : `__bridge_macro_${part.text.slice(1)}()`;
          let text = ''; let at = part.startIndex;
          for (const child of part.namedChildren) { text += part.text.slice(at - part.startIndex, child.startIndex - part.startIndex) + render(child); at = child.endIndex; }
          text += part.text.slice(at - part.startIndex);
          return part.type === 'token_repetition' ? text.replace(/^\$\(/, '').replace(/\)[+*?]$/, '') : text;
        };
        const expanded = parse(`fn __macro_probe() ${render(right)}`);
        if (!expanded) continue;
        const forwarded = new Set<string>();
        const walk = (part: SyntaxNode): void => {
          if (['macro_invocation', 'closure_expression'].includes(part.type)) return;
          if (part.type === 'call_expression') { const name = field(part, 'function')?.text; if (name?.startsWith('__bridge_macro_')) forwarded.add(name.slice('__bridge_macro_'.length)); }
          for (const child of part.namedChildren) walk(child);
        };
        if (!expanded.hasError) walk(expanded);
        result.macroContracts.push({ declaration, shape: pairs ? 'pairs' : list ? 'list' : 'single', forwardedSlots: slots.flatMap((slot, i) => forwarded.has(slot) ? [i] : []) });
      }
      if (unsupportedRule) result.macroContracts = result.macroContracts.filter(c => c.declaration.id !== declaration.id);
      return;
    }
    if (node.type === 'function_item' && field(node, 'body')) {
      const name = field(node, 'name')?.text;
      if (!name || node.hasError) return;
      const params = field(node, 'parameters')?.namedChildren ?? [];
      const summary: RustFunctionSummary = { id: `${filePath}:${node.startIndex}`, filePath, name, owner, ...(trait ? { trait: true } : {}), modulePath, imports: {}, invokedParameters: [], line: node.startPosition.row + 1, column: node.startPosition.column,
        returnType: typeName(field(node, 'return_type')) === 'Self' ? owner : typeName(field(node, 'return_type')),
        parameters: params.map(p => p.type === 'self_parameter' ? 'self' : field(p, 'pattern')?.text ?? ''), hasSelf: params.some(p => p.type === 'self_parameter') };
      functions.push({ node, summary }); result.functions.push(summary);
      const modifiers = node.namedChildren.find(n => n.type === 'function_modifiers');
      const abi = modifiers?.namedChildren.find(n => n.type === 'extern_modifier');
      const abiName = abi?.namedChildren.find(n => n.type === 'string_literal');
      if (abi && (!abiName || ['C', 'C-unwind'].includes(literal(abiName) ?? ''))) {
        const attrs: string[] = [];
        let previous = node.previousNamedSibling;
        while (previous && (previous.type === 'attribute_item' || previous.type.endsWith('comment'))) {
          if (previous.type === 'attribute_item') attrs.push(previous.text);
          previous = previous.previousNamedSibling;
        }
        const exported = attrs.map(a => /^#\[\s*(?:unsafe\(\s*)?export_name\s*=\s*("(?:[^"\\]|\\.)*")\s*\)?\s*\]$/.exec(a)?.[1]).find(Boolean);
        const noMangle = attrs.some(a => /^#\[\s*(?:unsafe\(\s*)?no_mangle\s*\)?\s*\]$/.test(a));
        let symbolName: string | undefined;
        if (exported) { try { symbolName = JSON.parse(exported) as string; } catch { /* unknown name */ } }
        else if (noMangle) symbolName = name;
        if (symbolName) result.exports.push({ symbolName, functionId: summary.id, filePath, line: summary.line });
      }
      return;
    }
    for (const child of node.namedChildren) collect(child, owner, modulePath, false, trait);
  }
  collectNamespaceBindings(root);
  collect(root);
  for (const { node: functionNode, summary } of functions) {
    summary.imports = Object.fromEntries(imports.get(summary.modulePath) ?? []);
    const env: Env = new Map([...statics].filter(([key]) => key.startsWith(`${summary.modulePath}\0`)).map(([key, value]) => [key.slice(summary.modulePath.length + 1), value]));
    const params = field(functionNode, 'parameters')?.namedChildren ?? [];
    params.forEach((p, index) => {
      if (p.type === 'self_parameter') env.set('self', { origins: [index], type: summary.owner });
      else bind(field(p, 'pattern'), { origins: [index], type: typeName(field(p, 'type')) }, env);
    });
    const returnedDispatches = new Set<RustDispatchSummary>();
    const activeCallbacks: RustCallbackRequirement[] = [];
    const activeClosures = new Set<number>();
    const closureResults = new Map<string, Value>();
    function evaluate(node: SyntaxNode | null, scope: Env): Value {
      if (!node) return unknown();
      if (node.type === 'identifier' || node.type === 'self') return scope.get(node.text) ?? (unitStructs.has(`${summary.modulePath}\0${node.text}`) ? { origins: [], type: node.text } : unknown());
      if (node.type === 'function_item') return unknown();
      if (node.type === 'macro_invocation') {
        const macroName = field(node, 'macro')?.text;
        const tokens = node.namedChildren.find(n => n.type === 'token_tree');
        if (!macroName || !tokens) return unknown();
        const groups: SyntaxNode[][] = [[]];
        for (const token of tokens.children.slice(1, -1)) {
          if (token.text === ',') groups.push([]); else groups[groups.length - 1]!.push(token);
        }
        const nonempty = groups.filter(g => g.length);
        const pairs = nonempty.length > 0 && nonempty.every(g => g.filter(t => t.text === '=>').length === 1);
        const fragments: Array<{ source: string; slot: number; shape: 'pairs' | 'list' | 'single' }> = [];
        for (const group of nonempty) {
          if (pairs) {
            const split = group.findIndex(t => t.text === '=>');
            for (const [slot, parts] of [group.slice(0, split), group.slice(split + 1)].entries()) if (parts.length) fragments.push({ source: parts.map(p => p.text).join(' '), slot, shape: 'pairs' });
          } else {
            fragments.push({ source: group.map(p => p.text).join(' '), slot: 0, shape: 'list' });
            if (nonempty.length === 1) fragments.push({ source: group.map(p => p.text).join(' '), slot: 0, shape: 'single' });
          }
        }
        for (const fragment of fragments) {
          // Most macros contain no tracked function value. Avoid reparsing
          // their token payloads; this filter can only skip impossible proofs.
          if (!(fragment.source.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some(name => scope.get(name)?.callResults?.length)) continue;
          const parsed = parse(`fn __macro_argument(){ ${fragment.source} }`);
          if (!parsed) continue;
          const scan = (part: SyntaxNode): void => {
            if (['closure_expression', 'macro_invocation', 'let_declaration'].includes(part.type)) return;
            if (part.type === 'block' && part.namedChildren.some(c => c.type === 'let_declaration')) return;
            if (part.type === 'call_expression') {
              const callee = field(part, 'function');
              if (callee?.type === 'identifier') for (const id of scope.get(callee.text)?.callResults ?? []) {
                const call = callById.get(id);
                if (call) (call.invocationProofs ??= []).push({ callbacks: [...activeCallbacks], macro: { callerId: summary.id, name: macroName, shape: fragment.shape, slot: fragment.slot } });
              }
            }
            for (const child of part.namedChildren) scan(child);
          };
          if (!parsed.hasError) scan(parsed);
        }
        return unknown();
      }
      if (node.type === 'block') {
        const local = new Map(scope);
        // Rust items are block-scoped and order-independent, including uses
        // that shadow a standard conversion imported by the enclosing module.
        for (const child of significant(node)) {
          if (child.type === 'use_declaration') {
            const argument = field(child, 'argument');
            const names = new Map<string, string>();
            if (argument) {
              collectUse(argument, names);
              if (argument.type === 'use_wildcard' || argument.descendantsOfType('use_wildcard').length) local.set('*', unknown());
            }
            for (const [name, importPath] of names) local.set(name, { origins: [], importPath });
          } else if (['mod_item', 'function_item', 'struct_item', 'enum_item', 'type_item'].includes(child.type)) {
            const name = field(child, 'name')?.text;
            if (name) local.set(name, { origins: [], namespace: true });
          }
        }
        let value = unknown();
        for (const child of significant(node)) {
          if (['use_declaration', 'mod_item', 'struct_item', 'enum_item', 'type_item'].includes(child.type)) continue;
          value = evaluate(child, local);
        }
        // Writes through a nested scope can rebind an outer operation or
        // function pointer. Do not retain the old proof across that scope.
        invalidateWrites(node, scope);
        return value;
      }
      if (node.type === 'reference_expression') {
        const referenced = field(node, 'value') ?? significant(node).at(-1) ?? null;
        const value = evaluate(referenced, scope);
        if (node.namedChildren.some(n => n.type === 'mutable_specifier') && referenced?.type === 'identifier') {
          scope.set(referenced.text, forget(scope.get(referenced.text)));
        }
        return value;
      }
      if (['unsafe_block', 'parenthesized_expression', 'try_expression'].includes(node.type)) return evaluate(significant(node).at(-1) ?? null, scope);
      if (node.type === 'tuple_expression') return { origins: [], tuple: significant(node).map(n => evaluate(n, scope)) };
      if (node.type === 'let_declaration') {
        const value = evaluate(field(node, 'value'), scope);
        const annotated = typeName(field(node, 'type'));
        bind(field(node, 'pattern'), annotated ? { ...value, type: annotated } : value, scope);
        return unknown();
      }
      if (node.type === 'assignment_expression') {
        const value = evaluate(field(node, 'right'), scope);
        bind(field(node, 'left'), value, scope);
        return unknown();
      }
      if (node.type === 'struct_expression') return { origins: [], type: typeName(field(node, 'name')) };
      if (node.type === 'if_expression') {
        const condition = field(node, 'condition');
        const local = new Map(scope);
        if (condition?.type === 'let_condition') bind(field(condition, 'pattern'), evaluate(field(condition, 'value'), scope), local);
        else evaluate(condition, scope);
        const yes = evaluate(field(node, 'consequence'), local);
        const no = evaluate(field(node, 'alternative'), new Map(scope));
        invalidateWrites(node, scope);
        return merge([yes, no]);
      }
      if (node.type === 'closure_expression') return { origins: [], closure: { node, scope: new Map(scope) } };
      if (node.type === 'match_expression') {
        const value = evaluate(field(node, 'value'), scope);
        const outputs: Value[] = [];
        // Arms are tried in order. An earlier wildcard or identical literal makes a
        // literal arm unreachable; an earlier guarded or conditional literal arm may take that
        // literal, and an earlier non-literal pattern may take any value.
        let catchAll = false;
        let contestedAll = false;
        const contested = new Set<string>();
        const claimed = new Set<string>();
        for (const arm of field(node, 'body')?.namedChildren ?? []) {
          if (arm.type !== 'match_arm') continue;
          const pattern = field(arm, 'pattern');
          const guard = pattern ? field(pattern, 'condition') : null;
          const shape = pattern?.namedChildren.find(child => child.id !== guard?.id) ?? null;
          const operations = literalAlternatives(shape);
          // An attribute (e.g. #[cfg]) may compile the arm out: it neither proves nor shadows a literal.
          const conditional = arm.namedChildren.some(child => child.type === 'attribute_item' || child.type === 'inner_attribute_item');
          const armValue = field(arm, 'value');
          const local = new Map(scope);
          bind(pattern, value, local);
          const possibleParameters = possibleOrigins(value);
          const potentialDispatch = !!operations && possibleParameters.length > 0;
          if (potentialDispatch) result.potentialDispatchParameters[summary.id] = [...new Set([
            ...(result.potentialDispatchParameters[summary.id] ?? []), ...possibleParameters,
          ])];
          const wrappers = new Set(['Some', 'Ok'].filter(name => !local.has(name) && !summary.imports[name] && !result.functions.some(f => f.name === name && !f.owner && f.modulePath === summary.modulePath)));
          const armShape = dispatchArm(armValue, wrappers);
          const armTarget = target(armShape?.node ?? null, local, summary.owner);
          // Guards can select a different target for the same literal. Leave
          // guarded mappings unresolved rather than claiming exclusivity.
          const armDispatches: RustDispatchSummary[] = [];
          if (potentialDispatch) {
            const unknownTarget = !armTarget || (armTarget.method && !armTarget.owner) ||
              (armShape?.node.type === 'identifier' && local.has(armShape.node.text) && !local.get(armShape.node.text)?.importPath);
            for (const operation of operations!) {
              if (catchAll || claimed.has(operation)) continue;
              const unresolved = unknownTarget || conditional || contestedAll || contested.has(operation);
              const dispatch: RustDispatchSummary = { functionId: summary.id, operation, parameterIndex: value.origins.length === 1 ? value.origins[0]! : -1, targetName: armTarget?.name ?? '',
                targetOwner: armTarget?.owner, line: arm.startPosition.row + 1, returnsFunction: !unresolved && !!armShape?.returnsFunction, requiredCallbacks: [...activeCallbacks],
                guarded: !!guard, unresolved: !!unresolved };
              armDispatches.push(dispatch);
              result.dispatches.push(dispatch);
            }
          }
          if (conditional || guard) { if (operations) operations.forEach(operation => contested.add(operation)); else contestedAll = true; }
          else if (!shape && pattern?.children.some(child => child.type === '_')) catchAll = true;
          else if (operations) operations.forEach(operation => claimed.add(operation));
          else contestedAll = true;
          const output = evaluate(armValue, local);
          const returned = armDispatches.filter(dispatch => dispatch.returnsFunction);
          if (returned.length) output.dispatchResults = returned;
          if (armValue?.type !== 'return_expression') outputs.push(output);
        }
        invalidateWrites(node, scope);
        return merge(outputs);
      }
      if (node.type === 'call_expression') {
        const callee = field(node, 'function');
        const args = field(node, 'arguments')?.namedChildren ?? [];
        const values = args.map(arg => evaluate(arg, scope));
        const to = target(callee, scope, summary.owner);
        const plainCallee = callee?.type === 'generic_function' ? field(callee, 'function') : callee;
        const calleeParts = (plainCallee?.text ?? '').split('::');
        const importedHead = scope.get(calleeParts[0]!)?.importPath ??
          (!scope.has(calleeParts[0]!) && imports.get(summary.modulePath)?.get(calleeParts[0]!));
        const canonicalCallee = importedHead ? [importedHead, ...calleeParts.slice(1)].join('::') : plainCallee?.text ?? '';
        for (const arg of args) if (arg.type === 'reference_expression' && arg.namedChildren.some(n => n.type === 'mutable_specifier')) {
          const value = field(arg, 'value');
          if (value?.type === 'identifier') scope.set(value.text, forget(scope.get(value.text)));
        }
        if (callee?.type === 'field_expression' && !NON_MUTATING_RECEIVER_METHODS.has(to?.name ?? '')) {
          const receiver = field(callee, 'value');
          if (receiver && ['identifier', 'self'].includes(receiver.type) && scope.get(receiver.text)?.origins.length) scope.set(receiver.text, forget(scope.get(receiver.text)));
        }
        // Evaluate chained receivers, but do not guess their type.
        if (callee?.type === 'field_expression') evaluate(field(callee, 'value'), scope);
        const invokeClosure = (value: Value | undefined, arguments_: Value[] = []): Value => {
          if (!value?.closure) {
            if (!activeCallbacks.length) for (const index of value?.origins ?? []) if (!summary.invokedParameters.includes(index)) summary.invokedParameters.push(index);
            return unknown();
          }
          const closureId = value.closure.node.id;
          if (activeClosures.has(closureId)) return unknown();
          // The same body with the same captures, arguments and callback context records the same facts.
          const key = `${valueKey(value)}|${arguments_.map(valueKey).join('|')}|${JSON.stringify(activeCallbacks)}`;
          const cached = closureResults.get(key);
          if (cached) return cached;
          const local = new Map(value.closure.scope);
          (field(value.closure.node, 'parameters')?.namedChildren ?? []).forEach((p, i) => bind(p, arguments_[i] ?? unknown(), local));
          activeClosures.add(closureId);
          try {
            const returned = evaluate(field(value.closure.node, 'body'), local);
            closureResults.set(key, returned);
            return returned;
          } finally { activeClosures.delete(closureId); }
        };
        if (to?.method && to.name === 'with' && to.receiver?.threadLocal) invokeClosure(values[0], [{ ...to.receiver, threadLocal: false }]);
        if (callee?.type === 'identifier' && scope.get(callee.text)?.closure) return invokeClosure(scope.get(callee.text), values);
        // Standard unwind wrappers execute/preserve their callback. Unknown
        // higher-order functions cannot activate a dormant closure by name.
        if (['std::panic::catch_unwind', 'core::panic::catch_unwind'].includes(canonicalCallee) && standardNamespace(canonicalCallee, summary.modulePath, scope)) invokeClosure(values[0]);
        if (['std::panic::AssertUnwindSafe', 'core::panic::AssertUnwindSafe'].includes(canonicalCallee) && standardNamespace(canonicalCallee, summary.modulePath, scope)) return values[0] ?? unknown();
        if (to && !(to.method && to.name === 'with' && to.receiver?.threadLocal) && !(['std::panic::catch_unwind', 'core::panic::catch_unwind'].includes(canonicalCallee) && standardNamespace(canonicalCallee, summary.modulePath, scope))) {
          values.forEach((value, parameterIndex) => {
            if (!value.closure) return;
            activeCallbacks.push({ callerId: summary.id, targetName: to.name, targetOwner: to.owner, parameterIndex, method: to.method });
            invokeClosure(value); activeCallbacks.pop();
          });
        }
        if (callee?.type === 'identifier') for (const id of scope.get(callee.text)?.callResults ?? []) {
          const call = callById.get(id); if (call) {
            if (!activeCallbacks.length) call.resultInvoked = true;
            else (call.invocationProofs ??= []).push({ callbacks: [...activeCallbacks] });
          }
        }
        if (callee?.type === 'identifier' && scope.has(callee.text) && !scope.get(callee.text)?.importPath) {
          if (!activeCallbacks.length) for (const index of scope.get(callee.text)?.origins ?? []) if (!summary.invokedParameters.includes(index)) summary.invokedParameters.push(index);
          return unknown();
        }
        if (to && (!to.method || to.owner)) {
          const call: RustCallSummary = { id: `${summary.id}:${node.startIndex}`, fromFunctionId: summary.id, targetName: to.name, targetOwner: to.owner,
            argumentOrigins: values.map(v => v.origins), argumentPossibilities: values.map(possibleOrigins), method: to.method, resultInvoked: false, requiredCallbacks: [...activeCallbacks], line: node.startPosition.row + 1 };
          result.calls.push(call); callById.set(call.id, call);
          // A function result is opaque, except known byte/string-preserving
          // conversions. These are library semantics, not project mappings.
          const path = canonicalCallee;
          if (['std::str::from_utf8', 'core::str::from_utf8'].includes(path) && standardNamespace(path, summary.modulePath, scope)) return { ...(values[0] ?? unknown()), type: 'str', wrapped: true };
          if (['std::slice::from_raw_parts', 'core::slice::from_raw_parts'].includes(path) && standardNamespace(path, summary.modulePath, scope)) return { ...(values[0] ?? unknown()), type: '[u8]' };
          if (to.method && to.receiver?.borrowContainer && ['borrow', 'borrow_mut', 'try_borrow', 'try_borrow_mut'].includes(to.name)) return { ...to.receiver, type: to.receiver.borrowedType, borrowContainer: false, borrowedType: undefined, wrapped: to.name.startsWith('try_') };
          const textType = to.receiver?.type;
          const canonicalType = textType && (scope.get(textType)?.importPath ?? imports.get(summary.modulePath)?.get(textType) ?? textType);
          const standardText = textType && !declaredTypes.has(textType) && !scope.get(textType)?.namespace && (['str', '[u8]'].includes(canonicalType!) || (['String', 'std::string::String', 'alloc::string::String'].includes(canonicalType!) && standardNamespace(canonicalType === 'String' ? 'std::string::String' : canonicalType!, summary.modulePath, scope)));
          if (to.method && standardText && ['as_str', 'as_bytes', 'as_ptr', 'to_owned', 'to_string'].includes(to.name)) return to.receiver!;
          if (to.method && to.receiver?.wrapped && ['unwrap', 'expect'].includes(to.name)) return { ...to.receiver, wrapped: false };
          if (['Some', 'Ok'].includes(to.name) && !to.owner && !summary.imports[to.name] && !result.functions.some(f => f.name === to.name && !f.owner && f.modulePath === summary.modulePath)) return values[0] ?? unknown();
          const definitions = !to.owner && summary.imports[to.name] ? [] : result.functions.filter(f => f.name === to.name && f.owner === to.owner && f.modulePath === summary.modulePath);
          return { origins: [], callResults: [call.id], possibleOrigins: [...new Set([
            ...values.flatMap(possibleOrigins), ...(to.receiver ? possibleOrigins(to.receiver) : []),
          ])],
            type: definitions.length === 1 ? definitions[0]!.returnType : undefined, wrapped: definitions.length === 1 && ['Option', 'Result'].includes(definitions[0]!.returnType ?? '') && !declaredTypes.has(definitions[0]!.returnType!) };
        }
        return unknown();
      }
      if (node.type === 'return_expression') {
        const returned = evaluate(significant(node).at(-1) ?? null, scope);
        for (const dispatch of returned.dispatchResults ?? []) returnedDispatches.add(dispatch);
        return returned;
      }
      if (node.type === 'expression_statement') { evaluate(significant(node).at(-1) ?? null, scope); return unknown(); }
      // Traverse control-flow bodies with independent lexical scopes. Unknown
      // expressions cannot manufacture an origin simply by mentioning it.
      const children = significant(node).map(child => evaluate(child, new Map(scope)));
      invalidateWrites(node, scope);
      return { origins: [], possibleOrigins: [...new Set(children.flatMap(possibleOrigins))] };
    }
    const returned = evaluate(field(functionNode, 'body'), env);
    for (const dispatch of returned.dispatchResults ?? []) returnedDispatches.add(dispatch);
    result.dispatches = result.dispatches.filter(d => d.functionId !== summary.id || !d.returnsFunction || returnedDispatches.has(d));
  }
  return result;
}

/** A source-identity oracle supplied by the integration layer when Cargo or
 * module-file metadata proves where an imported type is defined. */
export type RustOwnerResolver = (ownerPath: string, caller: RustFunctionSummary, candidates: RustFunctionSummary[]) => RustFunctionSummary | undefined;

function functionsByName(functions: RustFunctionSummary[]): Map<string, RustFunctionSummary[]> {
  const index = new Map<string, RustFunctionSummary[]>();
  for (const fn of functions) {
    const matches = index.get(fn.name) ?? [];
    matches.push(fn); index.set(fn.name, matches);
  }
  return index;
}

function functionResolver(functions: RustFunctionSummary[], resolveOwner?: RustOwnerResolver,
  byName = functionsByName(functions)): (name: string, owner: string | undefined, caller: RustFunctionSummary) => RustFunctionSummary | undefined {
  const named = new Map<string, RustFunctionSummary[]>();
  for (const fn of functions) {
    const key = `${fn.filePath}\0${fn.modulePath}\0${fn.owner ?? ''}\0${fn.name}`;
    const matches = named.get(key) ?? []; matches.push(fn); named.set(key, matches);
  }
  return (name, owner, caller) => {
    if (!owner) {
      const imported = caller.imports[name];
      if (imported) {
        const declaredName = imported.split('::').pop();
        return resolveOwner?.(imported, caller, (byName.get(declaredName ?? '') ?? []).filter(f => !f.owner));
      }
      const matches = named.get(`${caller.filePath}\0${caller.modulePath}\0\0${name}`) ?? [];
      return matches.length === 1 ? matches[0] : undefined;
    }

    const parts = owner.split('::').filter(Boolean);
    const imported = caller.imports[parts[0]!];
    const canonicalOwner = imported ? [imported, ...parts.slice(1)].join('::') : owner;
    const candidates = byName.get(name) ?? [];
    if (!imported && !owner.startsWith('::')) {
      const modules = caller.modulePath.split('::').filter(Boolean);
      if (parts[0] === 'crate') { modules.length = 0; parts.shift(); }
      else if (parts[0] === 'self') parts.shift();
      while (parts[0] === 'super') { if (!modules.length) return undefined; modules.pop(); parts.shift(); }
      const qualified = [...modules, ...parts];
      const freeModule = qualified.map(p => `::${p}`).join('');
      const typeName = qualified.pop();
      const typeModule = qualified.map(p => `::${p}`).join('');
      const local = [
        ...(named.get(`${caller.filePath}\0${freeModule}\0\0${name}`) ?? []),
        ...(typeName ? named.get(`${caller.filePath}\0${typeModule}\0${typeName}\0${name}`) ?? [] : []),
      ];
      if (local.length) return local.length === 1 ? local[0] : undefined;
    }
    // The same Rust path syntax denotes either a module's free function or a
    // type's associated function. Require one source identity across both.
    const free = resolveOwner?.(`${canonicalOwner}::${name}`, caller, candidates.filter(f => !f.owner));
    const method = resolveOwner?.(canonicalOwner, caller, candidates.filter(f => !!f.owner));
    if (free && method && free.id !== method.id) return undefined;
    return free ?? method;
  };
}

/** Resolve only unique source definitions and propagate a discriminant's
 * parameter backwards through actual call arguments to the C ABI export. */
export function resolveRustFfiDispatch(files: RustFfiFileAnalysis[], resolveOwner?: RustOwnerResolver): RustFfiDispatchRoute[] {
  const functions = files.flatMap(f => f.functions);
  const byId = new Map(functions.map(f => [f.id, f]));
  const resolve = functionResolver(functions.filter(f => !f.trait), resolveOwner);
  const callbackProof = (requirements: RustCallbackRequirement[] | undefined): boolean => (requirements ?? []).every(requirement => {
    const caller = byId.get(requirement.callerId);
    const target = caller && resolve(requirement.targetName, requirement.targetOwner, caller);
    return !!target?.invokedParameters.includes(requirement.parameterIndex + (requirement.method && target.hasSelf ? 1 : 0));
  });
  const macroContracts = files.flatMap(f => f.macroContracts);
  const macroProof = (proof: RustInvocationProof): boolean => {
    if (!callbackProof(proof.callbacks)) return false;
    if (!proof.macro) return true;
    const { callerId, name, shape, slot } = proof.macro;
    const caller = byId.get(callerId);
    if (!caller) return false;
    const imported = caller.imports[name];
    const matching = macroContracts.filter(c => c.declaration.name === (imported ?? name).split('::').pop() && c.shape === shape);
    const declarations = files.flatMap(f => f.macroDefinitions).filter(d => d.name === (imported ?? name).split('::').pop());
    const local = declarations.filter(d => d.filePath === caller.filePath && d.modulePath === caller.modulePath);
    const declaration = !imported && !name.includes('::') && local.length === 1 ? local[0] : resolveOwner?.(imported ?? name, caller, declarations);
    if (!declaration) return false;
    const contracts = matching.filter(c => c.declaration.id === declaration.id);
    return contracts.length > 0 && contracts.every(c => c.forwardedSlots.includes(slot));
  };
  const incoming = new Map<string, Array<{ call: RustCallSummary; from: RustFunctionSummary; to: RustFunctionSummary }>>();
  for (const call of files.flatMap(f => f.calls)) {
    if (!callbackProof(call.requiredCallbacks)) continue;
    const from = byId.get(call.fromFunctionId);
    const to = from && resolve(call.targetName, call.targetOwner, from);
    if (!from || !to) continue;
    const list = incoming.get(to.id) ?? [];
    list.push({ call, from, to }); incoming.set(to.id, list);
  }
  const exports = files.flatMap(f => f.exports);
  const output: RustFfiDispatchRoute[] = [];
  const seenRoutes = new Set<string>();
  const dispatches = files.flatMap(f => f.dispatches);
  const dispatchGroups = new Map<string, RustDispatchSummary[]>();
  for (const dispatch of dispatches) {
    const key = `${dispatch.functionId}\0${dispatch.operation}`;
    const group = dispatchGroups.get(key) ?? []; group.push(dispatch); dispatchGroups.set(key, group);
  }
  for (const dispatch of dispatches) {
    const dispatcher = byId.get(dispatch.functionId);
    const handler = dispatcher && resolve(dispatch.targetName, dispatch.targetOwner, dispatcher);
    if (!dispatcher || !handler || dispatch.parameterIndex < 0 || dispatch.guarded || dispatch.unresolved || !callbackProof(dispatch.requiredCallbacks)) continue;
    const siblings = dispatchGroups.get(`${dispatch.functionId}\0${dispatch.operation}`)!;
    if (siblings.some(d => d.guarded || d.unresolved || d.targetName !== dispatch.targetName || d.targetOwner !== dispatch.targetOwner)) continue;
    const explored = new Set<string>();
    const visit = (current: RustFunctionSummary, index: number, path: RustFunctionSummary[], functionInvoked: boolean): void => {
      const key = `${current.id}:${index}:${functionInvoked}`;
      if (explored.has(key)) return;
      explored.add(key);
      for (const exported of exports) if (exported.functionId === current.id && functionInvoked) {
        const routeKey = `${exported.functionId}:${index}:${dispatch.operation}:${handler.id}`;
        if (!seenRoutes.has(routeKey)) {
          seenRoutes.add(routeKey);
          output.push({ export: exported, operation: dispatch.operation, exportParameterIndex: index, target: handler, dispatcher,
            callPath: [...path].reverse(), dispatchLine: dispatch.line });
        }
      }
      for (const { call, from, to } of incoming.get(current.id) ?? []) {
        const argument = index - (call.method && to.hasSelf ? 1 : 0);
        if (argument < 0) continue;
        const origins = call.argumentOrigins[argument];
        if (origins?.length !== 1) continue;
        // Only the immediate dispatcher call may prove invocation of the
        // returned function. Calling an unrelated wrapper result is no proof.
        const invoked = functionInvoked || (current.id === dispatcher.id && (call.resultInvoked || (call.invocationProofs?.some(macroProof) ?? false)));
        visit(from, origins[0]!, [...path, from], invoked);
      }
    };
    visit(dispatcher, dispatch.parameterIndex, [dispatcher], !dispatch.returnsFunction);
  }
  return output;
}

/** Exports connected to a dispatch table even when parameter propagation or
 * function-pointer invocation remains unproven. Consumers must treat these as
 * transport-only boundaries, not fan out through the unspecialized Rust graph. */
export function findRustDispatchingExports(files: RustFfiFileAnalysis[], resolveOwner?: RustOwnerResolver): Set<string> {
  const functions = files.flatMap(f => f.functions);
  const byId = new Map(functions.map(f => [f.id, f]));
  const byName = functionsByName(functions);
  const predecessors = new Map<string, Array<{ from: RustFunctionSummary; to: RustFunctionSummary; call: RustCallSummary }>>();
  const resolve = functionResolver(functions.filter(f => !f.trait), resolveOwner);
  for (const call of files.flatMap(f => f.calls)) {
    const from = byId.get(call.fromFunctionId);
    if (!from) continue;
    const exact = resolve(call.targetName, call.targetOwner, from);
    // Boundary classification may over-approximate unresolved imported owners;
    // it only prevents fanout and NEVER supplies a semantic handler edge.
    const ownerName = call.targetOwner?.split('::').pop();
    const candidates = exact ? [exact] : call.targetOwner ? (byName.get(call.targetName) ?? []).filter(f => f.owner?.split('::').pop() === ownerName) : [];
    for (const to of candidates) {
      const parents = predecessors.get(to.id) ?? [];
      parents.push({ from, to, call }); predecessors.set(to.id, parents);
    }
  }
  const reachable = new Set<string>();
  const dispatching = new Set<string>();
  const exports = new Set(files.flatMap(file => file.exports.map(exported => exported.functionId)));
  const pending = files.flatMap(file => Object.entries(file.potentialDispatchParameters)
    .flatMap(([functionId, indices]) => indices.map(index => ({ functionId, index }))));
  while (pending.length) {
    const { functionId, index } = pending.pop()!;
    const key = `${functionId}:${index}`;
    if (reachable.has(key)) continue;
    reachable.add(key);
    if (exports.has(functionId)) dispatching.add(functionId);
    for (const { from, to, call } of predecessors.get(functionId) ?? []) {
      const argumentIndex = index - (call.method && to.hasSelf ? 1 : 0);
      if (argumentIndex < 0) continue;
      for (const origin of call.argumentPossibilities[argumentIndex] ?? []) pending.push({ functionId: from.id, index: origin });
    }
  }
  return dispatching;
}
