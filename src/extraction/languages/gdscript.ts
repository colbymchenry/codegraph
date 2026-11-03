import * as path from 'path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

// PrestonKnopp/tree-sitter-gdscript (ABI 14). Where the wasm comes from and how
// to rebuild it: docs/grammars/tree-sitter-gdscript.md.
const text = (node: SyntaxNode, ctx: ExtractorContext): string => getNodeText(node, ctx.source);

/** Only a complete literal is static: never search inside a nested expression. */
function stringValue(node: SyntaxNode | null | undefined, ctx: ExtractorContext): string | null {
  if (node?.type !== 'string') return null;
  const value = text(node, ctx);
  const match = /^(?:&)?(["'])([^\r\n\\]*?)\1$/.exec(value);
  return match?.[2] ?? null;
}

function addRef(ctx: ExtractorContext, node: SyntaxNode, name: string, kind: 'calls' | 'references' | 'function_ref' | 'imports' | 'extends' | 'instantiates'): void {
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (fromNodeId && name) ctx.addUnresolvedReference({
    fromNodeId, referenceName: name, referenceKind: kind,
    line: node.startPosition.row + 1, column: node.startPosition.column,
  });
}

/**
 * A scene node reference: `$::Panel::Label` for `$Panel/Label`. The `$` tells it
 * from a signal or a class of the same name, and `::` keeps the node's own name
 * as the tail a failed reference waits under, so it binds again when its scene
 * comes back. Godot allows neither `:` nor `/` in a node name. A `%` only says
 * the name is unique in its scene.
 */
function addNodePathRef(ctx: ExtractorContext, node: SyntaxNode, nodePath: string): void {
  const segments = nodePath.trim().replace(/%/g, '').split('/').filter((s) => s !== '' && s !== '.' && s !== '..');
  if (segments.length > 0) addRef(ctx, node, `$::${segments.join('::')}`, 'references');
}

function visitChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) ctx.visitNode(child);
}

