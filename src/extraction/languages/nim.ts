import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { NodeKind } from '../../types';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

/**
 * Nim extraction.
 *
 * The callable surface fits the declarative model exactly — every callable
 * (`proc`/`func`/`method`/`iterator`/`template`/`macro`/`converter`) carries
 * `name`, `parameters`, `return_type` and `body` fields — so those ride the
 * standard arrays.
 *
 * The TYPE surface does not fit, and is handled in `visitNode` instead. A Nim
 * type is `type_section` > `type_declaration` > [ `type_symbol_declaration`
 * (the name), <definition> ]: the name and the definition are SIBLINGS, so none
 * of the shapes the core's `typeAliasTypes` path looks for exist — there is no
 * `name` field on the matched node, and `findChildByTypes` on the name node
 * finds no aggregate child. Object fields, enum members and the `import a/[b, c]`
 * list have the same problem (the core's `extractField` reads
 * `variable_declarator` children, and `extractEnumMembers` does not look through
 * `symbol_declaration`). `visitNode` gives all four the handling they need — the
 * same call the nix extractor makes for a grammar that does not fit.
 *
 * Exported names are wrapped in an `exported_symbol` node (`proc foo*`), so
 * every name read goes through `nameOf`/`resolveName` rather than trusting the
 * raw `name` field text.
 */

/** Every Nim callable kind shares `name`/`parameters`/`return_type`/`body`. */
const CALLABLE_TYPES = [
  'proc_declaration',
  'func_declaration',
  'iterator_declaration',
  'template_declaration',
  'macro_declaration',
  'converter_declaration',
];

/** The declared name of a declaration node, or null. */
function nameNodeOf(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'name');
}

/**
 * `foo*` marks a symbol exported: the identifier is wrapped in an
 * `exported_symbol`, whose own text carries the trailing `*`. Unwrap to the
 * identifier so the symbol name is `foo`, and treat the wrapper's presence as
 * the export signal (Nim's only one — there is no visibility keyword).
 */
function nameOf(nameNode: SyntaxNode, source: string): string {
  const unwrapped = nameNode.type === 'exported_symbol' ? nameNode.namedChild(0) : null;
  const text = unwrapped ? getNodeText(unwrapped, source) : getNodeText(nameNode, source);
  return text.replace(/\*+$/, '').trim();
}

function isExportedName(nameNode: SyntaxNode | null): boolean {
  return nameNode?.type === 'exported_symbol';
}

/** The child of a `type_declaration` that is the definition (not the name). */
function typeBodyOf(decl: SyntaxNode): SyntaxNode | null {
  for (const child of decl.namedChildren) {
    if (child.type === 'type_symbol_declaration' || child.type === 'pragma_list') continue;
    return child;
  }
  return null;
}

/** The node kind a Nim type definition maps to. */
function typeKindOf(body: SyntaxNode | null): NodeKind {
  if (!body) return 'type_alias';
  switch (body.type) {
    case 'object_declaration':
      return 'struct';
    case 'ref_type':
      // `ref object` is Nim's reference/inheritance type (the `ref` receiver
      // whose methods dispatch dynamically) — the class-shaped one. A plain
      // `ref T` alias is not.
      return body.namedChildren.some((c) => c.type === 'object_declaration') ? 'class' : 'type_alias';
    case 'enum_declaration':
      return 'enum';
    // A `concept` is a compile-time structural contract — Nim's nearest thing
    // to an interface.
    case 'concept_declaration':
      return 'interface';
    default:
      // `type_expression` (aliases, proc types, tuples), `distinct_type`, …
      return 'type_alias';
  }
}

/** The `object_declaration` inside a type definition, if it has one. */
function objectOf(body: SyntaxNode | null): SyntaxNode | null {
  if (!body) return null;
  if (body.type === 'object_declaration') return body;
  if (body.type === 'ref_type') {
    return body.namedChildren.find((c) => c.type === 'object_declaration') ?? null;
  }
  return null;
}

/**
 * `Derived = ref object of Base` — the superclass is the object's FIRST child,
 * a `type_expression` holding the base name (a bodyless `object` starts with its
 * `field_declaration_list` instead). Emitted as an `extends` reference off the
 * type, which is how the resolver links inheritance.
 */
