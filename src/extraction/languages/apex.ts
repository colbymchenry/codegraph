import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

/**
 * Salesforce Apex.
 *
 * The tree-sitter-sfapex grammar is modeled on tree-sitter-java, so the node
 * types are nearly identical (class_declaration, method_declaration, superclass,
 * interfaces, enum_constant, ...). This extractor mirrors java.ts; the only
 * Apex-specific addition is `trigger_declaration` — a top-level executable that
 * we treat as a function so its body's method_invocation calls (trigger →
 * handler class) are captured as `calls` edges.
 *
 * Apex has no import/package statements (all classes are globally visible by
 * name), so there's no importTypes/extractPackage. Annotations (@AuraEnabled,
 * @RemoteAction, @InvocableMethod, @isTest) live in a `modifiers` node and are
 * picked up generically as `decorates` references by the core extractor.
 */
export const apexExtractor: LanguageExtractor = {
  // Triggers are top-level executables (not inside a class) → function nodes,
  // body visited for handler calls.
  functionTypes: ['trigger_declaration'],
  classTypes: ['class_declaration'],
  methodTypes: ['method_declaration', 'constructor_declaration'],
  interfaceTypes: ['interface_declaration'],
  structTypes: [],
  enumTypes: ['enum_declaration'],
  enumMemberTypes: ['enum_constant'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['method_invocation'],
  variableTypes: ['local_variable_declaration'],
  // Apex properties are `field_declaration`s carrying an `accessor_list`; the
  // grammar has no dedicated property node, so both fields and properties are
  // extracted as fields.
  fieldTypes: ['field_declaration'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'type',
  getSignature: (node, source) => {
    // trigger AccountTrigger on Account (before insert, after update)
    if (node.type === 'trigger_declaration') {
      const object = getChildByField(node, 'object');
      const events = node.namedChildren
        .filter((c: SyntaxNode) => c.type === 'trigger_event')
        .map((c: SyntaxNode) => getNodeText(c, source).trim());
      const on = object ? `on ${getNodeText(object, source)}` : '';
      return events.length ? `${on} (${events.join(', ')})`.trim() : on || undefined;
    }
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'type');
    if (!params) return undefined;
    const paramsText = getNodeText(params, source);
    return returnType ? getNodeText(returnType, source) + ' ' + paramsText : paramsText;
  },
  getVisibility: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers') {
        const text = child.text;
        // `global` is broader than `public` (cross-namespace) but maps to it here.
        if (text.includes('public') || text.includes('global')) return 'public';
        if (text.includes('private')) return 'private';
        if (text.includes('protected')) return 'protected';
      }
    }
    return undefined;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.type === 'modifiers' && child.text.includes('static')) {
        return true;
      }
    }
    return false;
  },
};
