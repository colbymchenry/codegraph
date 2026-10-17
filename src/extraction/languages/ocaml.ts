import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

// Node names follow tree-sitter-ocaml's two grammars (`ocaml` for `.ml`,
// `interface` for `.mli`), which share one vocabulary: the interface grammar
// swaps `let` for `val` specs and signatures. Names are looked up by child TYPE
// rather than field name, so a binding's name is found whichever way the grammar
// labels it.
//
// OCaml declarations nest (`module M = struct … end`, `let` inside `let`), and a
// `let_binding` is a function, a constant or a unit effect depending on its
// shape, so the top-level forms are dispatched through the visitNode hook:
//   - `let f x = …` / `let f = fun x -> …` → function; `let v = 42` → constant;
//     `let () = …` has no name, so its calls attach to the enclosing scope;
//   - `type t = A | B` → enum + members, `type t = {…}` → struct + fields,
//     any other `type` → type alias;
//   - `module M = struct … end` → module (its members are scoped under it, so
//     `M.f x` is emitted as `M::f` and resolves by qualified name);
//   - `module type S = sig … end` → interface; `val` specs (`.mli`) → functions, or methods of a module type.
// Each file is itself a module (`util.ml` → `Util`).
// Classes (`class c = object … end`) use the generic class/method walk.
// Local `let`s are not symbols: their calls belong to the enclosing function.

const collapseWs = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** `A.B` of a `module_path` → `A::B`. */
const pathOf = (modPath: SyntaxNode, source: string): string =>
  getNodeText(modPath, source).replace(/\s+/g, '').replace(/\./g, '::');

// Module aliases of a file (`module U = Util`, `let module D = Util.Deep in`), by tree.
const aliasMemo = new WeakMap<object, Map<string, string>>();

function aliasesOf(node: SyntaxNode, source: string): Map<string, string> {
  let aliases = aliasMemo.get(node.tree);
  if (aliases) return aliases;
  aliases = new Map();
  for (const def of node.tree.rootNode.descendantsOfType('module_definition')) {
    for (const binding of def.namedChildren) {
      const name = binding.namedChildren.find((c) => c.type === 'module_name');
      const body = getChildByField(binding, 'body');
      if (name && body?.type === 'module_path') aliases.set(getNodeText(name, source), pathOf(body, source));
    }
  }
  aliasMemo.set(node.tree, aliases);
  return aliases;
}

/** `U::double` → `Util::double`: follow the leading module through the file's aliases. */
function expandAlias(path: string, node: SyntaxNode, source: string): string {
  const aliases = aliasesOf(node, source);
  for (let depth = 0; depth < 8; depth++) {
    const [head, ...rest] = path.split('::');
    const target = aliases.get(head!);
    if (!target) break;
    path = [target, ...rest].join('::');
  }
  return path;
}

/** `Foo.Bar.baz` from a `value_path` → `Foo::Bar::baz`; null for non-identifier callees. */
function calleeName(fn: SyntaxNode, source: string): string | null {
  if (fn.type !== 'value_path') return null;
  const name = fn.namedChildren.find((c) => c.type === 'value_name');
  if (!name) return null;
  const modPath = fn.namedChildren.find((c) => c.type === 'module_path');
  const base = getNodeText(name, source);
  return modPath ? expandAlias(`${pathOf(modPath, source)}::${base}`, fn, source) : base;
}

/** Binding name: `value_name`, or an operator in parens (`(>>=)`). Null for patterns like `()` or `(a, b)`. */
function bindingName(pattern: SyntaxNode | null, source: string): string | null {
  if (!pattern) return null;
  if (pattern.type === 'value_name') return getNodeText(pattern, source);
  if (pattern.type === 'parenthesized_operator') return collapseWs(getNodeText(pattern, source)).replace(/^\(\s*|\s*\)$/g, '');
  return null;
}

/** Binding text up to its body, without the trailing `=` (`add x y`). */
function headerOf(node: SyntaxNode, body: SyntaxNode | null, source: string): string {
  const end = body ? body.startIndex : node.endIndex;
  return collapseWs(source.substring(node.startIndex, end)).replace(/\s*=$/, '').slice(0, 200);
}

