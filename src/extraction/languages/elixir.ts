import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getPrecedingDocstring } from '../tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from '../tree-sitter-types';

/**
 * Elixir Language Extractor for CodeGraph
 *
 * Handles:
 * - Modules: `defmodule`, `defprotocol`, `defimpl`
 * - Functions: `def`, `defp`, `defmacro`, `defmacrop` with clause merging and arity (`name/arity`)
 * - Imports & Aliases: `alias`, `import`, `require`, `use` (including multi-alias `alias Foo.{Bar, Baz}`)
 * - Calls: remote calls (`Mod.fn/N`), local calls (`fn/N`), and pipe operator (`|>`) arity adjustments (+1)
 * - Capture references: `&Mod.fn/N`, `&fn/N`
 * - Docstrings: `@doc`, `@moduledoc`
 */

/** Non-function call targets in Elixir that should not be extracted as call edges */
const ELIXIR_CONTROL_KEYWORDS = new Set([
  'defmodule', 'defprotocol', 'defimpl',
  'def', 'defp', 'defmacro', 'defmacrop', 'defstruct', 'defdelegate',
  'alias', 'import', 'require', 'use',
  'if', 'unless', 'case', 'cond', 'with', 'for', 'try', 'receive',
  'quote', 'unquote', 'raise', 'throw', 'fn', 'do', 'end', 'schema',
  'field', 'has_many', 'has_one', 'belongs_to', 'many_to_many',
]);

/** Clause-merge state for adjacent same-name same-arity function clauses */
let lastFnFile = '';
let lastFnName = '';
let lastFnArity = -1;
let lastFnId = '';

