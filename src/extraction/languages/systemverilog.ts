import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind } from '../../types';

/**
 * SystemVerilog / Verilog extractor (tree-sitter-systemverilog grammar).
 *
 * The design hierarchy is the payload here: a module's `callers` are the modules
 * that instantiate it, its `callees`/contained children are its sub-instances and
 * subroutines, and `impact` is the instantiation cone. SystemVerilog keeps
 * declaration names nested (module name under a `*_ansi_header`, subroutine name
 * under a `*_body_declaration`, a typedef under the `type_name` field), so a single
 * resolver walks those shapes rather than relying on a flat name field.
 */

/** Resolve a declaration's identifier across SV's varied nesting. */
function svName(node: SyntaxNode, source: string): string | undefined {
  // The constructor `function new(...)` parses as class_constructor_declaration
  // with no name field — its identity is always 'new'.
  if (node.type === 'class_constructor_declaration') return 'new';

  // class_declaration / package_declaration expose `name` directly.
  const direct = getChildByField(node, 'name');
  if (direct) return getNodeText(direct, source).trim();

  // `typedef <type> NAME;` carries the alias on the `type_name` field.
  const typeName = getChildByField(node, 'type_name');
  if (typeName) return getNodeText(typeName, source).trim();

  // module/interface/program keep the name one level down in the ANSI header;
  // function/task keep it on the *_body_declaration.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (/_(ansi_|nonansi_)?header$/.test(child.type) || /_body_declaration$/.test(child.type)) {
      const nm = getChildByField(child, 'name');
      if (nm) return getNodeText(nm, source).trim();
    }
  }

  // Fallback: only an enum member names itself with a sole shallow identifier.
  // For any other node whose name didn't resolve above, return undefined so the
  // engine skips it — a skipped node beats one mislabeled with a port/param id.
  if (node.type === 'enum_name_declaration') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c && c.type === 'simple_identifier') return getNodeText(c, source).trim();
    }
  }
  return undefined;
}

/** The instantiated module *type* (`adder` in `adder u_add (...)`), not the `u_add` label. */
function instantiatedType(node: SyntaxNode, source: string): string | undefined {
  // The grammar tags the type as the `instance_type` field; the instance label
  // lives deeper under hierarchical_instance > name_of_instance.
  const t = getChildByField(node, 'instance_type');
  if (t) return getNodeText(t, source).trim();
  const first = node.namedChild(0);
  return first && first.type === 'simple_identifier' ? getNodeText(first, source).trim() : undefined;
}

// Built-in data types that can surface as a bare identifier under data_type
// (most lower to dedicated grammar nodes like integer_atom_type, but a few
// user-style spellings slip through). A field of one of these is not a has-a
// relationship to a user class, so it never becomes a composition edge.
const SV_BUILTIN_TYPES = new Set([
  'int', 'integer', 'bit', 'logic', 'reg', 'byte', 'shortint', 'longint',
  'time', 'real', 'shortreal', 'realtime', 'string', 'chandle', 'event', 'void',
]);

/**
 * The user-class type of a `class_property` field, or undefined for a builtin /
 * untyped field. The type sits under one of two shapes: ordinary/qualified fields
 * nest it as `data_declaration -> data_type_or_implicit -> data_type` (the
 * data_declaration follows any leading rand/local/protected qualifier siblings,
 * so it is not at a fixed index); a `const` member exposes `data_type` as a direct
 * child of class_property. From data_type, the type identifier is read:
 *   - a `class_type` child joins its DIRECT simple_identifier children with `::`
 *     (so `pkg::base` keeps its scope, and a `#(param)` value assignment — which
 *     is a sibling, not a simple_identifier — is excluded: `port #(txn)` -> `port`).
 *   - otherwise a direct simple_identifier under data_type is the type name.
 *   - a builtin (`int` -> integer_atom_type, `string` -> empty) has no
 *     simple_identifier here, so this returns undefined and no edge is emitted.
 */
