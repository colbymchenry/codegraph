import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Solidity extractor — tree-sitter-solidity (ABI 14).
 *
 * Solidity has multiple top-level "contract-like" containers (contract /
 * interface / library) and several callable forms that don't have a `name:`
 * field (constructor, fallback, receive). We map:
 *   - contract_declaration  → class      (also library_declaration)
 *   - interface_declaration → interface
 *   - struct_declaration    → struct
 *   - enum_declaration      → enum       (enum_value is the bare ident — no
 *                                         name field, so handled in visitNode)
 *   - function_definition / modifier_definition  → function|method
 *   - constructor_definition / fallback_receive_definition  → method (synthetic
 *     name: "constructor" / "fallback" / "receive" — these are nameless in AST)
 *   - state_variable_declaration / struct_member → field (inside contract/struct)
 *   - event_definition / error_declaration       → field-shaped node carrying
 *     the event/error name so callers/refs can resolve emit X / revert X
 *   - import_directive → import
 *   - call_expression / emit_statement / revert_statement / modifier_invocation
 *     → calls (the latter three are call-shaped but use distinct AST nodes)
 */

function getInheritanceAncestors(node: SyntaxNode, source: string): string[] {
  const ancestors: string[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type !== 'inheritance_specifier') continue;
    const ancestor = getChildByField(child, 'ancestor');
    if (!ancestor) continue;
    // ancestor is user_defined_type → contains identifier (or scoped path)
    const id = ancestor.descendantsOfType('identifier');
    if (id.length > 0) {
      const last = id[id.length - 1]!;
      ancestors.push(getNodeText(last, source));
    }
  }
  return ancestors;
}

function fallbackReceiveName(node: SyntaxNode): string {
  // tree-sitter-solidity reuses one node type for both `fallback() ...` and
  // `receive() ...` — the keyword is an unnamed/anonymous child. Walk all
  // children (named + unnamed) and pick the first whose text is one of these.
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (!child) continue;
    const t = child.text;
    if (t === 'fallback' || t === 'receive') return t;
  }
  return 'fallback';
}

