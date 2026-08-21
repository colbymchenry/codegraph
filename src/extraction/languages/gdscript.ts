import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

// GDScript (Godot, tree-sitter-gdscript). A Python-like indentation grammar
// where every `.gd` file is an implicit class — top-level `func`s extract as
// functions, `class X:` inner classes as classes with methods.
//
// Grammar shapes that need care:
// - The var/const family (`variable_statement`, `export_variable_statement`,
//   `onready_variable_statement`, `const_statement`) names its target via a
//   `name`-typed child, NOT `identifier`, so the core's generic variable
//   fallback (which looks for identifier children) can't read them. The
//   visitNode hook creates variable/constant nodes itself, then walks the
//   initializer so calls inside it (`preload(...)`, `Foo.new()`) are captured.
// - `func _init(...)` (constructor_definition) has no name field; resolveName
//   supplies the conventional `_init`.
// - `enumerator` names its identifier via `left`, not `name`.
// - `obj.method(args)` parses as attribute(identifier, attribute_call(...)),
//   so attribute_call joins callTypes; the core's namedChild(0) callee
//   fallback then yields the bare method name (resolution is name-match only,
//   matching how self/this receivers are emitted elsewhere).
// - `signal foo(a, b)` extracts as a property carrying the parameter list, so
//   connect()-heavy scripts expose their signal surface in the graph.
const VARIABLE_NODE_TYPES = new Set([
  'variable_statement',
  'export_variable_statement',
  'onready_variable_statement',
  'const_statement',
]);

export const gdscriptExtractor: LanguageExtractor = {
  functionTypes: ['function_definition', 'constructor_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition', 'constructor_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_definition'],
  enumMemberTypes: ['enumerator'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call', 'attribute_call', 'base_call'],
  variableTypes: [], // handled by the visitNode hook (see above)
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  resolveName: (node, source) => {
    if (node.type === 'constructor_definition') return '_init';
    if (node.type === 'enumerator') {
      const left = getChildByField(node, 'left');
      return left ? getNodeText(left, source) : undefined;
    }
    return undefined;
  },

  // `static` is a named static_keyword CHILD (no field) on function_definition;
  // the var statements carry it via a field, but a child scan covers both.
  isStatic: (node) => node.namedChildren.some((c) => c?.type === 'static_keyword'),

  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    const ret = getChildByField(node, 'return_type');
    if (ret) sig += ' -> ' + getNodeText(ret, source);
    return sig;
  },

  visitNode: (node, ctx) => {
    if (node.type === 'signal_statement') {
      const nameNode = node.childForFieldName('name');
      if (nameNode) {
        const params = node.childForFieldName('parameters');
        ctx.createNode('property', getNodeText(nameNode, ctx.source), node, {
          signature: params ? getNodeText(params, ctx.source) : undefined,
        });
      }
      return true;
    }
    if (VARIABLE_NODE_TYPES.has(node.type)) {
      const nameNode = node.childForFieldName('name');
      const valueNode = node.childForFieldName('value');
      if (nameNode) {
        const typeNode = node.childForFieldName('type');
        const typeSig = typeNode ? `: ${getNodeText(typeNode, ctx.source)}` : '';
        const initValue = valueNode ? getNodeText(valueNode, ctx.source).slice(0, 100) : '';
        const initSig = initValue ? ` = ${initValue}${initValue.length >= 100 ? '...' : ''}` : '';
        ctx.createNode(
          node.type === 'const_statement' ? 'constant' : 'variable',
          getNodeText(nameNode, ctx.source),
          node,
          { signature: (typeSig + initSig).trim() || undefined },
        );
      }
      // Walk the initializer so calls inside it (preload(), Foo.new()) are captured.
      if (valueNode) ctx.visitNode(valueNode);
      return true;
    }
    return false;
  },
};
