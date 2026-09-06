import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import type { NodeKind, ReferenceKind } from '../../types';

// Node names follow the vendored cap-js-community/tree-sitter-cds grammar
// (2.0.0, ABI 14) for SAP CAP's Core Data Services.
//
// CDS is a declarative modelling language: a file holds artifacts (entities,
// services, types, aspects, events, actions) and nothing else. There are no
// call sites, so the whole graph comes from DECLARED structure, and three
// shapes of that structure defeat the generic extractor, which is why every
// symbol-bearing node is dispatched through the visitNode hook below:
//   - an artifact carries its members as direct children under a wrapper the
//     generic walker has no field for (`element_definitions`, `bound_actions`),
//     so a bodiless-looking `entity_definition` would be skipped and its
//     elements never seen;
//   - `extend X with { ... }` and `annotate X with ...` declare no symbol of
//     their own: the directive is a dependency on X plus, for `extend`, a set
//     of members that belong to X, so the members are created with their
//     qualifiedName rooted at X rather than at the file that adds them;
//   - annotations (`@readonly entity E`) sit BEFORE the definition as siblings
//     while inline ones (`service S @(path:'/x') {`) sit inside it, so
//     decorators cannot be read off a single child field.
//
// qualifiedName scheme: `namespace a.b.c;` becomes one `namespace` node named
// `a.b.c` (dotted, a single scope segment) through packageTypes/extractPackage,
// so definitions read `a.b.c::Books`, `a.b.c::Books::title`,
// `a.b.c::CatalogService::Books`. Replacing `::` with `.` in a qualifiedName
// therefore yields exactly the CDS fully qualified name, which is what the
// resolver compares against. A definition DECLARED with a dotted name
// (`entity sap.common.Regions`, what OData import tooling emits) keeps that
// property: it is named by its last segment and its prefix becomes one more
// qualifiedName segment (see definitionName).
//
// Reference names use the same spelling (see cdsReferenceName): the artifact
// path with its first segment expanded through the file's `using ... as`
// aliases, written with `::` before the last segment
// (`sap.capire.bookshop.Books` -> `sap.capire.bookshop::Books`). Built-in
// scalar types are dropped: they have no definition to point at.

/**
 * CDS built-in scalar types (case sensitive, as CDS is). A reference to one of
 * these can never resolve to a node in the repo, so emitting it would leave a
 * permanently unresolved reference on nearly every element in the model.
 * `cds.` / `hana.` prefixed names are the qualified spelling of the same set
 * plus the HANA-native types, handled by isCdsBuiltinType.
 */
export const CDS_BUILTIN_TYPES: ReadonlySet<string> = new Set([
  'String', 'LargeString', 'Binary', 'LargeBinary', 'Boolean',
  'Integer', 'Integer16', 'Integer32', 'Integer64',
  'Int16', 'Int32', 'Int64', 'UInt8',
  'Decimal', 'DecimalFloat', 'Double',
  'Date', 'Time', 'DateTime', 'Timestamp',
  'UUID', 'Vector', 'Map',
]);

/** Whether a type path names a CDS built-in rather than a modelled artifact. */
export function isCdsBuiltinType(name: string): boolean {
  return CDS_BUILTIN_TYPES.has(name) || name.startsWith('cds.') || name.startsWith('hana.');
}

/**
 * The reference name codegraph stores for a CDS artifact path.
 *
 * A `using` alias only ever binds the FIRST segment of a path, so expansion is
 * a single map lookup and the rest of the path is kept as written. The result
 * is spelled the way qualifiedNames are built: the enclosing namespace stays
 * dotted and a `::` separates it from the artifact, so
 * `sap.capire.bookshop.Books` becomes `sap.capire.bookshop::Books` and matches
 * the qualifiedName that definition got from `namespace` + name. A bare name
 * (`Authors`) has no namespace part and stays bare.
 */
export function cdsReferenceName(
  dottedPath: string,
  aliases?: ReadonlyMap<string, string>
): string {
  const segments = dottedPath.split('.').filter((s) => s.length > 0);
  if (segments.length === 0) return '';
  const head = aliases?.get(segments[0]!);
  const expanded = head ? [head, ...segments.slice(1)].join('.') : segments.join('.');
  const lastDot = expanded.lastIndexOf('.');
  return lastDot === -1 ? expanded : `${expanded.slice(0, lastDot)}::${expanded.slice(lastDot + 1)}`;
}

