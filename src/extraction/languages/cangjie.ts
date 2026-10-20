import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField, getPrecedingDocstring, cleanCommentMarkers } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';
import type { Node, NodeKind } from '../../types';
import { cangjieRewrites, preParseCangjie } from './cangjie-preparse';

/**
 * Cangjie (仓颉) extractor — Cangjie-SIG/tree-sitter-cangjie 1.1.0 (MIT, ABI 14).
 *
 * The grammar names declarations with a dedicated child node rather than a
 * `name:` field (`functionDefinition → funcName`, `classDefinition →
 * className`, …), and puts bodies in an unfielded child (`block`,
 * `classBody`, …) — resolveName / resolveBody read both.
 *
 * Shapes handled here rather than by the generic walker:
 *   - `variableDeclaration` — a file-scope `let`/`var`/`const` becomes a
 *     constant/variable; one in a type body becomes a field. The name lives
 *     in `variableName → varBindingPattern`, the value in `initilizer:`.
 *   - `propertyDefinition` (`prop size: Int64 { get() {…} }`) — a property
 *     whose getter/setter blocks are walked as its own code.
 *   - `extendDefinition` (`extend Point <: ToString { … }`) — members join
 *     the extended type when it is declared in the same file; otherwise an
 *     extension node marked `extend` holds them. The `<:` list is an
 *     `implements` from whichever holds them.
 *   - `importList` — `import a.b.C`, `import a.b.*`, `import a.b.{C, D}`,
 *     `import a.b.C as D`: one import node + `imports` ref per imported FQN.
 *
 *   - body-less `prop x: T` (an interface's properties) — preParse rewrites
 *     them to body-less functions the grammar accepts; they are emitted
 *     back as properties here. See cangjie-preparse.ts for every rewrite.
 *
 * Calls are flat in this grammar: a `postfixExpression` is a head
 * (`atomicVariable`, possibly a dotted `scoped_identifier`) followed by a
 * run of suffixes (`fieldAccess`, `callSuffix`, `trailingLambdaExpression`,
 * `indexAccess`, `questAccess`) — `getRepo().save(3)` is ONE node holding two
 * calls. cangjieCallees walks that run; the core's extractCall emits them.
 */

/** Declaration node type → the child node type that carries its name. */
const NAME_CHILD: Record<string, string> = {
  functionDefinition: 'funcName',
  classDefinition: 'className',
  structDefinition: 'structName',
  interfaceDefinition: 'interfaceName',
  enumDefinition: 'enumName',
  typeAlias: 'typeAliasName',
  macroDefinition: 'macroName',
  propertyDefinition: 'propertyName',
};

const BODY_TYPES = new Set([
  'block', 'classBody', 'structBody', 'interfaceBody', 'enumBody', 'extendBody',
]);

const TYPE_LIKE_KINDS = new Set<NodeKind>(['class', 'struct', 'interface', 'enum']);

/** Decorator marking the extension node of an `extend` whose type is declared elsewhere. */
export const CANGJIE_EXTEND_MARKER = 'extend';

/** Decorator marking a `foreign func` — a declaration of a C function. */
export const CANGJIE_FOREIGN_MARKER = 'foreign';

/** `` `type` `` → `type`: a backtick-escaped identifier names the bare word. */
function unquote(name: string): string {
  return name.length > 2 && name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name;
}

/** An identifier node's text, unquoted. */
function identText(node: SyntaxNode, source: string): string {
  return unquote(getNodeText(node, source).trim());
}

function childOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

/** The text of a declaration's `modifiers` child, split into keywords. */
function modifierWords(node: SyntaxNode): string[] {
  const mods = childOfType(node, 'modifiers');
  return mods ? mods.text.split(/\s+/).filter(Boolean) : [];
}

/** Bare type name from a type node's text: `pkg.Box<T>` → `Box`. */
function bareTypeName(text: string): string | undefined {
  const name = text.replace(/<[^]*$/, '').trim().split('.').pop()?.trim();
  return name && /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
}