function fieldTypeName(classProperty: SyntaxNode, source: string): string | undefined {
  // Two field shapes carry the type differently:
  //   - ordinary/qualified fields nest it under a `data_declaration` (which
  //     itself may sit behind rand/local/protected sibling *_qualifier nodes,
  //     so it isn't at a fixed index — `rand local foo_t f;` puts it at 2);
  //   - a `const` member skips the wrapper entirely and exposes `data_type`
  //     as a direct child of class_property.
  // Find the data_type for either shape; qualifier nodes carry no type info.
  let dataType: SyntaxNode | undefined;
  for (let i = 0; i < classProperty.namedChildCount; i++) {
    const c = classProperty.namedChild(i);
    if (!c) continue;
    if (c.type === 'data_type') {
      dataType = c; // const-member form: class_property > data_type
      break;
    }
    if (c.type === 'data_declaration') {
      for (let j = 0; j < c.namedChildCount; j++) {
        const d = c.namedChild(j);
        if (!d) continue;
        if (d.type === 'data_type_or_implicit') {
          for (let k = 0; k < d.namedChildCount; k++) {
            const e = d.namedChild(k);
            if (e && e.type === 'data_type') { dataType = e; break; }
          }
        } else if (d.type === 'data_type') {
          dataType = d;
        }
        if (dataType) break;
      }
      break;
    }
  }
  if (!dataType) return undefined;

  const first = dataType.namedChild(0);
  if (!first) return undefined; // e.g. `string` parses with no child here

  if (first.type === 'class_type') {
    const ids: string[] = [];
    for (let i = 0; i < first.namedChildCount; i++) {
      const c = first.namedChild(i);
      if (c && c.type === 'simple_identifier') ids.push(getNodeText(c, source).trim());
    }
    return ids.length > 0 ? ids.join('::') : undefined;
  }
  if (first.type === 'simple_identifier') return getNodeText(first, source).trim();

  // Builtin scalar/integer types (integer_atom_type, etc.) -> not a user type.
  return undefined;
}

/** The `name` field text of a method_call's method_call_body child, if any. */
function methodCallName(methodCall: SyntaxNode, source: string): string | undefined {
  for (let i = 0; i < methodCall.namedChildCount; i++) {
    const c = methodCall.namedChild(i);
    if (c && c.type === 'method_call_body') {
      const nm = getChildByField(c, 'name');
      if (nm) return getNodeText(nm, source).trim();
    }
  }
  return undefined;
}

