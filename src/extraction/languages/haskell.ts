import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText, getPrecedingDocstring } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import { HASKELL_EFFECT_ALIAS_HEAD_PREFIX } from '../../types';

// tree-sitter-haskell emits signatures, default signatures, and equations as
// separate syntax nodes. Keep them under one graph node per lexical declaration.
// The syntax-parent span distinguishes same-named locals in separate let blocks;
// methods are already uniquely scoped by their typeclass/instance owner.
// The core creates a lightweight ExtractorContext wrapper for every visited
// syntax node, so key the per-extraction state by the stable nodes array rather
// than by the ephemeral context object. Once an extraction result is released,
// the WeakMap entry can be collected; daemon re-indexing cannot accumulate old
// source coordinates indefinitely.
type ExtractedNode = NonNullable<ReturnType<ExtractorContext['createNode']>>;

interface HaskellExtractionState {
  declarationGroups: Map<string, ExtractedNode>;
  moduleExports?: HaskellModuleExports | null;
  localTypeNames?: Set<string>;
  lexicalBindings: Map<string, Map<string, LexicalBinding[]>>;
  signatureIndexes: Map<string, Map<string, SyntaxNode[]>>;
  scopeNodes: Map<string, ExtractedNode | undefined>;
}

interface LexicalBinding {
  startIndex: number;
  materializedNode: boolean;
}

const extractionStates = new WeakMap<object, HaskellExtractionState>();

function extractionState(owner: object): HaskellExtractionState {
  let state = extractionStates.get(owner);
  if (!state) {
    state = {
      declarationGroups: new Map(),
      lexicalBindings: new Map(),
      signatureIndexes: new Map(),
      scopeNodes: new Map(),
    };
    extractionStates.set(owner, state);
  }
  return state;
}

function declarationGroupMap(ctx: ExtractorContext): Map<string, ExtractedNode> {
  return extractionState(ctx.nodes as object).declarationGroups;
}

function scopeOwner(ctx: ExtractorContext, id?: string): ExtractedNode | undefined {
  const ownerId = id ?? ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!ownerId) return undefined;
  const state = extractionState(ctx.nodes as object);
  if (state.scopeNodes.has(ownerId)) return state.scopeNodes.get(ownerId);
  const owner = ctx.nodes.find((candidate) => candidate.id === ownerId);
  state.scopeNodes.set(ownerId, owner);
  return owner;
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// Haskell identifiers are Unicode-aware. Centralize their lexical shape so
// accented/Greek declarations, exports, and qualified references are all
// classified the same way instead of being mistaken for symbolic operators.
const HASKELL_ID_CONTINUE_SOURCE = String.raw`[\p{L}\p{Mn}\p{N}_']`;
const HASKELL_IDENTIFIER_SOURCE = String.raw`(?:[\p{Ll}\p{Lo}\p{Lu}\p{Lt}_]${HASKELL_ID_CONTINUE_SOURCE}*#*)`;
const HASKELL_CONID_SOURCE = String.raw`(?:[\p{Lu}\p{Lt}]${HASKELL_ID_CONTINUE_SOURCE}*)`;
const HASKELL_MODULE_NAME_SOURCE = String.raw`${HASKELL_CONID_SOURCE}(?:\.${HASKELL_CONID_SOURCE})*`;
const HASKELL_IDENTIFIER_RE = new RegExp(`^${HASKELL_IDENTIFIER_SOURCE}$`, 'u');
export const HASKELL_CONID_START_RE = /^[\p{Lu}\p{Lt}]/u;
const HASKELL_VARID_START_RE = /^[\p{Ll}\p{Lo}_]/u;

function firstDescendant(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  if (types.has(node.type)) return node;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const hit = firstDescendant(child, types);
    if (hit) return hit;
  }
  return null;
}

interface HaskellModuleExports {
  /** Direct type/class exports (`T`, `type T`, and the parent in `T(..)`). */
  directTypes: Set<string>;
  /** Direct value exports (`foo`, `(+)`, and `pattern P`). */
  directValues: Set<string>;
  allChildren: Set<string>;
  /** Per-parent grouped children, retaining their type/value namespace. */
  children: Map<string, Map<string, Set<HaskellNamespace>>>;
  exportsSelf: boolean;
}

type HaskellNamespace = 'type' | 'value';

interface HaskellChildExport {
  name: string;
  namespaces: Set<HaskellNamespace>;
}

/**
 * Read one grouped export list from tree-sitter's concrete children. The
 * grammar currently recovers `type (+)` / `pattern P` through ERROR nodes, so
 * relying only on named fields loses the explicit namespace. Splitting on the
 * concrete comma tokens keeps each recovery fragment together without having
 * to reparse the surrounding module header.
 */
function groupedChildExports(children: SyntaxNode, source: string): HaskellChildExport[] {
  const segments: SyntaxNode[][] = [];
  let segment: SyntaxNode[] = [];
  for (const child of children.children) {
    if (child.type === ',') {
      if (segment.length > 0) segments.push(segment);
      segment = [];
    } else if (child.type !== '(' && child.type !== ')') {
      segment.push(child);
    }
  }
  if (segment.length > 0) segments.push(segment);

  const exportNameNodes = new Set(['variable', 'constructor', 'name', 'operator', 'constructor_operator']);
  const descendantTexts = (nodes: SyntaxNode[]): string[] => {
    const texts: string[] = [];
    const stack = [...nodes];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.type === 'associated_type') texts.push('type');
      if (exportNameNodes.has(current.type)
        || (current.type === 'ERROR' && /^(?:type|pattern)$/.test(getNodeText(current, source).trim()))) {
        const text = getNodeText(current, source).trim();
        if (text) texts.push(text);
      }
      stack.push(...current.namedChildren);
    }
    return texts;
  };

  const exports: HaskellChildExport[] = [];
  for (const nodes of segments) {
    const texts = descendantTexts(nodes);
    const explicitType = texts.includes('type');
    const explicitPattern = texts.includes('pattern');
    const rawName = [...texts].reverse().find((text) => text !== 'type' && text !== 'pattern') ?? '';
    const name = rawName.startsWith('(') && rawName.endsWith(')')
      ? rawName.slice(1, -1).trim()
      : rawName;
    if (!name || name === '..') continue;

    const namespaces = new Set<HaskellNamespace>();
    if (explicitType) namespaces.add('type');
    else if (explicitPattern || HASKELL_VARID_START_RE.test(name)
      || (!name.startsWith(':') && !HASKELL_IDENTIFIER_RE.test(name))) {
      namespaces.add('value');
    } else {
      // Uppercase names and constructor operators are resolved relative to
      // their parent: they can denote either a data constructor/pattern or an
      // associated type. Preserve both until node-kind filtering has evidence.
      namespaces.add('type');
      namespaces.add('value');
    }
    exports.push({ name, namespaces });
  }
  return exports;
}

function syntaxRoot(node: SyntaxNode): SyntaxNode {
  let root = node;
  while (root.parent) root = root.parent;
  return root;
}

function normalizedExportName(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source).replace(/\s+/g, '').trim();
  return text.startsWith('(') && text.endsWith(')') ? text.slice(1, -1) : text;
}

function parenthesizedOperator(name: string): string {
  const compact = name.replace(/\s+/g, '').trim();
  if (!compact) return compact;
  return compact.startsWith('(') && compact.endsWith(')') ? compact : `(${compact})`;
}

/** Canonical node name for the operator field of an infix declaration. */
function declaredInfixName(text: string): string {
  const compact = text.replace(/\s+/g, '').trim();
  if (!compact) return compact;
  // Backticks make an ordinary identifier infix; they do not turn its name
  // into a symbolic operator. Keeping `foo` bare is what lets its signature,
  // export entry, prefix calls, and backtick calls all meet on one symbol. The
  // delimiters themselves prove the payload is an identifier, including a
  // Unicode varid that an ASCII character-class cannot recognize.
  if (compact.startsWith('`') && compact.endsWith('`') && compact.length > 2) {
    return compact.slice(1, -1);
  }
  return HASKELL_IDENTIFIER_RE.test(compact)
    ? compact
    : parenthesizedOperator(compact);
}

function getHaskellPrecedingDocstring(node: SyntaxNode, source: string): string | undefined {
  const direct = getPrecedingDocstring(node, source);
  if (direct) return direct;
  // tree-sitter-haskell places a Haddock comment for the first declaration as
  // a sibling of the `declarations` wrapper rather than inside it.
  if (
    node.parent?.type === 'declarations'
    && node.previousNamedSibling === null
  ) {
    return getPrecedingDocstring(node.parent, source);
  }
  return undefined;
}

/** Canonical reference spelling used by the Haskell import resolver. */
export function normalizeReferenceText(text: string): string {
  let compact = text.replace(/\s+/g, '').trim().replace(/^`|`$/g, '');
  // tree-sitter represents a qualified prefix operator as one prefix_id whose
  // text is `(L.<+>)`. Remove only those reference-position parentheses; an
  // unqualified operator declaration keeps its conventional `(+)` node name.
  if (compact.startsWith('(') && compact.endsWith(')')) {
    const inner = compact.slice(1, -1);
    if (new RegExp(`^(?:${HASKELL_CONID_SOURCE}\\.)+`, 'u').test(inner)) compact = inner;
  }
  const qualified = compact.match(new RegExp(
    `^((?:${HASKELL_CONID_SOURCE}\\.)+)(.+)$`,
    'u',
  ));
  if (!qualified) return compact;
  const member = qualified[2]!;
  return `${qualified[1]!.slice(0, -1)}::${
    HASKELL_IDENTIFIER_RE.test(member) ? member : parenthesizedOperator(member)
  }`;
}

/** Split a normalized reference at its module delimiter, never inside an op. */
export function haskellReferenceParts(name: string): { qualifier: string | null; member: string } {
  const qualified = name.match(new RegExp(
    `^(${HASKELL_MODULE_NAME_SOURCE})::(.+)$`,
    'u',
  ));
  const rawMember = qualified?.[2] ?? name;
  const member = rawMember.startsWith('(') && rawMember.endsWith(')')
    ? rawMember.slice(1, -1)
    : rawMember;
  return { qualifier: qualified?.[1] ?? null, member };
}

/** Canonical spelling for an unqualified term in Haskell's lexical scope. */
function lexicalBindingName(name: string): string {
  const parts = haskellReferenceParts(name);
  return parts.qualifier === null ? parts.member : name;
}

interface HaskellDeclarationHead {
  /** Declared family/class/type name, parenthesized when it is an operator. */
  baseName: string;
  /** Full applied LHS, useful for instance node display names. */
  displayName: string;
  nameNode: SyntaxNode;
}

/** Extract a declaration's LHS without ever falling through into its RHS. */
function declarationHead(node: SyntaxNode, source: string): HaskellDeclarationHead | null {
  const nameNode = getChildByField(node, 'name');
  if (nameNode) {
    const baseName = getNodeText(nameNode, source).trim();
    const patterns = getChildByField(node, 'patterns');
    return {
      baseName,
      displayName: collapseWhitespace(`${baseName} ${patterns ? getNodeText(patterns, source) : ''}`),
      nameNode,
    };
  }

  const infix = node.namedChildren.find((child) => child.type === 'infix');
  const operator = infix ? getChildByField(infix, 'operator') : null;
  if (!infix || !operator) return null;
  return {
    baseName: declaredInfixName(getNodeText(operator, source)),
    displayName: collapseWhitespace(getNodeText(infix, source)),
    nameNode: operator,
  };
}

