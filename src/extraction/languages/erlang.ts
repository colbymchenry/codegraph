import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText, getChildByField } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext, ImportInfo } from '../tree-sitter-types';

/**
 * Erlang extraction configuration.
 *
 * The WhatsApp tree-sitter-erlang grammar structures functions as:
 *   fun_decl → function_clause (name, args, body)
 *   where the name/args/body live on the clause, not the fun_decl.
 * Multiple clauses share the fun_decl parent (multi-clause functions).
 * We use visitNode to intercept fun_decl and extract each clause as a
 * function, with the module name as the implicit receiver/namespace.
 */
export const erlangExtractor: LanguageExtractor = {
  functionTypes: ['fun_decl'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: ['record_decl'],
  enumTypes: [],
  typeAliasTypes: ['type_alias', 'opaque'],
  importTypes: ['pp_include', 'pp_include_lib', 'import_attribute'],
  callTypes: ['call'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'args',

  // Erlang's fun_decl wraps function_clause(s); the name is on the clause.
  // visitNode intercepts fun_decl to extract each clause properly.
  visitNode: (node: SyntaxNode, ctx: ExtractorContext): boolean => {
    const nodeType = node.type;

    // .app.src / .app files: top-level tuple {application, Name, [...Props]}.
    // The Erlang tree-sitter grammar parses these as valid Erlang terms.
    // Extract the application name and its dependency list.
    if (nodeType === 'source_file') {
      const firstChild = node.namedChildren[0];
      if (firstChild?.type === 'tuple') {
        const firstAtom = firstChild.namedChildren[0];
        if (firstAtom?.type === 'atom' && getNodeText(firstAtom, ctx.source) === 'application') {
          const nameAtom = firstChild.namedChildren[1];
          if (nameAtom?.type === 'atom') {
            const appName = getNodeText(nameAtom, ctx.source).replace(/^['"]|['"]$/g, '');
            if (appName) {
              ctx.createNode('module', appName, node);
            }
          }
          const propsList = firstChild.namedChildren[2];
          if (propsList?.type === 'list') {
            for (const prop of propsList.namedChildren) {
              if (prop.type !== 'tuple' || prop.namedChildren[0]?.type !== 'atom') continue;
              const key = getNodeText(prop.namedChildren[0], ctx.source);
              if (key === 'applications') {
                const depList = prop.namedChildren[1];
                if (depList?.type === 'list') {
                  for (const dep of depList.namedChildren) {
                    if (dep.type === 'atom') {
                      const depName = getNodeText(dep, ctx.source).replace(/^['"]|['"]$/g, '');
                      if (depName) ctx.createNode('import', depName, dep);
                    }
                  }
                }
              }
            }
          }
          return true;
        }
      }
      return false;
    }

    if (nodeType === 'fun_decl') {
      // fun_decl contains one or more function_clause children
      // (Erlang multi-clause functions). All clauses share the same name.
      // Extract the first clause to get the function name and create a single node.
      const clause = getChildByField(node, 'clause')
        ?? node.namedChildren.find((c: SyntaxNode) => c.type === 'function_clause');

      if (!clause) return true;

      const nameNode = getChildByField(clause, 'name');
      if (!nameNode) return true;

      const name = getNodeText(nameNode, ctx.source).replace(/^['"]|['"]$/g, '');
      if (!name) return true;

      // Build signature from args
      const argsNode = getChildByField(clause, 'args');
      let arity = 0;
      let sig = name;
      if (argsNode) {
        arity = argsNode.namedChildren.filter((c: SyntaxNode) => c.type !== 'comment').length;
        sig += getNodeText(argsNode, ctx.source);
      }
      sig += '/' + arity;

      const fnNode = ctx.createNode('function', name, node, { signature: sig });
      if (!fnNode) return true;

      ctx.pushScope(fnNode.id);

      // Visit all clauses' bodies for calls
      for (const child of node.namedChildren) {
        if (child.type === 'function_clause') {
          const body = getChildByField(child, 'body');
          if (body) {
            ctx.visitFunctionBody(body, fnNode.id);
          }
        }
      }

      ctx.popScope();
      return true;
    }

    if (nodeType === 'module_attribute') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const modName = getNodeText(nameNode, ctx.source).replace(/^['"]|['"]$/g, '');
        if (modName) {
          ctx.createNode('module', modName, node);
        }
      }
      return true;
    }

    if (nodeType === 'record_decl') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const recName = getNodeText(nameNode, ctx.source).replace(/^['"]|['"]$/g, '');
        if (recName) {
          const structNode = ctx.createNode('struct', recName, node);
          if (structNode) {
            ctx.pushScope(structNode.id);
            // Extract fields
            for (const child of node.namedChildren) {
              if (child.type === 'record_field') {
                const fieldName = getChildByField(child, 'name');
                if (fieldName) {
                  const fName = getNodeText(fieldName, ctx.source).replace(/^['"]|['"]$/g, '');
                  if (fName) {
                    ctx.createNode('field', fName, child);
                  }
                }
              }
            }
            ctx.popScope();
          }
        }
      }
      return true;
    }

    if (nodeType === 'type_alias' || nodeType === 'opaque') {
      const nameChild = getChildByField(node, 'name');
      if (nameChild) {
        // type_alias → type_name → atom
        const atomNode = getChildByField(nameChild, 'name') ?? nameChild;
        const tName = getNodeText(atomNode, ctx.source).replace(/^['"]|['"]$/g, '');
        if (tName) {
          ctx.createNode('type_alias', tName, node);
        }
      }
      return true;
    }

    if (nodeType === 'export_attribute') {
      // Create export nodes for each exported function
      for (const child of node.namedChildren) {
        if (child.type === 'fa') {
          const funAtom = getChildByField(child, 'fun');
          const arityNode = getChildByField(child, 'arity');
          if (funAtom) {
            const exportName = getNodeText(funAtom, ctx.source).replace(/^['"]|['"]$/g, '');
            let ariStr = '';
            if (arityNode) {
              const val = getChildByField(arityNode, 'value');
              if (val) ariStr = '/' + getNodeText(val, ctx.source);
            }
            ctx.createNode('export', exportName + ariStr, child);
          }
        }
      }
      return true;
    }

    if (nodeType === 'behaviour_attribute') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const behName = getNodeText(nameNode, ctx.source).replace(/^['"]|['"]$/g, '');
        if (behName) {
          // Find the module node for this file to use as the source
          const modNode = ctx.nodes.find((n) => n.kind === 'module' && n.filePath === ctx.filePath);
          if (modNode) {
            ctx.addUnresolvedReference({
              fromNodeId: modNode.id,
              referenceName: behName,
              referenceKind: 'implements',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }
      return true;
    }

    if (nodeType === 'spec') {
      // Specs are type annotations — extract the fun name for reference
      const funNode = getChildByField(node, 'fun');
      if (funNode) {
        const specName = getNodeText(funNode, ctx.source).replace(/^['"]|['"]$/g, '');
        if (specName) {
          ctx.createNode('constant', '@spec ' + specName, node);
        }
      }
      return true;
    }

    // Handle pp_define (macros) as constants
    if (nodeType === 'pp_define') {
      const lhs = getChildByField(node, 'lhs');
      if (lhs) {
        const macroVar = lhs.namedChildren.find((c: SyntaxNode) => c.type === 'var');
        if (macroVar) {
          const macroName = getNodeText(macroVar, ctx.source);
          if (macroName) {
            ctx.createNode('constant', macroName, node);
          }
        }
      }
      return true;
    }

    return false;
  },

  extractImport: (node: SyntaxNode, source: string): ImportInfo | null => {
    if (node.type === 'pp_include') {
      const fileNode = getChildByField(node, 'file');
      if (fileNode) {
        const filePath = getNodeText(fileNode, source).replace(/^"/, '').replace(/"$/, '');
        return {
          moduleName: filePath,
          signature: getNodeText(node, source),
        };
      }
    }
    if (node.type === 'pp_include_lib') {
      const fileNode = getChildByField(node, 'file');
      if (fileNode) {
        const filePath = getNodeText(fileNode, source).replace(/^"/, '').replace(/"$/, '');
        return {
          moduleName: filePath,
          signature: getNodeText(node, source),
        };
      }
    }
    if (node.type === 'import_attribute') {
      // -import(module, [fun1/1, fun2/2]).
      const modNode = getChildByField(node, 'module');
      if (modNode) {
        const modName = getNodeText(modNode, source).replace(/^['"]|['"]$/g, '');
        return {
          moduleName: modName,
          signature: getNodeText(node, source),
        };
      }
    }
    return null;
  },

  getSignature: (node: SyntaxNode, source: string): string | undefined => {
    // For fun_decl, the signature is built in visitNode, but the generic
    // path may also call this for other node types.
    if (node.type === 'fun_decl') {
      const clause = getChildByField(node, 'clause')
        ?? node.namedChildren.find((c: SyntaxNode) => c.type === 'function_clause');
      if (!clause) return undefined;
      const nameNode = getChildByField(clause, 'name');
      const argsNode = getChildByField(clause, 'args');
      if (!nameNode) return undefined;
      const name = getNodeText(nameNode, source).replace(/^['"]|['"]$/g, '');
      if (argsNode) {
        const arity = argsNode.namedChildren.filter((c: SyntaxNode) => c.type !== 'comment').length;
        return name + '/' + arity;
      }
      return name;
    }
    return undefined;
  },

  resolveName: (node: SyntaxNode, source: string): string | undefined => {
    // Erlang names are atoms (quoted or unquoted)
    if (node.type === 'atom') {
      return getNodeText(node, source).replace(/^['"]|['"]$/g, '');
    }
    return undefined;
  },

  isExported: (node: SyntaxNode, source: string): boolean => {
    // In Erlang, functions listed in -export() are public.
    // We check if the function name appears in any export_attribute ancestor.
    if (node.type !== 'fun_decl') return false;
    const clause = getChildByField(node, 'clause')
      ?? node.namedChildren.find((c: SyntaxNode) => c.type === 'function_clause');
    if (!clause) return false;
    const nameNode = getChildByField(clause, 'name');
    if (!nameNode) return false;
    const fnName = getNodeText(nameNode, source).replace(/^['"]|['"]$/g, '');
    const argsNode = getChildByField(clause, 'args');
    const arity = argsNode ? argsNode.namedChildren.filter((c: SyntaxNode) => c.type !== 'comment').length : 0;

    // Walk siblings to find export_attribute
    const root = node.parent;
    if (!root) return false;
    for (const sibling of root.namedChildren) {
      if (sibling.type === 'export_attribute') {
        for (const fa of sibling.namedChildren) {
          if (fa.type === 'fa') {
            const funAtom = getChildByField(fa, 'fun');
            const arityNode = getChildByField(fa, 'arity');
            if (funAtom) {
              const exportName = getNodeText(funAtom, source).replace(/^['"]|['"]$/g, '');
              let exportArity = 0;
              if (arityNode) {
                const val = getChildByField(arityNode, 'value');
                if (val) exportArity = parseInt(getNodeText(val, source), 10);
              }
              if (exportName === fnName && exportArity === arity) return true;
            }
          }
        }
      }
    }
    return false;
  },
};
