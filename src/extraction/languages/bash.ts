import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const SHELL_SOURCE_COMMANDS = new Set(['source', '.']);
const SHELL_INTERPRETERS = new Set(['bash', 'sh']);
const SHELL_WRAPPER_COMMANDS = new Set(['exec', 'command']);
const SKIP_CALL_COMMANDS = new Set([':', '[', '[[', ']', ']]']);

function commandName(node: SyntaxNode, source: string): string | null {
  const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'command_name');
  if (!nameNode) return null;
  const name = getNodeText(nameNode, source).trim();
  if (!name || /[\s$`{}()[\];"'<>]/.test(name)) return null;
  return name;
}

function commandArguments(node: SyntaxNode): SyntaxNode[] {
  const args: SyntaxNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'command_name' || child.type === 'variable_assignment') continue;
    args.push(child);
  }
  return args;
}

function staticShellWord(node: SyntaxNode, source: string): string | null {
  // A plain `word` is static only when it has no expansion children. Quoted
  // strings are accepted when their content is literal; command/parameter
  // substitutions make the path dynamic and are deliberately skipped.
  if (node.type === 'word') {
    const text = getNodeText(node, source).trim();
    return /[$`{}()[\];"'<>]/.test(text) ? null : text;
  }

  if (node.type === 'raw_string' || node.type === 'string') {
    if (node.namedChildren.some((c) => c.type !== 'string_content')) return null;
    const text = getNodeText(node, source).trim();
    const unquoted = text.replace(/^['"]|['"]$/g, '');
    return /[$`{}()[\];"'<>]/.test(unquoted) ? null : unquoted;
  }

  return null;
}

function isStaticProjectPath(value: string): boolean {
  return (
    (value.startsWith('./') || value.startsWith('../')) &&
    !/[\s{}()[\];"'<>$`]/.test(value)
  );
}

function isScriptPathCommand(name: string): boolean {
  return isStaticProjectPath(name) || /^\.\.?\//.test(name);
}

function emitImport(ctx: ExtractorContext, anchor: SyntaxNode, importPath: string): void {
  if (!isStaticProjectPath(importPath)) return;

  const signature = getNodeText(anchor, ctx.source).trim();
  ctx.createNode('import', importPath, anchor, { signature });

  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: importPath,
    referenceKind: 'imports',
    filePath: ctx.filePath,
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column,
  });
}

function emitCall(ctx: ExtractorContext, anchor: SyntaxNode, name: string): void {
  if (!name || SKIP_CALL_COMMANDS.has(name)) return;
  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: name,
    referenceKind: 'calls',
    filePath: ctx.filePath,
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column,
  });
}

function handleCommand(node: SyntaxNode, ctx: ExtractorContext): void {
  const name = commandName(node, ctx.source);
  if (!name) {
    visitCommandChildren(node, ctx);
    return;
  }

  const args = commandArguments(node);
  const firstArg = args[0] ? staticShellWord(args[0], ctx.source) : null;

  if (SHELL_SOURCE_COMMANDS.has(name)) {
    if (firstArg) emitImport(ctx, node, firstArg);
    visitCommandChildren(node, ctx);
    return;
  }

  // `bash ./script.sh`, `sh ../lib/tool`, and wrapper forms such as
  // `exec ./script.sh` are file dependencies as well as command invocations.
  if (firstArg && (SHELL_INTERPRETERS.has(name) || SHELL_WRAPPER_COMMANDS.has(name))) {
    emitImport(ctx, node, firstArg);
  }
  if (isScriptPathCommand(name)) {
    emitImport(ctx, node, name);
  }

  emitCall(ctx, node, name);
  visitCommandChildren(node, ctx);
}

function visitCommandChildren(node: SyntaxNode, ctx: ExtractorContext): void {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type === 'command_name') continue;
    ctx.visitNode(child);
  }
}

function assignmentName(node: SyntaxNode, source: string): string | null {
  const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'variable_name');
  if (!nameNode) return null;
  const name = getNodeText(nameNode, source).trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function assignmentValue(node: SyntaxNode): SyntaxNode | null {
  return getChildByField(node, 'value') || node.namedChildren.find((c) => c.type !== 'variable_name') || null;
}

function declarationPrefix(node: SyntaxNode, firstAssignment: SyntaxNode | null, source: string): string {
  const end = firstAssignment ? firstAssignment.startIndex : node.endIndex;
  return source.slice(node.startIndex, end);
}

function declarationFlags(prefix: string): { kind: 'variable' | 'constant'; isExported: boolean } {
  const isReadonly = /\breadonly\b/.test(prefix) || /\b(?:declare|typeset|local)\b[\s\S]*?(?:^|\s)-[A-Za-z]*r[A-Za-z]*\b/.test(prefix);
  const isExported = /\bexport\b/.test(prefix) || /\b(?:declare|typeset)\b[\s\S]*?(?:^|\s)-[A-Za-z]*x[A-Za-z]*\b/.test(prefix);
  return { kind: isReadonly ? 'constant' : 'variable', isExported };
}

function createAssignmentNode(
  assignment: SyntaxNode,
  ctx: ExtractorContext,
  kind: 'variable' | 'constant',
  isExported = false
): void {
  const name = assignmentName(assignment, ctx.source);
  if (!name) return;

  const value = assignmentValue(assignment);
  const initValue = value ? getNodeText(value, ctx.source).slice(0, 100) : undefined;
  const signature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

  ctx.createNode(kind, name, assignment, { signature, isExported });

  if (value) ctx.visitNode(value);
}

function handleDeclarationCommand(node: SyntaxNode, ctx: ExtractorContext): void {
  const assignments = node.namedChildren.filter((c) => c.type === 'variable_assignment');
  const prefix = declarationPrefix(node, assignments[0] ?? null, ctx.source);
  const flags = declarationFlags(prefix);

  for (const assignment of assignments) {
    createAssignmentNode(assignment, ctx, flags.kind, flags.isExported);
  }

  // Preserve command substitutions in declaration arguments that are not part of
  // an assignment (rare, but harmless to walk).
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child || child.type === 'variable_assignment') continue;
    ctx.visitNode(child);
  }
}

function handleFunctionDefinition(node: SyntaxNode, ctx: ExtractorContext): boolean {
  const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'word');
  if (!nameNode) return false;

  const name = getNodeText(nameNode, ctx.source).trim();
  if (!name) return false;

  const fn = ctx.createNode('function', name, node, { signature: '()' });
  if (!fn) return true;

  ctx.pushScope(fn.id);
  const body = getChildByField(node, 'body') || node.namedChildren.find((c) => c.type === 'compound_statement');
  if (body) ctx.visitNode(body);
  ctx.popScope();
  return true;
}

export const bashExtractor: LanguageExtractor = {
  functionTypes: ['function_definition'],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: 'body',
  paramsField: '',
  getSignature: () => '()',

  visitNode: (node, ctx) => {
    if (node.type === 'function_definition') {
      return handleFunctionDefinition(node, ctx);
    }

    if (node.type === 'declaration_command') {
      handleDeclarationCommand(node, ctx);
      return true;
    }

    if (node.type === 'variable_assignment') {
      if (node.parent?.type !== 'declaration_command') {
        createAssignmentNode(node, ctx, 'variable');
      }
      return true;
    }

    if (node.type === 'command') {
      handleCommand(node, ctx);
      return true;
    }

    return false;
  },
};