/** Parse the module header's explicit export list from the existing AST. */
function parseModuleExports(node: SyntaxNode, source: string): HaskellModuleExports | null {
  const root = syntaxRoot(node);
  const header = root.namedChildren.find((child) => child.type === 'header');
  if (!header) return null;
  const exportsNode = getChildByField(header, 'exports');
  if (!exportsNode) return null; // No list means Haskell's normal "export all".

  const result: HaskellModuleExports = {
    directTypes: new Set(),
    directValues: new Set(),
    allChildren: new Set(),
    children: new Map(),
    exportsSelf: false,
  };
  const ownModule = getChildByField(header, 'module');
  const ownModuleName = ownModule ? getNodeText(ownModule, source).replace(/\s+/g, '') : '';

  for (const entry of exportsNode.namedChildren) {
    if (entry.type === 'module_export') {
      const reexported = getChildByField(entry, 'module');
      if (reexported && getNodeText(reexported, source).replace(/\s+/g, '') === ownModuleName) {
        result.exportsSelf = true;
      }
      continue;
    }
    if (entry.type !== 'export') continue;
    const value = getChildByField(entry, 'variable')
      ?? getChildByField(entry, 'type')
      ?? getChildByField(entry, 'operator')
      ?? firstDescendant(entry, new Set(['variable', 'constructor', 'name', 'prefix_id']));
    if (!value) continue;
    const rawName = normalizedExportName(value, source);
    let qualifiedValue = value;
    while (qualifiedValue.type === 'prefix_id' && qualifiedValue.namedChildCount === 1) {
      qualifiedValue = qualifiedValue.namedChild(0)!;
    }
    const qualifier = qualifiedValue.type === 'qualified'
      ? getChildByField(qualifiedValue, 'module')
      : null;
    const qualifiedName = qualifiedValue.type === 'qualified'
      ? getChildByField(qualifiedValue, 'id')
      : null;
    const name = qualifier && qualifiedName
      && getNodeText(qualifier, source).replace(/\s+/g, '').replace(/\.$/, '') === ownModuleName
      ? normalizedExportName(qualifiedName, source)
      : rawName;
    if (!name) continue;
    const explicitNamespace = getChildByField(entry, 'namespace');
    const namespaceText = explicitNamespace
      ? getNodeText(explicitNamespace, source).trim()
      : '';
    // The AST's field distinguishes ordinary lowercase/value operators from
    // uppercase type names. `pattern` deliberately switches an uppercase
    // constructor/pattern synonym back to the value namespace.
    const namespace: HaskellNamespace = namespaceText === 'pattern'
      ? 'value'
      : namespaceText === 'type'
        ? 'type'
        : getChildByField(entry, 'variable') !== null
          || getChildByField(entry, 'operator') !== null
          ? 'value'
          : 'type';
    (namespace === 'value' ? result.directValues : result.directTypes).add(name);

    const children = getChildByField(entry, 'children');
    if (!children) continue;
    if (children.namedChildren.some((child) => child.type === 'all_names')) {
      result.allChildren.add(name);
      continue;
    }
    const names = new Map<string, Set<HaskellNamespace>>();
    for (const child of groupedChildExports(children, source)) {
      const namespaces = names.get(child.name) ?? new Set<HaskellNamespace>();
      for (const namespace of child.namespaces) namespaces.add(namespace);
      names.set(child.name, namespaces);
    }
    result.children.set(name, names);
  }
  return result;
}

function moduleExports(
  node: SyntaxNode,
  source: string,
  stateOwner: object,
): HaskellModuleExports | null {
  const state = extractionState(stateOwner);
  if (state.moduleExports !== undefined) return state.moduleExports;
  state.moduleExports = parseModuleExports(node, source);
  return state.moduleExports;
}

function isNameExported(
  node: SyntaxNode,
  source: string,
  name: string,
  stateOwner: object,
  parentName?: string,
  namespace: HaskellNamespace = 'value',
): boolean {
  const exports = moduleExports(node, source, stateOwner);
  if (!exports || exports.exportsSelf) return true;
  const canonical = name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name;
  const canonicalParent = parentName?.startsWith('(') && parentName.endsWith(')')
    ? parentName.slice(1, -1)
    : parentName;
  const directlyExported = namespace === 'value'
    ? exports.directValues.has(canonical)
    : exports.directTypes.has(canonical);
  if (!canonicalParent) return directlyExported;
  return directlyExported
    || exports.allChildren.has(canonicalParent)
    || exports.children.get(canonicalParent)?.get(canonical)?.has(namespace)
    || false;
}

/** Explicit parents that bundle a child in the module export list (`T(P)`). */
function bundledExportParents(
  node: SyntaxNode,
  source: string,
  name: string,
  stateOwner: object,
): string[] {
  const exports = moduleExports(node, source, stateOwner);
  if (!exports) return [];
  const canonical = name.startsWith('(') && name.endsWith(')') ? name.slice(1, -1) : name;
  return [...exports.children]
    .filter(([, children]) => children.get(canonical)?.has('value') === true)
    .map(([parent]) => parent);
}

function signatureNames(node: SyntaxNode, source: string): string[] {
  const names = getChildByField(node, 'names');
  if (names) {
    return names.namedChildren
      .filter((child) => child.type === 'variable' || child.type === 'prefix_id')
      .map((child) => getNodeText(child, source).trim())
      .filter(Boolean);
  }
  const name = getChildByField(node, 'name');
  return name ? [getNodeText(name, source).trim()] : [];
}

function signatureIndex(
  container: SyntaxNode,
  source: string,
  stateOwner: object,
): Map<string, SyntaxNode[]> {
  const key = `${container.type}:${container.startIndex}:${container.endIndex}`;
  const state = extractionState(stateOwner);
  const cached = state.signatureIndexes.get(key);
  if (cached) return cached;

  const index = new Map<string, SyntaxNode[]>();
  for (const child of container.namedChildren) {
    const signature = child.type === 'signature'
      ? child
      : child.type === 'default_signature'
        ? child.namedChildren.find((candidate) => candidate.type === 'signature') ?? null
        : child.type === 'foreign_export'
          ? foreignSignature(child)
          : null;
    if (!signature) continue;
    for (const name of signatureNames(signature, source)) {
      const entries = index.get(name) ?? [];
      entries.push(signature);
      index.set(name, entries);
    }
  }
  state.signatureIndexes.set(key, index);
  return index;
}

function associatedSignature(
  node: SyntaxNode,
  name: string,
  source: string,
  stateOwner: object,
): SyntaxNode | null {
  const container = node.parent;
  if (!container) return null;
  const index = node.type === 'pattern_synonym' ? patternSignatureIndex : signatureIndex;
  const candidates = index(container, source, stateOwner).get(name);
  if (!candidates) return null;
  for (let i = candidates.length - 1; i >= 0; i--) {
    if (candidates[i]!.startIndex < node.startIndex) return candidates[i]!;
  }
  // Ordinary bindings and pattern synonyms both allow their signature after
  // the equation. Prefer the conventional preceding declaration, then the
  // first later signature in this exact declaration container.
  return candidates.find((candidate) => candidate.startIndex > node.endIndex) ?? null;
}

function bindingDocstring(
  node: SyntaxNode,
  signatureNode: SyntaxNode | null,
  source: string,
): string | undefined {
  if (signatureNode && signatureNode.startIndex < node.startIndex) {
    return getHaskellPrecedingDocstring(signatureNode, source)
      ?? getHaskellPrecedingDocstring(node, source);
  }
  // A trailing signature must not move the doc anchor past a Haddock comment
  // attached to the binding itself. Still accept a comment on that signature
  // as a fallback for the less common reverse-declaration style.
  return getHaskellPrecedingDocstring(node, source)
    ?? (signatureNode ? getHaskellPrecedingDocstring(signatureNode, source) : undefined);
}

function patternSynonymNameNode(node: SyntaxNode): SyntaxNode | null {
  const equation = node.namedChildren.find((child) => child.type === 'equation');
  const signature = node.namedChildren.find((child) => child.type === 'signature');
  let nameNode = equation
    ? getChildByField(equation, 'synonym')
    : signature
      ? getChildByField(signature, 'synonym') ?? getChildByField(signature, 'name')
      : null;
  while (nameNode?.type === 'apply') nameNode = getChildByField(nameNode, 'function');
  if (nameNode?.type === 'infix') nameNode = getChildByField(nameNode, 'operator');
  if (nameNode?.type === 'record') nameNode = getChildByField(nameNode, 'constructor');
  return nameNode;
}

function patternSynonymName(node: SyntaxNode, source: string): string {
  const nameNode = patternSynonymNameNode(node);
  if (!nameNode) return '';
  return declaredInfixName(normalizedExportName(nameNode, source));
}

function patternSignatureIndex(
  container: SyntaxNode,
  source: string,
  stateOwner: object,
): Map<string, SyntaxNode[]> {
  const key = `pattern:${container.type}:${container.startIndex}:${container.endIndex}`;
  const state = extractionState(stateOwner);
  const cached = state.signatureIndexes.get(key);
  if (cached) return cached;

  const index = new Map<string, SyntaxNode[]>();
  for (const child of container.namedChildren) {
    if (child.type !== 'pattern_synonym') continue;
    const signature = child.namedChildren.find((candidate) => candidate.type === 'signature');
    if (!signature) continue;
    const synonym = getChildByField(signature, 'synonym') ?? getChildByField(signature, 'name');
    const nameNodes = synonym?.type === 'binding_list'
      ? synonym.namedChildren
      : synonym
        ? [synonym]
        : [];
    for (const nameNode of nameNodes) {
      const rawName = normalizedExportName(nameNode, source);
      if (!rawName) continue;
      const name = declaredInfixName(rawName);
      const entries = index.get(name) ?? [];
      // Retain the wrapper: the nested `signature` span omits the `pattern`
      // keyword and a preceding Haddock comment belongs to this declaration.
      entries.push(child);
      index.set(name, entries);
    }
  }
  state.signatureIndexes.set(key, index);
  return index;
}

function declarationGroupKey(
  node: SyntaxNode,
  name: string,
  kind: 'function' | 'method' | 'constant',
  ctx: ExtractorContext,
): string {
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  if (kind === 'method') return `${ctx.filePath}:method:${scopeId}:${name}`;
  const container = node.parent;
  const containerSpan = container ? `${container.startIndex}:${container.endIndex}` : 'root';
  return `${ctx.filePath}:${kind}:${scopeId}:${containerSpan}:${name}`;
}

function lexicalRangeDecorator(node: SyntaxNode): string | null {
  let ancestor = node.parent;
  while (ancestor) {
    if (['let_in', 'alternative', 'function', 'do', 'list_comprehension'].includes(ancestor.type)) {
      return `haskell-lexical-range:${ancestor.startPosition.row + 1}:${ancestor.endPosition.row + 1}`;
    }
    ancestor = ancestor.parent;
  }
  return null;
}

function groupedNode(key: string, ctx: ExtractorContext) {
  return declarationGroupMap(ctx).get(key);
}

function extendGroupedNode(node: SyntaxNode, existing: NonNullable<ReturnType<typeof groupedNode>>): void {
  const startLine = node.startPosition.row + 1;
  const endLine = node.endPosition.row + 1;
  if (startLine < existing.startLine) {
    existing.startLine = startLine;
    existing.startColumn = node.startPosition.column;
  } else if (startLine === existing.startLine) {
    existing.startColumn = Math.min(existing.startColumn, node.startPosition.column);
  }
  if (endLine > existing.endLine) {
    existing.endLine = endLine;
    existing.endColumn = node.endPosition.column;
  } else if (endLine === existing.endLine) {
    existing.endColumn = Math.max(existing.endColumn, node.endPosition.column);
  }
}

