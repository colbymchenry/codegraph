import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const pascalExtractor: LanguageExtractor = {
  functionTypes: ['declProc'],
  classTypes: ['declClass'],
  methodTypes: ['declProc'],
  interfaceTypes: ['declIntf'],
  structTypes: [],
  enumTypes: ['declEnum'],
  typeAliasTypes: ['declType'],
  importTypes: ['declUses'],
  callTypes: ['exprCall'],
  variableTypes: ['declField', 'declConst'],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',
  returnField: 'type',
  // Pascal/Delphi `function GetInstance: TBar` — the return type is a `typeref`
  // child. Capture its bare class name for the chained static-factory call
  // mechanism (#750). A procedure (no return) has no typeref → undefined.
  getReturnType: (node, source) => {
    const typeref = node.namedChildren.find((c: SyntaxNode) => c.type === 'typeref');
    if (!typeref) return undefined;
    const id = typeref.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? typeref;
    const name = getNodeText(id, source).trim();
    return /^[A-Za-z_]\w*$/.test(name) ? name : undefined;
  },
  getSignature: (node, source) => {
    const args = getChildByField(node, 'args');
    const returnType = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    if (!args && !returnType) return undefined;
    let sig = '';
    if (args) sig = getNodeText(args, source);
    if (returnType) {
      sig += ': ' + getNodeText(returnType, source);
    }
    return sig || undefined;
  },
  getVisibility: (node) => {
    let current = node.parent;
    while (current) {
      if (current.type === 'declSection') {
        for (let i = 0; i < current.childCount; i++) {
          const child = current.child(i);
          if (child?.type === 'kPublic' || child?.type === 'kPublished')
            return 'public';
          if (child?.type === 'kPrivate') return 'private';
          if (child?.type === 'kProtected') return 'protected';
        }
      }
      current = current.parent;
    }
    return undefined;
  },
  isExported: (_node, _source) => {
    // In Pascal, symbols declared in the interface section are exported
    return false;
  },
  isStatic: (node) => {
    for (let i = 0; i < node.childCount; i++) {
      if (node.child(i)?.type === 'kClass') return true;
    }
    return false;
  },
  isConst: (node) => {
    return node.type === 'declConst';
  },
};