/** The type an `extend` block extends, for a member written inside it. */
function extendedTypeOf(extendDef: SyntaxNode, source: string): string | undefined {
  const t = childOfType(extendDef, 'extendType');
  return t ? bareTypeName(getNodeText(t, source)) : undefined;
}

/** `let`/`var`/`const` keyword of a variableDeclaration. */
function bindingKeyword(node: SyntaxNode): string | undefined {
  for (let i = 0; i < node.childCount; i++) {
    const t = node.child(i)?.type;
    if (t === 'let' || t === 'var' || t === 'const') return t;
  }
  return undefined;
}

/** The names bound by a variableDeclaration (`let (a, b) = …` binds two). */
function boundNames(node: SyntaxNode): SyntaxNode[] {
  const vn = childOfType(node, 'variableName');
  if (!vn) return [];
  return vn.descendantsOfType('varBindingPattern').filter((n): n is SyntaxNode => !!n);
}

/**
 * The grammar nests an interface body left-recursively (`interfaceBody →
 * interfaceBody → … → member`), so the doc comment above the first member is
 * a sibling of the OUTERMOST body. Climb while `node` leads its parent body.
 */
function declarationWrapper(node: SyntaxNode): SyntaxNode | undefined {
  let cur = node;
  while (cur.parent?.type === 'interfaceBody' && cur.parent.firstNamedChild?.id === cur.id) cur = cur.parent;
  return cur === node ? undefined : cur;
}

const HEADER_TYPES = new Set(['packageDeclaration', 'macroPackageDeclaration', 'importList']);
const COMMENT_TYPES = new Set(['lineComment', 'blockComment']);

/**
 * The doc comment of the first declaration after the `package`/`import`
 * header: tree-sitter hands comments that follow those lines to the header
 * node as its trailing children, so they are not the declaration's siblings.
 */
function headerTrailingDoc(node: SyntaxNode, source: string): string | undefined {
  const prev = (declarationWrapper(node) ?? node).previousNamedSibling;
  if (!prev || !HEADER_TYPES.has(prev.type)) return undefined;
  const comments: SyntaxNode[] = [];
  for (let i = prev.namedChildCount - 1; i >= 0; i--) {
    const child = prev.namedChild(i);
    if (!child || !COMMENT_TYPES.has(child.type)) break;
    // A comment after code on its own line (`import a.b // why`) is that line's.
    const lineStart = source.lastIndexOf('\n', child.startIndex - 1) + 1;
    if (source.slice(lineStart, child.startIndex).trim() !== '') break;
    comments.unshift(child);
  }
  if (comments.length === 0) return undefined;
  return comments.map((c) => cleanCommentMarkers(getNodeText(c, source))).join('\n').trim() || undefined;
}

/** Annotations (`@Component`, `@Builder`) stand between a declaration and its doc comment. */
const DOC_STEP_OVER = ['macroExpression'];

function docOf(node: SyntaxNode, source: string): string | undefined {
  return getPrecedingDocstring(declarationWrapper(node) ?? node, source, DOC_STEP_OVER) ?? headerTrailingDoc(node, source);
}

const ANNOTATED_TYPES = new Set([
  'classDefinition', 'structDefinition', 'interfaceDefinition', 'enumDefinition', 'functionDefinition',
  'mainDefinition', 'operatorFunctionDefinition', 'init', 'primaryInit', 'variableDeclaration',
  'propertyDefinition', 'typeAlias', 'macroDefinition', 'extendDefinition',
]);

/**
 * A declaration's annotations, by name. Two grammar shapes: a type or
 * function's `@Component` / `@Builder` parses as `macroExpression` siblings
 * written before it, a member variable's `@State` / `@Link` as its own
 * `annotationList`. ArkUI-in-Cangjie keys off both (components, reactive
 * state, builder helpers); they also make `@Entry` pages searchable.
 */