function collapseWs(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** `![Some Name]` is CDS's quoting for identifiers that aren't plain words. */
function stripDelimiters(text: string): string {
  const t = text.trim();
  return t.startsWith('![') && t.endsWith(']') ? t.slice(2, -1) : t;
}

function stringLiteral(text: string): string {
  return text.replace(/^[`'"]/, '').replace(/[`'"]$/, '');
}

/**
 * The dotted path a `simple_path` / `from_path` / `definition_reference` /
 * `annotation_path` node spells. Only DIRECT identifier children are joined, so
 * a path filter or argument hanging off the path (`Books[stock > 0]`) drops out
 * instead of contributing a phantom segment.
 */
function dottedPath(node: SyntaxNode, source: string): string {
  const parts: string[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'identifier') parts.push(stripDelimiters(getNodeText(child, source)));
  }
  return parts.join('.');
}

// --- Per-file state. Extraction is file-sequential within a worker, so a
// single set of module-level maps keyed by filePath is safe (and resets
// naturally when the next file starts). ---

let stateFile = '';
/** Local name -> full artifact path, from this file's `using` directives. */
let aliases = new Map<string, string>();
/** This file's `namespace a.b.c;` path, or '' when it declares none. */
let fileNamespace = '';
/** `fromNodeId|kind|name` of references already emitted for this file. */
let emittedRefs = new Set<string>();
/**
 * First name segment -> kind of every artifact this file defines at its top
 * level (`service AdminService` records `AdminService` -> module). Used to tell
 * a dotted directive target that lives in THIS file's namespace
 * (`extend AdminService.Exposed`) from a global one (`extend sap.common.Countries`).
 */
let fileDefinitions = new Map<string, NodeKind>();

const TOP_LEVEL_KINDS: Readonly<Record<string, NodeKind>> = {
  entity_definition: 'class',
  view_definition: 'class',
  service_definition: 'module',
  context_definition: 'namespace',
  aspect_definition: 'interface',
  type_definition: 'type_alias',
  event_definition: 'struct',
  annotation_definition: 'type_alias',
  action_definition: 'function',
  function_definition: 'function',
};

/**
 * `using` directives are collected up front rather than as the walk reaches
 * them: CDS allows them anywhere at the top level, and an annotation-only file
 * commonly names an imported artifact in the same statement order it imports
 * it, so a lazily built map would expand some paths and not others.
 */
function resetFileState(root: SyntaxNode, source: string, filePath: string): void {
  stateFile = filePath;
  aliases = new Map();
  fileNamespace = '';
  emittedRefs = new Set();
  fileDefinitions = new Map();
  for (const child of root.namedChildren) {
    if (child.type === 'namespace') {
      const path = getChildByField(child, 'path');
      if (path) fileNamespace = dottedPath(path, source);
      continue;
    }
    const kind = TOP_LEVEL_KINDS[child.type];
    if (kind) {
      const nameNode = getChildByField(child, 'name');
      const first = nameNode ? stripDelimiters(getNodeText(nameNode, source)).split('.')[0] : '';
      if (first) fileDefinitions.set(first, kind);
      continue;
    }
    if (child.type !== 'using') continue;
    for (const imported of child.namedChildren) {
      if (imported.type !== 'artifact_import') continue;
      const target = imported.namedChildren.find((c) => c.type === 'definition_reference');
      if (!target) continue;
      const path = dottedPath(target, source);
      if (!path) continue;
      const aliasNode = getChildByField(imported, 'alias');
      // Without `as`, the local name is the path's last segment:
      // `using sap.capire.bookshop.Books` binds `Books`.
      const local = aliasNode ? getNodeText(aliasNode, source) : path.split('.').pop()!;
      aliases.set(stripDelimiters(local), path);
    }
  }
}

function fileAliases(node: SyntaxNode, ctx: ExtractorContext): ReadonlyMap<string, string> {
  if (ctx.filePath !== stateFile) {
    let root = node;
    while (root.parent) root = root.parent;
    resetFileState(root, ctx.source, ctx.filePath);
  }
  return aliases;
}

// --- Annotations, doc comments, signatures ---

/**
 * Node types that a leading annotation run can introduce. Used to tell a
 * definition's own inline annotations from the prefix annotations of the
 * member that follows it.
 */
const DEFINITION_TYPES: ReadonlySet<string> = new Set([
  'entity_definition', 'view_definition', 'service_definition', 'context_definition',
  'aspect_definition', 'type_definition', 'event_definition', 'annotation_definition',
  'action_definition', 'function_definition', 'element_definition', 'mixin_element_definition',
  'enum_symbol_definition', 'parameter_definition', 'annotate_artifact', 'annotate_element',
  'extend_artifact', 'extend_structure', 'extend_projection', 'extend_service', 'extend_context',
]);

/**
 * The annotations written IN FRONT of a definition (`@readonly entity E`).
 * They are siblings, not children, and a doc comment may sit above them. The
 * scan walks EVERY sibling, anonymous tokens included: the `{` that opens a
 * service body is exactly what separates the service's own inline annotations
 * from the prefix annotations of its first member.
 */
function prefixAnnotations(node: SyntaxNode): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  let sibling = node.previousSibling;
  while (sibling) {
    if (sibling.type === 'annotation') found.unshift(sibling);
    else if (sibling.type !== 'comment') break;
    sibling = sibling.previousSibling;
  }
  return found;
}

/** Whether an annotation run starting here introduces a nested definition. */
function introducesDefinition(annotation: SyntaxNode): boolean {
  let sibling = annotation.nextSibling;
  while (sibling && (sibling.type === 'annotation' || sibling.type === 'comment')) {
    sibling = sibling.nextSibling;
  }
  return !!sibling && DEFINITION_TYPES.has(sibling.type);
}

/**
 * The annotations written ON a definition itself: `service S @(path:'/x') {`,
 * `title : String @mandatory;`. A child annotation that introduces a nested
 * definition belongs to that member instead and is picked up there.
 */
function inlineAnnotations(node: SyntaxNode): SyntaxNode[] {
  return node.children.filter((c) => c.type === 'annotation' && !introducesDefinition(c));
}

/**
 * `@readonly`, `@UI.HeaderInfo`, `@cds.persistence.skip` as written. A grouped
 * annotation (`@(a: 1, b.c: 2)`) contributes one entry per group item, which is
 * how CAP itself reads them.
 */
function annotationNames(annotation: SyntaxNode, source: string, out: string[]): void {
  const group = annotation.namedChildren.find((c) => c.type === 'annotation_group');
  const paths = group
    ? group.namedChildren
        .filter((item) => item.type === 'annotation_group_item')
        .map((item) => item.namedChildren.find((c) => c.type === 'annotation_path'))
    : [annotation.namedChildren.find((c) => c.type === 'annotation_path')];
  for (const path of paths) {
    if (!path) continue;
    const name = dottedPath(path, source);
    if (name) out.push(`@${name}`);
  }
}

function decoratorsOf(node: SyntaxNode, source: string, extra: string[] = []): string[] | undefined {
  const names = [...extra];
  for (const annotation of prefixAnnotations(node)) annotationNames(annotation, source, names);
  for (const annotation of inlineAnnotations(node)) annotationNames(annotation, source, names);
  const unique = [...new Set(names)];
  return unique.length > 0 ? unique : undefined;
}

function docstringOf(node: SyntaxNode, source: string): string | undefined {
  // A doc comment sits above the ANNOTATIONS, not above the definition, so the
  // lookup is anchored at the first prefix annotation whenever there is one.
  const anchor = prefixAnnotations(node)[0] ?? node;
  return getPrecedingDocstring(anchor, source);
}

/** Node types that open a definition's body, where its signature stops. */
const BODY_TYPES: ReadonlySet<string> = new Set([
  'element_definitions', 'element_enum_definition', 'select_item_list',
  'bound_actions', 'mixin_definition_list', 'excluding_clause', 'where_clause',
]);

/**
 * An artifact's header: everything up to its body. `entity Books : cuid,
 * managed`, `entity ListOfBooks as projection on Books`. Annotation subtrees
 * are skipped because an annotation VALUE carries braces of its own
 * (`@UI.HeaderInfo: { ... }`) that must not be mistaken for the body.
 */
function headerText(node: SyntaxNode, source: string): string {
  let end = node.endIndex;
  const scan = (n: SyntaxNode): void => {
    for (const child of n.children) {
      if (child.type === 'annotation') continue;
      if (BODY_TYPES.has(child.type) || (!child.isNamed && child.type === '{')) {
        if (child.startIndex < end) end = child.startIndex;
        continue;
      }
      scan(child);
    }
  };
  scan(node);
  return collapseWs(source.substring(node.startIndex, end)).replace(/[:,;]$/, '').trim();
}

/** A member's source line without its terminating semicolon. */
function statementText(node: SyntaxNode, source: string): string {
  return collapseWs(getNodeText(node, source)).replace(/;$/, '').trim();
}

// --- References ---

function emitRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  referenceName: string,
  referenceKind: ReferenceKind,
  at: SyntaxNode
): void {
  const key = `${fromNodeId}|${referenceKind}|${referenceName}`;
  if (emittedRefs.has(key)) return;
  emittedRefs.add(key);
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName,
    referenceKind,
    line: at.startPosition.row + 1,
    column: at.startPosition.column,
  });
}

