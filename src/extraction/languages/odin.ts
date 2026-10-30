import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Odin extractor — tree-sitter-odin v1.3.0 (ABI 14, vendored).
 *
 * Odin declares EVERYTHING with `Name :: <thing>`, and the grammar splits that
 * one syntax into a node type per thing:
 *   - procedure_declaration            → function   (`f :: proc(...) -> T {}`)
 *   - overloaded_procedure_declaration → function   (`f :: proc{f_a, f_b}`)
 *   - struct_declaration               → struct
 *   - union_declaration                → struct     (no `union` NodeKind; the
 *                                        variants become `references`)
 *   - bit_field_declaration            → struct     (its members are fields)
 *   - enum_declaration                 → enum + enum_member
 *   - const_declaration                → constant, or type_alias when the value
 *                                        is a type expression (`distinct u32`)
 *   - variable_declaration/var_declaration → variable
 *   - import_declaration               → import
 *   - package_declaration              → namespace  (via packageTypes)
 *
 * Three grammar shapes drive the design:
 *
 * 1. NO `name:`/`body:`/`parameters:` FIELDS EXIST. The grammar's only fields
 *    are `alias`, `function`, `argument`, and expression operands — every
 *    declaration is positional: an optional `attributes` node, then the name
 *    identifier, then the thing. So `resolveName` reads the first `identifier`
 *    child (skipping `attributes`, which would otherwise name every decorated
 *    procedure "@(require_results)"), and a procedure's body is reached
 *    through its `procedure` child.
 *
 * 2. RECORD MEMBERS ARE DIRECT CHILDREN — there is no body node to hand the
 *    core's extractStruct/extractEnum, and the record's OWN name is one of the
 *    same-typed children its members are. Both are handled in `visitNode`, the
 *    way tree-sitter-solidity's identically-shaped declarations are.
 *
 * 3. A PACKAGE QUALIFIER IS A SIBLING OF THE CALL, not part of it:
 *    `fmt.println(x)` is member_expression(identifier, call_expression). The
 *    odin branch of extractCall re-attaches it — see tree-sitter.ts.
 */

/** Node types that make a `Name :: <value>` declaration a TYPE alias. */
const TYPE_EXPRESSION_NODES: ReadonlySet<string> = new Set([
  'distinct_type',
  'array_type',
  'pointer_type',
  'multi_pointer_type',
  'map_type',
  'bit_set_type',
  'matrix_type',
  'variadic_type',
  'tuple_type',
  'struct_type',
  'union_type',
  'enum_type',
  'bit_field_type',
  'procedure_type',
  'polymorphic_type',
  'specialized_type',
  'conditional_type',
  'constant_type',
]);

/**
 * Odin's builtin procedures — `base:builtin`, in scope in every package with no
 * import and no qualifier. A call to one is spelled exactly like a call to a
 * procedure of your own, so without this set `len(xs)` enters the resolver as a
 * user symbol and name-matches anything called `len` anywhere in the repo,
 * including a struct FIELD and a package that is never imported. Suppressed at
 * emit time, the way SCALA_BUILTIN_TYPES and terraform's BUILTIN_HEADS are.
 *
 * The cost is a package that SHADOWS a builtin with its own procedure: its
 * calls go unrecorded. That direction loses an edge; the other invents one.
 */
export const ODIN_BUILTINS: ReadonlySet<string> = new Set([
  'len', 'cap', 'size_of', 'align_of', 'offset_of', 'offset_of_selector',
  'offset_of_member', 'offset_of_by_string', 'type_of', 'type_info_of', 'typeid_of',
  'swizzle', 'complex', 'quaternion', 'real', 'imag', 'jmag', 'kmag', 'conj',
  'expand_values', 'min', 'max', 'abs', 'clamp', 'soa_zip', 'soa_unzip',
  'make', 'make_slice', 'make_dynamic_array', 'make_dynamic_array_len',
  'make_dynamic_array_len_cap', 'make_map', 'make_multi_pointer',
  'new', 'new_clone', 'free', 'free_all',
  'delete', 'delete_string', 'delete_map', 'delete_slice', 'delete_dynamic_array',
  'delete_key', 'delete_soa',
  'append', 'append_elem', 'append_elems', 'append_string', 'append_elem_string',
  'append_soa', 'append_nothing', 'inject_at', 'assign_at',
  'clear', 'clear_map', 'clear_dynamic_array', 'clear_soa',
  'reserve', 'reserve_soa', 'resize', 'resize_soa', 'shrink',
  'copy', 'copy_slice', 'copy_from_string',
  'pop', 'pop_safe', 'pop_front', 'pop_front_safe',
  'ordered_remove', 'unordered_remove', 'remove_range',
  'card', 'raw_data', 'container_of',
  'assert', 'assert_contextless', 'ensure', 'ensure_contextless',
  'panic', 'panic_contextless', 'unimplemented', 'unimplemented_contextless',
]);

