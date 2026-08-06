import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor } from '../tree-sitter-types';

export const pythonExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: ['class_definition'],
  methodTypes: ['function_definition'], // Methods are functions inside classes
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: ['import_statement', 'import_from_statement'],
  callTypes: ['call'],
  variableTypes: ['assignment'], // Python uses assignment for variable declarations
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',
  returnField: 'return_type',
  getSignature: (node, source) => {
    const params = getChildByField(node, 'parameters');
    const returnType = getChildByField(node, 'return_type');
    if (!params) return undefined;
    let sig = getNodeText(params, source);
    if (returnType) {
      sig += ' -> ' + getNodeText(returnType, source);
    }
    return sig;
  },
  isAsync: (node) => {
    const prev = node.previousSibling;
    return prev?.type === 'async';
  },
  isStatic: (node) => {
    // Check for @staticmethod decorator
    const prev = node.previousNamedSibling;
    if (prev?.type === 'decorator') {
      const text = prev.text;
      return text.includes('staticmethod');
    }
    return false;
  },
  extractImport: (node, source) => {
    const importText = source.substring(node.startIndex, node.endIndex).trim();
    if (node.type === 'import_from_statement') {
      const moduleNode = node.childForFieldName('module_name');
      if (moduleNode) {
        return { moduleName: source.substring(moduleNode.startIndex, moduleNode.endIndex), signature: importText };
      }
    }
    // import_statement creates multiple imports - return null for core fallback
    return null;
  },
  isExported: (node) => {
    // Python has no export syntax — every module- and class-level def/class is
    // importable by name (`from module import _foo` works fine; a leading
    // underscore is only a PEP 8 convention, not an enforcement, and `__all__`
    // only restricts `import *`). The only names actually unreachable from
    // outside the file are ones nested inside a function body (closures).
    // Without this, the extractor left `isExported` unset for every Python
    // symbol, so `findExportedSymbol`'s `byName` index (import-resolver.ts) was
    // always empty for Python — the generic "named import used in a direct
    // call" resolution path silently failed for every Python file. Other
    // Python-specific paths (resolvePythonModuleMember, resolveModuleImportToFile)
    // built their own unfiltered file scans and so masked this everywhere
    // except a directly-called aliased function import
    // (`from mod import fn as alias; alias()`), which has no other resolution
    // path (found on a real project).
    let parent = node.parent;
    while (parent) {
      if (parent.type === 'function_definition') return false;
      parent = parent.parent;
    }
    return true;
  },
};