/**
 * Emit a reference to the artifact a path node names. Built-ins and the CDS
 * pseudo-variables (`$self`, `$user`, `$now`, `$at`, `$projection`) name
 * nothing that can be indexed, so they are dropped rather than left to sit
 * unresolved forever.
 */
function emitPathRef(
  ctx: ExtractorContext,
  fromNodeId: string,
  pathNode: SyntaxNode,
  kind: ReferenceKind,
  aliasMap: ReadonlyMap<string, string>
): void {
  const raw = dottedPath(pathNode, ctx.source);
  if (!raw || raw.startsWith('$') || isCdsBuiltinType(raw)) return;
  const name = cdsReferenceName(raw, aliasMap);
  if (name) emitRef(ctx, fromNodeId, name, kind, pathNode);
}

/**
 * The artifact an `extend` / `annotate` directive names.
 *
 * CDS looks a bare target up in the CURRENT namespace first, so inside
 * `namespace sap.capire.bookshop;` the directive `extend Books with { isbn :
 * String; }` extends `sap.capire.bookshop.Books` and the new element belongs
 * there. The namespace is one dotted qualifiedName segment, which is why the
 * result reads `sap.capire.bookshop::Books` and lines up with the entity's own
 * qualifiedName. Two bare targets are NOT namespace-local: an alias bound by
 * `using` (`extend managed with ...`) already names an artifact elsewhere, and
 * a dotted target is written out in full, so both keep the plain reference
 * spelling.
 */