/** Nodes whose LEADING identifier run is binding names rather than type names. */
const BINDING_PARENTS: ReadonlySet<string> = new Set([
  'parameter',
  'default_parameter',
  'named_type',
  // A nested anonymous `struct { … }` in a field's type position — its members
  // are `struct_member` (a `field` is the top-level form, handled by
  // extractRecord, and listed here so a nested one can never leak either).
  'struct_member',
  'field',
]);

/**
 * Nodes whose DIRECT identifier children are member names, scattered rather
 * than leading: an inline `enum { Fast, Slow }` and an inline
 * `bit_field u8 { lo: bool | 1 }`. Each member's declared TYPE sits under a
 * `type` child, so it still emits.
 */
const MEMBER_LIST_PARENTS: ReadonlySet<string> = new Set(['enum_type', 'bit_field_type']);

/**
 * Whether an identifier is one of its parent's leading binding names — the run
 * before the `:`, which Odin lets carry commas (`a, b: int`, `p, q: int`).
 * Read off the anonymous siblings, because the `,` and `:` are tokens.
 */
function isLeadingBindingName(id: SyntaxNode): boolean {
  if (!BINDING_PARENTS.has(id.parent?.type ?? '')) return false;
  for (let prev = id.previousSibling; prev; prev = prev.previousSibling) {
    if (prev.type !== 'identifier' && prev.text !== ',') return false;
  }
  return true;
}

/** Named children of an Odin declaration, minus its leading `attributes`. */
function declarationChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter((c: SyntaxNode) => c.type !== 'attributes');
}

/** The declared name — the first identifier once `attributes` is skipped. */
function declaredNameNode(node: SyntaxNode): SyntaxNode | null {
  return declarationChildren(node).find((c: SyntaxNode) => c.type === 'identifier') ?? null;
}

/** The `procedure` child holding a procedure declaration's signature + block. */
function procedureOf(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((c: SyntaxNode) => c.type === 'procedure') ?? null;
}

/**
 * Names of the `@(...)` attributes on a declaration (`private`, `test`, …).
 * Read off the nodes' own text rather than the file source, because
 * `extractModifiers` is handed no source.
 */
function attributeNames(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (const attrs of node.namedChildren) {
    if (attrs.type !== 'attributes') continue;
    for (const attr of attrs.namedChildren) {
      for (const id of attr.namedChildren) {
        if (id.type === 'identifier') names.push(id.text);
      }
    }
  }
  return names;
}

/**
 * A member identifier of an enum/bit_field body: everything after the declared
 * name that isn't the backing type and isn't an explicit VALUE (`Low = 1`,
 * `Alias = Other`). The `=` is an anonymous token, so a value identifier is
 * recognised by its preceding sibling rather than by its type.
 */
function memberIdentifiers(node: SyntaxNode, nameNode: SyntaxNode): SyntaxNode[] {
  const members: SyntaxNode[] = [];
  for (const child of declarationChildren(node)) {
    if (child.type !== 'identifier') continue;
    if (child.equals(nameNode)) continue;
    if (child.previousSibling?.text === '=') continue;
    members.push(child);
  }
  return members;
}

