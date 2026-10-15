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
// argument record) calls choice C; `T with ...` / `T {..}` instantiates T. A
// choice-argument record built ahead of its exercise
// (`let arg = Transfer with ...`) instantiates the choice.

const DEFAULT_CONSUMPTION = 'consuming';
const CHOICE_DECORATOR = 'choice';
const MAX_SIGNATURE = 400;

/**
 * `exercise`, `exerciseCmd`, `exerciseByKey`, `createAndExerciseCmd`, and
 * project helpers named alike (`submitExerciseInterfaceByKeyCmd`).
 */
const EXERCISE_FN = /(?:^e|E)xercise/;

/** Clause nodes whose expressions run when the contract is created or a key is looked up. */
const TEMPLATE_CLAUSES = new Set(['signatory', 'observer', 'ensure', 'agreement', 'contract_key', 'maintainer']);

/** Choice arguments (records, positional applications) already linked as an exercised choice — not also an instantiation. */
const exercisedChoiceArgs = new Set<number>();
/** The parse tree the set belongs to (node ids repeat across trees). */
let exercisedChoiceArgsTree: unknown = null;

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

function resetExercisedChoiceArgs(node: SyntaxNode): void {
  if (exercisedChoiceArgsTree !== node.tree) {
    exercisedChoiceArgs.clear();
    exercisedChoiceArgsTree = node.tree;
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
  resetExercisedChoiceArgs(node);
  if (choice.record) exercisedChoiceArgs.add(choice.record.id);
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
  resetExercisedChoiceArgs(node);
  if (exercisedChoiceArgs.has(node.id)) return;
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

  ctx.pushScope(cls.id);
  createFields(getChildByField(node, 'fields'), ctx);
  for (const decl of body?.namedChildren ?? []) {
    if (decl) handleTemplateDecl(decl, ctx);
  }
  ctx.popScope();
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
        resetExercisedChoiceArgs(node);
        if (exercisedChoiceArgs.has(node.id)) {
          // `exercise cid (C a b)`: already a call to C; only its arguments remain.
          for (const child of node.namedChildren) {
            if (child) ctx.visitNode(child);
          }
          return true;
        }
        // Pre-hook: the generic call extraction still runs for the application.
        linkExercisedChoice(node, ctx);
        return false;
      case 'record':
        linkRecordConstruction(node, ctx);
        return false;
      default:
        return haskellExtractor.visitNode!(node, ctx);
    }
  },
};