function directiveTargetName(target: SyntaxNode, ctx: ExtractorContext): string {
  // Refreshes the per-file state, so fileNamespace below is this file's.
  const aliasMap = fileAliases(target, ctx);
  const raw = dottedPath(target, ctx.source);
  if (!raw || raw.startsWith('$') || isCdsBuiltinType(raw)) return '';
  const segments = raw.split('.');
  const first = segments[0]!;
  if (fileNamespace && !aliasMap.has(first)) {
    // A bare target is namespace-local. A dotted one is too when its first
    // segment is an artifact this file defines (`extend AdminService.Exposed`
    // next to `service AdminService`), and is then spelled as the nested
    // scopes the definition itself got. Any other dotted target is a global
    // name (`extend sap.common.Countries`) and keeps its plain spelling.
    if (segments.length === 1) return `${fileNamespace}::${raw}`;
    if (fileDefinitions.has(first)) return `${fileNamespace}::${segments.join('::')}`;
  }
  return cdsReferenceName(raw, aliasMap);
}

/**
 * Whether a directive target sits inside a service this file defines, which
 * makes the members an `extend` adds part of that service's exposed API.
 */
function targetsLocalService(target: SyntaxNode, ctx: ExtractorContext): boolean {
  const aliasMap = fileAliases(target, ctx);
  const first = dottedPath(target, ctx.source).split('.')[0] ?? '';
  return !!first && !aliasMap.has(first) && fileDefinitions.get(first) === 'module';
}