/**
 * The names, optional type annotation and initializer values of a positional
 * Odin declaration. Odin allows a COMMA-SEPARATED name list on both the `::`
 * and the `:` form — `A, B :: 1, 2` and `x, y: int = 3, 4` are ONE declaration
 * node each, with the names as a leading run.
 *
 * The comma is what bounds that run, and it has to: `Alias :: Other` has the
 * same two-identifier shape, and taking both would mint a bogus symbol named
 * after the right-hand side. `B` follows a `,`; `Other` follows a `::`.
 */
export function odinDeclarationParts(node: SyntaxNode): {
  names: SyntaxNode[];
  typeNode: SyntaxNode | null;
  values: SyntaxNode[];
} {
  const children = declarationChildren(node);
  const names: SyntaxNode[] = [];
  let index = 0;
  for (; index < children.length; index++) {
    const child = children[index];
    if (!child || child.type !== 'identifier') break;
    if (names.length > 0 && child.previousSibling?.text !== ',') break;
    names.push(child);
  }
  const annotation = children[index];
  const typeNode = annotation?.type === 'type' ? annotation : null;
  if (typeNode) index++;
  return { names, typeNode, values: children.slice(index) };
}

/** Every declared name in a struct `field` — Odin allows `a, b: int`. */
function fieldNameNodes(field: SyntaxNode): SyntaxNode[] {
  const names: SyntaxNode[] = [];
  for (const child of field.namedChildren) {
    if (child.type === 'type') break; // the type ends the name list
    if (child.type === 'identifier') names.push(child);
  }
  return names;
}

/** `Name :: struct/union/bit_field/enum { … }` — one node plus its members. */
function extractRecord(
  node: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'struct' | 'enum',
  memberKind: 'field' | 'enum_member',
): boolean {
  const nameNode = declaredNameNode(node);
  if (!nameNode) return true;

  const created = ctx.createNode(kind, getNodeText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    visibility: odinVisibility(node),
    isExported: odinIsExported(node),
  });
  if (!created) return true;

  ctx.pushScope(created.id);
  if (node.type === 'struct_declaration') {
    for (const field of declarationChildren(node)) {
      if (field.type !== 'field') continue;
      const typeNode = getChildByField(field, 'type') ?? field.namedChildren.find((c: SyntaxNode) => c.type === 'type');
      const typeText = typeNode ? getNodeText(typeNode, ctx.source) : undefined;
      for (const name of fieldNameNodes(field)) {
        const fieldName = getNodeText(name, ctx.source);
        ctx.createNode('field', fieldName, name, {
          signature: typeText ? `${fieldName}: ${typeText}` : fieldName,
        });
      }
      // The field's declared type is a dependency of the record — `next: ^Node`
      // is what makes a struct graph traversable.
      if (typeNode) emitTypeReferences(typeNode, created.id, ctx);
    }
  } else {
    for (const member of memberIdentifiers(node, nameNode)) {
      ctx.createNode(memberKind, getNodeText(member, ctx.source), member);
    }
  }
  ctx.popScope();
  return true;
}

/**
 * `Name :: union { A, B }` — the variants are `type` children, not named
 * members, so they become `references` from the union to each variant type.
 */
function extractUnion(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = declaredNameNode(node);
  if (!nameNode) return true;

  const created = ctx.createNode('struct', getNodeText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    visibility: odinVisibility(node),
    isExported: odinIsExported(node),
  });
  if (!created) return true;

  for (const variant of declarationChildren(node)) {
    if (variant.type === 'type') emitTypeReferences(variant, created.id, ctx);
  }
  return true;
}

/**
 * `f :: proc{f_a, f_b}` — a procedure GROUP. Callers spell it `f(...)`, so it
 * is a function node; the members it dispatches to become `references` so the
 * group links to the overloads an agent actually has to read.
 */
function extractProcedureGroup(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = declaredNameNode(node);
  if (!nameNode) return true;

  const created = ctx.createNode('function', getNodeText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: ctx.source.slice(nameNode.endIndex, node.endIndex).replace(/\s+/g, ' ').replace(/^\s*::\s*/, '').trim(),
    visibility: odinVisibility(node),
    isExported: odinIsExported(node),
  });
  if (!created) return true;

  for (const member of memberIdentifiers(node, nameNode)) {
    ctx.addUnresolvedReference({
      fromNodeId: created.id,
      referenceName: getNodeText(member, ctx.source),
      referenceKind: 'references',
      line: member.startPosition.row + 1,
      column: member.startPosition.column,
    });
  }
  return true;
}