function emitInheritance(ctx: ExtractorContext, objectDecl: SyntaxNode, typeId: string): void {
  const first = objectDecl.namedChild(0);
  if (!first || first.type !== 'type_expression') return;
  const baseName = getNodeText(first, ctx.source).trim();
  // Only a bare type name is a static target; a generic base or a qualified
  // path stays unresolved rather than guessing.
  if (!/^[A-Za-z_]\w*$/.test(baseName)) return;
  ctx.addUnresolvedReference({
    fromNodeId: typeId,
    referenceName: baseName,
    referenceKind: 'extends',
    line: first.startPosition.row + 1,
    column: first.startPosition.column,
  });
}

/**
 * Object fields: `field_declaration` > `symbol_declaration_list` >
 * `symbol_declaration` (the `name` field) + a `type` field on the declaration.
 * One declaration can bind several names (`x*, y*: int`).
 */
function emitFields(ctx: ExtractorContext, objectDecl: SyntaxNode, typeId: string): void {
  const list = objectDecl.namedChildren.find((c) => c.type === 'field_declaration_list');
  if (!list) return;

  for (const field of list.namedChildren) {
    if (field.type !== 'field_declaration') continue;
    const symList = field.namedChildren.find((c) => c.type === 'symbol_declaration_list');
    if (!symList) continue;

    const typeNode = getChildByField(field, 'type');
    const typeText = typeNode ? getNodeText(typeNode, ctx.source).trim() : undefined;

    // A field's declared type is a dependency of the type declaring it, so it
    // gets a `references` ref (the kind the core uses for type annotations).
    // One ref per DECLARATION, not per name: `x, y: Foo` mentions Foo once.
    //
    // Gated on Nim's own convention — types are capitalized — which is also the
    // cheapest precision gate: it admits `x: Shape` and drops every primitive
    // (`int`, `string`, …), which resolve to nothing and would only cost the
    // resolver a pass. A lowercase user type is missed; a silent miss beats a
    // wrong edge.
    if (typeNode && typeText && /^[A-Z]\w*$/.test(typeText)) {
      ctx.addUnresolvedReference({
        fromNodeId: typeId,
        referenceName: typeText,
        referenceKind: 'references',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }

    for (const sym of symList.namedChildren) {
      if (sym.type !== 'symbol_declaration') continue;
      const nameNode = nameNodeOf(sym);
      if (!nameNode) continue;
      const name = nameOf(nameNode, ctx.source);
      if (!name) continue;
      ctx.createNode('field', name, sym, {
        signature: typeText ? `: ${typeText}` : undefined,
        isExported: isExportedName(nameNode),
      });
    }
  }
}

/**
 * Enum members: `enum_declaration` > `enum_field_declaration` >
 * `symbol_declaration` (the `name` field). The core's enum path cannot reach
 * them — it reads the member's own `name` field, and here that lives one level
 * deeper.
 */
function emitEnumMembers(ctx: ExtractorContext, enumDecl: SyntaxNode): void {
  for (const entry of enumDecl.namedChildren) {
    if (entry.type !== 'enum_field_declaration') continue;
    for (const sym of entry.namedChildren) {
      if (sym.type !== 'symbol_declaration') continue;
      const nameNode = nameNodeOf(sym);
      if (!nameNode) continue;
      const name = nameOf(nameNode, ctx.source);
      if (!name) continue;
      ctx.createNode('enum_member', name, sym, { isExported: isExportedName(nameNode) });
    }
  }
}

/**
 * The module paths an import entry names. An entry is a bare identifier
 * (`os`), a `std/strutils` infix path, or a bracket list — `std/[tables, sets]`
 * names TWO modules, which is why this returns a list.
 */
function moduleNamesOf(entry: SyntaxNode, source: string): string[] {
  if (entry.type === 'identifier' || entry.type === 'accent_quoted') {
    const name = getNodeText(entry, source).trim().replace(/^`|`$/g, '');
    return name ? [name] : [];
  }
  if (entry.type !== 'infix_expression') return [];

  const left = getChildByField(entry, 'left') ?? entry.namedChild(0);
  const right = getChildByField(entry, 'right') ?? entry.namedChild(entry.namedChildCount - 1);
  if (!left || !right) return [];
  const prefix = moduleNamesOf(left, source)[0];
  if (!prefix) return [];

  const tails =
    right.type === 'array_construction' || right.type === 'bracket_expression'
      ? right.namedChildren.flatMap((c) => moduleNamesOf(c, source))
      : moduleNamesOf(right, source);
  return tails.map((tail) => `${prefix}/${tail}`);
}

/** An `import` node plus the `imports` reference the resolver links to a file. */
function emitImport(ctx: ExtractorContext, moduleName: string, anchor: SyntaxNode): void {
  const importNode = ctx.createNode('import', moduleName, anchor, {
    signature: getNodeText(anchor, ctx.source).trim().slice(0, 100),
  });
  if (!importNode || ctx.nodeStack.length === 0) return;
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: moduleName,
    referenceKind: 'imports',
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column,
  });
}