function visitFunctionPayload(node: SyntaxNode, functionId: string, ctx: ExtractorContext): void {
  ctx.pushScope(functionId);
  const explicitPattern = getChildByField(node, 'pattern');
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (
      child.type === 'match'
      || child.type === 'patterns'
      || (!!explicitPattern
        && child.startIndex === explicitPattern.startIndex
        && child.endIndex === explicitPattern.endIndex)
      || child.type === 'local_binds'
      || child.type === 'where'
    ) {
      // Route through the full visitor, not the calls-only body walker: Haskell
      // permits named local functions in let/where blocks and those need the
      // language hook for clause grouping and signature attachment.
      ctx.visitNode(child);
    } else if (child.type === 'infix') {
      // An infix declaration stores its two parameter patterns on the infix
      // head rather than in a `patterns` field. Visit the operands, but not the
      // declaring operator itself (which is not a reference).
      const left = getChildByField(child, 'left_operand');
      const right = getChildByField(child, 'right_operand');
      if (left) ctx.visitNode(left);
      if (right) ctx.visitNode(right);
    }
  }
  ctx.popScope();
}

function signatureDeclaresFunction(signatureNode: SyntaxNode): boolean {
  let type = getChildByField(signatureNode, 'type');
  while (type && (type.type === 'forall' || type.type === 'context' || type.type === 'parens')) {
    type = getChildByField(type, 'type') ?? (type.namedChildCount === 1 ? type.namedChild(0) : null);
  }
  return type?.type === 'function';
}

// A transformer name is not enough to prove an effect: Haskell modules may
// declare the same nominal type. Require its monad-carrier argument to be a
// type variable corroborated by the signature context as well, then defer the
// nominal head's origin to import/re-export resolution.
const TRANSFORMER_CARRIER_ARGUMENT = new Map<string, number>([
  ['ExceptT', 1],
  ['ReaderT', 1],
  ['StateT', 1],
  ['WriterT', 1],
  ['RWST', 3],
]);

const PRIMITIVE_EFFECT_HEADS = new Set(['IO', 'ST', 'STM']);

interface ExecutableResultProof {
  /** Nominal heads whose canonical origins must all be checked by the resolver. */
  importedEffectHeads: string[];
}

function isMonadConstraintHead(name: string): boolean {
  // Some project-level effect capabilities do not follow the Monad* naming
  // convention. Keep the transaction capability validated on real code; the
  // carrier-position check below still prevents unrelated mentions of `m`
  // from promoting a binding.
  return name === 'Monad' || name.startsWith('Monad') || name === 'PrimMonad' || name === 'RunTx';
}

function appliedTypeHead(type: SyntaxNode | null): SyntaxNode | null {
  let current = type;
  while (current?.type === 'parens') {
    current = getChildByField(current, 'type')
      ?? (current.namedChildCount === 1 ? current.namedChild(0) : null);
  }
  while (current?.type === 'apply') {
    current = getChildByField(current, 'constructor') ?? current.namedChild(0);
    while (current?.type === 'parens') {
      current = getChildByField(current, 'type')
        ?? (current.namedChildCount === 1 ? current.namedChild(0) : null);
    }
  }
  return current;
}

function appliedTypeParts(type: SyntaxNode | null): {
  head: SyntaxNode | null;
  typeArguments: SyntaxNode[];
} {
  let current = type;
  while (current?.type === 'parens') {
    current = getChildByField(current, 'type')
      ?? (current.namedChildCount === 1 ? current.namedChild(0) : null);
  }
  const typeArguments: SyntaxNode[] = [];
  while (current?.type === 'apply') {
    const argument = getChildByField(current, 'argument')
      ?? (current.namedChildCount > 1 ? current.namedChild(current.namedChildCount - 1) : null);
    if (argument) typeArguments.unshift(argument);
    current = getChildByField(current, 'constructor') ?? current.namedChild(0);
    while (current?.type === 'parens') {
      current = getChildByField(current, 'type')
        ?? (current.namedChildCount === 1 ? current.namedChild(0) : null);
    }
  }
  return { head: current, typeArguments };
}

const LOCAL_TYPE_DECLARATION_NODES = new Set([
  'class', 'data_type', 'newtype', 'type_synomym', 'data_family', 'type_family',
]);

function moduleLocalTypeNames(
  node: SyntaxNode,
  source: string,
  stateOwner: object,
): Set<string> {
  const state = extractionState(stateOwner);
  if (state.localTypeNames) return state.localTypeNames;
  const names = new Set<string>();
  const stack = [syntaxRoot(node)];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (LOCAL_TYPE_DECLARATION_NODES.has(current.type)) {
      const head = declarationHead(current, source);
      if (head?.baseName) names.add(head.baseName);
    }
    stack.push(...current.namedChildren);
  }
  state.localTypeNames = names;
  return names;
}

function primitiveEffectProof(
  normalized: string,
  leaf: string,
  localTypeNames: ReadonlySet<string>,
): ExecutableResultProof | null {
  if (!PRIMITIVE_EFFECT_HEADS.has(leaf)) return null;
  // Qualified IO-like names are not accepted. Exact IO still goes through the
  // resolver so `Prelude hiding (IO)` plus a custom import cannot fabricate a
  // call edge.
  if (leaf === 'IO') {
    return normalized === leaf && !localTypeNames.has(leaf)
      ? { importedEffectHeads: [normalized] }
      : null;
  }
  if (normalized === leaf && localTypeNames.has(leaf)) return null;
  return { importedEffectHeads: [normalized] };
}

function isTransformerCandidate(
  normalized: string,
  leaf: string,
  localTypeNames: ReadonlySet<string>,
): boolean {
  if (!TRANSFORMER_CARRIER_ARGUMENT.has(leaf)) return false;
  if (normalized === leaf) return !localTypeNames.has(leaf);
  // A qualifier may be canonical, an alias for a canonical module, or custom.
  // The persisted marker lets import resolution decide without guessing.
  return true;
}

function monadicConstraintUsesVariable(
  context: SyntaxNode | null,
  variable: string,
  source: string,
): boolean {
  if (!context) return false;
  const stack = [context];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'parens' || current.type === 'tuple') {
      stack.push(...current.namedChildren);
      continue;
    }
    if (current.type === 'forall' || current.type === 'context') {
      const nested = getChildByField(current, 'context')
        ?? getChildByField(current, 'constraint')
        ?? getChildByField(current, 'type');
      if (nested) stack.push(nested);
      continue;
    }
    if (current.type === 'apply') {
      const head = appliedTypeHead(current);
      const normalized = head ? normalizeReferenceText(getNodeText(head, source)) : '';
      const leaf = haskellReferenceParts(normalized).member;
      let carrier = getChildByField(current, 'argument');
      while (carrier?.type === 'parens' && carrier.namedChildCount === 1) {
        carrier = carrier.namedChild(0);
      }
      // MTL-style classes put the monad carrier last (`MonadReader env m`,
      // `MonadError err m`). Requiring that position avoids mistaking an
      // environment/state parameter mentioned by the same constraint for the
      // executable result constructor.
      if (isMonadConstraintHead(leaf)
        && carrier?.type === 'variable'
        && getNodeText(carrier, source).trim() === variable) {
        return true;
      }
    }
  }
  return false;
}

/**
 * A no-argument Haskell binding can still be an executable computation. Keep
 * the heuristic intentionally type-directed: concrete primitive effects, or a
 * result constructor variable proven monadic by the signature context. This
 * avoids turning ordinary applied values (`Maybe Int`, `Functor f => f Int`)
 * into functions merely because their RHS happens to contain an application.
 */
function executableResultProof(
  signatureNode: SyntaxNode,
  source: string,
  stateOwner: object,
): ExecutableResultProof | null {
  let type = getChildByField(signatureNode, 'type');
  let context: SyntaxNode | null = null;
  while (type && (type.type === 'forall' || type.type === 'context' || type.type === 'parens')) {
    if (type.type === 'context') context = getChildByField(type, 'context');
    type = getChildByField(type, 'type') ?? (type.namedChildCount === 1 ? type.namedChild(0) : null);
  }
  // For a binding with parameters, only the terminal result tells us whether
  // returning a whole-RHS action invokes a computation. In particular,
  // `Bool -> (Int -> Int)` and `Bool -> Int` are ordinary value/function
  // results and must not turn `choose _ = callback` / `foo _ = answer` into
  // call edges.
  while (type?.type === 'function') {
    type = getChildByField(type, 'result')
      ?? (type.namedChildCount > 0 ? type.namedChild(type.namedChildCount - 1) : null);
    while (type?.type === 'parens') {
      type = getChildByField(type, 'type')
        ?? (type.namedChildCount === 1 ? type.namedChild(0) : null);
    }
  }
  const { head, typeArguments } = appliedTypeParts(type);
  if (!head) return null;
  const normalized = normalizeReferenceText(getNodeText(head, source));
  const leaf = haskellReferenceParts(normalized).member;
  const localTypeNames = moduleLocalTypeNames(signatureNode, source, stateOwner);
  const primitive = primitiveEffectProof(normalized, leaf, localTypeNames);
  if (primitive) return primitive;
  const carrierIndex = TRANSFORMER_CARRIER_ARGUMENT.get(leaf);
  if (carrierIndex !== undefined) {
    if (!isTransformerCandidate(normalized, leaf, localTypeNames)) return null;
    let carrier = typeArguments[carrierIndex] ?? null;
    while (carrier?.type === 'parens' && carrier.namedChildCount === 1) {
      carrier = carrier.namedChild(0);
    }
    if (!carrier) return null;
    if (carrier.type === 'variable') {
      return monadicConstraintUsesVariable(
        context,
        getNodeText(carrier, source).trim(),
        source,
      ) ? { importedEffectHeads: [normalized] } : null;
    }
    const carrierHead = appliedTypeHead(carrier);
    if (!carrierHead) return null;
    const carrierName = normalizeReferenceText(getNodeText(carrierHead, source));
    const carrierLeaf = haskellReferenceParts(carrierName).member;
    // A concrete carrier must itself be unambiguously executable. IO is the
    // only such carrier accepted here, and both nominal origins are persisted:
    // proving only the outer transformer would let a project-defined pure IO
    // type fabricate a runtime call edge.
    const carrierProof = primitiveEffectProof(carrierName, carrierLeaf, localTypeNames);
    return carrierProof && carrierName === 'IO'
      ? { importedEffectHeads: [normalized, ...carrierProof.importedEffectHeads] }
      : null;
  }
  return head.type === 'variable' && monadicConstraintUsesVariable(context, leaf, source)
    // We have no sound canonical-origin proof for arbitrary capability class
    // names here. Persist the result variable so resolution fails closed to a
    // `references` edge for a point-free alias.
    ? { importedEffectHeads: [normalized] }
    : null;
}

function signatureDeclaresExecutableResult(
  signatureNode: SyntaxNode,
  source: string,
  stateOwner: object,
): boolean {
  return executableResultProof(signatureNode, source, stateOwner) !== null;
}

