import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * R language extractor (#828).
 *
 * R has no declaration syntax — everything is an expression, so every symbol
 * the graph needs arrives through the visitNode hook rather than node-type
 * lists:
 *
 *   - functions:   `name <- function(x) …` / `name = function(x) …` parse as
 *                  binary_operator(lhs: identifier, rhs: function_definition).
 *                  (`function(x) … -> name` right-assign of a function does
 *                  not survive the grammar's precedence — the `->` binds inside
 *                  the body — and the style is rare; deliberate gap.)
 *   - variables:   top-level assignments only (locals would bloat the graph);
 *                  ALL_CAPS / dotted-caps names extract as constants.
 *   - imports:     `library(x)` / `require(x)` / `requireNamespace("x")` are
 *                  ordinary calls; `source("file.R")` references another file.
 *                  All are claimed so no noise call-edge to `library` remains
 *                  (same pattern as Lua's `require`).
 *   - classes:     S4 `setClass("Name", …)`, R5 `setRefClass("Name", …)`, and
 *                  R6 `R6Class("Name", public = list(m = function() …))` are
 *                  calls too; the class node is named by the first string
 *                  argument and `name = function` entries in its list() args
 *                  extract as methods inside the class scope.
 *   - S4 generics: `setGeneric("name", …)` / `setMethod("name", "Class", fn)`
 *                  extract as functions named by the first string argument.
 *
 * Calls themselves go through the generic call extraction (`call` nodes with a
 * `function` field). Namespaced `pkg::fn(…)` keeps its qualified text;
 * `obj$method(…)` extracts under its full text (resolution of `$`-dispatch is
 * a known gap — R's S3 dispatch is runtime by design).
 */

const ASSIGN_LEFT = new Set(['<-', '<<-', '=']);
const ASSIGN_RIGHT = new Set(['->', '->>']);
const IMPORT_FNS = new Set(['library', 'require', 'requireNamespace', 'loadNamespace']);
const CLASS_FNS = new Set(['setClass', 'setRefClass', 'R6Class', 'ggproto']);
const GENERIC_FNS = new Set(['setGeneric', 'setMethod']);
/** ALL_CAPS or DOTTED.CAPS top-level assignment → constant. */
const CONSTANT_NAME = /^[A-Z][A-Z0-9._]*$/;

/** The call's callee name when it is a bare identifier or `pkg::fn` (→ `fn`). */
function calleeName(call: SyntaxNode, source: string): string | null {
  const fn = getChildByField(call, 'function');
  if (!fn) return null;
  if (fn.type === 'identifier') return getNodeText(fn, source);
  if (fn.type === 'namespace_operator') {
    const rhs = getChildByField(fn, 'rhs');
    if (rhs) return getNodeText(rhs, source);
  }
  return null;
}

/** First positional argument's value node of a call. */
function firstArgValue(call: SyntaxNode): SyntaxNode | null {
  const args = getChildByField(call, 'arguments');
  if (!args) return null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'argument') continue;
    return getChildByField(arg, 'value');
  }
  return null;
}

/** Text of a string node's content, or an identifier's text. */
function literalOrIdentifier(node: SyntaxNode | null, source: string): string | null {
  if (!node) return null;
  if (node.type === 'identifier') return getNodeText(node, source);
  if (node.type === 'string') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c?.type === 'string_content') return getNodeText(c, source);
    }
    return ''; // empty string literal
  }
  return null;
}

/** Emit one `name = function(…)` argument entry as a method in the current scope. */
function emitMethodArg(entry: SyntaxNode, ctx: ExtractorContext): void {
  const entryName = getChildByField(entry, 'name');
  const entryValue = getChildByField(entry, 'value');
  if (!entryName || entryValue?.type !== 'function_definition') return;
  const params = getChildByField(entryValue, 'parameters');
  const method = ctx.createNode('method', getNodeText(entryName, ctx.source), entry, {
    signature: params ? getNodeText(params, ctx.source) : undefined,
  });
  const body = getChildByField(entryValue, 'body');
  if (method && body) {
    ctx.pushScope(method.id);
    ctx.visitNode(body); // hook-aware walk — see the function-assignment note below
    ctx.popScope();
  }
}