/**
 * Every source a projection or query reads from: the `on` target of a
 * projection, each `from` of a select (comma-separated sources and joins
 * alike), and each `redirected to` target in the select list.
 */
function collectQuerySources(node: SyntaxNode, out: SyntaxNode[]): void {
  for (const child of node.namedChildren) {
    if (child.type === 'from_path') {
      out.push(child);
    } else if (child.type === 'redirected_to') {
      const target = child.namedChildren.find((c) => c.type === 'simple_path');
      if (target) out.push(target);
    } else {
      collectQuerySources(child, out);
    }
  }
}

/**
 * The artifacts a TYPE position names, read off one node's direct children: an
 * association/composition target, a parameterized or plain named type, or the
 * entity behind `type of Books:title`.
 */
function emitTypeRefs(
  node: SyntaxNode,
  fromNodeId: string,
  ctx: ExtractorContext,
  aliasMap: ReadonlyMap<string, string>
): void {
  for (const child of node.namedChildren) {
    switch (child.type) {
      case 'association_to':
      case 'composition_of':
      case 'type_type_of': {
        // The first simple_path is the target; anything after it is the
        // cardinality, the `on` condition or a foreign-key list.
        const target = child.namedChildren.find((c) => c.type === 'simple_path');
        if (target) emitPathRef(ctx, fromNodeId, target, 'references', aliasMap);
        break;
      }
      case 'type_reference': {
        // `Books:ID` borrows an element's type: the artifact is `Books`.
        const target = getChildByField(child, 'name');
        if (target) emitPathRef(ctx, fromNodeId, target, 'references', aliasMap);
        break;
      }
      case 'simple_path':
        // The `type:` field of `title : String` / `currency : Currency`.
        emitPathRef(ctx, fromNodeId, child, 'references', aliasMap);
        break;
      default:
        break;
    }
  }
}

/**
 * Type references anywhere under a parameter list or a return type. Parameters
 * are not symbols of their own, but the artifacts they name are real
 * dependencies of the operation, including the elements of an anonymous
 * `returns { ... }` structure.
 */
function emitNestedTypeRefs(
  node: SyntaxNode,
  fromNodeId: string,
  ctx: ExtractorContext,
  aliasMap: ReadonlyMap<string, string>,
  depth = 0
): void {
  if (depth > 8) return;
  emitTypeRefs(node, fromNodeId, ctx, aliasMap);
  for (const child of node.namedChildren) {
    // A type_reference's second path is an ELEMENT of the first, never an
    // artifact, so its subtree is already fully consumed above.
    if (child.type === 'type_reference' || child.type === 'type_type_of') continue;
    emitNestedTypeRefs(child, fromNodeId, ctx, aliasMap, depth + 1);
  }
}

// --- Definitions ---

interface DefOptions {
  /**
   * The qualifiedName every definition visited under these options hangs off:
   * the enclosing artifact's own qualifiedName, or the target of an `extend X
   * with ...` (whose members belong to X, not to the file that adds them).
   */
  qnPrefix?: string;
  /** Members of a service are its exposed API surface. */
  exported?: boolean;
}

/**
 * The qualifiedName the definitions in the current scope hang off.
 *
 * The core composes a qualifiedName by joining the NAMES on the scope stack,
 * which comes out one segment short as soon as a name is dotted (`entity
 * sap.common.Regions` is NAMED `Regions` but qualified `sap.common::Regions`,
 * so its elements would land under `Regions::code`). Every definition
 * therefore passes its own qualifiedName down as qnPrefix instead of letting
 * the stack recompose one. For an undotted name the two agree exactly.
 */
function scopeQualifiedName(ctx: ExtractorContext, opts: DefOptions): string {
  if (opts.qnPrefix !== undefined) return opts.qnPrefix;
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return '';
  const parent = ctx.nodes.find((n) => n.id === parentId);
  // A file node contributes nothing to a qualifiedName, matching the core.
  return parent && parent.kind !== 'file' ? parent.qualifiedName : '';
}