function doBlockProvesAction(node: SyntaxNode): boolean {
  const statements = node.childrenForFieldName('statement');
  // A direct `<-` bind necessarily executes an action. Otherwise require an
  // intermediate executable statement: the final expression alone may be a
  // pure value wrapped in `do` merely for layout, and `let` is not an action.
  if (statements.some((statement) => statement.type === 'bind')) return true;
  const executable = statements.filter((statement) => statement.type !== 'let');
  return executable.length > 1;
}

function isTopLevelMainBinding(node: SyntaxNode, source: string): boolean {
  const name = getChildByField(node, 'name');
  return node.type === 'bind'
    && name !== null
    && getNodeText(name, source).trim() === 'main'
    && node.parent?.type === 'declarations'
    && node.parent.parent?.type === 'haskell';
}

function isFunctionBinding(
  node: SyntaxNode,
  signatureNode: SyntaxNode | null,
  source: string,
  stateOwner: object,
): boolean {
  if (signatureNode) {
    if (signatureDeclaresFunction(signatureNode)
      || signatureDeclaresExecutableResult(signatureNode, source, stateOwner)) return true;
  }
  // In an executable Haskell target the top-level `main` binding is the action
  // GHC invokes, even when users omit its conventional `IO` signature. Keep an
  // explicit non-effect signature authoritative, and never apply this shortcut
  // to a local binding that merely shares the name.
  if (signatureNode === null && isTopLevelMainBinding(node, source)) return true;
  const match = getChildByField(node, 'match');
  let expression = match ? getChildByField(match, 'expression') : null;
  while (expression?.type === 'parens' && expression.namedChildCount === 1) {
    expression = expression.namedChild(0);
  }
  if (expression?.type === 'do') {
    // For an untyped binding, a direct bind or an intermediate non-let
    // statement is the best available evidence of sequencing. An explicit
    // signature is stronger evidence and cannot be overridden here: even
    // `Maybe` and user-defined applicatives can use multi-statement `do`.
    return signatureNode === null && doBlockProvesAction(expression);
  }
  if (
    expression?.type === 'lambda'
    || expression?.type === 'lambda_case'
    || expression?.type === 'left_section'
    || expression?.type === 'right_section'
  ) return true;
  if (expression?.type === 'infix') {
    const operator = getChildByField(expression, 'operator');
    const operatorName = operator ? getNodeText(operator, source).trim() : '';
    return operatorName === '.' || operatorName === '>=>' || operatorName === '<=<';
  }
  return false;
}

// Function-first combinators for which a bare first argument is genuinely
// invoked by the combinator. Data-first variants (`forM_`, `for_`, …) are
// intentionally excluded.
const HOF_NAMES = new Set([
  'map', 'fmap', 'filter', 'foldr', 'foldl', "foldl'", 'foldr1', 'foldl1',
  'concatMap', 'find', 'any', 'all', 'mapM', 'mapM_', 'foldM', 'foldM_',
  'traverse', 'traverse_', 'mapAccumL', 'mapAccumR', 'takeWhile', 'dropWhile',
  'span', 'break', 'partition', 'groupBy', 'sortBy', 'nubBy', 'deleteBy',
  'insertBy', 'unionBy', 'intersectBy', 'zipWith', 'zipWith3', 'zipWithM',
  'zipWithM_', 'iterate', 'unfoldr', 'until',
]);

function nodeContains(container: SyntaxNode | null, node: SyntaxNode): boolean {
  return !!container
    && node.startIndex >= container.startIndex
    && node.endIndex <= container.endIndex;
}

interface HaskellPatternBinding {
  name: string;
  node: SyntaxNode;
}

function collectPatternBindings(pattern: SyntaxNode | null, source: string): HaskellPatternBinding[] {
  if (!pattern) return [];
  const bindings: HaskellPatternBinding[] = [];
  const stack = [pattern];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'type_application' || current.type === 'type_binder') {
      // Visible type arguments inside a pattern (`Just @kind value`) inhabit
      // the type namespace; their lower-case variables are not term binders.
      continue;
    }
    if (current.type === 'signature') {
      // In `(value :: typeVariable)`, only the annotated term/pattern can
      // introduce a runtime binding. Descending through the type would make a
      // scoped type variable shadow an unrelated term with the same spelling.
      const expression = getChildByField(current, 'expression');
      if (expression) stack.push(expression);
      continue;
    }
    if (current.type === 'view_pattern') {
      // The expression is executed; only the RHS pattern introduces names.
      const nestedPattern = getChildByField(current, 'pattern');
      if (nestedPattern) stack.push(nestedPattern);
      continue;
    }
    if (current.type === 'field_pattern') {
      const nestedPattern = getChildByField(current, 'pattern');
      if (nestedPattern) {
        // `R { field = x }` binds x, not the label `field`.
        stack.push(nestedPattern);
      } else {
        // `R { field }` is a field pun and does bind `field`.
        const field = getChildByField(current, 'field');
        const variable = field ? firstDescendant(field, new Set(['variable'])) : null;
        if (variable) {
          const name = getNodeText(variable, source).trim();
          if (name) bindings.push({ name, node: variable });
        }
      }
      continue;
    }
    if (current.type === 'prefix_id') {
      // Symbolic variables are parenthesized in pattern position (`f (<+>)`
      // and `\(<+>) -> ...`). tree-sitter represents them as prefix_id rather
      // than variable, so treating only variable nodes as binders lets an
      // imported homonym leak into both the binder position and its RHS uses.
      // Constructor operators remain references to their data constructor.
      const operator = firstDescendant(
        current,
        new Set(['operator', 'constructor_operator']),
      );
      const normalized = normalizeReferenceText(
        operator ? getNodeText(operator, source) : getNodeText(current, source),
      );
      const parts = haskellReferenceParts(normalized);
      if (parts.qualifier === null && parts.member && !parts.member.startsWith(':')) {
        bindings.push({ name: parts.member, node: current });
      }
      continue;
    }
    if (current.type === 'variable') {
      const name = getNodeText(current, source).trim();
      if (name) bindings.push({ name, node: current });
    } else {
      stack.push(...current.namedChildren);
    }
  }
  return bindings;
}

function collectPatternNames(pattern: SyntaxNode | null, source: string): string[] {
  return collectPatternBindings(pattern, source).map(({ name }) => name);
}

function patternContainsName(
  pattern: SyntaxNode | null,
  name: string,
  source: string,
  beforeIndex: number | null = null,
): boolean {
  const canonicalName = lexicalBindingName(name);
  return collectPatternBindings(pattern, source).some((binding) =>
    lexicalBindingName(binding.name) === canonicalName
      && (beforeIndex === null || binding.node.startIndex < beforeIndex));
}

function functionPatternRoots(node: SyntaxNode): SyntaxNode[] {
  const patterns = getChildByField(node, 'patterns');
  if (patterns) return [patterns];
  const infix = node.namedChildren.find((child) => child.type === 'infix');
  if (!infix) return [];
  return [getChildByField(infix, 'left_operand'), getChildByField(infix, 'right_operand')]
    .filter((candidate): candidate is SyntaxNode => candidate !== null);
}

function declarationBindings(
  node: SyntaxNode,
  source: string,
  stateOwner: object,
): Array<[string, boolean, number?]> {
  const bindings: Array<[string, boolean, number?]> = [];
  const stack = [node];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current.type === 'function') {
      const head = declarationHead(current, source);
      const name = head?.baseName ?? '';
      if (name) bindings.push([name, true]);
      continue; // A declaration RHS introduces no additional names here.
    }
    if (current.type === 'bind') {
      const pattern = getChildByField(current, 'pattern');
      if (pattern) {
        // A monadic/generator pattern does not scope over its own RHS. Its
        // binders become visible only after the whole statement/qualifier.
        for (const name of collectPatternNames(pattern, source)) {
          bindings.push([name, false, current.endIndex]);
        }
      } else {
        const nameNode = getChildByField(current, 'name');
        const name = nameNode ? getNodeText(nameNode, source).trim() : '';
        if (name) {
          const signature = associatedSignature(current, name, source, stateOwner);
          bindings.push([name, isFunctionBinding(current, signature, source, stateOwner)]);
        }
      }
      continue;
    }
    if (current.type === 'generator' || current.type === 'pattern_guard') {
      for (const name of collectPatternNames(getChildByField(current, 'pattern'), source)) {
        bindings.push([name, false, current.endIndex]);
      }
      continue;
    }
    stack.push(...current.namedChildren);
  }
  return bindings;
}

function lexicalBindingIndex(
  container: SyntaxNode,
  source: string,
  stateOwner?: object,
): Map<string, LexicalBinding[]> {
  const key = `${container.type}:${container.startIndex}:${container.endIndex}`;
  const state = stateOwner ? extractionState(stateOwner) : undefined;
  const cached = state?.lexicalBindings.get(key);
  if (cached) return cached;

  const index = new Map<string, LexicalBinding[]>();
  for (const child of container.namedChildren) {
    for (const [name, materializedNode, scopeStartIndex] of declarationBindings(
      child,
      source,
      stateOwner ?? container,
    )) {
      const key = lexicalBindingName(name);
      const occurrences = index.get(key) ?? [];
      occurrences.push({ startIndex: scopeStartIndex ?? child.startIndex, materializedNode });
      index.set(key, occurrences);
    }
  }
  state?.lexicalBindings.set(key, index);
  return index;
}

function bindingAt(
  container: SyntaxNode,
  name: string,
  source: string,
  beforeIndex: number | null,
  stateOwner?: object,
): LexicalBinding | undefined {
  const occurrences = lexicalBindingIndex(container, source, stateOwner)
    .get(lexicalBindingName(name));
  if (!occurrences) return undefined;
  if (beforeIndex === null) return occurrences[occurrences.length - 1];
  for (let i = occurrences.length - 1; i >= 0; i--) {
    if (occurrences[i]!.startIndex < beforeIndex) return occurrences[i];
  }
  return undefined;
}

