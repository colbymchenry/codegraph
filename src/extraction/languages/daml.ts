import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';
import {
  collapseWs,
  fileModuleName,
  handleFunctionLike,
  haskellExtractor,
  precedingHaddock,
  qualifiedRef,
  type QualifiedRef,
} from './haskell';

// DAML (Digital Asset's smart-contract language) on the tree-sitter-daml
// grammar, which extends tree-sitter-haskell 0.23.1 and keeps its node names.
// Haskell constructs (functions, data types, classes, instances, imports,
// calls) go through the Haskell extractor; this adds DAML's contract
// declarations:
//
//   template T with fields where ...   → class T (exported, public) + fields
//     choice C : R with ... controller p do ...
//                                       → method C in T (public), decorated
//                                         `choice` + its consumption mode
//     interface instance I for T where → T implements I; method bodies become
//                                         methods of T
//     signatory / observer / ensure / key / maintainer
//                                       → calls attributed to T
//   interface I requires J where ...    → interface I (extends J), method
//                                         signatures and choices as methods
//   exception E with fields where ...   → class E + fields
//
// A template and its choices are the contract's ledger API: any party with the
// authority can create the template or exercise a choice, whatever the module
// exports, so they are always exported.
//
// A choice also declares a module-level record type of its own name (the
// choice argument, `Module.Transfer`), and two templates in one module can't
// share a choice name, so a choice's qualified name is `Module::Choice`: the
// form a qualified exercise (`exercise cid Account.Credit`) resolves against.
// Qualified references are written with import aliases expanded (see
// `qualifiedRef`). Interface methods are module-level functions too
// (`Claim.getClaims c`), so they get `Module::method` the same way.
//
// Ledger actions become edges: `exercise cid C with ...` (and every
// `exercise*` / `createAndExercise*` helper, whose last argument is the choice
// argument record) calls choice C; `create T with ...` calls template T, and
// `create this ...` the template it is written in; `fetchByKey @T k` (and the
// other by-key actions and `fetchFromInterface`) calls T. Any other
// `T with ...` / `T {..}` instantiates T. A choice-argument record built ahead
// of its exercise (`let arg = Transfer with ...`) instantiates the choice.
//
// A function named as a value — composed (`f . g $ x`), applied with `$` or
// `<$>`, or passed to another function (`mapA settle steps`) — is called by the
// expression it is part of, so it is a call too. Names the code binds itself
// (parameters, patterns, `<-` and `let` values, template and choice fields,
// `this` / `self` / `arg`) are not references.

const DEFAULT_CONSUMPTION = 'consuming';
const CHOICE_DECORATOR = 'choice';
const MAX_SIGNATURE = 400;

/**
 * `exercise`, `exerciseCmd`, `exerciseByKey`, `createAndExerciseCmd`, and
 * project helpers named alike (`submitExerciseInterfaceByKeyCmd`).
 */
const EXERCISE_FN = /(?:^e|E)xercise/;

/** Ledger actions whose first argument is the contract to create: `create T with ..`, `create this`. */
const CREATE_FNS = new Set(['create', 'createAndExercise']);

/** Ledger actions whose type application names the template or interface: `fetchByKey @T key`. */
const TYPE_APPLIED_LEDGER_FNS = new Set(['fetchByKey', 'lookupByKey', 'exerciseByKey', 'visibleByKey', 'fetchFromInterface']);

/** The contract value a template's clauses and choices see. */
const THIS = 'this';

/** Names DAML binds in every template body and choice. */
const IMPLICIT_BINDERS = new Set([THIS, 'self', 'arg']);

/** A record pattern binding every field (`Transfer{..}`): its names are not known here. */
const RECORD_WILDCARD = '..';

/** Child fields holding patterns, whose variables are binders. */
const PATTERN_FIELDS = new Set(['pattern', 'patterns']);

/** Child fields below which a variable is never a value: patterns, and types (`cid : ContractId t`). */
const NON_VALUE_FIELDS = new Set([...PATTERN_FIELDS, 'type']);

/** Nodes below which a variable is a binder, a field label or a type, never a value reference. */
const NON_VALUE_ANCESTORS = new Set(['field_name', 'projection_selector', 'signature', 'type_application', 'patterns', 'import', 'header']);

/** Clause nodes whose expressions run when the contract is created or a key is looked up. */
const TEMPLATE_CLAUSES = new Set(['signatory', 'observer', 'ensure', 'agreement', 'contract_key', 'maintainer']);