function annotationsOf(node: SyntaxNode): string[] | undefined {
  if (!ANNOTATED_TYPES.has(node.type)) return undefined;
  const names: string[] = [];
  let sib = (declarationWrapper(node) ?? node).previousNamedSibling;
  while (sib && (sib.type === 'macroExpression' || COMMENT_TYPES.has(sib.type))) {
    const name = sib.type === 'macroExpression' ? childOfType(sib, 'macroName') : null;
    if (name) names.unshift(name.text.trim());
    sib = sib.previousNamedSibling;
  }
  // A `foreign func` (alone or in a `foreign { … }` block) is implemented in
  // C; the FFI synthesizer links it to that function by name.
  const holder = node.parent?.type === 'foreignBody' ? node.parent.parent : node.parent;
  if (node.type === 'functionDefinition' && holder?.type === 'foreignDeclaration') names.push(CANGJIE_FOREIGN_MARKER);
  for (const list of node.namedChildren) {
    if (list?.type !== 'annotationList') continue;
    for (const anno of list.namedChildren) {
      const name = anno ? childOfType(anno, 'annotationName') : null;
      if (name) names.push(name.text.trim());
    }
  }
  return names.length > 0 ? names : undefined;
}

function topScope(ctx: ExtractorContext): Node | undefined {
  const topId = ctx.nodeStack[ctx.nodeStack.length - 1];
  return topId ? ctx.nodes.find((n) => n.id === topId) : undefined;
}

function visibilityOf(node: SyntaxNode): 'public' | 'private' | 'protected' | 'internal' | undefined {
  for (const w of modifierWords(node)) {
    if (w === 'public' || w === 'private' || w === 'protected' || w === 'internal') return w;
  }
  return undefined;
}

function signatureOf(node: SyntaxNode, source: string): string | undefined {
  const params = childOfType(node, 'parameterList') ?? childOfType(node, 'primaryInitParamList');
  if (!params) return undefined;
  const ret = childOfType(node, 'returnType');
  const typeParams = childOfType(node, 'typeParameters');
  // `returnType` spans its own leading `:`.
  return `${typeParams ? getNodeText(typeParams, source) : ''}${getNodeText(params, source)}${
    ret ? getNodeText(ret, source) : ''
  }`;
}

/** One `imports` ref + import node per FQN an `importList` brings in. */
function importedFqns(node: SyntaxNode, source: string): string[] {
  const fqns: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    const pkg = getChildByField(child, 'packageName') ?? childOfType(child, 'scoped_identifier');
    if (child.type === 'packageFull') {
      // `import a.b.*` keeps the package; `import a.b.C` is the symbol FQN.
      if (pkg) fqns.push(getNodeText(pkg, source));
    } else if (child.type === 'packageAlias') {
      if (pkg) fqns.push(getNodeText(pkg, source));
    } else if (child.type === 'subGroupOfPackage') {
      const group = childOfType(child, 'packageGroup');
      const base = pkg ? getNodeText(pkg, source) : '';
      for (const member of group?.namedChildren ?? []) {
        // `{C, D as E}` — the alias renames locally; the FQN names `D`.
        const name = member ? getNodeText(member, source).trim().split(/\s+as\s+/)[0]! : '';
        if (name) fqns.push(base ? `${base}.${name}` : name);
      }
    }
  }
  // `importList` with a single FQN can also carry it as its own packageName field.
  if (fqns.length === 0) {
    const own = getChildByField(node, 'packageName');
    if (own) fqns.push(getNodeText(own, source));
  }
  return fqns.map((f) => f.replace(/\s+/g, ''));
}

/** Annotations that make a class an ArkUI component (mirrored by the state→build synthesizer). */
const COMPONENT_ANNOTATIONS = new Set([
  'Component', 'ComponentV2', 'Entry', 'CustomDialog', 'Reusable', 'HybridComponentEntry',
]);

/**
 * Whether `node` is view code, where `Text("x").fontSize(16)` chains UI
 * attributes onto a component: inside a `build()` or an `@Builder` function,
 * or any member of an annotated component class (its row/section helpers
 * build views without either marker).
 */