/** Haskell lexical values that must not become global/imported callees. */
function isLexicallyBound(
  name: string,
  node: SyntaxNode,
  source: string,
  stateOwner?: object,
): boolean {
  if (!name || haskellReferenceParts(name).qualifier !== null) return false;
  let branch = node;
  let ancestor = node.parent;
  while (ancestor) {
    if (ancestor.type === 'function' || ancestor.type === 'lambda') {
      const patternRoots = ancestor.type === 'function'
        ? functionPatternRoots(ancestor)
        : [getChildByField(ancestor, 'patterns')].filter(
            (candidate): candidate is SyntaxNode => candidate !== null,
          );
      // View-pattern expressions are evaluated left-to-right. A binder in the
      // view result (or in a later argument) must not retroactively shadow the
      // callable used by the view expression; every binder is visible in the
      // ordinary RHS because all pattern positions precede it.
      if (patternRoots.some((pattern) =>
        patternContainsName(pattern, name, source, node.startIndex))) return true;
      const whereBinds = getChildByField(ancestor, 'binds');
      if (whereBinds) {
        const binding = bindingAt(whereBinds, name, source, null, stateOwner);
        if (binding && !binding.materializedNode) return true;
      }
    }
    if (ancestor.type === 'bind') {
      const whereBinds = getChildByField(ancestor, 'binds');
      if (whereBinds) {
        const binding = bindingAt(whereBinds, name, source, null, stateOwner);
        if (binding && !binding.materializedNode) return true;
      }
    }
    if (ancestor.type === 'pattern_synonym') {
      const equation = ancestor.namedChildren.find((child) => child.type === 'equation');
      const synonym = equation ? getChildByField(equation, 'synonym') : null;
      if (patternContainsName(synonym, name, source, node.startIndex)) return true;
    }
    if (ancestor.type === 'alternative') {
      if (patternContainsName(
        getChildByField(ancestor, 'pattern'),
        name,
        source,
        node.startIndex,
      )) return true;
    }
    if (ancestor.type === 'let_in' || ancestor.type === 'let') {
      const binds = getChildByField(ancestor, 'binds');
      if (binds) {
        // Haskell let bindings are recursive: every declaration is in scope in
        // every RHS as well as in the body.
        const binding = bindingAt(binds, name, source, null, stateOwner);
        if (binding && !binding.materializedNode) return true;
      }
    }
    if (ancestor.type === 'local_binds') {
      const binding = bindingAt(ancestor, name, source, null, stateOwner);
      if (binding && !binding.materializedNode) return true;
    }
    if (ancestor.type === 'rec') {
      // RecursiveDo's explicit `rec` block brings every contained monadic
      // binder into scope throughout the block, even inside earlier RHSs.
      const binding = bindingAt(ancestor, name, source, null, stateOwner);
      if (binding && !binding.materializedNode) return true;
    }
    if (ancestor.type === 'do') {
      const recursiveDo = new RegExp(
        `^\\s*(?:${HASKELL_MODULE_NAME_SOURCE}\\.)?mdo\\b`,
        'u',
      ).test(getNodeText(ancestor, source));
      const binding = bindingAt(
        ancestor,
        name,
        source,
        recursiveDo ? null : branch.startIndex,
        stateOwner,
      );
      if (binding && !binding.materializedNode) return true;
    }
    if (ancestor.type === 'qualifiers') {
      const binding = bindingAt(ancestor, name, source, branch.startIndex, stateOwner);
      if (binding && !binding.materializedNode) return true;
    }
    if (ancestor.type === 'list_comprehension') {
      const output = getChildByField(ancestor, 'expression');
      const qualifiers = getChildByField(ancestor, 'qualifiers');
      if (output && qualifiers && nodeContains(output, node)) {
        const binding = bindingAt(qualifiers, name, source, null, stateOwner);
        if (binding && !binding.materializedNode) return true;
      }
    }
    if (ancestor.type === 'guards') {
      const binding = bindingAt(ancestor, name, source, branch.startIndex, stateOwner);
      if (binding && !binding.materializedNode) return true;
    }
    if (ancestor.type === 'match') {
      const guards = getChildByField(ancestor, 'guards');
      const expression = getChildByField(ancestor, 'expression');
      if (guards && expression && nodeContains(expression, node)) {
        const binding = bindingAt(guards, name, source, null, stateOwner);
        if (binding && !binding.materializedNode) return true;
      }
    }
    branch = ancestor;
    ancestor = ancestor.parent;
  }
  return false;
}

function isHaskellPatternPosition(node: SyntaxNode): boolean {
  let ancestor = node.parent;
  while (ancestor) {
    // The expression inside a Template Haskell splice is evaluated at the
    // current stage even when the splice sits in a quoted pattern or instance
    // head. Do not let those outer pattern-shaped fields downgrade its calls
    // to constructor/value references.
    if (ancestor.type === 'splice') return false;
    if (ancestor.type === 'view_pattern') {
      const expression = getChildByField(ancestor, 'expression');
      if (expression && nodeContains(expression, node)) return false;
    }
    const pattern = getChildByField(ancestor, 'pattern')
      ?? getChildByField(ancestor, 'patterns')
      ?? getChildByField(ancestor, 'synonym');
    if (pattern && nodeContains(pattern, node)) return true;
    if (ancestor.type === 'function') {
      const infix = ancestor.namedChildren.find((child) => child.type === 'infix');
      const left = infix ? getChildByField(infix, 'left_operand') : null;
      const right = infix ? getChildByField(infix, 'right_operand') : null;
      if (nodeContains(left, node) || nodeContains(right, node)) return true;
    }
    ancestor = ancestor.parent;
  }
  return false;
}

function normalizedSimpleReference(node: SyntaxNode, source: string): { name: string; node: SyntaxNode } | null {
  let current: SyntaxNode | null = node;
  // Visible type applications specialize a value but do not apply a term:
  // `handler @Int` is still the same point-free value as `handler`. Unwrap
  // only an all-type-argument spine; `handler @Int value` must remain an
  // ordinary application for the call walker.
  while (current) {
    if (current.type === 'parens' && current.namedChildCount === 1) {
      current = current.namedChild(0);
      continue;
    }
    if (current.type === 'infix_id' && current.namedChildCount === 1) {
      current = current.namedChild(0);
      continue;
    }
    if (current.type === 'signature') {
      const expression = getChildByField(current, 'expression');
      if (!expression) break;
      current = expression;
      continue;
    }
    if (current.type === 'apply') {
      const argument = getChildByField(current, 'argument');
      const functionNode = getChildByField(current, 'function');
      if (argument?.type !== 'type_application' || !functionNode) break;
      current = functionNode;
      continue;
    }
    break;
  }
  if (
    !current
    || ![
      'variable', 'constructor', 'name', 'operator', 'constructor_operator',
      'qualified', 'prefix_id',
    ].includes(current.type)
  ) return null;
  const name = normalizeReferenceText(getNodeText(current, source));
  return name ? { name, node: current } : null;
}

function referenceHead(node: SyntaxNode | null, source: string): { name: string; node: SyntaxNode } | null {
  let current = node;
  while (current?.type === 'parens' && current.namedChildCount === 1) {
    current = current.namedChild(0);
  }
  while (current?.type === 'apply') {
    current = getChildByField(current, 'constructor')
      ?? getChildByField(current, 'function')
      ?? current.namedChild(0);
  }
  if (current?.type === 'infix') {
    const operator = getChildByField(current, 'operator');
    if (!operator) return null;
    return { name: normalizeReferenceText(getNodeText(operator, source)), node: operator };
  }
  return current ? normalizedSimpleReference(current, source) : null;
}

function constraintHeads(
  node: SyntaxNode | null,
  source: string,
): Array<{ name: string; node: SyntaxNode }> {
  if (!node) return [];
  if (node.type === 'parens' && node.namedChildCount === 1) {
    return constraintHeads(node.namedChild(0), source);
  }
  if (node.type === 'tuple') {
    return node.namedChildren.flatMap((child) => constraintHeads(child, source));
  }
  if (node.type === 'forall') {
    const body = getChildByField(node, 'constraint')
      ?? getChildByField(node, 'context')
      ?? getChildByField(node, 'type');
    return constraintHeads(body, source);
  }
  if (node.type === 'context') {
    const antecedent = getChildByField(node, 'context');
    const conclusion = getChildByField(node, 'type') ?? getChildByField(node, 'constraint');
    return [
      ...constraintHeads(antecedent, source),
      ...constraintHeads(conclusion, source),
    ];
  }
  const head = referenceHead(node, source);
  if (!head) return [];
  const headParts = haskellReferenceParts(head.name);
  const leaf = headParts.member;
  // Lowercase, unqualified heads in ConstraintKinds/quantified constraints
  // are bound type variables (`class c a => C c a`), not global classes.
  if (headParts.qualifier === null && HASKELL_VARID_START_RE.test(leaf)) return [];
  // Equality/coercion constraints are predicates, not superclass declarations.
  if (['~', '~~', '~#', '~R#', '~N#'].includes(leaf)) return [];
  return [head];
}

function emitPointFreeReference(node: SyntaxNode, ownerId: string, ctx: ExtractorContext): void {
  const match = getChildByField(node, 'match');
  const expression = match ? getChildByField(match, 'expression') : null;
  const reference = expression ? normalizedSimpleReference(expression, ctx.source) : null;
  if (!reference || isLexicallyBound(reference.name, reference.node, ctx.source, ctx.nodes as object)) return;
  const leaf = haskellReferenceParts(reference.name).member;
  // A point-free constructor is a value dependency, not a function reference.
  // The bare-constructor walker emits its single canonical `references` edge
  // for `alias = Constructor`; an all-type application is call-shaped in the
  // grammar, so emit that value edge here before the call walker skips it.
  if (HASKELL_CONID_START_RE.test(leaf) || leaf.startsWith(':')) {
    let rhs: SyntaxNode = expression!;
    while (rhs.type === 'parens' && rhs.namedChildCount === 1) rhs = rhs.namedChild(0)!;
    if (rhs.type === 'signature') rhs = getChildByField(rhs, 'expression') ?? rhs;
    if (rhs.type === 'apply') {
      ctx.addUnresolvedReference({
        fromNodeId: ownerId,
        referenceName: reference.name,
        referenceKind: 'references',
        line: reference.node.startPosition.row + 1,
        column: reference.node.startPosition.column,
      });
    }
    return;
  }
  const owner = scopeOwner(ctx, ownerId);
  const signatureNode = owner
    ? associatedSignature(node, owner.name, ctx.source, ctx.nodes as object)
    : null;
  // A whole-RHS name represents execution only when the binding's terminal
  // signature result is a proven computation carrier. Ordinary aliases remain
  // strict function/value references: `choose _ = callback` returns a
  // function, and `foo _ = answer` returns data, so neither fabricates Flow.
  const proof = owner
    && (owner.kind === 'function' || owner.kind === 'method')
    && signatureNode
    ? executableResultProof(signatureNode, ctx.source, ctx.nodes as object)
    : null;
  const implicitMainAction = signatureNode === null
    && owner?.name === 'main'
    && isTopLevelMainBinding(node, ctx.source);
  const referenceKind = implicitMainAction
    ? 'calls'
    : proof
      ? 'haskell_effect_alias'
      : 'function_ref';
  ctx.addUnresolvedReference({
    fromNodeId: ownerId,
    referenceName: reference.name,
    referenceKind,
    line: reference.node.startPosition.row + 1,
    column: reference.node.startPosition.column,
    ...(proof ? {
      candidates: proof.importedEffectHeads.map(
        (head) => `${HASKELL_EFFECT_ALIAS_HEAD_PREFIX}${head}`,
      ),
    } : {}),
  });
}