/** The leading simple_identifier of the first hierarchical_identifier in a subtree. */
function firstHierId(node: SyntaxNode, source: string): string | undefined {
  const stack: SyntaxNode[] = [node];
  let guard = 0;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'hierarchical_identifier') {
      const id = cur.namedChild(0);
      if (id && id.type === 'simple_identifier') return getNodeText(id, source).trim();
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

/**
 * For a `T::type_id::create(...)` call, the created Type `T`. The outer
 * method_call is `create`; its receiver `primary` nests an inner method_call
 * named `type_id` whose own `primary > hierarchical_identifier` leads with the
 * base type id. Returns undefined unless a `type_id` link is actually present —
 * so a plain `obj.create()` (no factory) is not mistaken for a UVM create.
 */
function createTypeFromChain(createCall: SyntaxNode, source: string): string | undefined {
  // The receiver is the create call's primary child (not the method_call_body).
  let primary: SyntaxNode | undefined;
  for (let i = 0; i < createCall.namedChildCount; i++) {
    const c = createCall.namedChild(i);
    if (c && c.type === 'primary') { primary = c; break; }
  }
  if (!primary) return undefined;

  // Find the inner method_call (the `type_id` link) under that primary.
  const stack: SyntaxNode[] = [primary];
  let guard = 0;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'method_call' && methodCallName(cur, source) === 'type_id') {
      // Its own receiver primary leads with the base type identifier.
      for (let i = 0; i < cur.namedChildCount; i++) {
        const c = cur.namedChild(i);
        if (c && c.type === 'primary') return firstHierId(c, source);
      }
      return undefined;
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  return undefined;
}

/**
 * The assigned handle for a create call: walk up to the enclosing
 * operator_assignment (under blocking_assignment) and read the leading
 * identifier of its variable_lvalue. Empty when the create isn't assigned
 * (e.g. a bare `create(...)` statement). Capped so a deep nesting can't loop.
 */
function assignedHandle(createCall: SyntaxNode, source: string): string {
  for (let p = createCall.parent, depth = 0; p && depth < 24; p = p.parent, depth++) {
    if (p.type === 'operator_assignment' || p.type === 'blocking_assignment') {
      for (let i = 0; i < p.namedChildCount; i++) {
        const c = p.namedChild(i);
        if (c && c.type === 'variable_lvalue') {
          const h = firstHierId(c, source);
          if (h) return h;
        }
      }
      return '';
    }
  }
  return '';
}

/** Dotted segments of a hierarchical_identifier (`a.b.c` -> ['a','b','c']). */
function hierIdSegments(hierId: SyntaxNode, source: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < hierId.namedChildCount; i++) {
    const c = hierId.namedChild(i);
    if (c && c.type === 'simple_identifier') out.push(getNodeText(c, source).trim());
  }
  return out;
}

/**
 * For a `a.b.connect(c.d)` statement, the (fromChain, toChain) dotted handle
 * paths — or undefined when the subroutine_call isn't a `.connect()`. The
 * subroutine_call wraps a `tf_call` whose hierarchical_identifier ends in
 * `connect`; the prefix is the from-chain and the first argument's
 * hierarchical_identifier is the to-chain.
 */
function connectChains(subroutineCall: SyntaxNode, source: string): { from: string; to: string } | undefined {
  let tfCall: SyntaxNode | undefined;
  for (let i = 0; i < subroutineCall.namedChildCount; i++) {
    const c = subroutineCall.namedChild(i);
    if (c && c.type === 'tf_call') { tfCall = c; break; }
  }
  if (!tfCall) return undefined;

  let hierId: SyntaxNode | undefined;
  let args: SyntaxNode | undefined;
  for (let i = 0; i < tfCall.namedChildCount; i++) {
    const c = tfCall.namedChild(i);
    if (!c) continue;
    if (c.type === 'hierarchical_identifier') hierId = c;
    else if (c.type === 'list_of_arguments') args = c;
  }
  if (!hierId) return undefined;

  const segs = hierIdSegments(hierId, source);
  if (segs.length < 2 || segs[segs.length - 1] !== 'connect') return undefined; // need prefix.connect
  const fromChain = segs.slice(0, -1).join('.');

  // The to-chain is the first argument's hierarchical_identifier.
  if (!args) return undefined;
  const stack: SyntaxNode[] = [args];
  let guard = 0;
  let toChain: string | undefined;
  while (stack.length && guard++ < 64) {
    const cur = stack.pop()!;
    if (cur.type === 'hierarchical_identifier') {
      toChain = hierIdSegments(cur, source).join('.');
      break;
    }
    for (let i = cur.namedChildCount - 1; i >= 0; i--) {
      const c = cur.namedChild(i);
      if (c) stack.push(c);
    }
  }
  if (!toChain) return undefined;
  return { from: fromChain, to: toChain };
}

/** True when the subtree is an enum typedef, so it becomes an `enum` node not a type alias. */
function isEnumTypedef(node: SyntaxNode): boolean {
  const queue: SyntaxNode[] = [node];
  let guard = 0;
  while (queue.length && guard++ < 256) {
    const cur = queue.shift()!;
    if (cur.type === 'enum_name_declaration' || cur.type === 'enum_base_type') return true;
    for (let i = 0; i < cur.namedChildCount; i++) {
      const c = cur.namedChild(i);
      if (c) queue.push(c);
    }
  }
  return false;
}