/**
 * A definition's node name and qualifiedName.
 *
 * CDS allows a DOTTED name wherever a definition is declared (`entity
 * sap.common.Regions : CodeList`, `type a.b.T : String`, `action a.b.c()`),
 * and that is what SAP's OData-to-CDS import tooling emits. The node is NAMED
 * by the last segment so a lookup by name finds it, and the dotted prefix
 * becomes ONE qualifiedName segment, so dot-normalizing the qualifiedName
 * still spells the CDS fully qualified name: `sap.common::Regions` at the top
 * level, `X::sap.common::Regions` under `namespace X;`, `S::a.b::C` inside a
 * service. A delimited identifier is a single name even when it contains a
 * dot, so it is never split.
 */
function definitionName(
  node: SyntaxNode,
  ctx: ExtractorContext,
  opts: DefOptions
): { name: string; qualifiedName: string } | null {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return null;
  const raw = getNodeText(nameNode, ctx.source).trim();
  const text = stripDelimiters(raw);
  const lastDot = raw.startsWith('![') ? -1 : text.lastIndexOf('.');
  const name = lastDot === -1 ? text : text.slice(lastDot + 1);
  if (!name) return null;
  const prefix = lastDot === -1 ? '' : text.slice(0, lastDot);
  const parts = [scopeQualifiedName(ctx, opts), prefix, name].filter((p) => p.length > 0);
  return { name, qualifiedName: parts.join('::') };
}

/** Member node types dispatched back through visitDefinition. */
const MEMBER_TYPES: ReadonlySet<string> = new Set([
  'element_definition', 'action_definition', 'function_definition',
  'entity_definition', 'view_definition', 'service_definition', 'context_definition',
  'aspect_definition', 'type_definition', 'event_definition', 'annotation_definition',
]);

/** Wrappers that hold members instead of being one. */
const MEMBER_WRAPPERS: ReadonlySet<string> = new Set([
  'element_definitions', 'element_enum_definition', 'bound_actions',
  // `Composition of many { ... }` inlines an anonymous aspect as the target.
  'association_to', 'composition_of',
]);

function visitMembers(node: SyntaxNode, ctx: ExtractorContext, opts: DefOptions): void {
  for (const child of node.namedChildren) {
    if (MEMBER_WRAPPERS.has(child.type)) visitMembers(child, ctx, opts);
    else if (child.type === 'enum_symbol_definition') handleEnumSymbol(child, ctx, opts);
    else if (MEMBER_TYPES.has(child.type)) visitDefinition(child, ctx, opts);
  }
}

function handleArtifact(
  node: SyntaxNode,
  ctx: ExtractorContext,
  opts: DefOptions,
  kind: NodeKind,
  extraDecorators: string[] = []
): boolean {
  const named = definitionName(node, ctx, opts);
  if (!named) return true;
  const aliasMap = fileAliases(node, ctx);
  const artifact = ctx.createNode(kind, named.name, node, {
    signature: headerText(node, ctx.source).slice(0, 200),
    docstring: docstringOf(node, ctx.source),
    decorators: decoratorsOf(node, ctx.source, extraDecorators),
    // A service is reachable from outside by definition, as are its members.
    isExported: kind === 'module' || (opts.exported ?? false),
    qualifiedName: named.qualifiedName,
  });
  if (!artifact) return true;

  // `entity Books : cuid, managed` / `aspect A : B` / `event E : Base`
  for (const child of node.namedChildren) {
    if (child.type !== 'include_list') continue;
    for (const include of child.namedChildren) {
      if (include.type === 'simple_path') {
        emitPathRef(ctx, artifact.id, include, 'extends', aliasMap);
      }
    }
  }

  const sources: SyntaxNode[] = [];
  for (const child of node.namedChildren) {
    if (child.type === 'projection_clause' || child.type === 'query_expression') {
      collectQuerySources(child, sources);
    }
  }
  for (const source of sources) emitPathRef(ctx, artifact.id, source, 'references', aliasMap);

  // `type Amount : Decimal(10,2)` / `type Ref : type of Books:title`
  emitTypeRefs(node, artifact.id, ctx, aliasMap);

  ctx.pushScope(artifact.id);
  visitMembers(node, ctx, {
    qnPrefix: artifact.qualifiedName,
    exported: kind === 'module' || (opts.exported ?? false),
  });
  ctx.popScope();
  return true;
}