function extractHaskellBareCall(
  node: SyntaxNode,
  source: string,
  stateOwner?: object,
): string | undefined {
  const reference = normalizedSimpleReference(node, source);
  if (!reference) return undefined;
  const parent = node.parent;
  if (!parent) return undefined;
  let sectionAncestor: SyntaxNode | null = parent;
  while (sectionAncestor && ['parens', 'infix_id', 'qualified', 'prefix_id'].includes(sectionAncestor.type)) {
    sectionAncestor = sectionAncestor.parent;
  }
  if (
    sectionAncestor
    && (sectionAncestor.type === 'left_section' || sectionAncestor.type === 'right_section')
    && nodeContains(
      getChildByField(sectionAncestor, 'operator')
        ?? sectionAncestor.namedChildren.find((child) => [
          'infix_id', 'operator', 'constructor_operator', 'qualified', 'prefix_id',
        ].includes(child.type))
        ?? null,
      node,
    )
  ) return undefined;

  let eligible = false;
  // `do { initialise; Server.serve }`: a bare expression statement executes
  // the action even though there is no `apply` node.
  if (parent.type === 'exp' && parent.namedChildCount === 1) {
    eligible = true;
  } else if (
    parent.type === 'splice'
    && getChildByField(parent, 'expression')?.startIndex === node.startIndex
    && getChildByField(parent, 'expression')?.endIndex === node.endIndex
  ) {
    // `$compile`, `$(compile)`, and `$$(compile @T)` execute their whole
    // expression at the current Template Haskell stage. Applied splices are
    // already caught by the ordinary call walker; this covers the otherwise
    // invisible nullary/bare spelling. Quotes remain opaque because
    // handleTemplateQuote visits only splices at its own staging level.
    eligible = true;
  } else if (
    parent.type === 'bind'
    && nodeContains(getChildByField(parent, 'expression'), node)
    && getChildByField(parent, 'expression')?.startIndex === node.startIndex
    && getChildByField(parent, 'expression')?.endIndex === node.endIndex
  ) {
    // `value <- action` executes a bare monadic action just like a standalone
    // expression statement. Applied actions are handled by the normal call
    // walker; this branch covers the otherwise invisible nullary spelling.
    eligible = true;
  } else if (
    parent.type === 'view_pattern'
    && nodeContains(getChildByField(parent, 'expression'), node)
    && getChildByField(parent, 'expression')?.startIndex === node.startIndex
    && getChildByField(parent, 'expression')?.endIndex === node.endIndex
  ) {
    eligible = true;
  } else if (parent.type === 'apply') {
    // Flatten the prefix-application spine so operator spellings have the same
    // action semantics as their infix form: `(<*>) fun load`, `(>>) a b`, …
    const applicationArguments: SyntaxNode[] = [];
    let callee: SyntaxNode | null = parent;
    while (callee?.type === 'apply') {
      const argument = getChildByField(callee, 'argument');
      if (argument) applicationArguments.unshift(argument);
      callee = getChildByField(callee, 'function');
    }
    const functionRef = callee ? normalizedSimpleReference(callee, source) : null;
    const functionBase = functionRef ? haskellReferenceParts(functionRef.name).member : '';
    const argumentIndex = applicationArguments.findIndex((argument) =>
      argument.startIndex === node.startIndex && argument.endIndex === node.endIndex);
    eligible = argumentIndex >= 0 && (
      (HOF_NAMES.has(functionBase) && argumentIndex === 0)
      || (['>>', '*>', '<*', '<*>', '<**>', '<|>'].includes(functionBase) && argumentIndex <= 1)
      || (['<$>', '<$', '=<<'].includes(functionBase) && argumentIndex === 1)
      || (['<&>', '$>', '>>='].includes(functionBase) && argumentIndex === 0)
    );
  } else if (parent.type === 'infix') {
    const left = getChildByField(parent, 'left_operand');
    const right = getChildByField(parent, 'right_operand');
    const operator = getChildByField(parent, 'operator');
    const operatorRef = operator ? normalizedSimpleReference(operator, source) : null;
    const operatorBase = operatorRef ? haskellReferenceParts(operatorRef.name).member : '';
    const isLeft = nodeContains(left, node)
      && left?.startIndex === node.startIndex
      && left?.endIndex === node.endIndex;
    const isRight = nodeContains(right, node)
      && right?.startIndex === node.startIndex
      && right?.endIndex === node.endIndex;
    // These operators execute statically named action operands. Continuations
    // (`>>=` RHS / `=<<` LHS) are handled as higher-order function refs by the
    // normal infix walker, while lexical parameters remain suppressed below.
    eligible = ['>>', '*>', '<*', '<*>', '<**>', '<|>'].includes(operatorBase) && (isLeft || isRight)
      || (['<$>', '<$', '=<<'].includes(operatorBase) && isRight)
      || (['<&>', '$>', '>>='].includes(operatorBase) && isLeft);
  }
  if (!eligible || isLexicallyBound(reference.name, reference.node, source, stateOwner)) return undefined;
  return reference.name;
}

function extractHaskellBareReference(
  node: SyntaxNode,
  source: string,
  stateOwner?: object,
): { name: string; referenceKind: 'references' | 'function_ref'; node?: SyntaxNode }
  | Array<{ name: string; referenceKind: 'references' | 'function_ref'; node?: SyntaxNode }>
  | undefined {
  if (node.type === 'left_section' || node.type === 'right_section') {
    const operator = getChildByField(node, 'operator')
      ?? node.namedChildren.find((child) => [
        'infix_id', 'operator', 'constructor_operator', 'qualified',
      ].includes(child.type));
    const reference = operator ? referenceHead(operator, source) : null;
    if (!reference || isLexicallyBound(reference.name, reference.node, source, stateOwner)) return undefined;
    return { name: reference.name, referenceKind: 'function_ref' };
  }

  if (node.type === 'projection' || node.type === 'projection_selector') {
    const fields = node.childrenForFieldName('field');
    const variables = fields.flatMap((field) => {
      if (field.type === 'variable') return [field];
      const variable = firstDescendant(field, new Set(['variable']));
      return variable ? [variable] : [];
    });
    return variables
      .map((variable) => ({
        name: getNodeText(variable, source).trim(),
        referenceKind: 'references' as const,
        node: variable,
      }))
      .filter((reference) => reference.name.length > 0);
  }

  if (node.type === 'field_update') {
    const fieldRoot = getChildByField(node, 'field');
    if (!fieldRoot) return undefined;
    const fields: SyntaxNode[] = [];
    const stack = [fieldRoot];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.type === 'field_name') {
        fields.push(current);
        continue;
      }
      stack.push(...current.namedChildren);
    }
    fields.sort((left, right) => left.startIndex - right.startIndex);
    return fields.map((field) => ({
      name: getNodeText(field, source).trim(),
      referenceKind: 'references' as const,
      node: field,
    })).filter((reference) => reference.name.length > 0);
  }

  const inPattern = isHaskellPatternPosition(node);
  if (!['constructor', 'constructor_operator', 'qualified', 'prefix_id'].includes(node.type)) {
    return undefined;
  }
  const parent = node.parent;
  if (!parent) return undefined;
  let sectionAncestor: SyntaxNode | null = parent;
  while (sectionAncestor && ['parens', 'infix_id', 'qualified', 'prefix_id'].includes(sectionAncestor.type)) {
    sectionAncestor = sectionAncestor.parent;
  }
  if (
    sectionAncestor
    && (sectionAncestor.type === 'left_section' || sectionAncestor.type === 'right_section')
    && nodeContains(
      getChildByField(sectionAncestor, 'operator')
        ?? sectionAncestor.namedChildren.find((child) => [
          'infix_id', 'operator', 'constructor_operator', 'qualified', 'prefix_id',
        ].includes(child.type))
        ?? null,
      node,
    )
  ) return undefined;
  // Application/infix pattern nodes already emit their constructor through the
  // normal call-shaped pattern handler. Descendants of a qualified/prefix name
  // are likewise represented by their parent as one canonical reference.
  if (
    (sectionAncestor?.type === 'apply'
      && nodeContains(getChildByField(sectionAncestor, 'function'), node))
    || (!inPattern && sectionAncestor?.type === 'infix'
      && nodeContains(getChildByField(sectionAncestor, 'operator'), node))
    || ((parent.type === 'left_section' || parent.type === 'right_section')
      && nodeContains(getChildByField(parent, 'operator'), node))
    || parent.type === 'qualified'
    || parent.type === 'prefix_id'
  ) return undefined;

  if (!inPattern && sectionAncestor?.type === 'apply'
    && nodeContains(getChildByField(sectionAncestor, 'argument'), node)) {
    const directFunction = getChildByField(sectionAncestor, 'function');
    const directReference = directFunction
      ? normalizedSimpleReference(directFunction, source)
      : null;
    const directBase = directReference ? haskellReferenceParts(directReference.name).member : '';
    // A known higher-order combinator executes this constructor value, and
    // the call walker emits the semantic call edge. Avoid a second value edge.
    if (HOF_NAMES.has(directBase)) return undefined;
  }
  const reference = normalizedSimpleReference(node, source);
  if (!reference) return undefined;

  const referenceParts = haskellReferenceParts(reference.name);
  if (
    inPattern
    && node.type === 'prefix_id'
    && referenceParts.qualifier === null
    && !referenceParts.member.startsWith(':')
  ) {
    // This prefix_id is a symbolic variable binder, not a use of a global or
    // imported operator. Constructor operators (whose member starts with `:`)
    // continue to the pattern-reference path below.
    return undefined;
  }

  if (!inPattern) {
    const leaf = referenceParts.member;
    if (!HASKELL_CONID_START_RE.test(leaf) && !leaf.startsWith(':')) return undefined;

    // Bare constructor values are semantic references only in expressions,
    // never in signatures, type heads, imports, or export lists.
    let branch = node;
    let ancestor: SyntaxNode | null = node.parent;
    let expressionPosition = false;
    while (ancestor) {
      if (ancestor.type === 'view_pattern') {
        expressionPosition = nodeContains(getChildByField(ancestor, 'expression'), branch);
        break;
      }
      if (ancestor.type === 'guards') {
        expressionPosition = true;
        break;
      }
      if (ancestor.type === 'match' || ancestor.type === 'bind') {
        expressionPosition = nodeContains(getChildByField(ancestor, 'expression'), branch)
          || nodeContains(getChildByField(ancestor, 'guards'), branch);
        break;
      }
      if (ancestor.type === 'constructor_synonym') {
        expressionPosition = nodeContains(getChildByField(ancestor, 'match'), branch);
        break;
      }
      if (ancestor.type === 'signature') {
        // An expression annotation (`value :: Type`) shares the same grammar
        // node as a declaration signature. Its expression remains runtime
        // code, but the annotation type does not.
        expressionPosition = nodeContains(getChildByField(ancestor, 'expression'), branch);
        break;
      }
      if (ancestor.type === 'type_application') {
        // Visible type applications (`callee @Type`) place their type in an
        // expression tree, but constructor-shaped names below this node still
        // belong to the type namespace. The runtime callee is a sibling of the
        // type_application node, so it continues through the normal call walk.
        break;
      }
      if (['header', 'import', 'data_type', 'newtype', 'type_synomym',
        'type_family', 'type_instance', 'data_family', 'class', 'instance'].includes(ancestor.type)) {
        break;
      }
      branch = ancestor;
      ancestor = ancestor.parent;
    }
    if (!expressionPosition) return undefined;
  }
  return { name: reference.name, referenceKind: 'references' };
}

function derivedClassNames(node: SyntaxNode, source: string): Array<{ name: string; node: SyntaxNode }> {
  const derivingClauses = node.childrenForFieldName('deriving');
  if (derivingClauses.length === 0) {
    derivingClauses.push(...node.namedChildren.filter((child) => child.type === 'deriving'));
  }
  if (derivingClauses.length === 0) return [];
  const result: Array<{ name: string; node: SyntaxNode }> = [];
  for (const deriving of derivingClauses) {
    const classes = getChildByField(deriving, 'classes') ?? deriving;
    const stack = [classes];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.type === 'qualified' || current.type === 'name' || current.type === 'prefix_id') {
        const reference = normalizedSimpleReference(current, source);
        if (reference) result.push(reference);
      } else {
        stack.push(...current.namedChildren);
      }
    }
  }
  return result;
}