/**
 * Records (and positional applications) already linked as a ledger action — an
 * exercised choice's argument, a created contract — and so not also an instantiation.
 */
const linkedRecords = new Set<number>();
/** The parse tree the set belongs to (node ids repeat across trees). */
let linkedRecordsTree: unknown = null;

/** The templates being walked, innermost last, as `Module::Template` (what `this` creates). */
const templateStack: string[] = [];

/** Names each scope node binds, by node id; `null` when a record wildcard binds unknown names. */
const scopeBinders = new Map<number, Set<string> | null>();
/** The parse tree the memo belongs to. */
let scopeBindersTree: unknown = null;

function callerId(ctx: ExtractorContext): string | undefined {
  return ctx.nodeStack[ctx.nodeStack.length - 1];
}

/** A constructor reference: `Transfer`, or `Account.Credit` → `Daml.Finance…Account::Credit`. */
function constructorRef(node: SyntaxNode, source: string): QualifiedRef | null {
  if (node.type === 'constructor') return { referenceName: getNodeText(node, source) };
  if (node.type === 'qualified' && getChildByField(node, 'id')?.type === 'constructor') {
    return qualifiedRef(node, source);
  }
  return null;
}

/** `Account.I` → `Daml.Finance…Account::I`; an unqualified type name as written. */
function typeRef(node: SyntaxNode, source: string): QualifiedRef {
  return qualifiedRef(node, source) ?? { referenceName: getNodeText(node, source) };
}

/** The constructor a choice-argument expression builds: `C`, `(C with ..)`, `C {..}`, `M.C with ..`. */
function constructedRef(node: SyntaxNode, source: string): { ref: QualifiedRef; record: SyntaxNode | null } | null {
  let cur: SyntaxNode | null = node;
  while (cur?.type === 'parens') cur = getChildByField(cur, 'expression');
  if (!cur) return null;
  if (cur.type === 'record') {
    const head = getChildByField(cur, 'expression');
    const ref = head ? constructorRef(head, source) : null;
    return ref ? { ref, record: cur } : null;
  }
  // `(C a b)` — a positional choice argument: the constructor heads the application.
  let head: SyntaxNode | null = cur;
  while (head?.type === 'apply') head = getChildByField(head, 'function');
  const ref = head ? constructorRef(head, source) : null;
  return ref ? { ref, record: cur.type === 'apply' ? cur : null } : null;
}

/** The function at the head of an application spine, unqualified: `Script.exerciseCmd cid C` → `exerciseCmd`. */
function applicationHead(node: SyntaxNode, source: string): string | null {
  let cur: SyntaxNode | null = node;
  while (cur?.type === 'apply') cur = getChildByField(cur, 'function');
  if (!cur) return null;
  if (cur.type === 'variable') return getNodeText(cur, source);
  if (cur.type === 'qualified') {
    const id = getChildByField(cur, 'id');
    return id?.type === 'variable' ? getNodeText(id, source) : null;
  }
  return null;
}

function resetLinkedRecords(node: SyntaxNode): void {
  if (linkedRecordsTree !== node.tree) {
    linkedRecords.clear();
    linkedRecordsTree = node.tree;
  }
}

/**
 * `exercise cid C with ...` → `calls C`. Only the outermost application of the
 * spine carries the last argument, which is the choice argument.
 */