const child = (node: SyntaxNode, ...types: string[]): SyntaxNode | undefined =>
  node.namedChildren.find((c) => types.includes(c.type));

/** A file is a module named after it: `lib/util_x.ml(i)` is `Util_x`, so `Util_x.f` resolves as `Util_x::f`. */
function handleCompilationUnit(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const base = (ctx.filePath.split(/[\\/]/).pop() ?? '').replace(/\.mli?$/, '');
  if (!base) return false;
  const mod = ctx.createNode('module', base.charAt(0).toUpperCase() + base.slice(1), node);
  if (!mod) return false;
  ctx.pushScope(mod.id);
  for (const child of node.namedChildren) ctx.visitNode(child);
  ctx.popScope();
  return true;
}

function handleValueDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const docstring = getPrecedingDocstring(node, ctx.source);
  for (const binding of node.namedChildren) {
    if (binding.type !== 'let_binding') continue;
    const body = getChildByField(binding, 'body');
    const name = bindingName(getChildByField(binding, 'pattern'), ctx.source);
    if (!name) {
      if (body) ctx.visitFunctionBody(body, parentId);
      continue;
    }
    const isFunction =
      binding.namedChildren.some((c) => c.type === 'parameter') ||
      body?.type === 'fun_expression' ||
      body?.type === 'function_expression';
    const sym = ctx.createNode(isFunction ? 'function' : 'constant', name, binding, {
      docstring,
      signature: headerOf(binding, body, ctx.source),
    });
    if (!sym || !body) continue;
    ctx.pushScope(sym.id);
    // `let open M in …` / `M.(…)` bring M's names into scope inside this binding.
    for (const open of binding.descendantsOfType(['open_module', 'local_open_expression'])) {
      const path = child(open, 'module_path');
      if (!path) continue;
      const moduleName = getNodeText(path, ctx.source).replace(/\s+/g, '');
      ctx.createNode('import', moduleName, open, { signature: collapseWs(getNodeText(open, ctx.source)).slice(0, 100) });
      ctx.addUnresolvedReference({
        fromNodeId: sym.id,
        referenceName: moduleName,
        referenceKind: 'imports',
        line: open.startPosition.row + 1,
        column: open.startPosition.column,
      });
    }
    ctx.visitFunctionBody(binding, sym.id); // whole binding: default-arg expressions count too
    ctx.popScope();
  }
  return true;
}

function handleTypeDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const docstring = getPrecedingDocstring(node, ctx.source);
  for (const binding of node.namedChildren) {
    if (binding.type !== 'type_binding') continue;
    const nameNode = getChildByField(binding, 'name');
    if (!nameNode) continue;
    const name = getNodeText(nameNode, ctx.source);
    const signature = collapseWs(getNodeText(binding, ctx.source)).slice(0, 200);
    const variant = binding.namedChildren.find((c) => c.type === 'variant_declaration');
    const record = binding.namedChildren.find((c) => c.type === 'record_declaration');
    const members = variant ?? record;
    const sym = ctx.createNode(variant ? 'enum' : record ? 'struct' : 'type_alias', name, binding, {
      docstring,
      signature,
    });
    if (!sym || !members) continue;
    ctx.pushScope(sym.id);
    for (const m of members.namedChildren) {
      const label = m.namedChildren.find((c) => c.type === 'constructor_name' || c.type === 'field_name');
      if (label) ctx.createNode(variant ? 'enum_member' : 'field', getNodeText(label, ctx.source), m);
    }
    ctx.popScope();
  }
  return true;
}

function handleModuleDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const docstring = getPrecedingDocstring(node, ctx.source);
  for (const binding of node.namedChildren) {
    if (binding.type !== 'module_binding') continue;
    const nameNode = child(binding, 'module_name');
    if (!nameNode) continue;
    const body = getChildByField(binding, 'body');
    const mod = ctx.createNode('module', getNodeText(nameNode, ctx.source), binding, {
      docstring,
      signature: headerOf(binding, body ?? null, ctx.source),
    });
    // The members: a `struct … end` body (`.ml`) or, in an `.mli`, the `sig … end` the module is declared with.
    // `module M : S = struct … end` / functor results wrap it; take the first one found.
    const members =
      [body, getChildByField(binding, 'module_type')]
        .map((n) => (n && (n.type === 'structure' || n.type === 'signature') ? n : n?.namedChildren.find((c) => c.type === 'structure' || c.type === 'signature')))
        .find(Boolean);
    if (!mod || !members) continue;
    ctx.pushScope(mod.id);
    for (const item of members.namedChildren) ctx.visitNode(item);
    ctx.popScope();
  }
  return true;
}