/**
 * Extract a class call's methods. Two shapes:
 *  - inside list() arguments — R5 `methods = list(deposit = function(x) …)`,
 *    R6 `public = list(…)` / `private = list(…)`;
 *  - DIRECT named function arguments — ggproto's style:
 *    `ggproto("GeomPoint", Geom, draw_panel = function(…) …)`.
 * Also records the parent class as an `extends` reference: ggproto's second
 * positional identifier argument, R6's `inherit = Parent`, S4's
 * `contains = "Parent"`.
 */
function extractClassMembers(classCall: SyntaxNode, classId: string, ctx: ExtractorContext): void {
  const args = getChildByField(classCall, 'arguments');
  if (!args) return;
  let positional = 0;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg?.type !== 'argument') continue;
    const argName = getChildByField(arg, 'name');
    const value = getChildByField(arg, 'value');
    if (!argName) {
      positional++;
      // ggproto("Name", Parent, …) — the 2nd positional identifier is the parent.
      if (positional === 2 && value?.type === 'identifier') {
        ctx.addUnresolvedReference({
          fromNodeId: classId,
          referenceName: getNodeText(value, ctx.source),
          referenceKind: 'extends',
          line: value.startPosition.row + 1,
          column: value.startPosition.column,
        });
      }
      continue;
    }
    const argNameText = getNodeText(argName, ctx.source);
    // R6 `inherit = Parent` / S4 `contains = "Parent"`.
    if ((argNameText === 'inherit' || argNameText === 'contains') && value) {
      const parent = literalOrIdentifier(value, ctx.source);
      if (parent) {
        ctx.addUnresolvedReference({
          fromNodeId: classId,
          referenceName: parent,
          referenceKind: 'extends',
          line: value.startPosition.row + 1,
          column: value.startPosition.column,
        });
      }
      continue;
    }
    // Direct named function argument (ggproto methods).
    if (value?.type === 'function_definition') {
      emitMethodArg(arg, ctx);
      continue;
    }
    // list(…) of named function arguments (R5/R6 methods).
    if (value?.type === 'call' && calleeName(value, ctx.source) === 'list') {
      const listArgs = getChildByField(value, 'arguments');
      if (!listArgs) continue;
      for (let j = 0; j < listArgs.namedChildCount; j++) {
        const entry = listArgs.namedChild(j);
        if (entry?.type === 'argument') emitMethodArg(entry, ctx);
      }
    }
  }
}