/** Helper to extract @doc string preceding a function or @moduledoc inside a module */
function getElixirAttributeDoc(node: SyntaxNode, attr: 'doc' | 'moduledoc'): string | undefined {
  if (attr === 'moduledoc') {
    const doBlock = node.children.find((c) => c.type === 'do_block');
    if (!doBlock) return undefined;
    for (const child of doBlock.namedChildren) {
      if (child.type === 'comment') continue;
      if (child.type === 'unary_operator' && child.children[0]?.text === '@') {
        const op = child.childForFieldName('operand');
        const target = op?.childForFieldName('target')?.text;
        if (target === 'moduledoc') {
          const args = op?.children.find((c) => c.type === 'arguments');
          const str = args?.children.find((c) => c.type === 'string');
          const content = str?.children.find((c) => c.type === 'quoted_content');
          return content?.text.trim() || str?.text.replace(/^["']{1,3}|["']{1,3}$/g, '').trim();
        }
      }
      break;
    }
    return undefined;
  }

  let prev = node.previousNamedSibling;
  while (prev) {
    if (prev.type === 'comment') {
      prev = prev.previousNamedSibling;
      continue;
    }
    if (prev.type === 'unary_operator' && prev.children[0]?.text === '@') {
      const op = prev.childForFieldName('operand');
      const target = op?.childForFieldName('target')?.text;
      if (op && target === attr) {
        const args = op.children.find((c) => c.type === 'arguments');
        const str = args?.children.find((c) => c.type === 'string');
        const content = str?.children.find((c) => c.type === 'quoted_content');
        return content?.text.trim() || str?.text.replace(/^["']{1,3}|["']{1,3}$/g, '').trim();
      }
      if (target === 'spec' || target === 'type' || target === 'opaque') {
        prev = prev.previousNamedSibling;
        continue;
      }
    }
    break;
  }
  return undefined;
}

/** Parse function head from `arguments` node of def/defp/defmacro */
function parseFunctionHead(argsNode: SyntaxNode): {
  name: string;
  arity: number;
  params: string[];
  signatureText: string;
} | null {
  let head = argsNode.namedChildren[0];
  if (!head) return null;

  // Handle `when` guard clause: `def foo(a) when is_integer(a)`
  if (head.type === 'binary_operator') {
    const whenOp = head.children.find((c) => c.type === 'when');
    if (whenOp) {
      head = head.namedChildren[0];
    }
  }
  if (!head) return null;

  let name = '';
  let arity = 0;
  const params: string[] = [];

  if (head.type === 'identifier') {
    name = head.text;
    arity = 0;
  } else if (head.type === 'call') {
    name = head.childForFieldName('target')?.text || '';
    const fnArgs = head.children.find((c) => c.type === 'arguments');
    if (fnArgs) {
      for (const p of fnArgs.namedChildren) {
        if (p.type !== 'comment') {
          arity++;
          // For default args `a \\ 0`, take the parameter name
          if (p.type === 'binary_operator' && p.children.some((c) => c.type === '\\\\')) {
            params.push(p.namedChildren[0]?.text ?? p.text);
          } else {
            params.push(p.text);
          }
        }
      }
    }
  }

  if (!name) return null;
  const signatureText = head.text;
  return { name, arity, params, signatureText };
}

/** Handle `defmodule Foo.Bar do ... end` */
function handleDefmodule(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const args = node.children.find((c) => c.type === 'arguments');
  if (!args) return false;

  const aliasNode = args.namedChildren.find((c) => c.type === 'alias' || c.type === 'identifier');
  if (!aliasNode) return false;

  const moduleName = aliasNode.text;
  const docstring = getElixirAttributeDoc(node, 'moduledoc');

  const moduleNode = ctx.createNode('module', moduleName, node, {
    docstring,
    signature: `defmodule ${moduleName}`,
    isExported: true,
  });
  if (!moduleNode) return false;

  // Ensure qualified name matches module name
  moduleNode.qualifiedName = moduleName;

  ctx.pushScope(moduleNode.id);
  const doBlock = node.children.find((c) => c.type === 'do_block');
  if (doBlock) {
    for (const child of doBlock.namedChildren) {
      ctx.visitNode(child);
    }
  }
  ctx.popScope();
  return true;
}

/** Handle `def`, `defp`, `defmacro`, `defmacrop` */
function handleDef(node: SyntaxNode, ctx: ExtractorContext, isPrivate: boolean): boolean {
  const args = node.children.find((c) => c.type === 'arguments');
  if (!args) return false;

  const head = parseFunctionHead(args);
  if (!head) return false;

  const { name, arity, signatureText } = head;

  // Check for continuation clause of the SAME function (same name AND arity)
  if (ctx.filePath === lastFnFile && name === lastFnName && arity === lastFnArity && lastFnId) {
    for (let i = ctx.nodes.length - 1; i >= 0; i--) {
      const n = ctx.nodes[i];
      if (n && n.id === lastFnId) {
        if (node.endPosition.row + 1 > n.endLine) {
          n.endLine = node.endPosition.row + 1;
        }
        break;
      }
    }
    ctx.pushScope(lastFnId);
    visitFunctionContent(node, ctx, lastFnId);
    ctx.popScope();
    return true;
  }

  const docstring = getElixirAttributeDoc(node, 'doc') ?? getPrecedingDocstring(node, ctx.source);
  const fnNode = ctx.createNode('function', name, node, {
    docstring,
    signature: `${isPrivate ? 'defp' : 'def'} ${signatureText}`,
    visibility: isPrivate ? 'private' : 'public',
    isExported: !isPrivate,
  });

  if (!fnNode) return false;

  // Qualified name in Elixir: `Mod::name/arity`
  fnNode.qualifiedName = `${fnNode.qualifiedName}/${arity}`;

  ctx.pushScope(fnNode.id);
  visitFunctionContent(node, ctx, fnNode.id);
  ctx.popScope();

  lastFnFile = ctx.filePath;
  lastFnName = name;
  lastFnArity = arity;
  lastFnId = fnNode.id;

  return true;
}

/** Visit function body and extract call references */
function visitFunctionContent(node: SyntaxNode, ctx: ExtractorContext, fnId: string): void {
  const doBlock = node.children.find((c) => c.type === 'do_block');
  if (doBlock) {
    extractElixirCallsInBody(doBlock, ctx, fnId);
    return;
  }
  const args = node.children.find((c) => c.type === 'arguments');
  const keywords = args?.children.find((c) => c.type === 'keywords');
  if (keywords) {
    extractElixirCallsInBody(keywords, ctx, fnId);
  }
}

/** Recursively extract calls, remote calls, and pipe chains inside function bodies */
function extractElixirCallsInBody(root: SyntaxNode, ctx: ExtractorContext, fnId: string): void {
  const line = (n: SyntaxNode) => n.startPosition.row + 1;
  const col = (n: SyntaxNode) => n.startPosition.column;

  function walk(node: SyntaxNode): void {
    // Pipe operator: `left |> right`
    if (node.type === 'binary_operator') {
      const isPipe = node.children.some((c) => c.type === '|>');
      if (isPipe) {
        const lhs = node.namedChildren[0];
        const rhs = node.namedChildren[1];

        if (lhs) walk(lhs);

        if (rhs) {
          if (rhs.type === 'call') {
            const target = rhs.childForFieldName('target');
            const args = rhs.children.find((c) => c.type === 'arguments');
            const explicitArgs = args?.namedChildren.filter((c) => c.type !== 'comment').length ?? 0;
            const arity = explicitArgs + 1; // +1 from pipe

            if (target?.type === 'dot') {
              const left = target.namedChildren[0]?.text;
              const right = target.namedChildren[1]?.text;
              if (left && right) {
                ctx.addUnresolvedReference({
                  fromNodeId: fnId,
                  referenceName: `${left}::${right}/${arity}`,
                  referenceKind: 'calls',
                  line: line(target),
                  column: col(target),
                });
              }
            } else if (target?.type === 'identifier' && !ELIXIR_CONTROL_KEYWORDS.has(target.text)) {
              ctx.addUnresolvedReference({
                fromNodeId: fnId,
                referenceName: `${target.text}/${arity}`,
                referenceKind: 'calls',
                line: line(target),
                column: col(target),
              });
            }

            // Walk arguments of the pipe target call as well
            if (args) {
              for (const arg of args.namedChildren) walk(arg);
            }
            return; // Already handled rhs call
          } else if (rhs.type === 'identifier' && !ELIXIR_CONTROL_KEYWORDS.has(rhs.text)) {
            ctx.addUnresolvedReference({
              fromNodeId: fnId,
              referenceName: `${rhs.text}/1`,
              referenceKind: 'calls',
              line: line(rhs),
              column: col(rhs),
            });
            return;
          } else if (rhs.type === 'dot') {
            const left = rhs.namedChildren[0]?.text;
            const right = rhs.namedChildren[1]?.text;
            if (left && right) {
              ctx.addUnresolvedReference({
                fromNodeId: fnId,
                referenceName: `${left}::${right}/1`,
                referenceKind: 'calls',
                line: line(rhs),
                column: col(rhs),
              });
            }
            return;
          }
        }
      }
    }

    // Standard function call
    if (node.type === 'call') {
      const target = node.childForFieldName('target');
      const args = node.children.find((c) => c.type === 'arguments');
      const argCount = args?.namedChildren.filter((c) => c.type !== 'comment').length ?? 0;

      if (target?.type === 'dot') {
        const left = target.namedChildren[0]?.text;
        const right = target.namedChildren[1]?.text;
        if (left && right) {
          ctx.addUnresolvedReference({
            fromNodeId: fnId,
            referenceName: `${left}::${right}/${argCount}`,
            referenceKind: 'calls',
            line: line(target),
            column: col(target),
          });
        }
      } else if (target?.type === 'identifier' && !ELIXIR_CONTROL_KEYWORDS.has(target.text)) {
        ctx.addUnresolvedReference({
          fromNodeId: fnId,
          referenceName: `${target.text}/${argCount}`,
          referenceKind: 'calls',
          line: line(target),
          column: col(target),
        });
      }
    }

    // Function capture reference: `&Mod.fn/2` or `&fn/1`
    if (node.type === 'unary_operator' && node.children[0]?.text === '&') {
      const operand = node.namedChildren[0];
      if (operand?.type === 'binary_operator' && operand.children.some((c) => c.type === '/')) {
        const left = operand.namedChildren[0];
        const right = operand.namedChildren[1];
        const arity = right?.text;
        if (left && arity) {
          if (left.type === 'dot') {
            const mod = left.namedChildren[0]?.text;
            const fn = left.namedChildren[1]?.text;
            if (mod && fn) {
              ctx.addUnresolvedReference({
                fromNodeId: fnId,
                referenceName: `${mod}::${fn}/${arity}`,
                referenceKind: 'references',
                line: line(left),
                column: col(left),
              });
            }
          } else if (left.type === 'identifier') {
            ctx.addUnresolvedReference({
              fromNodeId: fnId,
              referenceName: `${left.text}/${arity}`,
              referenceKind: 'references',
              line: line(left),
              column: col(left),
            });
          }
        }
      }
    }

    for (const child of node.namedChildren) {
      walk(child);
    }
  }

  walk(root);
}

/** Handle `alias`, `import`, `require`, `use` */
function handleDirective(node: SyntaxNode, ctx: ExtractorContext, directive: string): boolean {
  const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!parentId) return true;

  const args = node.children.find((c) => c.type === 'arguments');
  if (!args) return true;

  const line = node.startPosition.row + 1;
  const column = node.startPosition.column;

  for (const child of args.namedChildren) {
    // Multi-alias: `alias Foo.{Bar, Baz}`
    if (child.type === 'dot') {
      const left = child.children.find((c) => c.type === 'alias')?.text;
      const right = child.children.find((c) => c.type === 'tuple');
      if (left && right) {
        for (const item of right.namedChildren) {
          if (item.type === 'alias') {
            ctx.addUnresolvedReference({
              fromNodeId: parentId,
              referenceName: `${left}.${item.text}`,
              referenceKind: 'imports',
              line,
              column,
            });
          }
        }
      }
    } else if (child.type === 'alias') {
      const kind = directive === 'use' ? 'implements' : 'imports';
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: child.text,
        referenceKind: kind,
        line,
        column,
      });
    }
  }

  return true;
}

export const elixirExtractor: LanguageExtractor = {
  functionTypes: [], // Handled in visitNode
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: ['call', 'binary_operator'],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: 'parameters',

  visitNode: (node, ctx) => {
    if (node.type === 'call') {
      const target = node.childForFieldName('target')?.text;
      if (target === 'defmodule' || target === 'defprotocol' || target === 'defimpl') {
        return handleDefmodule(node, ctx);
      }
      if (target === 'def' || target === 'defmacro') {
        return handleDef(node, ctx, false);
      }
      if (target === 'defp' || target === 'defmacrop') {
        return handleDef(node, ctx, true);
      }
      if (target === 'alias' || target === 'import' || target === 'require' || target === 'use') {
        return handleDirective(node, ctx, target);
      }
      // Consume @doc / @spec expressions so they aren't treated as standalone calls
      if (node.parent?.type === 'unary_operator' && node.parent.children[0]?.text === '@') {
        return true;
      }
    }

    if (node.type === 'unary_operator' && node.children[0]?.text === '@') {
      return true; // Attribute consumed
    }

    return false;
  },
};