function linkExercisedChoice(node: SyntaxNode, ctx: ExtractorContext): void {
  const parent = node.parent;
  if (parent?.type === 'apply' && getChildByField(parent, 'function')?.id === node.id) return;
  const head = applicationHead(node, ctx.source);
  if (!head || !EXERCISE_FN.test(head)) return;
  const arg = getChildByField(node, 'argument');
  const choice = arg ? constructedRef(arg, ctx.source) : null;
  const from = callerId(ctx);
  if (!choice || !from) return;
  resetLinkedRecords(node);
  if (choice.record) linkedRecords.add(choice.record.id);
  ctx.addUnresolvedReference({
    fromNodeId: from,
    ...choice.ref,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** `T with ...` / `T {..}` → `instantiates T` (a record update `this with ...` has no constructor). */
function linkRecordConstruction(node: SyntaxNode, ctx: ExtractorContext): void {
  resetLinkedRecords(node);
  if (linkedRecords.has(node.id)) return;
  const head = getChildByField(node, 'expression');
  const ref = head ? constructorRef(head, ctx.source) : null;
  const from = callerId(ctx);
  if (!ref || !from) return;
  ctx.addUnresolvedReference({
    fromNodeId: from,
    ...ref,
    referenceKind: 'instantiates',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** `f a b` → `[a, b]`: an application spine's arguments in order. */
function spineArguments(node: SyntaxNode): SyntaxNode[] {
  const args: SyntaxNode[] = [];
  let cur: SyntaxNode | null = node;
  while (cur?.type === 'apply') {
    const arg = getChildByField(cur, 'argument');
    if (arg) args.unshift(arg);
    cur = getChildByField(cur, 'function');
  }
  return args;
}

function unparenthesized(node: SyntaxNode): SyntaxNode | null {
  let cur: SyntaxNode | null = node;
  while (cur?.type === 'parens') cur = getChildByField(cur, 'expression');
  return cur;
}

/** The template a `create` argument makes: `T with ..`, `(T a b)`, or `this` / `this with ..` in a template. */
function createdTemplate(arg: SyntaxNode, source: string): QualifiedRef | null {
  const value = unparenthesized(arg);
  if (!value) return null;
  const base = value.type === 'record' ? getChildByField(value, 'expression') : value;
  if (base?.type === 'variable' && getNodeText(base, source) === THIS) {
    const template = templateStack[templateStack.length - 1];
    if (!template) return null;
    if (value.type === 'record') linkedRecords.add(value.id);
    return { referenceName: template };
  }
  const built = constructedRef(value, source);
  if (!built) return null;
  if (built.record) linkedRecords.add(built.record.id);
  return built.ref;
}

/** `@T` / `@M.T` → T; a type variable (`@t`) names no template. */
function appliedType(arg: SyntaxNode, source: string): QualifiedRef | null {
  if (arg.type !== 'type_application') return null;
  const type = getChildByField(arg, 'type');
  if (type?.type === 'name') return { referenceName: getNodeText(type, source) };
  return type?.type === 'qualified' ? qualifiedRef(type, source) : null;
}

/** `create T with ..` / `create this` / `fetchByKey @T k` → `calls T`, on the outermost application. */
function linkLedgerAction(node: SyntaxNode, ctx: ExtractorContext): void {
  const parent = node.parent;
  if (parent?.type === 'apply' && getChildByField(parent, 'function')?.id === node.id) return;
  const head = applicationHead(node, ctx.source);
  const first = spineArguments(node)[0];
  const from = callerId(ctx);
  if (!head || !first || !from) return;
  resetLinkedRecords(node);
  const target = CREATE_FNS.has(head)
    ? createdTemplate(first, ctx.source)
    : TYPE_APPLIED_LEDGER_FNS.has(head) ? appliedType(first, ctx.source) : null;
  if (!target) return;
  ctx.addUnresolvedReference({
    fromNodeId: from,
    ...target,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** The field a node fills in its parent (`function`, `argument`, `pattern`, …). */
function fieldOf(node: SyntaxNode): string | null {
  const parent = node.parent;
  if (!parent) return null;
  for (let i = 0; i < parent.childCount; i++) {
    if (parent.child(i)?.id === node.id) return parent.fieldNameForChild(i);
  }
  return null;
}

function collectVariables(node: SyntaxNode, source: string, into: Set<string>): boolean {
  if (node.type === 'wildcard' && getNodeText(node, source) === RECORD_WILDCARD) return false;
  if (node.type === 'variable') into.add(getNodeText(node, source));
  for (const child of node.namedChildren) {
    if (child && !collectVariables(child, source, into)) return false;
  }
  return true;
}

function fieldNames(fields: SyntaxNode | null, source: string, into: Set<string>): void {
  for (const field of fields?.namedChildren ?? []) {
    if (field?.type !== 'field') continue;
    for (const name of field.childrenForFieldName('name')) {
      if (name) into.add(getNodeText(name, source));
    }
  }
}

/** Names a `let` / `where` block binds without a node of their own: pattern bindings (`(a, b) = ..`). */
function patternBindBinders(binds: SyntaxNode | null, source: string, into: Set<string>): boolean {
  for (const bind of binds?.namedChildren ?? []) {
    const pattern = bind?.type === 'bind' && !getChildByField(bind, 'name') ? getChildByField(bind, 'pattern') : null;
    if (pattern && !collectVariables(pattern, source, into)) return false;
  }
  return true;
}

/** A `do` block's `x <- ..` patterns and `let` values (a `let` function is a node of its own). */
function doBinders(node: SyntaxNode, source: string, into: Set<string>): boolean {
  for (const statement of node.namedChildren) {
    if (statement?.type === 'bind') {
      const pattern = getChildByField(statement, 'pattern');
      if (pattern && !collectVariables(pattern, source, into)) return false;
    } else if (statement?.type === 'let') {
      const binds = getChildByField(statement, 'binds');
      for (const bind of binds?.namedChildren ?? []) {
        const name = bind?.type === 'bind' ? getChildByField(bind, 'name') : null;
        if (name) into.add(getNodeText(name, source));
      }
      if (!patternBindBinders(binds, source, into)) return false;
    }
  }
  return true;
}

/** The names a scope node binds for the expressions below it; null when a record wildcard hides them. */
function bindersOf(node: SyntaxNode, source: string): Set<string> | null {
  if (scopeBindersTree !== node.tree) {
    scopeBinders.clear();
    scopeBindersTree = node.tree;
  }
  if (scopeBinders.has(node.id)) return scopeBinders.get(node.id)!;
  const names = new Set<string>();
  let known = true;
  for (let i = 0; i < node.childCount && known; i++) {
    const child = node.child(i);
    if (child && PATTERN_FIELDS.has(node.fieldNameForChild(i) ?? '')) known = collectVariables(child, source, names);
  }
  if (known && node.type === 'do') known = doBinders(node, source, names);
  if (known && node.type !== 'do') known = patternBindBinders(getChildByField(node, 'binds'), source, names);
  if (node.type === 'template' || node.type === 'template_choice') fieldNames(getChildByField(node, 'fields'), source, names);
  const result = known ? names : null;
  scopeBinders.set(node.id, result);
  return result;
}

/** A variable the code binds itself between it and the module top. */
function isBound(node: SyntaxNode, name: string, source: string): boolean {
  if (IMPLICIT_BINDERS.has(name)) return true;
  for (let cur = node.parent; cur; cur = cur.parent) {
    const binders = bindersOf(cur, source);
    if (!binders || binders.has(name)) return true;
  }
  return false;
}

/**
 * Not a binder, a field label, a type, a declaration's name or an application
 * head (a call already). Above a clause's `match` is its header, which only
 * binds, so the walk stops there.
 */
function isValuePosition(node: SyntaxNode): boolean {
  const field = fieldOf(node);
  if (field === 'name' || field === 'id') return false;
  if (field === 'function' && node.parent?.type === 'apply') return false;
  for (let cur: SyntaxNode | null = node; cur?.parent && cur.type !== 'match'; cur = cur.parent) {
    if (NON_VALUE_ANCESTORS.has(cur.type) || NON_VALUE_FIELDS.has(fieldOf(cur) ?? '')) return false;
  }
  return true;
}

/** A function named as a value (`f . g`, `mapA f xs`) → `calls f`. */
function linkValueReference(node: SyntaxNode, ctx: ExtractorContext): void {
  const from = callerId(ctx);
  if (!from || !isValuePosition(node)) return;
  let ref: QualifiedRef | null;
  if (node.type === 'qualified') {
    if (getChildByField(node, 'id')?.type !== 'variable') return;
    ref = qualifiedRef(node, ctx.source);
  } else {
    const name = getNodeText(node, ctx.source);
    ref = isBound(node, name, ctx.source) ? null : { referenceName: name };
  }
  if (!ref) return;
  ctx.addUnresolvedReference({
    fromNodeId: from,
    ...ref,
    referenceKind: 'calls',
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

/** `-- ^` docs right after a declaration's header, which DAML puts inside choices and fields. */
function innerHaddock(node: SyntaxNode, source: string): string | undefined {
  const lines: string[] = [];
  for (const child of node.children) {
    if (!child) continue;
    if (child.type === 'haddock') {
      lines.push(getNodeText(child, source).replace(/^--\s*\^?\s?/gm, '').trim());
    } else if (lines.length > 0 && child.type !== 'comment') {
      break;
    }
  }
  const text = lines.join('\n').trim();
  return text || undefined;
}

/** `a : Int; b : Text` from a `fields` node. */
function fieldsSummary(fields: SyntaxNode | null, source: string): string | undefined {
  if (!fields) return undefined;
  const parts = fields.namedChildren
    .filter((f): f is SyntaxNode => f?.type === 'field')
    .map((f) => collapseWs(getNodeText(f, source)));
  return parts.length > 0 ? parts.join('; ') : undefined;
}

function createFields(fields: SyntaxNode | null, ctx: ExtractorContext): void {
  if (!fields) return;
  for (const field of fields.namedChildren) {
    if (field?.type !== 'field') continue;
    for (const nameNode of field.childrenForFieldName('name')) {
      if (!nameNode) continue;
      ctx.createNode('field', getNodeText(nameNode, ctx.source), field, {
        signature: collapseWs(getNodeText(field, ctx.source)).slice(0, MAX_SIGNATURE),
        docstring: innerHaddock(field, ctx.source),
        isExported: true,
        visibility: 'public',
      });
    }
  }
}

/** Visit a node's named children for calls, attributed to the current scope. */
function visitChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (const child of node.namedChildren) {
    if (child) ctx.visitNode(child);
  }
}

function handleChoice(node: SyntaxNode, ctx: ExtractorContext): void {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return;
  const name = getNodeText(nameNode, ctx.source);
  const consumptionNode = getChildByField(node, 'consumption');
  const consumption = consumptionNode ? getNodeText(consumptionNode, ctx.source) : DEFAULT_CONSUMPTION;
  const returnType = getChildByField(node, 'type');
  const params = fieldsSummary(getChildByField(node, 'fields'), ctx.source);
  const clauses = node.childrenForFieldName('clause').filter((c): c is SyntaxNode => !!c);

  const signature = [
    `${consumption} choice ${name}`,
    returnType ? `: ${collapseWs(getNodeText(returnType, ctx.source))}` : '',
    params ? `with ${params}` : '',
    ...clauses.map((c) => collapseWs(getNodeText(c, ctx.source))),
  ].filter(Boolean).join(' ');

  const module = fileModuleName(node, ctx.source);
  const method = ctx.createNode('method', name, node, {
    ...(module ? { qualifiedName: `${module}::${name}` } : {}),
    signature: signature.slice(0, MAX_SIGNATURE),
    docstring: innerHaddock(node, ctx.source) ?? precedingHaddock(node, ctx.source),
    returnType: returnType ? collapseWs(getNodeText(returnType, ctx.source)) : undefined,
    decorators: [CHOICE_DECORATOR, consumption],
    isExported: true,
    visibility: 'public',
  });
  if (!method) return;

  ctx.pushScope(method.id);
  for (const clause of clauses) visitChildren(clause, ctx);
  const body = getChildByField(node, 'body');
  if (body) ctx.visitNode(body);
  ctx.popScope();
}

/** `interface instance I for T where ...`: the owner implements I; method bodies become its methods. */
function handleInterfaceInstance(node: SyntaxNode, ctx: ExtractorContext): void {
  const iface = getChildByField(node, 'interface');
  const owner = callerId(ctx);
  if (iface && owner) {
    ctx.addUnresolvedReference({
      fromNodeId: owner,
      ...typeRef(iface, ctx.source),
      referenceKind: 'implements',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }
  const body = getChildByField(node, 'body');
  if (!body) return;
  for (const decl of body.namedChildren) {
    if (!decl) continue;
    if (decl.type === 'function' || decl.type === 'bind') handleFunctionLike(decl, ctx, 'method');
    else ctx.visitNode(decl);
  }
}

function templateSignature(node: SyntaxNode, name: string, body: SyntaxNode | null, source: string): string {
  const parts = [`template ${name}`];
  const fields = fieldsSummary(getChildByField(node, 'fields'), source);
  if (fields) parts.push(`with ${fields}`);
  for (const decl of body?.namedChildren ?? []) {
    if (decl && TEMPLATE_CLAUSES.has(decl.type)) parts.push(collapseWs(getNodeText(decl, source)));
  }
  return parts.join(' ').slice(0, MAX_SIGNATURE);
}

function handleTemplateDecl(decl: SyntaxNode, ctx: ExtractorContext): void {
  switch (decl.type) {
    case 'template_choice':
      handleChoice(decl, ctx);
      return;
    case 'controller_can':
      for (const choice of decl.childrenForFieldName('choice')) {
        if (choice) handleChoice(choice, ctx);
      }
      return;
    case 'interface_instance':
    case 'implements':
      handleInterfaceInstance(decl, ctx);
      return;
    case 'let': {
      const binds = getChildByField(decl, 'binds');
      if (binds) visitChildren(binds, ctx);
      return;
    }
    default:
      // signatory / observer / ensure / key / maintainer / agreement
      visitChildren(decl, ctx);
  }
}

function handleTemplate(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  const body = getChildByField(node, 'body');
  const cls = ctx.createNode('class', name, node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: templateSignature(node, name, body, ctx.source),
    decorators: ['template'],
    isExported: true,
    visibility: 'public',
  });
  if (!cls) return true;

  const module = fileModuleName(node, ctx.source);
  templateStack.push(module ? `${module}::${name}` : name);
  ctx.pushScope(cls.id);
  try {
    createFields(getChildByField(node, 'fields'), ctx);
    for (const decl of body?.namedChildren ?? []) {
      if (decl) handleTemplateDecl(decl, ctx);
    }
  } finally {
    ctx.popScope();
    templateStack.pop();
  }
  return true;
}

function handleInterface(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  const body = getChildByField(node, 'body');
  const requires = node.childrenForFieldName('requires').filter((r): r is SyntaxNode => !!r);
  const viewtype = body?.namedChildren.find((d) => d?.type === 'viewtype');

  const iface = ctx.createNode('interface', name, node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: [
      `interface ${name}`,
      requires.length > 0 ? `requires ${requires.map((r) => getNodeText(r, ctx.source)).join(', ')}` : '',
      viewtype ? collapseWs(getNodeText(viewtype, ctx.source)) : '',
    ].filter(Boolean).join(' '),
    decorators: ['interface'],
    isExported: true,
    visibility: 'public',
  });
  if (!iface) return true;

  for (const req of requires) {
    ctx.addUnresolvedReference({
      fromNodeId: iface.id,
      ...typeRef(req, ctx.source),
      referenceKind: 'extends',
      line: req.startPosition.row + 1,
      column: req.startPosition.column,
    });
  }

  ctx.pushScope(iface.id);
  for (const decl of body?.namedChildren ?? []) {
    if (!decl) continue;
    switch (decl.type) {
      case 'signature': {
        // An interface method: implemented by every `interface instance`.
        const methodNameNode = getChildByField(decl, 'name');
        if (!methodNameNode) break;
        const methodName = getNodeText(methodNameNode, ctx.source);
        const module = fileModuleName(decl, ctx.source);
        ctx.createNode('method', methodName, decl, {
          ...(module ? { qualifiedName: `${module}::${methodName}` } : {}),
          signature: collapseWs(getNodeText(decl, ctx.source)).slice(0, MAX_SIGNATURE),
          docstring: innerHaddock(decl, ctx.source) ?? precedingHaddock(decl, ctx.source),
          isAbstract: true,
          isExported: true,
          visibility: 'public',
        });
        break;
      }
      case 'template_choice':
        handleChoice(decl, ctx);
        break;
      case 'interface_instance':
        handleInterfaceInstance(decl, ctx);
        break;
      default:
        visitChildren(decl, ctx);
    }
  }
  ctx.popScope();
  return true;
}

function handleException(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name');
  if (!nameNode) return true;
  const name = getNodeText(nameNode, ctx.source);
  const fields = getChildByField(node, 'fields');
  const summary = fieldsSummary(fields, ctx.source);
  const cls = ctx.createNode('class', name, node, {
    docstring: precedingHaddock(node, ctx.source),
    signature: `exception ${name}${summary ? ` with ${summary}` : ''}`.slice(0, MAX_SIGNATURE),
    decorators: ['exception'],
    isExported: true,
    visibility: 'public',
  });
  if (!cls) return true;
  ctx.pushScope(cls.id);
  createFields(fields, ctx);
  const body = getChildByField(node, 'body');
  if (body) visitChildren(body, ctx);
  ctx.popScope();
  return true;
}

export const damlExtractor: LanguageExtractor = {
  ...haskellExtractor,

  visitNode: (node, ctx) => {
    switch (node.type) {
      case 'template':
        return handleTemplate(node, ctx);
      case 'interface':
        return handleInterface(node, ctx);
      case 'exception':
        return handleException(node, ctx);
      case 'apply':
        resetLinkedRecords(node);
        if (linkedRecords.has(node.id)) {
          // `exercise cid (C a b)`: already a call to C; only its arguments remain.
          for (const child of node.namedChildren) {
            if (child) ctx.visitNode(child);
          }
          return true;
        }
        // Pre-hook: the generic call extraction still runs for the application.
        linkExercisedChoice(node, ctx);
        linkLedgerAction(node, ctx);
        return false;
      case 'record':
        linkRecordConstruction(node, ctx);
        return false;
      case 'variable':
      case 'qualified':
        linkValueReference(node, ctx);
        return false;
      default:
        return haskellExtractor.visitNode!(node, ctx);
    }
  },
};