function handleModuleType(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = child(node, 'module_type_name');
  if (!nameNode) return true;
  const sig = ctx.createNode('interface', getNodeText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
  });
  const body = getChildByField(node, 'body');
  if (!sig || body?.type !== 'signature') return true;
  ctx.pushScope(sig.id);
  for (const item of body.namedChildren) ctx.visitNode(item);
  ctx.popScope();
  return true;
}

/** `val f : int -> int` — a method of the module type it is declared in, otherwise a function of its module. */
function handleValueSpecification(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = child(node, 'value_name', 'parenthesized_operator');
  const label = bindingName(name ?? null, ctx.source);
  if (label) {
    const inModuleType = node.parent?.parent?.type === 'module_type_definition';
    ctx.createNode(inModuleType ? 'method' : 'function', label, node, {
      docstring: getPrecedingDocstring(node, ctx.source),
      signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    });
  }
  return true;
}

function handleException(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const ctor = node.namedChildren.find((c) => c.type === 'constructor_declaration');
  const name = ctor?.namedChildren.find((c) => c.type === 'constructor_name');
  if (name) {
    ctx.createNode('class', getNodeText(name, ctx.source), node, {
      docstring: getPrecedingDocstring(node, ctx.source),
      signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    });
  }
  return true;
}

function handleExternal(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const name = node.namedChildren.find((c) => c.type === 'value_name');
  if (name) {
    ctx.createNode('function', getNodeText(name, ctx.source), node, {
      docstring: getPrecedingDocstring(node, ctx.source),
      signature: collapseWs(getNodeText(node, ctx.source)).slice(0, 200),
    });
  }
  return true;
}

const CLASS_NAME_NODE: Record<string, string> = {
  class_binding: 'class_name',
  method_definition: 'method_name',
  instance_variable_definition: 'instance_variable_name',
};

export const ocamlExtractor: LanguageExtractor = {
  functionTypes: [], // let-bindings are dispatched via visitNode
  classTypes: ['class_binding'],
  methodTypes: ['method_definition'],
  interfaceTypes: [], // module types are dispatched via visitNode
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['open_module', 'include_module', 'open_module_signature', 'include_module_type'],
  callTypes: [], // application_expression is picked up by extractBareCall
  variableTypes: [],
  fieldTypes: ['instance_variable_definition'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameter',

  // Class members carry their name as a typed child (the grammar labels it differently across versions).
  resolveName: (node, source) => {
    const nameType = CLASS_NAME_NODE[node.type];
    const name = nameType ? child(node, nameType) : undefined;
    return name ? getNodeText(name, source) : undefined;
  },

  extractImport: (node, source) => {
    const path = child(node, 'module_path', 'extended_module_path', 'module_type_path');
    if (!path) return null;
    return {
      moduleName: getNodeText(path, source).replace(/\s+/g, ''),
      signature: collapseWs(getNodeText(node, source)),
    };
  },

  // `f x y` / `M.f x` — module paths become `M::f`, the qualifiedName a function
  // gets inside `module M = struct … end`.
  extractBareCall: (node, source) => {
    if (node.type !== 'application_expression') return undefined;
    const fn = getChildByField(node, 'function');
    return (fn && calleeName(fn, source)) ?? undefined;
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'compilation_unit':
        return handleCompilationUnit(node, ctx);
      case 'value_definition':
        return handleValueDefinition(node, ctx);
      case 'type_definition':
        return handleTypeDefinition(node, ctx);
      case 'module_definition':
        return handleModuleDefinition(node, ctx);
      case 'module_type_definition':
        return handleModuleType(node, ctx);
      case 'value_specification':
        return handleValueSpecification(node, ctx);
      case 'exception_definition':
        return handleException(node, ctx);
      case 'external':
        return handleExternal(node, ctx);
      default:
        return false;
    }
  },
};