/** `import a, std/b` / `include c` — one module node per named path. */
function emitImportStatement(ctx: ExtractorContext, node: SyntaxNode): void {
  for (const list of node.namedChildren) {
    if (list.type !== 'expression_list') continue;
    for (const entry of list.namedChildren) {
      for (const moduleName of moduleNamesOf(entry, ctx.source)) emitImport(ctx, moduleName, entry);
    }
  }
}

/** `from std/math import PI, sqrt` — the module is what carries the dependency. */
function emitImportFrom(ctx: ExtractorContext, node: SyntaxNode): void {
  const moduleNode = getChildByField(node, 'module');
  if (!moduleNode) return;
  for (const moduleName of moduleNamesOf(moduleNode, ctx.source)) {
    emitImport(ctx, moduleName, moduleNode);
  }
}

export const nimExtractor: LanguageExtractor = {
  functionTypes: CALLABLE_TYPES,
  methodTypes: ['method_declaration'],
  // A Nim `method` is declared at top level and dispatches on its FIRST
  // parameter's type — there is no enclosing class. Same shape as Go's
  // top-level methods with an explicit receiver.
  methodsAreTopLevel: true,
  classTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  // Types, fields, enum members and imports are handled in `visitNode` — see
  // the file comment for why the declarative shapes do not fit.
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call'],
  variableTypes: ['variable_declaration'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  /** `proc foo*` / `Point*` / `x*: int` — unwrap the exported wrapper. */
  resolveName: (node, source) => {
    const nameNode = nameNodeOf(node);
    return isExportedName(nameNode) ? nameOf(nameNode!, source) : undefined;
  },

  isExported: (node) => isExportedName(nameNodeOf(node)),

  /** `let`/`var`/`const` share one declaration shape; the section parent decides. */
  isConst: (node) => node.parent?.type === 'const_section',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    const result = getChildByField(node, 'return_type');
    return getNodeText(params, source) + (result ? ': ' + getNodeText(result, source) : '');
  },

  /**
   * A `method` dispatches on its first parameter's declared type
   * (`method describe(s: Shape)`) — the receiver, by Nim's own rules. Only
   * `method_declaration` has one: `proc`/`func`/`iterator`/`template`/`macro`/
   * `converter` must return undefined so the core keeps them as functions.
   */
  getReceiverType: (node, source) => {
    if (node.type !== 'method_declaration') return undefined;
    const params = getChildByField(node, 'parameters');
    const first = params?.namedChildren.find((c) => c.type === 'parameter_declaration');
    if (!first) return undefined;
    const typeNode = getChildByField(first, 'type');
    const typeText = typeNode ? getNodeText(typeNode, source).trim() : '';
    // A bare type name is a receiver; `seq[int]`, `var T`, `openArray[T]` are not.
    return /^[A-Za-z_]\w*$/.test(typeText) ? typeText : undefined;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'type_declaration') {
      const symDecl = node.namedChildren.find((c) => c.type === 'type_symbol_declaration');
      const nameNode = symDecl ? nameNodeOf(symDecl) : null;
      if (!nameNode) return false;
      const name = nameOf(nameNode, ctx.source);
      if (!name) return false;

      const body = typeBodyOf(node);
      // The declaration node (not the name) anchors the symbol: an object type
      // spans its whole body, and startLine/endLine come from the anchor.
      const typeNode = ctx.createNode(typeKindOf(body), name, node, {
        isExported: isExportedName(nameNode),
      });
      if (!typeNode) return true;

      const objectDecl = objectOf(body);
      if (!objectDecl) {
        if (body?.type === 'enum_declaration') {
          ctx.pushScope(typeNode.id);
          emitEnumMembers(ctx, body);
          ctx.popScope();
        }
        return true;
      }

      ctx.pushScope(typeNode.id);
      emitInheritance(ctx, objectDecl, typeNode.id);
      emitFields(ctx, objectDecl, typeNode.id);
      ctx.popScope();
      return true;
    }

    if (node.type === 'import_statement' || node.type === 'include_statement') {
      emitImportStatement(ctx, node);
      return true;
    }

    if (node.type === 'import_from_statement') {
      emitImportFrom(ctx, node);
      return true;
    }

    return false;
  },
};