function handleBind(node: SyntaxNode, ctx: ExtractorContext): boolean {
  // A `bind` under `do` is a monadic pattern bind (`x <- action`), not a named
  // declaration. Local value binds stay attributed to their enclosing symbol;
  // only function-valued local binds become their own graph nodes.
  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const owner = scopeOwner(ctx, scopeId);
  const isMethod = !!owner && (owner.kind === 'trait' || owner.decorators?.includes('haskell-instance'));
  const isTopLevel = !owner || owner.kind === 'file' || owner.kind === 'namespace';
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) {
    // Top-level pattern bindings introduce one exported value per bound
    // variable. Local/monadic pattern binds remain lexical and are attributed
    // to their enclosing symbol by the ordinary walker.
    if (!isTopLevel) return false;
    const pattern = getChildByField(node, 'pattern');
    const names = [...new Set(collectPatternNames(pattern, ctx.source))];
    if (names.length === 0) return false;
    const lhs = pattern
      ? collapseWhitespace(getNodeText(pattern, ctx.source)).slice(0, 240)
      : '';
    for (const name of names) {
      const signatureNode = associatedSignature(node, name, ctx.source, ctx.nodes as object);
      const kind = signatureNode && signatureDeclaresFunction(signatureNode) ? 'function' : 'constant';
      const bindingNode = ctx.createNode(kind, name, node, {
        signature: signatureNode
          ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
          : lhs || undefined,
        docstring: bindingDocstring(node, signatureNode, ctx.source),
        isExported: isNameExported(node, ctx.source, name, ctx.nodes as object),
      });
      if (!bindingNode) continue;
      emitPointFreeReference(node, bindingNode.id, ctx);
      visitFunctionPayload(node, bindingNode.id, ctx);
    }
    return true;
  }
  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return false;

  const signatureNode = associatedSignature(node, name, ctx.source, ctx.nodes as object);
  const functionBinding = isMethod
    || isFunctionBinding(node, signatureNode, ctx.source, ctx.nodes as object);
  if (!isTopLevel && !functionBinding) return false;

  const kind = isMethod ? 'method' : functionBinding ? 'function' : 'constant';
  const groupKey = declarationGroupKey(node, name, kind, ctx);
  const existing = groupedNode(groupKey, ctx);
  if (existing) {
    extendGroupedNode(node, existing);
    emitPointFreeReference(node, existing.id, ctx);
    visitFunctionPayload(node, existing.id, ctx);
    return true;
  }
  const signature = signatureNode
    ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
    : collapseWhitespace(getNodeText(node, ctx.source).split('=', 1)[0] ?? '').slice(0, 240);
  const bindingNode = ctx.createNode(kind, name, node, {
    signature: signature || undefined,
    docstring: bindingDocstring(node, signatureNode, ctx.source),
    isExported: isTopLevel
      ? isNameExported(node, ctx.source, name, ctx.nodes as object)
      : owner?.kind === 'trait' && isNameExported(node, ctx.source, name, ctx.nodes as object, owner.name),
    decorators: !isTopLevel && kind === 'function'
      ? [lexicalRangeDecorator(node)].filter((value): value is string => value !== null)
      : undefined,
  });
  if (!bindingNode) return true;

  declarationGroupMap(ctx).set(groupKey, bindingNode);
  emitPointFreeReference(node, bindingNode.id, ctx);
  visitFunctionPayload(node, bindingNode.id, ctx);
  return true;
}

function handleFunction(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  let name = nameNode ? getNodeText(nameNode, ctx.source).trim() : '';
  if (!name) {
    const infix = node.namedChildren.find((child) => child.type === 'infix');
    const operator = infix ? getChildByField(infix, 'operator') : null;
    const operatorName = operator ? getNodeText(operator, ctx.source).trim() : '';
    if (operatorName) name = declaredInfixName(operatorName);
  }
  if (!name) return true;

  const scopeId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const parent = scopeOwner(ctx, scopeId);
  const kind = parent && (parent.kind === 'trait' || parent.decorators?.includes('haskell-instance'))
    ? 'method'
    : 'function';
  const isTopLevel = !parent || parent.kind === 'file' || parent.kind === 'namespace';
  const groupKey = declarationGroupKey(node, name, kind, ctx);
  const existing = groupedNode(groupKey, ctx);
  if (existing) {
    extendGroupedNode(node, existing);
    emitPointFreeReference(node, existing.id, ctx);
    visitFunctionPayload(node, existing.id, ctx);
    return true;
  }

  const signatureNode = associatedSignature(node, name, ctx.source, ctx.nodes as object);
  const signature = signatureNode
    ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
    : collapseWhitespace(getNodeText(node, ctx.source).split('=', 1)[0] ?? '').slice(0, 240);
  const functionNode = ctx.createNode(kind, name, node, {
    signature: signature || undefined,
    docstring: bindingDocstring(node, signatureNode, ctx.source),
    // Instance implementations and let/where helpers are lexical; class
    // methods are importable only when their parent class exports them.
    isExported: isTopLevel
      ? isNameExported(node, ctx.source, name, ctx.nodes as object)
      : parent?.kind === 'trait' && isNameExported(node, ctx.source, name, ctx.nodes as object, parent.name),
    decorators: !isTopLevel && kind === 'function'
      ? [lexicalRangeDecorator(node)].filter((value): value is string => value !== null)
      : undefined,
  });
  if (!functionNode) return true;

  declarationGroupMap(ctx).set(groupKey, functionNode);
  emitPointFreeReference(node, functionNode.id, ctx);
  visitFunctionPayload(node, functionNode.id, ctx);
  return true;
}

const CONSTRUCTOR_DECLARATIONS = new Set([
  'data_constructor',
  'newtype_constructor',
  'gadt_constructor',
  'constructor_synonym',
]);

function handleDataDeclaration(
  node: SyntaxNode,
  ctx: ExtractorContext,
  options?: { name?: string; isExported?: boolean; exportParentName?: string },
): boolean {
  const head = declarationHead(node, ctx.source);
  const name = options?.name ?? head?.baseName ?? '';
  if (!name) return true;

  const typeNode = ctx.createNode(node.type === 'newtype' ? 'struct' : 'enum', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getHaskellPrecedingDocstring(node, ctx.source),
    isExported: options?.isExported
      ?? isNameExported(node, ctx.source, name, ctx.nodes as object, undefined, 'type'),
  });
  if (!typeNode) return true;

  ctx.pushScope(typeNode.id);
  const walk = (current: SyntaxNode): void => {
    if (CONSTRUCTOR_DECLARATIONS.has(current.type)) {
      const constructorShape = getChildByField(current, 'constructor');
      const infix = constructorShape?.type === 'infix'
        ? constructorShape
        : current.namedChildren.find((child) => child.type === 'infix');
      const names = getChildByField(current, 'names');
      const constructorNames = names?.type === 'binding_list'
        ? names.namedChildren
        : [getChildByField(current, 'name')
          ?? (infix ? getChildByField(infix, 'operator') : null)
          ?? firstDescendant(current, new Set(['constructor']))]
          .filter((candidate): candidate is SyntaxNode => candidate !== null);
      for (const constructorName of constructorNames) {
        const rawConstructor = getNodeText(constructorName, ctx.source).trim();
        const constructor = declaredInfixName(rawConstructor);
        ctx.createNode('enum_member', constructor, current, {
          signature: collapseWhitespace(getNodeText(current, ctx.source)).slice(0, 260),
          isExported: isNameExported(
            current,
            ctx.source,
            constructor,
            ctx.nodes as object,
            options?.exportParentName ?? name,
          ),
          decorators: options?.exportParentName
            ? [`haskell-export-parent:${options.exportParentName}`]
            : undefined,
        });
      }
      // Record fields can live below a constructor, so continue walking.
    } else if (current.type === 'field') {
      // Positional newtype payloads are also parsed as `field`, but only record
      // declarations have one or more explicit `name:` children. Grouped
      // selectors (`{ x, y :: Int }`) repeat that field and must all be emitted.
      for (const fieldName of current.childrenForFieldName('name')) {
        const field = getNodeText(fieldName, ctx.source).trim();
        ctx.createNode('field', field, current, {
          isExported: isNameExported(
            current,
            ctx.source,
            field,
            ctx.nodes as object,
            options?.exportParentName ?? name,
          ),
          decorators: options?.exportParentName
            ? [`haskell-export-parent:${options.exportParentName}`]
            : undefined,
        });
      }
    }
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (child) walk(child);
    }
  };
  walk(node);
  ctx.popScope();

  for (const derived of derivedClassNames(node, ctx.source)) {
    ctx.addUnresolvedReference({
      fromNodeId: typeNode.id,
      referenceName: derived.name,
      referenceKind: 'implements',
      line: derived.node.startPosition.row + 1,
      column: derived.node.startPosition.column,
    });
  }
  return true;
}

function handleDataFamily(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (!head) return true;
  const name = head.baseName;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const owner = scopeOwner(ctx, ownerId);
  ctx.createNode('enum', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getHaskellPrecedingDocstring(node, ctx.source),
    isExported: owner?.kind === 'trait'
      ? isNameExported(node, ctx.source, name, ctx.nodes as object, owner.name, 'type')
      : isNameExported(node, ctx.source, name, ctx.nodes as object, undefined, 'type'),
    decorators: ['haskell-data-family'],
  });
  return true;
}

function handleDataInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const declaration = node.namedChildren.find((child) => child.type === 'data_type' || child.type === 'newtype');
  if (!declaration) return true;
  const head = declarationHead(declaration, ctx.source);
  if (!head) return true;
  const baseName = head.baseName;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  const owner = scopeOwner(ctx, ownerId);
  const instanceName = owner && (owner.kind === 'trait' || owner.decorators?.includes('haskell-instance'))
    ? baseName
    : head.displayName;
  return handleDataDeclaration(declaration, ctx, {
    name: instanceName,
    // A family application (`F Int`) is not an independently importable type
    // declaration. Its constructors retain their own module export semantics.
    isExported: false,
    exportParentName: baseName,
  });
}

function handlePatternSynonym(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const equation = node.namedChildren.find((child) => child.type === 'equation');
  const nameNode = patternSynonymNameNode(node);
  if (!nameNode) return true;
  // A standalone pattern signature is a sibling declaration. It is indexed
  // here and materialized together with the following equation.
  if (!equation) return true;
  const name = patternSynonymName(node, ctx.source);
  const signatureNode = associatedSignature(node, name, ctx.source, ctx.nodes as object);
  const exportParents = bundledExportParents(node, ctx.source, name, ctx.nodes as object);
  const patternNode = ctx.createNode('enum_member', name, node, {
    signature: collapseWhitespace(getNodeText(signatureNode ?? node, ctx.source)).slice(0, 400),
    docstring: bindingDocstring(node, signatureNode, ctx.source),
    isExported: isNameExported(node, ctx.source, name, ctx.nodes as object)
      || exportParents.length > 0,
    decorators: [
      'haskell-pattern-synonym',
      ...exportParents.map((parent) => `haskell-export-parent:${parent}`),
    ],
  });
  if (patternNode && signatureNode) extendGroupedNode(signatureNode, patternNode);

  // Record pattern synonyms introduce ordinary module-scope selector
  // functions, even though the fields are syntactically nested in the synonym.
  const synonym = getChildByField(equation, 'synonym');
  const selectorStack = synonym ? [synonym] : [];
  const seenSelectors = new Set<string>();
  while (selectorStack.length > 0) {
    const current = selectorStack.pop()!;
    if (current.type === 'field_pattern') {
      const field = getChildByField(current, 'field');
      const variable = field ? firstDescendant(field, new Set(['variable'])) : null;
      const selector = variable ? getNodeText(variable, ctx.source).trim() : '';
      if (selector && !seenSelectors.has(selector)) {
        seenSelectors.add(selector);
        ctx.createNode('field', selector, current, {
          signature: signatureNode
            ? collapseWhitespace(getNodeText(signatureNode, ctx.source)).slice(0, 400)
            : `pattern selector ${selector} for ${name}`,
          isExported: isNameExported(node, ctx.source, selector, ctx.nodes as object),
          decorators: ['haskell-pattern-selector', `haskell-pattern-owner:${name}`],
        });
      }
      continue;
    }
    selectorStack.push(...current.namedChildren);
  }
  if (patternNode) {
    // Pattern synonyms contain pattern-position constructors plus ordinary
    // matcher/builder expressions. Reuse the normal semantic walker so view
    // helpers and builder functions are calls while synonym arguments remain
    // lexical and constructors keep their expression/pattern edge kinds.
    ctx.pushScope(patternNode.id);
    const matcher = getChildByField(equation, 'pattern');
    if (matcher) ctx.visitFunctionBody(matcher, patternNode.id);
    const builderStack = [...node.namedChildren];
    while (builderStack.length > 0) {
      const current = builderStack.pop()!;
      if (current.type === 'constructor_synonym') {
        const match = getChildByField(current, 'match');
        const expression = match ? getChildByField(match, 'expression') : null;
        if (expression) ctx.visitFunctionBody(expression, patternNode.id);
        continue;
      }
      builderStack.push(...current.namedChildren);
    }
    ctx.popScope();
  }
  return true;
}