/** `Name :: distinct u32` / `Name :: ^Node` / `Name :: proc() -> bool`. */
function extractTypeAlias(node: SyntaxNode, ctx: ExtractorContext, target: SyntaxNode): boolean {
  const nameNode = declaredNameNode(node);
  if (!nameNode) return false;

  const created = ctx.createNode('type_alias', getNodeText(nameNode, ctx.source), node, {
    docstring: getPrecedingDocstring(node, ctx.source),
    signature: getNodeText(target, ctx.source).trim().slice(0, 200),
    visibility: odinVisibility(node),
    isExported: odinIsExported(node),
  });
  if (created) emitTypeReferences(target, created.id, ctx);
  return true;
}

/**
 * The identifiers inside a type expression that NAME a type, with the two runs
 * of bindings that sit in the same subtree removed:
 *  - a `parameter` / `named_type` / nested `struct_member` leads with its
 *    BINDING names, so `proc(x: int)`, `-> (ok: bool)` and
 *    `inner: struct { parse: int }` would otherwise reference `x`, `ok` and
 *    `parse` as if they were types, and name-match same-named procedures;
 *  - an inline `enum { Fast, Slow }` / `bit_field { lo: bool | 1 }` names its
 *    MEMBERS here; they are bindings too, and never leading ones.
 */
function typeIdentifiers(typeNode: SyntaxNode): SyntaxNode[] {
  return typeNode
    .descendantsOfType('identifier')
    .filter((id: SyntaxNode) => !isLeadingBindingName(id) && !MEMBER_LIST_PARENTS.has(id.parent?.type ?? ''));
}

/**
 * Emit a `references` ref for every user-defined type name inside a type
 * expression, so `^Node`, `[]Cue` and `map[string]Sidecar` all link to the
 * types they name. Builtin TYPE names (`int`, `string`, `u8`) simply resolve to
 * nothing, which costs a lookup and never a wrong edge — no `int` is declared
 * anywhere for one to land on. That argument does NOT carry to builtin
 * PROCEDURES, which share their names with ordinary declarations: see
 * ODIN_BUILTINS, which the odin branch of extractCall refuses before emitting.
 */
function emitTypeReferences(typeNode: SyntaxNode, fromNodeId: string, ctx: ExtractorContext): void {
  for (const id of typeIdentifiers(typeNode)) {
    ctx.addUnresolvedReference({
      fromNodeId,
      referenceName: getNodeText(id, ctx.source),
      referenceKind: 'references',
      line: id.startPosition.row + 1,
      column: id.startPosition.column,
    });
  }
}

/**
 * The type names a composite literal spells in its own HEAD, in source order:
 * `[Fault]string{…}` names the KEY enum and the value type, `[dynamic]Sidecar{}`
 * and `[4]Sidecar{}` name the element, `map[string]Sidecar{}` names both sides,
 * and `Sidecar{…}` names the record itself.
 *
 * Everything from the first `struct_field` on is member DATA and is excluded by
 * construction: `.None = ""` holds a `member_expression` whose identifier is an
 * enum MEMBER, and referencing that would link the literal to whatever `None`
 * happens to name in the package.
 *
 * The enumerated-array TABLE is why this exists. `FAULT := [Fault]string{…}` is
 * a compiler-checked companion to its key enum — add a member and the build
 * fails until the table grows a row — so it is precisely the declaration that
 * must change when the enum does, and without the head it was the one that did
 * not name it. The core walks the literal for CALLS already; the types in front
 * of it are what nothing was reading.
 */
export function odinLiteralTypeNames(value: SyntaxNode): SyntaxNode[] {
  if (value.type !== 'struct' && value.type !== 'map') return [];
  const names: SyntaxNode[] = [];
  for (const child of value.namedChildren) {
    if (child.type === 'struct_field') break;
    if (child.type === 'identifier') names.push(child);
    if (child.type === 'type') names.push(...typeIdentifiers(child));
  }
  return names;
}