export const rExtractor: LanguageExtractor = {
  functionTypes: [], // named functions are assignments — handled in visitNode
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [], // library()/require()/source() are calls — handled in visitNode
  callTypes: ['call'],
  variableTypes: [], // top-level assignments — handled in visitNode
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    const source = ctx.source;

    if (node.type === 'call') {
      const fname = calleeName(node, source);
      if (!fname) return false;

      // library(dplyr) / require(stats) / requireNamespace("jsonlite") —
      // and source("helpers.R"), which references another file in the project.
      if (IMPORT_FNS.has(fname) || fname === 'source') {
        const mod = literalOrIdentifier(firstArgValue(node), source);
        if (!mod) return true; // dynamic argument — nothing to record, still not a call edge
        const imp = ctx.createNode('import', mod, node, {
          signature: getNodeText(node, source).trim().slice(0, 100),
        });
        if (imp && ctx.nodeStack.length > 0) {
          const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
          if (parentId) {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: mod,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return true;
      }

      // setClass("Patient", …) / setRefClass("Account", …) / R6Class("Stack", …)
      if (CLASS_FNS.has(fname)) {
        const name = literalOrIdentifier(firstArgValue(node), source);
        if (!name) return false;
        const cls = ctx.createNode('class', name, node, {});
        if (cls) {
          ctx.pushScope(cls.id);
          extractClassMembers(node, cls.id, ctx);
          ctx.popScope();
        }
        return true;
      }

      // setGeneric("describe", …) / setMethod("describe", "Patient", function(obj) …)
      if (GENERIC_FNS.has(fname)) {
        const name = literalOrIdentifier(firstArgValue(node), source);
        if (!name) return false;
        // The implementing function_definition, when present (setMethod always,
        // setGeneric usually via the def= argument).
        const args = getChildByField(node, 'arguments');
        let impl: SyntaxNode | null = null;
        if (args) {
          for (let i = 0; i < args.namedChildCount; i++) {
            const v = args.namedChild(i)?.type === 'argument'
              ? getChildByField(args.namedChild(i)!, 'value') : null;
            if (v?.type === 'function_definition') { impl = v; break; }
          }
        }
        const params = impl ? getChildByField(impl, 'parameters') : null;
        const fn = ctx.createNode('function', name, node, {
          signature: params ? getNodeText(params, source) : undefined,
        });
        const body = impl ? getChildByField(impl, 'body') : null;
        if (fn && body) {
          ctx.pushScope(fn.id);
          ctx.visitNode(body); // hook-aware walk — see the function-assignment note below
          ctx.popScope();
        }
        return true;
      }

      return false; // ordinary call — generic extraction records the edge
    }

    if (node.type === 'binary_operator') {
      const op = node.childForFieldName('operator')?.text;
      if (!op) return false;
      const lhs = getChildByField(node, 'lhs');
      const rhs = getChildByField(node, 'rhs');

      // name <- function(…) / name = function(…)   (any scope — nested
      // functions extract inside their enclosing function's scope). The body
      // is walked through ctx.visitNode, NOT ctx.visitFunctionBody: the body
      // walker doesn't consult this hook, and in R every nested definition is
      // an assignment expression that only this hook can recognize. visitNode
      // dispatches calls and the hook alike, with the function on the scope
      // stack so attribution is right.
      if (ASSIGN_LEFT.has(op) && lhs?.type === 'identifier' && rhs?.type === 'function_definition') {
        const params = getChildByField(rhs, 'parameters');
        const fn = ctx.createNode('function', getNodeText(lhs, source), node, {
          signature: params ? getNodeText(params, source) : undefined,
        });
        const body = getChildByField(rhs, 'body');
        if (fn && body) {
          ctx.pushScope(fn.id);
          ctx.visitNode(body);
          ctx.popScope();
        }
        return true;
      }

      // Top-level value assignments → variable/constant. Locals are skipped
      // deliberately (graph bloat); the initializer is still visited so its
      // calls and nested definitions extract.
      const topLevel = node.parent?.type === 'program';
      if (topLevel && ASSIGN_LEFT.has(op) && lhs?.type === 'identifier' && rhs) {
        // `Account <- setRefClass("Account", …)` is the CLASS definition idiom
        // (same for R6Class / setClass / setGeneric) — the call hook makes the
        // class/function node; a twin variable node would just be noise.
        const rhsCallee = rhs.type === 'call' ? calleeName(rhs, source) : null;
        if (!rhsCallee || (!CLASS_FNS.has(rhsCallee) && !GENERIC_FNS.has(rhsCallee))) {
          const name = getNodeText(lhs, source);
          ctx.createNode(CONSTANT_NAME.test(name) ? 'constant' : 'variable', name, node, {});
        }
        ctx.visitNode(rhs);
        return true;
      }
      // value -> name / value ->> name (right assign)
      if (topLevel && ASSIGN_RIGHT.has(op) && rhs?.type === 'identifier' && lhs) {
        const name = getNodeText(rhs, source);
        ctx.createNode(CONSTANT_NAME.test(name) ? 'constant' : 'variable', name, node, {});
        ctx.visitNode(lhs);
        return true;
      }

      return false;
    }

    return false;
  },
};
