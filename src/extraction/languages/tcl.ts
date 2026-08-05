import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { LanguageExtractor } from '../tree-sitter-types';

// Grammar: tree-sitter-tcl (vendored at src/extraction/wasm/tree-sitter-tcl.wasm,
// built from nicowillis/tree-sitter-tcl, MIT).
//
// Node shapes:
//   procedure: (procedure (simple_word<name>) (arguments ...) (braced_word<body>))
//   namespace:  (namespace (word_list (simple_word<"eval">) (simple_word<nsname>) ...))
//   set:        (set (id<varname>) ...)

export const tclExtractor: LanguageExtractor = {
  classTypes: ['namespace'],
  functionTypes: ['procedure'],
  methodTypes: ['procedure'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  // command is ONLY in callTypes. The engine's else-if chain (importTypes → callTypes)
  // means a type in importTypes never creates call edges — `source` detection is done
  // inside extractImport, leaving call edges for every other command node.
  importTypes: [],
  callTypes: ['command'],
  // 'set' is the grammar's variable assignment node (not 'variable_definition').
  variableTypes: ['set'],
  nameField: '',       // resolveName handles all three shapes
  bodyField: 'body',   // procedure has field('body', ...)
  paramsField: 'arguments', // procedure has field('arguments', ...)

  resolveName(node: SyntaxNode, source: string): string | undefined {
    if (node.type === 'procedure') {
      const child = node.namedChild(0);
      if (child && child.type === 'simple_word')
        return source.substring(child.startIndex, child.endIndex);
    }
    if (node.type === 'namespace') {
      const wl = node.namedChild(0);
      if (wl && wl.type === 'word_list') {
        const name = wl.namedChild(1);
        if (name && name.type === 'simple_word')
          return source.substring(name.startIndex, name.endIndex);
      }
    }
    if (node.type === 'set') {
      const child = node.namedChild(0);
      if (child && child.type === 'id')
        return source.substring(child.startIndex, child.endIndex);
    }
    return undefined;
  },

  getSignature(node: SyntaxNode, source: string): string | undefined {
    const text = source.substring(node.startIndex, node.endIndex);
    const firstLine = (text.split('\n')[0] ?? '').trim();
    return firstLine.length > 120 ? firstLine.substring(0, 120) + '…' : firstLine;
  },

  visitNode(node: SyntaxNode, ctx: import('../tree-sitter-types').ExtractorContext): boolean {
    if (node.type === 'command') {
      const nameChild = node.namedChild(0);
      if (!nameChild) return false;
      const cmd = ctx.source.substring(nameChild.startIndex, nameChild.endIndex);
      if (cmd !== 'source') return false;

      const wl = node.namedChild(1);
      const fileArg = wl?.namedChild(0);
      if (!fileArg) return true;

      const filename = ctx.source
        .substring(fileArg.startIndex, fileArg.endIndex)
        .replace(/^["'{]|['"}\]]+$/g, '');

      ctx.createNode('import', filename, node, { signature: `source ${filename}` });

      const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
      if (parentId && filename) {
        ctx.addUnresolvedReference({
          fromNodeId: parentId,
          referenceName: filename,
          referenceKind: 'imports',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return true;
    }

    if (node.type === 'set') {
      const id = node.namedChild(0);
      if (id && id.type === 'id') {
        const name = ctx.source.substring(id.startIndex, id.endIndex);
        ctx.createNode('variable', name, node, { signature: `set ${name}` });
      }
      // Preserve call extraction from `set` values (default variable extraction would skip children).
      for (let i = 1; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) ctx.visitNode(child);
      }
      return true;
    }

    return false;
  },
    // `source filename` — word list is the second child.
    const wl = node.namedChild(1);
    if (!wl) return null;
    const fileArg = wl.namedChild(0);
    if (!fileArg) return null;
    const filename = source
      .substring(fileArg.startIndex, fileArg.endIndex)
      .replace(/^["'{]|['"}\]]+$/g, '');
    return { moduleName: filename, signature: `source ${filename}` };
  },
};