function baseName(node: SyntaxNode, ctx: ExtractorContext): string | null {
  const literal = node.namedChildren.find((c) => c.type === 'string');
  if (literal) return stringValue(literal, ctx);
  const type = node.namedChildren.find((c) => c.type === 'type');
  // `extends "res://base.gd".Inner` is a type whose attribute starts with the path.
  return type ? text(type, ctx).replace(/^(["'])(.*?)\1/, '$2') : null;
}

function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  return getChildByField(call, 'arguments')?.namedChildren ?? [];
}

/** The file `node` loads, when it is a `preload` or `load` call of a literal path. */
function loadedPath(node: SyntaxNode | null | undefined, ctx: ExtractorContext): string | null {
  const callee = node?.type === 'call' ? node.namedChild(0) : null;
  if (callee?.type !== 'identifier') return null;
  const name = text(callee, ctx);
  return name === 'preload' || name === 'load' ? stringValue(argumentsOf(node!)[0], ctx) : null;
}

/** A static binding's type, or the exact script a preload/load names. */
function bindingType(node: SyntaxNode, ctx: ExtractorContext): string | null {
  const type = getChildByField(node, 'type');
  if (type?.type === 'type') return text(type, ctx);
  const value = getChildByField(node, 'value');
  const loaded = loadedPath(value, ctx);
  if (loaded) return loaded;
  if (value?.type === 'attribute') {
    const children = value.namedChildren;
    const method = children[1]?.type === 'attribute_call' ? children[1].namedChild(0) : null;
    if (children.length === 2 && children[0]?.type === 'identifier' && method && text(method, ctx) === 'new') {
      return text(children[0], ctx);
    }
  }
  return null;
}

/** Keep receiver evidence rather than reducing every object call to a bare name. */
function receiverName(receiver: SyntaxNode, at: SyntaxNode, ctx: ExtractorContext): string | null {
  if (receiver.type !== 'identifier') return null;
  const name = text(receiver, ctx);
  if (name === 'self' || name === 'super') return name;
  // Parameters and preceding locals shadow class members, and bindings in a
  // sibling method or inner class are never in view. Past a class, an inner
  // class sees its outer classes' constants, but not their instance fields.
  let pastClass = false;
  let scope: SyntaxNode | null = at.parent;
  const named = (node: SyntaxNode, field: string): boolean => {
    const child = getChildByField(node, field);
    return !!child && text(child, ctx) === name;
  };
  while (scope) {
    if (scope.type === 'for_statement' && named(scope, 'left')) {
      const explicit = getChildByField(scope, 'type');
      if (explicit) return text(explicit, ctx);
      const collection = getChildByField(scope, 'right');
      if (collection?.type === 'identifier') {
        const type = receiverName(collection, scope, ctx);
        return type ? /^Array\[(.+)\]$/.exec(type)?.[1] ?? null : null;
      }
      return null;
    }
    if (scope.type === 'function_definition' || scope.type === 'lambda') {
      const params = getChildByField(scope, 'parameters');
      for (const param of params?.namedChildren ?? []) {
        const id = param.type === 'identifier' ? param : param.namedChildren.find((c) => c.type === 'identifier');
        if (id && text(id, ctx) === name) return bindingType(param, ctx);
      }
    }
    if (scope.type === 'body' || scope.type === 'class_body' || scope.type === 'source') {
      for (const child of [...scope.namedChildren].reverse()) {
        if (scope.type === 'body' && child.startIndex >= at.startIndex) continue;
        const inView = child.type === 'const_statement' || (child.type === 'variable_statement' && !pastClass);
        if (inView && named(child, 'name')) return bindingType(child, ctx);
      }
    }
    if (scope.type === 'class_definition') pastClass = true;
    scope = scope.parent;
  }
  return name; // a globally registered class, or an unresolved dynamic receiver
}

/** The method a callable names: `m`, `self.m`, either with `.bind(...)`, or `Callable(self, "m")`. */
function callableMethod(node: SyntaxNode | undefined, ctx: ExtractorContext): string | null {
  if (node?.type === 'identifier') return text(node, ctx);
  if (node?.type === 'attribute') {
    const parts = node.namedChildren;
    const isSelf = parts[0] !== undefined && text(parts[0], ctx) === 'self';
    if (parts.length === 2 && isSelf && parts[1]?.type === 'identifier') return `self.${text(parts[1], ctx)}`;
    const last = parts[parts.length - 1];
    if (last?.type === 'attribute_call' && last.namedChild(0) && text(last.namedChild(0)!, ctx) === 'bind') {
      if (parts.length === 2 && parts[0]?.type === 'identifier') return text(parts[0], ctx);
      if (parts.length === 3 && isSelf && parts[1]?.type === 'identifier') return `self.${text(parts[1], ctx)}`;
    }
  }
  if (node?.type === 'call' && node.namedChild(0) && text(node.namedChild(0)!, ctx) === 'Callable') {
    const args = argumentsOf(node);
    if (args[0] && text(args[0], ctx) === 'self') return stringValue(args[1], ctx);
  }
  return null;
}

/**
 * The handler a connect registers, at the connect's own position so the signal
 * pass can pair the two. Godot 3 names it in two arguments: `self, "m"`.
 */
function addHandlerRef(ctx: ExtractorContext, site: SyntaxNode, args: SyntaxNode[], at: number): void {
  const target = args[at];
  const godot3 = target?.type === 'identifier' && text(target, ctx) === 'self';
  const method = godot3 ? stringValue(args[at + 1], ctx) : callableMethod(target, ctx);
  if (method) addRef(ctx, site, method, 'function_ref');
}

/**
 * The handlers a connect registers. A first argument that is a string names the
 * signal, and three arguments mean `Object.connect(sig, self, "m")`, with the
 * signal maybe in a variable. Two arguments can be `sig.connect(m, flags)` or
 * `object.connect(sig, m)`, which only resolution can tell: each that isn't
 * written as flags is filed, and only a method of that name binds.
 */
function addConnectHandlers(ctx: ExtractorContext, site: SyntaxNode, args: SyntaxNode[]): void {
  if (stringValue(args[0], ctx) !== null || args.length >= 3) {
    addHandlerRef(ctx, site, args, 1);
    return;
  }
  addHandlerRef(ctx, site, args, 0);
  const second = args[1];
  if (second && second.type !== 'integer' && !/\bCONNECT_/.test(text(second, ctx))) addHandlerRef(ctx, site, args, 1);
}

/** Three arguments are `Object.connect`: the receiver isn't a signal, whatever else it is. */
function isObjectConnect(args: SyntaxNode[]): boolean {
  return args.length >= 3;
}

/**
 * A signal's use is filed as `<signal>.emit` or `<signal>.connect`. The name is
 * what tells the signal pass the two apart: it stays on the edge as `refName`.
 */
function addSignalUse(ctx: ExtractorContext, site: SyntaxNode, signal: string, method: string): void {
  addRef(ctx, site, `${signal}.${method === 'connect' ? 'connect' : 'emit'}`, 'references');
}

/** Shared by declaration and function-body walkers. The caller walks children. */
function expression(node: SyntaxNode, ctx: ExtractorContext): boolean {
  if (node.type === 'get_node') {
    addNodePathRef(ctx, node, text(node, ctx).replace(/^\$/, '').replace(/["']/g, ''));
    return true;
  }
  if (node.type === 'call') {
    const callee = node.namedChild(0);
    if (callee?.type !== 'identifier') return true;
    const name = text(callee, ctx);
    const args = argumentsOf(node);
    if (name === 'preload' || name === 'load') {
      const file = loadedPath(node, ctx);
      if (file) {
        ctx.createNode('import', file, node, { signature: text(node, ctx) });
        addRef(ctx, node, file, 'imports');
        // A second reference from the file itself: the symbol's says who loads
        // it, and the file's is the one a file's list of imports reads.
        const fileId = ctx.nodeStack[0];
        if (fileId && fileId !== ctx.nodeStack[ctx.nodeStack.length - 1]) {
          ctx.addUnresolvedReference({ fromNodeId: fileId, referenceName: file, referenceKind: 'imports',
            line: node.startPosition.row + 1, column: node.startPosition.column });
        }
      }
    } else if (name === 'get_node' || name === 'get_node_or_null' || name === 'has_node') {
      const nodePath = stringValue(args[0], ctx);
      if (nodePath) addNodePathRef(ctx, node, nodePath);
    } else if (name === 'emit_signal' || name === 'connect') {
      const signal = stringValue(args[0], ctx);
      if (signal) addSignalUse(ctx, node, signal, name);
      if (name === 'connect') addConnectHandlers(ctx, node, args);
    } else if (name === 'super') {
      const owner = ctx.nodes.find((n) => n.id === ctx.nodeStack[ctx.nodeStack.length - 1]);
      if (owner?.kind === 'method') addRef(ctx, node, `super.${owner.name}`, 'calls');
    } else {
      addRef(ctx, node, name, 'calls');
    }
    return true;
  }
  if (node.type === 'attribute') {
    const children = node.namedChildren;
    for (let i = 1; i < children.length; i++) {
      const call = children[i]!;
      if (call.type !== 'attribute_call') continue;
      const method = call.namedChild(0);
      if (method?.type !== 'identifier') continue;
      const name = text(method, ctx);
      // A call on a call's result has no statically known receiver here.
      const receiver = children[0]!;
      const owner = receiverName(receiver, node, ctx);
      // An unknown receiver or a long chain hides which signal this is, but not its handler.
      if (!owner || i > 2) {
        if (name === 'connect') addConnectHandlers(ctx, call, argumentsOf(call));
        continue;
      }
      // A method held as a callable: `_changed.call_deferred()`. `object.call("m")` names another.
      if (i === 1 && (name === 'call' || name === 'call_deferred') && stringValue(argumentsOf(call)[0], ctx) === null) {
        addRef(ctx, call, text(receiver, ctx), 'calls');
        continue;
      }
      // Godot 4's named RPC callable executes that method on remote peers.
      // Keep its actual method name; an unknown callable resolves to nothing.
      if (name === 'rpc' || name === 'rpc_id') {
        const callable = i === 1 ? text(receiver, ctx) : `${owner}.${text(children[1]!, ctx)}`;
        addRef(ctx, call, callable, 'calls');
        continue;
      }
      const args = argumentsOf(call);
      const signalArgument = stringValue(args[0], ctx);
      if (i === 1 && (name === 'emit_signal' || name === 'connect') && signalArgument) {
        addSignalUse(ctx, call, owner === 'self' ? signalArgument : `${owner}.${signalArgument}`, name);
        if (name === 'connect') addConnectHandlers(ctx, call, args);
      } else if (name === 'emit' || name === 'connect') {
        if (name === 'emit' || !isObjectConnect(args)) {
          addSignalUse(ctx, call, i === 1 ? owner : `${owner}.${text(children[1]!, ctx)}`, name);
        }
        if (name === 'connect') addConnectHandlers(ctx, call, args);
      } else if (i === 1) {
        if (name === 'new') addRef(ctx, call, owner, 'instantiates');
        else addRef(ctx, call, `${owner}.${name}`, 'calls');
      }
    }
    return true;
  }
  return false;
}

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  methodTypes: ['function_definition'],
  classTypes: ['class_definition'],
  interfaceTypes: [], structTypes: [], enumTypes: [], typeAliasTypes: [],
  // The generic walk is off: `expression` below files every call, since the
  // generic one would lose the receiver and read `emit` and `connect` as calls.
  // It covers `f()`, `super()`, `a.b()`, `Type.new()`, `sig.emit()`, the two forms
  // of connect, `rpc` / `rpc_id`, `preload` / `load` and node paths. Left out on
  // purpose, as there's no receiver type to go by: a call on a call's result
  // (`a().b()`), a longer chain (`a.b.c()`) and a call on a subscript (`a[0].b()`).
  // A connect's handler is filed from any of those: it's in the arguments.
  importTypes: [], callTypes: [], variableTypes: [],
  nameField: 'name', bodyField: 'body', paramsField: 'parameters', returnField: 'return_type',
  docstringStepOverTypes: ['annotation'],
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const result = getChildByField(node, 'return_type');
    return params ? getNodeText(params, source) + (result ? ` -> ${getNodeText(result, source)}` : '') : undefined;
  },
  isStatic: (node) => node.namedChildren.some((c) => c.type === 'static_keyword'),
  visitNode: (node, ctx) => {
    if (node.type === 'source') {
      // A .gd file IS a class; class_name only registers its global name.
      // Its declaration and extends are siblings of its methods in this AST.
      const declaration = node.namedChildren.find((c) => c.type === 'class_name_statement');
      const name = declaration && getChildByField(declaration, 'name');
      const extendsClause = node.namedChildren.find((c) => c.type === 'extends_statement') ??
        declaration?.namedChildren.find((c) => c.type === 'extends_statement');
      const cls = ctx.createNode('class', name ? text(name, ctx) : path.posix.basename(ctx.filePath, path.posix.extname(ctx.filePath)), node, {
        isExported: !!name,
        signature: extendsClause ? text(extendsClause, ctx) : undefined,
      });
      if (cls) ctx.pushScope(cls.id);
      visitChildren(node, ctx);
      if (cls) ctx.popScope();
      return true;
    }
    if (node.type === 'class_definition') {
      const name = getChildByField(node, 'name');
      const body = getChildByField(node, 'body');
      const base = getChildByField(node, 'extends');
      if (name) {
        const cls = ctx.createNode('class', text(name, ctx), node, { signature: base ? text(base, ctx) : undefined });
        if (cls) ctx.pushScope(cls.id);
        if (base) ctx.visitNode(base);
        if (body) visitChildren(body, ctx);
        if (cls) ctx.popScope();
      }
      return true;
    }
    if (node.type === 'class_name_statement') {
      visitChildren(node, ctx); // Godot 3 permits `class_name Player extends Node`.
      return true;
    }
    if (node.type === 'extends_statement') {
      const base = baseName(node, ctx);
      if (base) addRef(ctx, node, base, 'extends');
      return true;
    }
    if (node.type === 'signal_statement' || node.type === 'variable_statement' || node.type === 'const_statement') {
      const name = getChildByField(node, 'name');
      const accessors = getChildByField(node, 'setget');
      const value = getChildByField(node, 'value');
      // `const Foo = preload("foo.gd")`: the script is the binding's type. A
      // subclass reads it from here, as it can't see the declaration.
      const script = node.type === 'signal_statement' ? null : loadedPath(value, ctx) ?? bindingType(node, ctx);
      const member = name && ctx.createNode(accessors ? 'property' : node.type === 'const_statement' ? 'constant' : 'field', text(name, ctx), node, {
        signature: text(node, ctx).split(/\r?\n/)[0],
        ...(node.type === 'signal_statement' ? { decorators: ['signal'] } : {}),
        ...(script ? { returnType: script } : {}),
      });
      // Initializer calls belong to the enclosing class, and use the body
      // walker so nested lambdas keep the normal function boundary behavior.
      if (value) ctx.walkInitializer(value);
      if (accessors && member) {
        ctx.pushScope(member.id);
        // `var hp: int: set = _set_hp`: the accessor is a named method.
        for (const part of accessors.namedChildren) {
          if (part.type === 'setter' || part.type === 'getter') addRef(ctx, part, text(part, ctx), 'function_ref');
        }
        ctx.visitFunctionBody(accessors, member.id);
        ctx.popScope();
      }
      return true;
    }
    if (node.type === 'enum_definition') {
      const name = getChildByField(node, 'name');
      const en = name ? ctx.createNode('enum', text(name, ctx), node) : null;
      if (en) ctx.pushScope(en.id);
      const body = getChildByField(node, 'body');
      for (const member of body?.namedChildren ?? []) {
        const id = getChildByField(member, 'left');
        if (id) ctx.createNode('enum_member', text(id, ctx), member, { signature: text(member, ctx) });
      }
      if (en) ctx.popScope();
      return true;
    }
    if (expression(node, ctx)) {
      visitChildren(node, ctx);
      return true;
    }
    return false;
  },
  visitBodyNode: expression,
};