// module/program are structural containers we model as 'module'; package -> 'namespace'.
const MODULE_NODES = new Set(['module_declaration', 'program_declaration']);

export const systemverilogExtractor: LanguageExtractor = {
  // Subroutines. function/task are dual-listed in methodTypes (gated by
  // methodScopeKinds below) so they read as 'method' inside a class but stay
  // 'function' inside a module. class_constructor_declaration ('function new')
  // is method-only — it never appears outside a class.
  functionTypes: ['function_declaration', 'task_declaration'],
  methodTypes: ['function_declaration', 'task_declaration', 'class_constructor_declaration'],
  // A subroutine is a method only inside a class scope, not a module.
  methodScopeKinds: ['class'],
  // UVM / OOP classes use the engine's class machinery directly.
  classTypes: ['class_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: ['type_declaration'],
  importTypes: ['include_compiler_directive'],
  callTypes: ['tf_call'], // function/task subroutine calls -> 'calls' edges
  variableTypes: [],

  nameField: 'name',
  bodyField: 'body', // SV has no 'body' field; extract* falls back to the node itself
  paramsField: 'tf_port_list',

  resolveName: (node, source) => svName(node, source),

  // SV functions/tasks keep statements under a *_body_declaration child (no 'body'
  // field); point the engine's body walk there or internal subroutine calls are lost.
  resolveBody: (node) => {
    if (node.type === 'function_declaration' || node.type === 'task_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && /_body_declaration$/.test(c.type)) return c;
      }
    }
    // The constructor has no *_body_declaration wrapper; walk the whole node so
    // calls in its body (super.new, helper calls) are still captured.
    if (node.type === 'class_constructor_declaration') return node;
    return null;
  },

  // Out-of-class definitions (`function void D::foo();`, `task D::run();`,
  // `function D::new();`) carry a `class_scope` naming the owning class — the
  // engine then extracts them as methods of D (qualified name + contains edge),
  // matching how Go/Rust receivers work. Inline definitions have no class_scope,
  // so this returns undefined and they follow the normal scope-based path.
  getReceiverType: (node, source) => {
    // function/task keep the class_scope under their *_body_declaration; the
    // constructor keeps it as a direct child.
    let container = node;
    if (node.type !== 'class_constructor_declaration') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const c = node.namedChild(i);
        if (c && /_body_declaration$/.test(c.type)) {
          container = c;
          break;
        }
      }
    }
    for (let i = 0; i < container.namedChildCount; i++) {
      const c = container.namedChild(i);
      if (c && c.type === 'class_scope') {
        const classType = c.namedChild(0); // class_scope > class_type > simple_identifier(s)
        if (!classType) return undefined;
        const ids: SyntaxNode[] = [];
        for (let j = 0; j < classType.namedChildCount; j++) {
          const id = classType.namedChild(j);
          if (id && id.type === 'simple_identifier') ids.push(id);
        }
        const last = ids[ids.length - 1]; // qualified pkg::D -> the class is the last id
        if (last) return getNodeText(last, source).trim();
      }
    }
    return undefined;
  },

  extractImport: (node, source) => {
    // Only `include "file" is handled here; package imports are emitted in the
    // visitNode hook so a multi-package statement (`import a::*, b::x;`) yields
    // one import per package rather than just the first.
    const signature = getNodeText(node, source).trim();
    const m = signature.match(/["<]([^">]+)[">]/); // `include "defs.svh"
    return m && m[1] ? { moduleName: m[1], signature } : null;
  },

  // `super.m()` / `this.m()` parse as `method_call > implicit_class_handle +
  // method_call_body{name}` — distinct from a named-handle `obj.m()`, which is a
  // `tf_call` already covered by callTypes. The engine can't resolve these from a
  // flat name (the receiver is implicit), so we surface a `this.<m>`/`super.<m>`
  // marker ref and let the SV inheritance-chain pass bind it. `super.` must reach
  // the PARENT class's `m`, never the caller's own — hence the handle is preserved
  // in the ref name rather than collapsed to the bare method here.
  //
  // This runs for every body node that isn't a tf_call, so it must be strict:
  // only a method_call whose first named child is an implicit_class_handle
  // qualifies; everything else returns undefined and is left untouched.
  extractBareCall: (node, source) => {
    if (node.type === 'method_call') {
      const handle = node.namedChild(0);

      // this./super. dispatch: implicit_class_handle receiver.
      if (handle && handle.type === 'implicit_class_handle') {
        // The handle text is `this`, `super`, or `this.super`; only `super`-bearing
        // forms walk up the extends chain — the rest resolve from the enclosing class.
        const receiver = getNodeText(handle, source).includes('super') ? 'super' : 'this';
        const methodName = methodCallName(node, source);
        return methodName ? `${receiver}.${methodName}` : undefined;
      }

      // UVM factory create: `h = T::type_id::create("h", this)`. The outer call
      // is `create`; its receiver chain carries the `type_id` link and the base
      // type. We can't resolve the LHS handle -> component class from the flat
      // name here (the class graph isn't built yet), so emit a marker carrying
      // the handle and the created Type; a post-pass binds it once the graph
      // exists. Guard on a real type_id link so plain `obj.create()` is ignored.
      if (methodCallName(node, source) === 'create') {
        const type = createTypeFromChain(node, source);
        if (type) {
          const handleName = assignedHandle(node, source); // '' when not assigned
          // Separate the handle and type with `|`, not `__`: a double underscore
          // is a legal SV identifier substring (`cfg__db`), so splitting the
          // body on `__` would mangle such names. A pipe can't occur in an
          // identifier or a dotted chain, so it splits unambiguously.
          return `__sv_create__${handleName}|${type}`;
        }
      }
      return undefined;
    }

    // TLM dataflow: `a.b.connect(c.d)`. The subroutine_call wraps a tf_call whose
    // hierarchical_identifier ends in `connect`. The handle chains can't be
    // resolved to component classes until the create-map exists, so emit a
    // marker with both dotted chains for the post-pass. (The inner tf_call still
    // emits a harmless unresolved `connect` call — dropped during resolution.)
    if (node.type === 'subroutine_call') {
      const chains = connectChains(node, source);
      // `|` separates the two dotted chains (see the create marker above for why
      // `__` is unsafe); dots stay as the in-chain token separator.
      if (chains) return `__sv_connect__${chains.from}|${chains.to}`;
      return undefined;
    }

    return undefined;
  },

  /**
   * The engine's list-driven dispatch can only emit class/struct/enum/interface/trait,
   * never 'module', and module instantiation isn't a call expression — so the structural
   * containers and the design-hierarchy edges are created here.
   */
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const t = node.type;

    // Enum typedefs: the engine's type-alias path can't emit enum members (it
    // looks for enumTypes, which SV leaves empty), so build the enum + members here.
    if (t === 'type_declaration' && isEnumTypedef(node)) {
      const name = svName(node, ctx.source);
      if (!name) return false;
      const enumNode = ctx.createNode('enum', name, node);
      if (!enumNode) return true;
      ctx.pushScope(enumNode.id);
      const q: SyntaxNode[] = [node];
      let guard = 0;
      while (q.length && guard++ < 512) {
        const cur = q.shift()!;
        if (cur.type === 'enum_name_declaration') {
          const mn = svName(cur, ctx.source);
          if (mn) ctx.createNode('enum_member', mn, cur);
          continue;
        }
        for (let i = 0; i < cur.namedChildCount; i++) {
          const c = cur.namedChild(i);
          if (c) q.push(c);
        }
      }
      ctx.popScope();
      return true;
    }

    // Package imports: one import node + `imports` ref per package_import_item,
    // so `import a::*, b::x;` produces both. (The engine's single-ImportInfo path
    // would only surface the first.)
    if (t === 'package_import_declaration') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const line = node.startPosition.row + 1;
      const column = node.startPosition.column;
      for (let i = 0; i < node.namedChildCount; i++) {
        const item = node.namedChild(i);
        if (!item || item.type !== 'package_import_item') continue;
        let pkg: string | undefined;
        for (let j = 0; j < item.namedChildCount; j++) {
          const c = item.namedChild(j);
          if (c && c.type === 'simple_identifier') {
            pkg = getNodeText(c, ctx.source).trim(); // leading id is the package name
            break;
          }
        }
        if (!pkg) continue;
        const imp = ctx.createNode('import', pkg, item);
        if (imp && fromId) {
          ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: pkg, referenceKind: 'imports', line, column });
        }
      }
      return true;
    }

    if (MODULE_NODES.has(t) || t === 'package_declaration') {
      const kind: NodeKind = t === 'package_declaration' ? 'namespace' : 'module';
      const name = svName(node, ctx.source);
      if (!name) return false; // malformed -> let default dispatch try
      const created = ctx.createNode(kind, name, node);
      if (!created) return true;
      ctx.pushScope(created.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      ctx.popScope();
      return true; // fully handled
    }

    if (t === 'module_instantiation') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const typeName = instantiatedType(node, ctx.source); // bind to the module type, not the u_xxx label
      if (fromId && typeName) {
        const line = node.startPosition.row + 1;
        const column = node.startPosition.column;
        // `instantiates` is the semantically-correct edge for the design hierarchy.
        // We also emit `calls` so the call-graph commands (callers/callees) surface
        // instantiation — "who instantiates this module" is the RTL analog of "who
        // calls this function", and `impact` already walks both.
        // Known limit: callers/callees traverse `calls` globally (every language), so
        // we keep the `calls` edge rather than rewiring that path. If a project has
        // BOTH a module and a subroutine of the same name, the `calls` edge can
        // mis-bind to the subroutine; the `instantiates` edge prefers `module` via the
        // name-matcher bias, but a same-file subroutine can still outscore it. Rare in RTL.
        ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'instantiates', line, column });
        ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'calls', line, column });
      }
      return false; // keep walking: port-connection expressions may contain calls
    }

    // Class fields of a user-class type are the has-a topology of a UVM
    // testbench (env has-an agent, agent has-a driver, ...). Emit a
    // `references` edge class->field-type so callers/callees/impact surface it
    // (those traversals already include `references`); the resolver binds the
    // type name to the class via the normal name/qualified-name match. We point
    // the edge at the class, not a field node — callees doesn't walk `contains`,
    // so a class->field->type chain would never surface.
    if (t === 'class_property') {
      const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
      const typeName = fieldTypeName(node, ctx.source);
      if (fromId && typeName && !SV_BUILTIN_TYPES.has(typeName)) {
        // Walk up to the enclosing class_declaration: it both confirms a real
        // class context (not just whatever sits on nodeStack) and gives the
        // name needed to drop self-pointers (`uvm_component parent;` inside
        // uvm_component) — a class referencing itself is noise in a has-a graph.
        let enclosingClass: SyntaxNode | undefined;
        for (let p = node.parent; p; p = p.parent) {
          if (p.type === 'class_declaration') { enclosingClass = p; break; }
        }
        const enclosingClassName = enclosingClass ? svName(enclosingClass, ctx.source) : undefined;
        if (enclosingClass && typeName !== enclosingClassName) {
          const line = node.startPosition.row + 1;
          const column = node.startPosition.column;
          ctx.addUnresolvedReference({ fromNodeId: fromId, referenceName: typeName, referenceKind: 'references', line, column });
        }
      }
      return false; // keep walking: a field initializer may contain calls
    }

    return false;
  },
};