function handleElement(node: SyntaxNode, ctx: ExtractorContext, opts: DefOptions): boolean {
  const named = definitionName(node, ctx, opts);
  if (!named) return true;
  const aliasMap = fileAliases(node, ctx);
  // `key` and `virtual` are bare keywords, not annotations, but they change what
  // the element IS, so they ride along on the decorators list.
  const modifiers = node.children
    .filter((c) => !c.isNamed && (c.type === 'key' || c.type === 'virtual'))
    .map((c) => c.type);
  const field = ctx.createNode('field', named.name, node, {
    signature: statementText(node, ctx.source).slice(0, 200),
    docstring: docstringOf(node, ctx.source),
    decorators: decoratorsOf(node, ctx.source, modifiers),
    isExported: opts.exported ?? false,
    qualifiedName: named.qualifiedName,
  });
  if (!field) return true;
  emitTypeRefs(node, field.id, ctx, aliasMap);
  ctx.pushScope(field.id);
  visitMembers(node, ctx, {
    qnPrefix: field.qualifiedName,
    exported: opts.exported ?? false,
  });
  ctx.popScope();
  return true;
}

function handleEnumSymbol(node: SyntaxNode, ctx: ExtractorContext, opts: DefOptions): void {
  const named = definitionName(node, ctx, opts);
  if (!named) return;
  ctx.createNode('enum_member', named.name, node, {
    signature: statementText(node, ctx.source).slice(0, 120),
    decorators: decoratorsOf(node, ctx.source),
    isExported: opts.exported ?? false,
    qualifiedName: named.qualifiedName,
  });
}

function handleAction(
  node: SyntaxNode,
  ctx: ExtractorContext,
  opts: DefOptions,
  kind: 'function' | 'method'
): boolean {
  const named = definitionName(node, ctx, opts);
  if (!named) return true;
  const aliasMap = fileAliases(node, ctx);
  const action = ctx.createNode(kind, named.name, node, {
    signature: statementText(node, ctx.source).slice(0, 200),
    docstring: docstringOf(node, ctx.source),
    decorators: decoratorsOf(node, ctx.source),
    isExported: opts.exported ?? false,
    qualifiedName: named.qualifiedName,
  });
  if (!action) return true;
  for (const child of node.namedChildren) {
    if (child.type === 'parameter_list' || child.type === 'return_type') {
      emitNestedTypeRefs(child, action.id, ctx, aliasMap);
    }
  }
  return true;
}

/**
 * `extend X with { ... }` and its projection / service / context / actions
 * variants. The directive declares no symbol: it is a dependency of the
 * enclosing scope on X plus a set of members that belong to X. Select items
 * (`extend X with columns { a, b }`) name existing elements and add nothing.
 */
function handleExtend(node: SyntaxNode, ctx: ExtractorContext, opts: DefOptions): boolean {
  const target = node.namedChildren.find((c) => c.type === 'definition_reference');
  if (!target) return true;
  const root = directiveTargetName(target, ctx);
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (scopeId && root) emitRef(ctx, scopeId, root, 'references', target);
  visitMembers(node, ctx, {
    // An unnamed target (nothing indexable to extend) leaves the members where
    // the scope stack puts them rather than rooting them at an empty prefix.
    ...(root ? { qnPrefix: root } : {}),
    exported: node.type === 'extend_service' || targetsLocalService(target, ctx) || (opts.exported ?? false),
  });
  return true;
}

/**
 * `annotate X with ...`. Pure metadata on an artifact defined elsewhere, so the
 * only graph fact is that this file depends on X.
 */
function handleAnnotate(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const target = node.namedChildren.find((c) => c.type === 'definition_reference');
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (target && scopeId) {
    const name = directiveTargetName(target, ctx);
    if (name) emitRef(ctx, scopeId, name, 'references', target);
  }
  return true;
}

/**
 * One `references` ref per imported artifact, so a definition pulled in by a
 * `using` records a dependency even when the file never names it again (the
 * common shape for `using { Currency, managed } from '@sap/cds/common'`). The
 * `imports` ref for the FILE is emitted by the core from extractImport.
 */
