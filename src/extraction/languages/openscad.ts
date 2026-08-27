import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';
import { Node as SyntaxNode } from 'web-tree-sitter';

/** First named child of a given type, or null. Tolerates a partial parse. */
function namedChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

/**
 * OpenSCAD — parametric CAD scripts (`.scad`).
 *
 * Grammar: @openscad/tree-sitter-openscad 0.6.1 (the OpenSCAD org's own),
 * vendored as wasm. Two things about the language shape the mappings here:
 *
 * 1. There are no classes, methods, interfaces, structs, enums or type
 *    aliases — none, not "rarely used". Those mappings stay EMPTY rather than
 *    being approximated with some available construct, so a class query over
 *    an OpenSCAD project returns nothing instead of something misleading.
 *
 * 2. A `module` is a named, parameterised, callable definition whose result is
 *    geometry — structurally a function. Both it and `function` map to the
 *    `function` kind. NOT to the `module` kind, which in CodeGraph means a
 *    file-level module (a Python module, a Kotlin package); reusing it would
 *    collide with a different concept in every cross-language query.
 */
export const openscadExtractor: LanguageExtractor = {
  functionTypes: ['module_item', 'function_item'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['include_statement', 'use_statement'],
  // `translate(…) rotate(…) cube(5);` nests as transform_chain → module_call +
  // transform_chain → …, so the body walker's generic recursion reaches every
  // operator in a chain. A leading `!`/`#`/`%`/`*` is a sibling `modifier`
  // node, not a wrapper, so it cannot hide the call it decorates.
  callTypes: ['module_call', 'function_call'],
  // Deliberately empty: `assignment` is NOT a variable declaration here. The
  // grammar reuses it for default parameter values (`module m(size = 10)`),
  // named call arguments (`cube(center = true)`) and let/for bindings, so
  // mapping it would mint a variable for every named argument in the file. A
  // real top-level declaration is `var_declaration`, whose name sits one level
  // down on the inner assignment — out of reach of the core's generic
  // fallback, so the visitNode hook below owns it.
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    return params ? getNodeText(params, source) : undefined;
  },

  /**
   * `module_item` exposes a `body` field and needs nothing here. A named
   * `function` has no body field at all — `function area(w, h) = w * h;` puts
   * its body in an unnamed expression child. Without this, calls inside a
   * function body (`function total(v) = sum(scale(v));`) produce no edges.
   */
  resolveBody: (node) => {
    if (node.type !== 'function_item') return null;
    const nameNode = getChildByField(node, 'name');
    const paramsNode = getChildByField(node, 'parameters');
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.id === nameNode?.id || child.id === paramsNode?.id) continue;
      return child;
    }
    return null;
  },

  /**
   * `include <path>` / `use <path>`. Neither carries fields; the path is an
   * `include_path` child whose text keeps the angle brackets.
   *
   * The path is recorded VERBATIM and is never joined onto a filesystem path,
   * opened, or resolved. It is attacker-controlled — `include <../../../etc/
   * passwd>` is a legal directive — and OpenSCAD's real search order
   * (OPENSCADPATH, user library dirs, relative to the including file) reaches
   * outside the indexed project, so resolving it safely is its own problem and
   * is deliberately not started here.
   */
  extractImport: (node, source) => {
    const pathNode = namedChildOfType(node, 'include_path');
    if (!pathNode) return null;
    const moduleName = getNodeText(pathNode, source).replace(/^</, '').replace(/>$/, '');
    if (!moduleName) return null;
    return { moduleName, signature: getNodeText(node, source).trim() };
  },

  /**
   * Top-level `x = 5;` parses as var_declaration → assignment(name, value).
   * The core's generic variable fallback only reads direct `identifier`
   * children, so it finds nothing one level down; handling it here keeps the
   * change out of CodeGraph's shared core.
   *
   * A special variable keeps its sigil: `$fn` is a `special_variable` node
   * spanning the `$`, so its text is `$fn` and not `fn`.
   */
  visitNode: (node, ctx) => {
    if (node.type !== 'var_declaration') return false;

    const assignment = namedChildOfType(node, 'assignment');
    if (!assignment) return false; // partial parse — let default dispatch try

    const nameNode = getChildByField(assignment, 'name');
    if (!nameNode) return false;

    const name = getNodeText(nameNode, ctx.source);
    if (!name) return false;

    ctx.createNode('variable', name, node);

    // Keep walking the assigned value: `plate_area = area(2, 3);` must still
    // record the call. Returning true without this would drop those edges.
    const value = getChildByField(assignment, 'value');
    if (value) ctx.visitNode(value);

    return true;
  },
};
