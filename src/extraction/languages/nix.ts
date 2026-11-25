import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

function unwrapVariableExpression(node: SyntaxNode): SyntaxNode {
  if (node.type !== 'variable_expression') return node;
  return node.namedChild(0) ?? node;
}

function getCalleeName(node: SyntaxNode, source: string): string | null {
  let current = node;
  while (current.type === 'apply_expression') {
    const funcNode = current.childForFieldName('function') || current.namedChild(0);
    if (!funcNode) break;
    current = funcNode;
  }
  current = unwrapVariableExpression(current);
  if (current.type === 'identifier' || current.type === 'select_expression') {
    return getNodeText(current, source).trim();
  }
  return null;
}

function getDirectCalleeName(node: SyntaxNode, source: string): string | null {
  let funcNode = node.childForFieldName('function') || node.namedChild(0);
  if (!funcNode) return null;
  funcNode = unwrapVariableExpression(funcNode);
  return getNodeText(funcNode, source).trim();
}

function isStaticProjectPath(value: string): boolean {
  return (
    (value.startsWith('./') || value.startsWith('../')) &&
    !/[\s{}()[\];"'<>$]/.test(value)
  );
}

function getStaticImportPath(argNode: SyntaxNode, source: string): string | null {
  let current = argNode;
  while (current.type === 'parenthesized_expression') {
    const inner = current.namedChild(0);
    if (!inner) break;
    current = inner;
  }

  let text = getNodeText(current, source).trim();
  if (
    ((text.startsWith('"') && text.endsWith('"')) ||
      (text.startsWith("'") && text.endsWith("'"))) &&
    text.length >= 2
  ) {
    text = text.slice(1, -1);
  }

  return isStaticProjectPath(text) ? text : null;
}

function isReturnedAttrsetMember(node: SyntaxNode): boolean {
  let current: SyntaxNode | null = node;
  let seenReturnedAttrset = false;

  while (current) {
    const parent: SyntaxNode | null = current.parent;
    if (!parent) break;

    if (parent.type === 'let_expression') {
      const bodyNode = parent.childForFieldName('body') || parent.childForFieldName('expression');
      if (!bodyNode || !bodyNode.equals(current)) return false;
    }

    if (parent.type === 'binding' && !current.equals(node)) return false;
    if (parent.type === 'formal_parameters' || parent.type === 'formals') return false;

    if (
      parent.type === 'attrset' ||
      parent.type === 'rec_attrset' ||
      parent.type === 'attrset_expression' ||
      parent.type === 'rec_attrset_expression'
    ) {
      seenReturnedAttrset = true;
    }

    current = parent;
  }

  return seenReturnedAttrset;
}

function getCurriedParamsAndBody(node: SyntaxNode, source: string): { params: string[]; bodyNode: SyntaxNode | null } {
  const params: string[] = [];
  let current = node;

  while (current.type === 'function_expression' && current.namedChildCount > 0) {
    const bodyNode = current.namedChild(current.namedChildCount - 1);
    if (!bodyNode) break;

    const paramPart = source.substring(current.startIndex, bodyNode.startIndex).trim();
    const paramText = paramPart.endsWith(':') ? paramPart.slice(0, -1).trim() : paramPart;
    if (paramText) params.push(paramText);

    if (bodyNode.type === 'function_expression') {
      current = bodyNode;
    } else {
      return { params, bodyNode };
    }
  }

  return {
    params,
    bodyNode: current.namedChildCount > 0 ? current.namedChild(current.namedChildCount - 1) : null,
  };
}

function formatFunctionSignature(params: string[]): string {
  if (params.length === 0) return '()';
  if (params.length > 1) return params.join(' : ');

  const [param] = params;
  if (!param) return '()';
  return param.startsWith('(') || param.includes('{') || param.includes('@') ? param : `(${param})`;
}

function inheritedAttrs(node: SyntaxNode): SyntaxNode | null {
  return node.namedChildren.find((child) => child.type === 'inherited_attrs') ?? null;
}

/**
 * `callPackage ./pkg.nix { }` and `pkgs.callPackage ../tools/foo { }` — the
 * nixpkgs auto-wiring idiom — reference a file the same way `import` does.
 */
function isCallPackageName(name: string): boolean {
  return (
    name === 'callPackage' ||
    name === 'callPackages' ||
    name.endsWith('.callPackage') ||
    name.endsWith('.callPackages')
  );
}

/** Innermost argument of a curried apply chain: `f a b` → `a`. */
function getFirstApplyArgument(node: SyntaxNode): SyntaxNode | null {
  let inner = node;
  for (;;) {
    const fn = inner.childForFieldName('function') || inner.namedChild(0);
    if (fn && fn.type === 'apply_expression') {
      inner = fn;
      continue;
    }
    break;
  }
  return inner.childForFieldName('argument') || inner.namedChild(1);
}

/** Import node + unresolved `imports` ref for a static project path. */
function emitFileImport(ctx: ExtractorContext, importPath: string, anchorNode: SyntaxNode, source: string): void {
  const impNode = ctx.createNode('import', importPath, anchorNode, {
    signature: getNodeText(anchorNode, source).trim().slice(0, 100),
  });

  if (impNode && ctx.nodeStack.length > 0) {
    const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (fromNodeId) {
      ctx.addUnresolvedReference({
        fromNodeId,
        referenceName: importPath,
        referenceKind: 'imports',
        line: anchorNode.startPosition.row + 1,
        column: anchorNode.startPosition.column,
      });
    }
  }
}

export const nixExtractor: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: '',
  bodyField: '',
  paramsField: '',

  visitNode: (node, ctx) => {
    const { source } = ctx;

    if (node.type === 'binding') {
      const attrpath = node.childForFieldName('attrpath') || node.namedChild(0);
      if (!attrpath) return false;

      const name = getNodeText(attrpath, source).trim();
      if (!name) return false;

      const valueNode = node.childForFieldName('expression') || node.childForFieldName('value') || node.namedChild(1);
      if (!valueNode) return false;

      if (valueNode.type === 'function_expression') {
        const { params, bodyNode } = getCurriedParamsAndBody(valueNode, source);
        const funcNode = ctx.createNode('function', name, node, {
          signature: formatFunctionSignature(params),
          isExported: isReturnedAttrsetMember(node),
        });

        if (funcNode) {
          ctx.pushScope(funcNode.id);
          if (bodyNode) ctx.visitNode(bodyNode);
          ctx.popScope();
        }
      } else {
        const initValue = getNodeText(valueNode, source).slice(0, 100);
        ctx.createNode('variable', name, node, {
          signature: initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined,
          isExported: isReturnedAttrsetMember(node),
        });

        // NixOS/home-manager module lists: `imports = [ ./hardware.nix ../common ]`
        // (and the flake-era `modules = [ ./configuration.nix ]`) reference files
        // without an `import` call. Only literal `path_expression` entries count —
        // variables and interpolations stay dynamic (silent beats wrong).
        const finalSegment = name.split('.').pop();
        if ((finalSegment === 'imports' || finalSegment === 'modules') && valueNode.type === 'list_expression') {
          for (const child of valueNode.namedChildren) {
            if (child.type === 'path_expression') {
              const entryPath = getNodeText(child, source).trim();
              if (isStaticProjectPath(entryPath)) {
                emitFileImport(ctx, entryPath, child, source);
              }
            }
          }
        }

        ctx.visitNode(valueNode);
      }

      return true;
    }

    if (node.type === 'function_expression') {
      const bodyNode = node.namedChild(node.namedChildCount - 1);
      if (bodyNode) ctx.visitNode(bodyNode);
      return true;
    }

    if (node.type === 'inherit' || node.type === 'inherit_from') {
      const attrs = inheritedAttrs(node);
      if (attrs) {
        for (const child of attrs.namedChildren) {
          const name = getNodeText(child, source).trim();
          if (name) {
            ctx.createNode('variable', name, child, {
              isExported: isReturnedAttrsetMember(child),
            });
          }
        }
      }

      for (const child of node.namedChildren) {
        if (child.type !== 'inherited_attrs') ctx.visitNode(child);
      }
      return true;
    }

    if (node.type === 'apply_expression') {
      const directCallee = getDirectCalleeName(node, source);
      const isDirectImport = directCallee === 'import' || directCallee === 'builtins.import';
      // Wrapper objects are re-created per access, so compare with .equals(),
      // never === — otherwise every level of a curried chain (`f a b`)
      // re-emits the same refs.
      const parentFn =
        node.parent?.type === 'apply_expression'
          ? (node.parent.childForFieldName('function') ?? node.parent.namedChild(0))
          : null;
      const isCalleeOfParent = parentFn ? parentFn.equals(node) : false;

      if (!(isCalleeOfParent && !isDirectImport)) {
        if (isDirectImport) {
          const argNode = node.childForFieldName('argument') || node.namedChild(1);
          const importPath = argNode ? getStaticImportPath(argNode, source) : null;

          if (importPath) {
            emitFileImport(ctx, importPath, node, source);
          }
        } else {
          const calleeName = getCalleeName(node, source);
          if (calleeName && calleeName !== 'import' && calleeName !== 'builtins.import' && ctx.nodeStack.length > 0) {
            const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
            if (fromNodeId) {
              ctx.addUnresolvedReference({
                fromNodeId,
                referenceName: calleeName,
                referenceKind: 'calls',
                line: node.startPosition.row + 1,
                column: node.startPosition.column,
              });
            }
          }

          // `callPackage ./pkg.nix { }` loads the file like `import` does; the
          // first argument of the apply chain is the package file. Only a
          // literal static path counts (`callPackage pkgPath { }` stays dynamic).
          if (calleeName && isCallPackageName(calleeName)) {
            const firstArg = getFirstApplyArgument(node);
            const importPath = firstArg ? getStaticImportPath(firstArg, source) : null;
            if (importPath) {
              emitFileImport(ctx, importPath, node, source);
            }
          }
        }
      }

      for (const child of node.namedChildren) {
        ctx.visitNode(child);
      }
      return true;
    }

    return false;
  },
};