/** `@(private)` is Odin's only visibility marker; everything else is package-public. */
function odinVisibility(node: SyntaxNode): 'public' | 'private' {
  return attributeNames(node).some((a) => a === 'private') ? 'private' : 'public';
}

function odinIsExported(node: SyntaxNode): boolean {
  return odinVisibility(node) === 'public';
}

/**
 * Type nodes a return type is reached THROUGH: `-> (s: Sidecar, ok: bool)` is
 * type > tuple_type > named_type > type > identifier, and `-> ^ast.Visitor` is
 * type > pointer_type > type > field_type. Descending picks the FIRST `type`
 * child at each level, which is also what skips a `named_type`'s binding name.
 */
const RETURN_TYPE_WRAPPERS: ReadonlySet<string> = new Set([
  'type',
  'tuple_type',
  'pointer_type',
  'multi_pointer_type',
  'named_type',
]);

/** The bare name of the first type in a return clause, or undefined. */
function returnTypeName(node: SyntaxNode, source: string): string | undefined {
  let cursor: SyntaxNode | null = node;
  for (let depth = 0; cursor && depth < RETURN_TYPE_MAX_DEPTH; depth++) {
    if (cursor.type === 'identifier') return getNodeText(cursor, source).trim();
    // `ast.Visitor` / `transcript.Render_Context` — the last segment is the
    // type; the ones before it are the package.
    if (cursor.type === 'field_type') {
      const last = cursor.namedChildren.filter((c: SyntaxNode) => c.type === 'identifier').at(-1);
      return last ? getNodeText(last, source).trim() : undefined;
    }
    if (!RETURN_TYPE_WRAPPERS.has(cursor.type)) return undefined;
    cursor =
      cursor.namedChildren.find((c: SyntaxNode) => c.type === 'type') ??
      cursor.namedChildren.find(
        (c: SyntaxNode) =>
          RETURN_TYPE_WRAPPERS.has(c.type) || c.type === 'field_type' || c.type === 'identifier'
      ) ??
      null;
  }
  return undefined;
}

/** Deeper than any return clause nests; a guard against a cyclic walk, not a limit. */
const RETURN_TYPE_MAX_DEPTH = 8;

/** Whether a bodiless `procedure_declaration` is an FFI declaration. */
function isForeignProcedure(node: SyntaxNode): boolean {
  return node.parent?.parent?.type === 'foreign_block';
}