export const solidityExtractor: LanguageExtractor = {
  // Free functions (file-level) AND methods inside contracts use the same
  // function_definition node — the dispatcher routes by isInsideClassLikeNode.
  functionTypes: ['function_definition', 'modifier_definition'],
  classTypes: ['contract_declaration', 'library_declaration'],
  methodTypes: [
    'function_definition',
    'modifier_definition',
    'constructor_definition',
    'fallback_receive_definition',
  ],
  interfaceTypes: ['interface_declaration'],
  structTypes: ['struct_declaration'],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: [], // enum_value has no name field; handled in visitNode
  typeAliasTypes: ['user_defined_type_definition'],
  importTypes: ['import_directive'],
  // emit / revert / modifier_invocation are call-shaped but distinct AST nodes
  callTypes: ['call_expression', 'emit_statement', 'revert_statement', 'modifier_invocation'],
  // top-level state vars are file-scope constants/variables; struct_member
  // and state_variable_declaration inside a contract are fields (handled via
  // fieldTypes + isInsideClassLikeNode).
  variableTypes: ['state_variable_declaration', 'constant_variable_declaration'],
  fieldTypes: ['state_variable_declaration', 'struct_member'],

  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',

  // constructor / fallback / receive have no `name:` field — synthesize one.
  resolveName: (node, _source) => {
    if (node.type === 'constructor_definition') return 'constructor';
    if (node.type === 'fallback_receive_definition') return fallbackReceiveName(node);
    return undefined;
  },

  getSignature: (node, source) => {
    // tree-sitter-solidity does NOT wrap params in a `parameters:` field — each
    // `parameter` node is a direct child of function/modifier/constructor. We
    // reconstruct `(t1 a, t2 b)` by walking those siblings; getChildByField
    // would return null and lose the entire param list.
    const params: string[] = [];
    let returnType: SyntaxNode | undefined;
    let visibility: SyntaxNode | undefined;
    let mutability: SyntaxNode | undefined;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      const fieldName = node.fieldNameForNamedChild(i);
      if (child.type === 'parameter' && fieldName !== 'return_type') {
        params.push(getNodeText(child, source));
      } else if (child.type === 'return_type_definition' || fieldName === 'return_type') {
        returnType = child;
      } else if (child.type === 'visibility') {
        visibility = child;
      } else if (child.type === 'state_mutability') {
        mutability = child;
      }
    }

    const parts: string[] = [];
    parts.push(`(${params.join(', ')})`);
    if (visibility) parts.push(getNodeText(visibility, source));
    if (mutability) parts.push(getNodeText(mutability, source));
    if (returnType) parts.push(getNodeText(returnType, source));
    return parts.join(' ');
  },

  getVisibility: (node) => {
    // Solidity functions: public/private/internal/external — `external` maps
    // to 'public' for our purposes (callable from outside the contract).
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type !== 'visibility') continue;
      const t = child.text.trim();
      if (t === 'public' || t === 'external') return 'public';
      if (t === 'private') return 'private';
      if (t === 'internal') return 'internal';
    }
    return undefined;
  },

  // `constant_variable_declaration` is by definition a constant; the generic
  // variable extractor defaults to kind:'variable' otherwise.
  isConst: (node) => node.type === 'constant_variable_declaration',

  visitNode: (node, ctx) => {
    const t = node.type;

    // Solidity inheritance: `contract MyToken is Token, IERC20 { ... }`. The
    // core's extractInheritance walks for `extends_clause`/`base_class_clause`
    // shaped children, which Solidity doesn't have — its `inheritance_specifier`
    // children are direct siblings of the `body:` field. We piggyback on the
    // standard contract/library/interface dispatch (which fires AFTER this
    // hook returns false) by emitting the extends references here, then
    // returning false so the generic class extractor still creates the node.
    // Each ancestor → one `extends` reference; the resolver then upgrades it
    // to a real edge. Without these refs, "what inherits from Ownable" /
    // "trace inherited onlyOwner" can't traverse the contract graph and the
    // agent has to Read each file to reconstruct the hierarchy.
    if (
      t === 'contract_declaration' ||
      t === 'library_declaration' ||
      t === 'interface_declaration'
    ) {
      // Mirror the generic class path — create the node (the extends refs
      // need its id), emit the refs, walk the body — then return true to
      // short-circuit the generic dispatch so nothing is doubled.
      const ancestors = getInheritanceAncestors(node, ctx.source);
      const nameNode = getChildByField(node, 'name');
      const body = getChildByField(node, 'body');
      if (!nameNode) return false;
      const name = getNodeText(nameNode, ctx.source);
      const kind = t === 'interface_declaration' ? 'interface' : 'class';
      const created = ctx.createNode(kind, name, node);
      if (!created) return true;
      // Solidity uses one keyword (`is`) for both class-extends-class and
      // class-implements-interface, indistinguishable at parse time. Emit
      // `extends` for every ancestor — the resolver's interface-impl synthesizer
      // (Phase 5.5) reclassifies a class→interface edge as `implements` based
      // on the target node kind, matching how Java/C# extractors do it.
      for (const ancestor of ancestors) {
        ctx.addUnresolvedReference({
          fromNodeId: created.id,
          referenceName: ancestor,
          referenceKind: 'extends',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      ctx.pushScope(created.id);
      if (body) {
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) ctx.visitNode(child);
        }
      }
      ctx.popScope();
      return true;
    }

    // tree-sitter-solidity puts struct_member / enum_value as DIRECT children
    // of struct_declaration / enum_declaration — there is no `body:` field, so
    // the core's extractStruct/extractEnum (which require a body field) bails.
    // We extract these here, push the parent on the scope stack, walk the
    // direct children, and emit one struct/enum node + its members.
    if (t === 'struct_declaration' || t === 'enum_declaration') {
      const nameNode = getChildByField(node, 'name');
      if (!nameNode) return true;
      const name = getNodeText(nameNode, ctx.source);
      const kind = t === 'struct_declaration' ? 'struct' : 'enum';
      const created = ctx.createNode(kind, name, node);
      if (!created) return true;
      ctx.pushScope(created.id);
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (!child) continue;
        if (child === nameNode) continue;
        ctx.visitNode(child);
      }
      ctx.popScope();
      return true;
    }

    // enum_value is the bare identifier of an enum case — no `name:` field, so
    // the generic enum-member dispatch can't find it. Use the node's own text.
    if (t === 'enum_value') {
      ctx.createNode('enum_member', getNodeText(node, ctx.source), node);
      return true;
    }

    // event SomeEvent(...) — preserve event name as a field-shaped node so
    // `emit SomeEvent(...)` (an emit_statement) can resolve to it. We use
    // `field` kind because Solidity events are member declarations of a
    // contract, similar in spirit to fields, and `field` reuses the FTS index
    // without adding a new NodeKind.
    if (t === 'event_definition') {
      const nameNode = getChildByField(node, 'name');
      if (!nameNode) return true;
      const name = getNodeText(nameNode, ctx.source);
      ctx.createNode('field', name, node, {
        signature: getNodeText(node, ctx.source).trim().slice(0, 200),
      });
      return true;
    }

    // error MyError(...) — same reasoning as event_definition. revert MyError()
    // (a revert_statement) is captured via callTypes and resolves by name.
    if (t === 'error_declaration') {
      const nameNode = getChildByField(node, 'name');
      if (!nameNode) return true;
      const name = getNodeText(nameNode, ctx.source);
      ctx.createNode('field', name, node, {
        signature: getNodeText(node, ctx.source).trim().slice(0, 200),
      });
      return true;
    }

    // struct_member: named field inside a struct. It has `name:` + `type:` —
    // the generic field dispatch handles it via fieldTypes, so no custom code.
    return false;
  },

  // import "X"; / import {A, B} from "X"; / import * as X from "Y";
  // We surface the SOURCE path as the moduleName — that's what
  // import-resolver matches against on disk. The `import_name:` field (if
  // present, for the symbolic-import form) is intentionally ignored here; the
  // SOURCE is the file being imported from.
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    const sourceField = getChildByField(node, 'source');
    if (!sourceField) return null;
    // source is a `string` node — strip quotes via descendantsOfType lookup.
    const stringContent = sourceField.descendantsOfType('string_literal');
    let moduleName: string;
    if (stringContent.length > 0) {
      moduleName = getNodeText(stringContent[0]!, source);
    } else {
      moduleName = getNodeText(sourceField, source);
    }
    moduleName = moduleName.replace(/^["']|["']$/g, '').trim();
    if (!moduleName) return null;
    return { moduleName, signature: importText };
  },
};