function inViewCode(node: SyntaxNode): boolean {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'functionDefinition' &&
        (childOfType(n, 'funcName')?.text === 'build' || (annotationsOf(n) ?? []).includes('Builder'))) {
      return true;
    }
    if (n.type === 'classDefinition' || n.type === 'structDefinition') {
      return (annotationsOf(n) ?? []).some((a) => COMPONENT_ANNOTATIONS.has(a));
    }
    if (n.type === 'translationUnit') return false;
  }
  return false;
}

/** A call found in a postfix run: the callee name and the node to position it on. */
export interface CangjieCallee {
  name: string;
  node: SyntaxNode;
}

const SELF_RECEIVERS = new Set(['this', 'super']);

/**
 * Callees of a `postfixExpression` / `thisSuperPostfixExpression`, in source
 * order. Callee names follow the dotted-language conventions the resolver
 * already understands:
 *   foo()            → `foo`
 *   this.foo()       → `foo`           (super/this receivers drop)
 *   recv.foo()       → `recv.foo`
 *   this.recv.foo()  → `recv.foo`
 *   Foo.make().bar() → `Foo.make`, `Foo.make().bar`  (capitalized head)
 *   getSvc().run()   → `getSvc`, `getSvc().run`      (top-level function head)
 *   a.b.c.d()        → `d`             (deep chains: bare name)
 *   Text("x").fontSize(16) in view code → `Text`, `.fontSize`
 *
 * The dot-prefixed `.fontSize` is a chained UI attribute: resolution links it
 * only to an attribute helper (`@Builder`/`@Extend`/`@Styles`), never to an
 * unrelated method that shares the name — on an ArkUI app `.width(…)` and
 * `.margin(…)` sit on nearly every view line.
 */
export function cangjieCallees(node: SyntaxNode, source: string): CangjieCallee[] {
  const out: CangjieCallee[] = [];
  const children = node.namedChildren.filter((c): c is SyntaxNode => !!c);
  if (children.length === 0) return out;

  // `path` is the dotted receiver chain seen so far; `opaque` means its value
  // is not statically nameable (an index, a parenthesized expression, a literal).
  let path: string[] = [];
  let opaque = false;
  let lastCall: string | null = null; // callee text of the call whose result we're chaining on
  let literalHead = false;
  // A capitalized component call (`Text(…)`, `Column { … }`) heading a chain in view code.
  const uiChain =
    children[0]!.type === 'atomicVariable' &&
    (children[1]?.type === 'callSuffix' || children[1]?.type === 'trailingLambdaExpression') &&
    inViewCode(node);
  let afterHeadCall = false;
  let uiChainBroken = false;
  // A chain preParse cut loose at a blank or comment line: `width(5)` was `.width(5)`.
  const continued = cangjieRewrites(source)?.attrHeads.has(children[0]!.startIndex) ?? false;

  const head = children[0]!;
  if (head.type === 'thisSuperExpression') {
    path = [getNodeText(head, source).trim()];
  } else if (head.type === 'atomicVariable') {
    for (const part of head.namedChildren) {
      if (!part) continue;
      if (part.type === 'identifier') path.push(identText(part, source));
      else if (part.type === 'scoped_identifier') path.push(...getNodeText(part, source).replace(/\s+/g, '').split('.').map(unquote));
      else if (part.type === 'fieldAccess') {
        const id = childOfType(part, 'identifier');
        if (id) path.push(identText(id, source));
      } else if (part.type === 'indexAccess') opaque = true;
      // typeArguments (`foo<Int64>(…)`) don't change the callee name.
    }
    if (path.length === 0) opaque = true;
    if (uiChain && !(path.length === 1 && /^[A-Z]/.test(path[0]!))) uiChainBroken = true;
    // preParse spells a string-literal receiver (`"x".m()`) as `_sss…`: a
    // builtin of String, never a project symbol — emit nothing for that call.
    if (path.length >= 2 && /^_s+$/.test(path[0]!)) literalHead = true;
  } else {
    opaque = true;
  }

  const emit = (at: SyntaxNode): void => {
    const method = path[path.length - 1];
    if (!method || !/^[A-Za-z_]\w*$/.test(method)) return;
    // `super(…)` / `this(…)` in an init delegate to another constructor.
    if (path.length === 1 && SELF_RECEIVERS.has(method) && lastCall === null) return;
    if (literalHead) {
      literalHead = false;
      return;
    }
    if (continued || (uiChain && !uiChainBroken && afterHeadCall)) {
      out.push({ name: `.${method}`, node: at });
      return;
    }
    let name: string;
    if (lastCall !== null) {
      // Chained on a call result: keep the inner call when resolution can
      // type it — a capitalized (type / companion-factory) head, as for
      // Kotlin/Scala, or a top-level function (`getAuthService().sendCode`),
      // typed by its declared return type, as for Go.
      name = (/^[A-Z]/.test(lastCall) || !lastCall.includes('.')) && path.length === 1
        ? `${lastCall}().${method}`
        : method;
    } else if (opaque) {
      name = method;
    } else {
      const receiver = path.slice(0, -1).filter((p, i) => !(i === 0 && SELF_RECEIVERS.has(p)));
      name = receiver.length === 1 ? `${receiver[0]}.${method}` : method;
    }
    out.push({ name, node: at });
  };

  let prevWasCall = false;
  for (let i = 1; i < children.length; i++) {
    const s = children[i]!;
    switch (s.type) {
      case 'fieldAccess': {
        const id = childOfType(s, 'identifier');
        path.push(id ? identText(id, source) : '');
        prevWasCall = false;
        break;
      }
      case 'callSuffix':
        emit(s);
        afterHeadCall = true;
        lastCall = calleeText(path, lastCall);
        path = [];
        opaque = false;
        prevWasCall = true;
        break;
      case 'trailingLambdaExpression':
        // `foo(x) { … }` is the same call as its callSuffix; `foo { … }` is a call.
        if (!prevWasCall) {
          emit(s);
          afterHeadCall = true;
          lastCall = calleeText(path, lastCall);
          path = [];
          opaque = false;
        }
        prevWasCall = true;
        break;
      case 'indexAccess':
        opaque = true;
        lastCall = null;
        path = ['[]'];
        prevWasCall = false;
        break;
      default:
        // questAccess (`?.`), incOrDec … leave the chain as is.
        break;
    }
  }
  return out;
}