export const odinExtractor: LanguageExtractor = {
  functionTypes: ['procedure_declaration'],
  classTypes: [], // Odin has no classes — procedures are all top-level
  methodTypes: [],
  interfaceTypes: [],
  // struct / union / bit_field / enum members are DIRECT children of the
  // declaration (no body node) and the declaration's own name is one of them,
  // so all four are built in visitNode instead of by the core walkers.
  structTypes: [],
  enumTypes: [],
  enumMemberTypes: [],
  // `Name :: distinct u32` is a const_declaration whose VALUE is a type — the
  // split happens in visitNode, so no node type is a type alias on its own.
  typeAliasTypes: [],
  importTypes: ['import_declaration'],
  // `selector_call_expression` (`s->m(3)`) WRAPS a call_expression, so listing
  // it here would emit the same call twice; the odin branch of extractCall
  // reads the wrapper from the inner call instead.
  callTypes: ['call_expression'],
  variableTypes: ['const_declaration', 'const_type_declaration', 'variable_declaration', 'var_declaration'],
  packageTypes: ['package_declaration'],

  // The grammar declares none of these fields (see the header note); they are
  // the interface's required shape, and resolveName/resolveBody do the work.
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  extractPackage: (node, source) => {
    const name = declaredNameNode(node);
    return name ? getNodeText(name, source) : null;
  },

  // Skip the leading `attributes` node: `@(require_results)` sits where a
  // name-field grammar would put the name, and taking firstNamedChild names
  // three quarters of an idiomatic Odin file "@(require_results)".
  resolveName: (node, source) => {
    const name = declaredNameNode(node);
    return name ? getNodeText(name, source) : undefined;
  },

  // A procedure's block hangs off its `procedure` child, not off the declaration.
  resolveBody: (node) => {
    const proc = procedureOf(node);
    return proc?.namedChildren.find((c: SyntaxNode) => c.type === 'block') ?? null;
  },

  getSignature: (node, source) => {
    const proc = procedureOf(node);
    if (!proc) return undefined;
    const block = proc.namedChildren.find((c: SyntaxNode) => c.type === 'block');
    const end = block ? block.startIndex : proc.endIndex;
    return source.slice(proc.startIndex, end).trim();
  },

  // The declared return type, reduced to the bare name a `type_of` edge can
  // land on: `-> ^Sidecar`, `-> (Sidecar, bool)`, `-> (s: Sidecar, ok: bool)`
  // and `-> ^ast.Visitor` give `Sidecar`, `Sidecar`, `Sidecar` and `Visitor`.
  // A NAMED return tuple holds `named_type` children rather than `type` ones,
  // and a QUALIFIED type is a `field_type` — the two shapes that account for
  // 150 of transcibr's 342 returning procedures.
  getReturnType: (node, source) => {
    const proc = procedureOf(node);
    const declared = proc?.namedChildren.find((c: SyntaxNode) => c.type === 'type');
    if (!declared) return undefined;
    const text = returnTypeName(declared, source);
    return text && /^[A-Za-z_]\w*$/.test(text) ? text : undefined;
  },

  getVisibility: odinVisibility,
  isExported: odinIsExported,
  isConst: (node) => node.type === 'const_declaration' || node.type === 'const_type_declaration',

  // `@(test)` / `@(init)` / `@(deferred_out)` are the closest thing Odin has to
  // decorators, and `@(test)` in particular is what marks a test procedure.
  extractModifiers: (node) => {
    const names = attributeNames(node);
    return names.length > 0 ? names : undefined;
  },

  // `import "core:fmt"` / `import st "core:strings"` / `foreign import k "…"`.
  // The path lives in a `string` child's `string_content`; the optional local
  // binding is the only field this node has.
  extractImport: (node, source) => {
    const stringNode = node.namedChildren.find((c: SyntaxNode) => c.type === 'string');
    if (!stringNode) return null;
    const content = stringNode.namedChildren.find((c: SyntaxNode) => c.type === 'string_content');
    const moduleName = getNodeText(content ?? stringNode, source).replace(/^["'`]|["'`]$/g, '').trim();
    if (!moduleName) return null;
    return { moduleName, signature: source.slice(node.startIndex, node.endIndex).trim() };
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'struct_declaration':
        return extractRecord(node, ctx, 'struct', 'field');
      case 'bit_field_declaration':
        return extractRecord(node, ctx, 'struct', 'field');
      case 'enum_declaration':
        return extractRecord(node, ctx, 'enum', 'enum_member');
      case 'union_declaration':
        return extractUnion(node, ctx);
      case 'overloaded_procedure_declaration':
        return extractProcedureGroup(node, ctx);
      case 'const_declaration':
      case 'const_type_declaration': {
        // `Digest :: distinct string` is a type, `MAX :: 12` is a constant, and
        // `Alias :: Other` is indistinguishable from `Alias :: SOME_CONST` at
        // parse time — so only an explicit type EXPRESSION reclassifies, and
        // the bare-identifier form stays a constant (a silent miss, never a
        // wrong kind).
        const value = declarationChildren(node).at(-1);
        if (value && TYPE_EXPRESSION_NODES.has(value.type)) {
          return extractTypeAlias(node, ctx, value);
        }
        return false;
      }
      case 'procedure_declaration': {
        // A procedure with no block is either a proc TYPE (`Cb :: proc(x: int)
        // -> bool`) or an FFI declaration inside a `foreign` block
        // (`GetLastError :: proc() -> u32 ---`). The FFI one is a real callable
        // and falls through to the function path; the type is an alias.
        const proc = procedureOf(node);
        const block = proc?.namedChildren.find((c: SyntaxNode) => c.type === 'block');
        if (proc && !block && !isForeignProcedure(node)) {
          return extractTypeAlias(node, ctx, proc);
        }
        return false;
      }
      default:
        return false;
    }
  },
};