function handleUsing(node: SyntaxNode, ctx: ExtractorContext): void {
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!scopeId) return;
  const aliasMap = fileAliases(node, ctx);
  for (const imported of node.namedChildren) {
    if (imported.type !== 'artifact_import') continue;
    const target = imported.namedChildren.find((c) => c.type === 'definition_reference');
    if (target) emitPathRef(ctx, scopeId, target, 'references', aliasMap);
  }
}

function hasEnumBody(node: SyntaxNode): boolean {
  return node.namedChildren.some((c) => c.type === 'element_enum_definition');
}

function visitDefinition(node: SyntaxNode, ctx: ExtractorContext, opts: DefOptions): boolean {
  switch (node.type) {
    case 'cds':
      resetFileState(node, ctx.source, ctx.filePath);
      return false; // the root's children are dispatched by the core walker
    case 'namespace':
      return true; // the namespace node itself is created by extractFilePackage
    case 'using':
      handleUsing(node, ctx);
      return false; // extractImport (core) creates the import node and its ref
    case 'entity_definition':
    case 'view_definition':
      return handleArtifact(node, ctx, opts, 'class');
    case 'service_definition':
      return handleArtifact(node, ctx, opts, 'module');
    case 'context_definition':
      return handleArtifact(node, ctx, opts, 'namespace');
    case 'aspect_definition':
      return handleArtifact(node, ctx, opts, 'interface');
    case 'event_definition':
      return handleArtifact(node, ctx, opts, 'struct');
    case 'annotation_definition':
      return handleArtifact(node, ctx, opts, 'type_alias', ['annotation']);
    case 'type_definition':
      return handleArtifact(node, ctx, opts, hasEnumBody(node) ? 'enum' : 'type_alias');
    case 'action_definition':
    case 'function_definition':
      // `... } actions { action cancel(); }` binds the operation to the entity.
      return handleAction(node, ctx, opts, node.parent?.type === 'bound_actions' ? 'method' : 'function');
    case 'element_definition':
      return handleElement(node, ctx, opts);
    case 'bound_actions':
      visitMembers(node, ctx, opts);
      return true;
    case 'extend_artifact':
    case 'extend_structure':
    case 'extend_projection':
    case 'extend_service':
    case 'extend_context':
      return handleExtend(node, ctx, opts);
    case 'annotate_artifact':
      return handleAnnotate(node, ctx);
    case 'annotation':
    case 'comment':
      return true; // consumed by decoratorsOf / docstringOf on the definition
    default:
      return false;
  }
}

export const cdsExtractor: LanguageExtractor = {
  // Every symbol-bearing node is dispatched through visitNode; the type lists
  // record the same mapping for the core (and for tooling that reads them).
  functionTypes: ['action_definition', 'function_definition'],
  classTypes: ['entity_definition', 'view_definition'],
  methodTypes: [],
  interfaceTypes: ['aspect_definition'],
  structTypes: ['event_definition'],
  enumTypes: [],
  enumMemberTypes: ['enum_symbol_definition'],
  typeAliasTypes: ['type_definition', 'annotation_definition'],
  importTypes: ['using'],
  callTypes: [], // CDS is declarative: a model has no call sites
  variableTypes: [],
  fieldTypes: ['element_definition'],
  nameField: 'name',
  bodyField: 'element_definitions',
  paramsField: 'parameter_list',
  returnField: 'return_type',

  // `namespace a.b.c;` wraps the file's definitions in one namespace node named
  // `a.b.c`, so an entity's qualifiedName is `a.b.c::Books`, the same spelling
  // cdsReferenceName produces for `a.b.c.Books`, which is what makes
  // cross-file resolution a plain qualified-name match.
  packageTypes: ['namespace'],
  extractPackage: (node, source) => {
    const path = getChildByField(node, 'path');
    return path ? dottedPath(path, source) || null : null;
  },

  extractImport: (node, source) => {
    const file = getChildByField(node, 'file');
    if (!file) return null;
    const moduleName = stringLiteral(getNodeText(file, source));
    if (!moduleName) return null;
    return { moduleName, signature: collapseWs(getNodeText(node, source)).slice(0, 200) };
  },

  visitNode: (node, ctx) => visitDefinition(node, ctx, {}),
};