/** Textual callee of the call just emitted, used to encode a chained call. */
function calleeText(path: string[], lastCall: string | null): string | null {
  if (lastCall !== null) return null; // only one level of chain is encoded
  const p = path.filter((x, i) => !(i === 0 && SELF_RECEIVERS.has(x)));
  if (p.length === 0 || p.some((x) => !/^[A-Za-z_]\w*$/.test(x))) return null;
  return p.join('.');
}

export const cangjieExtractor: LanguageExtractor = {
  preParse: (source) => preParseCangjie(source),

  functionTypes: ['functionDefinition', 'mainDefinition', 'macroDefinition'],
  classTypes: ['classDefinition'],
  methodTypes: ['functionDefinition', 'operatorFunctionDefinition', 'init', 'primaryInit', 'finalizer'],
  interfaceTypes: ['interfaceDefinition'],
  structTypes: ['structDefinition'],
  enumTypes: ['enumDefinition'],
  // Constructors are `enumConstant:`-fielded identifiers directly in the body
  // (payload types are typed nodes — `userType`, `Int64` — never `identifier`);
  // emitted in visitNode so an escaped name is unquoted.
  enumMemberTypes: [],
  typeAliasTypes: ['typeAlias'],
  importTypes: [], // importList handled in visitNode
  callTypes: ['postfixExpression', 'thisSuperPostfixExpression'],
  variableTypes: [], // variableDeclaration handled in visitNode
  propertyTypes: [], // propertyDefinition handled in visitNode

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameterList',

  recoverMangledName: (name) => unquote(name),

  resolveName: (node, source) => {
    switch (node.type) {
      case 'mainDefinition': return 'main';
      case 'init':
      case 'primaryInit': return 'init';
      case 'finalizer': return '~init';
      case 'operatorFunctionDefinition': {
        const op = childOfType(node, 'operator');
        return op ? `operator${getNodeText(op, source).trim()}` : 'operator';
      }
    }
    const childType = NAME_CHILD[node.type];
    if (childType) {
      const nameNode = childOfType(node, childType);
      if (nameNode) return getNodeText(nameNode, source).trim();
    }
    return undefined;
  },

  resolveBody: (node) => {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && BODY_TYPES.has(child.type)) return child;
    }
    // A primary constructor's statements sit directly under it.
    return node.type === 'primaryInit' ? node : null;
  },

  getSignature: (node, source) => signatureOf(node, source),

  getDeclarationWrapper: (node) => declarationWrapper(node),

  docstringStepOverTypes: DOC_STEP_OVER,

  extractModifiers: (node) => annotationsOf(node),

  // Not a body docstring: the doc comment tree-sitter attached to the
  // preceding package/import line (see headerTrailingDoc).
  getBodyDocstring: (node, source) => (node.parent ? headerTrailingDoc(node, source) : undefined),

  // Bare class name a chained `Foo.make().bar()` can be resolved on: `?Foo`
  // and `Foo<T>` unwrap to `Foo`; tuples, function types and builtins don't.
  getReturnType: (node, source) => {
    const ret = childOfType(node, 'returnType');
    const type = ret?.namedChild(0);
    if (!type) return undefined;
    const text = getNodeText(type, source).replace(/^\?+/, '');
    if (type.type !== 'userType' && type.type !== 'prefixType') return undefined;
    return bareTypeName(text);
  },

  getVisibility: (node) => visibilityOf(node),

  // Cangjie's default top-level visibility is `internal` (package-wide); only
  // `public`/`protected` declarations are visible to other packages.
  isExported: (node) => {
    const words = modifierWords(node);
    return words.includes('public') || words.includes('protected');
  },

  isStatic: (node) => modifierWords(node).includes('static'),

  isAbstract: (node) => modifierWords(node).includes('abstract') || undefined,

  packageTypes: ['packageDeclaration', 'macroPackageDeclaration'],
  extractPackage: (node, source) => {
    const pkg = getChildByField(node, 'packageName') ?? childOfType(node, 'scoped_identifier') ?? childOfType(node, 'identifier');
    return pkg ? getNodeText(pkg, source).replace(/\s+/g, '') : null;
  },

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'identifier': {
        if (node.parent?.type !== 'enumBody') return false;
        ctx.createNode('enum_member', identText(node, ctx.source), node);
        return true;
      }

      case 'functionDefinition': {
        // A body-less `prop` preParse turned into a function.
        if (!cangjieRewrites(ctx.source)?.props.has(node.startIndex)) return false;
        const nameNode = childOfType(node, 'funcName');
        if (!nameNode) return false;
        const ret = childOfType(node, 'returnType');
        const name = identText(nameNode, ctx.source);
        ctx.createNode('property', name, node, {
          docstring: docOf(node, ctx.source),
          signature: ret ? getNodeText(ret, ctx.source).replace(/^:\s*/, '') : undefined,
          visibility: visibilityOf(node),
          isStatic: modifierWords(node).includes('static'),
        });
        return true;
      }

      case 'importList': {
        const fqns = importedFqns(node, ctx.source);
        // `org. pkg` is preParse's spelling of `org::pkg`.
        const signature = getNodeText(node, ctx.source).trim().replace(/\.\s+/g, '.');
        const fromId = ctx.nodeStack[ctx.nodeStack.length - 1];
        for (const fqn of fqns) {
          ctx.createNode('import', fqn, node, { signature });
          if (fromId) {
            ctx.addUnresolvedReference({
              fromNodeId: fromId,
              referenceName: fqn,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return true;
      }

      case 'variableDeclaration': {
        const owner = topScope(ctx);
        const inType = !!owner && TYPE_LIKE_KINDS.has(owner.kind);
        // A local `let` in a function body never reaches here (bodies are
        // walked for calls by the core), so this is file or type scope.
        const keyword = bindingKeyword(node);
        const kind: NodeKind = inType ? 'field' : keyword === 'var' ? 'variable' : 'constant';
        const typeNode = getChildByField(node, 'type');
        const value = getChildByField(node, 'initilizer');
        const words = modifierWords(node);
        let firstId: string | undefined;
        for (const nameNode of boundNames(node)) {
          const created = ctx.createNode(kind, identText(nameNode, ctx.source), node, {
            docstring: docOf(node, ctx.source),
            signature: typeNode ? getNodeText(typeNode, ctx.source) : undefined,
            visibility: visibilityOf(node),
            isStatic: words.includes('static'),
            isExported: !inType && (words.includes('public') || words.includes('protected')),
          });
          firstId ??= created?.id;
        }
        if (value) {
          // The initializer's calls belong to the declared symbol (or to the
          // enclosing scope when nothing was created, e.g. a `_` binding).
          if (firstId) ctx.pushScope(firstId);
          ctx.walkInitializer(value);
          if (firstId) ctx.popScope();
        }
        return true;
      }

      case 'propertyDefinition': {
        const nameNode = childOfType(node, 'propertyName');
        if (!nameNode) return false;
        const typeNode = getChildByField(node, 'type');
        const name = identText(nameNode, ctx.source);
        const prop = ctx.createNode('property', name, node, {
          docstring: docOf(node, ctx.source),
          signature: typeNode ? getNodeText(typeNode, ctx.source) : undefined,
          visibility: visibilityOf(node),
          isStatic: modifierWords(node).includes('static'),
        });
        if (!prop) return true;
        // Calls attribute to the scope on top of the stack.
        ctx.pushScope(prop.id);
        for (const field of ['getter', 'setter']) {
          for (const accessor of node.childrenForFieldName(field)) {
            if (accessor?.type === 'block') ctx.visitFunctionBody(accessor, prop.id);
          }
        }
        ctx.popScope();
        return true;
      }

      case 'extendDefinition': {
        const typeName = extendedTypeOf(node, ctx.source);
        const owner = typeName
          ? ctx.nodes.find((n) => n.name === typeName && n.filePath === ctx.filePath && TYPE_LIKE_KINDS.has(n.kind))
          : undefined;
        // A type declared in another file, or a builtin (`extend Int64 <:
        // Countable`), gets an extension node of its own, marked `extend`, as a
        // Swift extension does: it holds the members and the conformances, so
        // interface dispatch reaches them. Resolution never lands a reference
        // to the TYPE on it (see resolution/cangjie-target-gate.ts).
        const holder = owner ?? (typeName
          ? ctx.createNode('class', typeName, node, { decorators: [CANGJIE_EXTEND_MARKER], docstring: docOf(node, ctx.source) })
          : null);
        if (holder) {
          for (const sup of node.namedChildren) {
            if (sup?.type !== 'superOrInterface') continue;
            const name = bareTypeName(getNodeText(sup, ctx.source));
            if (!name) continue;
            ctx.addUnresolvedReference({
              fromNodeId: holder.id,
              referenceName: name,
              referenceKind: 'implements',
              line: sup.startPosition.row + 1,
              column: sup.startPosition.column,
            });
          }
          ctx.pushScope(holder.id);
        }
        const body = childOfType(node, 'extendBody');
        for (const child of body?.namedChildren ?? []) {
          if (child) ctx.visitNode(child);
        }
        if (holder) ctx.popScope();
        return true;
      }

      case 'staticInit': {
        // `static init() { … }` — its calls stay with the enclosing type.
        const block = childOfType(node, 'block');
        const ownerId = ctx.nodeStack[ctx.nodeStack.length - 1];
        if (block && ownerId) ctx.visitFunctionBody(block, ownerId);
        return true;
      }
    }
    return false;
  },
};

/** Supertype names of a class/struct/enum/interface (`<: A & B`). */
export function cangjieSupertypes(node: SyntaxNode, source: string): { name: string; node: SyntaxNode }[] {
  const out: { name: string; node: SyntaxNode }[] = [];
  for (const child of node.namedChildren) {
    if (child?.type !== 'superOrInterface') continue;
    const name = bareTypeName(getNodeText(child, source));
    if (name) out.push({ name, node: child });
  }
  return out;
}