function foreignSignature(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type === 'signature')
    ?? firstDescendant(node, new Set(['signature']));
}

/** Model a foreign import as the Haskell binding it introduces. */
function handleForeignImport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const signatureNode = foreignSignature(node);
  if (!signatureNode) return true;
  const names = signatureNames(signatureNode, ctx.source);
  for (const name of names) {
    const kind = signatureDeclaresFunction(signatureNode) ? 'function' : 'constant';
    const foreignNode = ctx.createNode(kind, name, node, {
      signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
      docstring: getHaskellPrecedingDocstring(node, ctx.source),
      isExported: isNameExported(node, ctx.source, name, ctx.nodes as object),
      decorators: ['haskell-foreign-import'],
    });
    if (foreignNode) {
      declarationGroupMap(ctx).set(declarationGroupKey(node, name, kind, ctx), foreignNode);
    }
  }
  return true;
}

/** A foreign export reuses an existing Haskell binding; retain that dependency. */
function handleForeignExport(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const signatureNode = foreignSignature(node);
  if (!signatureNode) return true;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!ownerId) return true;
  for (const nameNode of signatureNames(signatureNode, ctx.source)) {
    ctx.addUnresolvedReference({
      fromNodeId: ownerId,
      referenceName: normalizeReferenceText(nameNode),
      referenceKind: 'function_ref',
      line: signatureNode.startPosition.row + 1,
      column: signatureNode.startPosition.column,
    });
  }
  return true;
}

function handleTypeAlias(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (head) {
    const name = head.baseName;
    ctx.createNode('type_alias', name, node, {
      signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
      docstring: getHaskellPrecedingDocstring(node, ctx.source),
      isExported: isNameExported(node, ctx.source, name, ctx.nodes as object, undefined, 'type'),
    });
  }
  return true;
}

function handleTypeFamily(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (!head) return true;
  const baseName = head.baseName;
  const name = node.type === 'type_instance' ? head.displayName : baseName;
  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1] ?? '';
  const owner = scopeOwner(ctx, ownerId);
  ctx.createNode('type_alias', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getHaskellPrecedingDocstring(node, ctx.source),
    isExported: node.type !== 'type_instance' && (
      owner?.kind === 'trait'
        ? isNameExported(node, ctx.source, baseName, ctx.nodes as object, owner.name, 'type')
        : isNameExported(node, ctx.source, baseName, ctx.nodes as object, undefined, 'type')
    ),
  });
  return true;
}

function visitDeclarationBody(node: SyntaxNode, bodyType: string, ownerId: string, ctx: ExtractorContext): void {
  const body = getChildByField(node, 'declarations')
    ?? node.namedChildren.find((child) => child.type === bodyType)
    ?? null;
  if (!body) return;
  ctx.pushScope(ownerId);
  ctx.visitNode(body);
  ctx.popScope();
}

function handleTypeclass(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (!head) return true;
  const name = head.baseName;
  const typeclass = ctx.createNode('trait', name, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    docstring: getHaskellPrecedingDocstring(node, ctx.source),
    isExported: isNameExported(node, ctx.source, name, ctx.nodes as object, undefined, 'type'),
  });
  if (typeclass) {
    const context = getChildByField(node, 'context');
    const inner = context ? getChildByField(context, 'context') : null;
    const constraints = inner?.type === 'tuple' ? inner.namedChildren : inner ? [inner] : [];
    const seenSuperclasses = new Set<string>();
    for (const superclass of constraints.flatMap((constraint) => constraintHeads(constraint, ctx.source))) {
      if (seenSuperclasses.has(superclass.name)) continue;
      seenSuperclasses.add(superclass.name);
      ctx.addUnresolvedReference({
        fromNodeId: typeclass.id,
        referenceName: superclass.name,
        referenceKind: 'extends',
        line: superclass.node.startPosition.row + 1,
        column: superclass.node.startPosition.column,
      });
    }
    visitDeclarationBody(node, 'class_declarations', typeclass.id, ctx);
  }
  return true;
}

function handleInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (!head) return true;
  const classReference = normalizeReferenceText(getNodeText(head.nameNode, ctx.source));
  const instanceName = head.displayName;
  const instanceNode = ctx.createNode('class', instanceName, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    decorators: ['haskell-instance'],
  });
  if (!instanceNode) return true;
  ctx.addUnresolvedReference({
    fromNodeId: instanceNode.id,
    referenceName: classReference,
    referenceKind: 'implements',
    line: head.nameNode.startPosition.row + 1,
    column: head.nameNode.startPosition.column,
  });
  visitDeclarationBody(node, 'instance_declarations', instanceNode.id, ctx);
  return true;
}

function handleDerivingInstance(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const head = declarationHead(node, ctx.source);
  if (!head) return true;
  const classReference = normalizeReferenceText(getNodeText(head.nameNode, ctx.source));
  const instanceName = head.displayName;
  const instanceNode = ctx.createNode('class', instanceName, node, {
    signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
    decorators: ['haskell-instance', 'haskell-deriving-instance'],
  });
  if (instanceNode) {
    ctx.addUnresolvedReference({
      fromNodeId: instanceNode.id,
      referenceName: classReference,
      referenceKind: 'implements',
      line: head.nameNode.startPosition.row + 1,
      column: head.nameNode.startPosition.column,
    });
  }
  return true;
}

function handleSignature(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const expression = getChildByField(node, 'expression');
  if (expression) {
    // Preserve calls and constructor references in an annotated expression,
    // while never walking its type subtree as runtime code.
    ctx.visitNode(expression);
    return true;
  }

  const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!ownerId) return true;
  const owner = scopeOwner(ctx, ownerId);
  if (!owner || (owner.kind !== 'trait' && !owner.decorators?.includes('haskell-instance'))) return true;

  const namesNode = getChildByField(node, 'names');
  const nameNodes = namesNode
    ? namesNode.namedChildren.filter((child) => child.type === 'variable' || child.type === 'prefix_id')
    : [getChildByField(node, 'name')].filter((child): child is SyntaxNode => child !== null);
  for (const nameNode of nameNodes) {
    const name = getNodeText(nameNode, ctx.source).trim();
    if (!name) continue;
    const groupKey = declarationGroupKey(node, name, 'method', ctx);
    const existing = groupedNode(groupKey, ctx);
    if (existing) {
      extendGroupedNode(node, existing);
      continue;
    }
    const method = ctx.createNode('method', name, node, {
      signature: collapseWhitespace(getNodeText(node, ctx.source)).slice(0, 400),
      isExported: owner.kind === 'trait'
        && isNameExported(node, ctx.source, name, ctx.nodes as object, owner.name),
    });
    if (method) declarationGroupMap(ctx).set(groupKey, method);
  }
  return true;
}

const TEMPLATE_QUOTE_NODES = new Set(['quote', 'typed_quote']);

/**
 * A Template Haskell bracket is code-as-data, not an execution boundary for
 * the enclosing binding. Tree-sitter still gives its body ordinary `apply`
 * nodes, so a normal walk would fabricate runtime calls from `[| f x |]`,
 * `[d| f x |]`, and their type/pattern variants.
 *
 * Splices at the bracket's current staging level are different: their
 * expression is evaluated while constructing the quoted syntax. Walk only
 * those expressions. A nested bracket raises the staging level again, so its
 * splices belong to generated code and must remain opaque to this binding.
 */
function handleTemplateQuote(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const visitCurrentStageSplices = (current: SyntaxNode): void => {
    for (let i = 0; i < current.namedChildCount; i++) {
      const child = current.namedChild(i);
      if (!child) continue;
      if (TEMPLATE_QUOTE_NODES.has(child.type)) continue;
      if (child.type === 'splice') {
        const expression = getChildByField(child, 'expression');
        if (expression) ctx.visitNode(expression);
        continue;
      }
      visitCurrentStageSplices(child);
    }
  };

  visitCurrentStageSplices(node);
  return true;
}

export const haskellExtractor: LanguageExtractor = {
  // Haskell's significant declarations need clause grouping and type-position
  // filtering, so they are dispatched through visitNode rather than the generic
  // one-node-per-declaration paths.
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import'],
  callTypes: ['apply', 'infix'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'declarations',
  paramsField: 'patterns',
  extractBareCall: extractHaskellBareCall,
  extractBareReference: extractHaskellBareReference,
  isLexicallyBound,
  isPatternPosition: isHaskellPatternPosition,

  packageTypes: ['header'],
  extractPackage: (node, source) => {
    const moduleNode = getChildByField(node, 'module');
    return moduleNode ? getNodeText(moduleNode, source).replace(/\s+/g, '') : null;
  },

  extractImport: (node, source) => {
    const moduleNode = getChildByField(node, 'module');
    if (!moduleNode) return null;
    return {
      moduleName: getNodeText(moduleNode, source).replace(/\s+/g, ''),
      signature: collapseWhitespace(getNodeText(node, source)).slice(0, 300),
    };
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'function':
        return handleFunction(node, ctx);
      case 'bind':
        return handleBind(node, ctx);
      case 'data_type':
      case 'newtype':
        return handleDataDeclaration(node, ctx);
      case 'data_family':
        return handleDataFamily(node, ctx);
      case 'data_instance':
        return handleDataInstance(node, ctx);
      case 'pattern_synonym':
        return handlePatternSynonym(node, ctx);
      case 'type_synomym':
        return handleTypeAlias(node, ctx);
      case 'type_family':
      case 'type_instance':
        return handleTypeFamily(node, ctx);
      case 'class':
        return handleTypeclass(node, ctx);
      case 'instance':
        return handleInstance(node, ctx);
      case 'deriving_instance':
        return handleDerivingInstance(node, ctx);
      case 'foreign_import':
        return handleForeignImport(node, ctx);
      case 'foreign_export':
        return handleForeignExport(node, ctx);
      case 'signature':
        return handleSignature(node, ctx);
      case 'quote':
      case 'typed_quote':
        return handleTemplateQuote(node, ctx);
      case 'th_quoted_name':
      case 'quasiquote':
        // Names and quasiquote bodies are code-as-data. Quasiquote bodies are
        // opaque in the grammar; generated declarations and quoter semantics
        // remain deliberately outside the Haskell model.
        return true;
      default:
        return false;
    }
  },
};
