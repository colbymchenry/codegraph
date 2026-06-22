import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const PATH_LIKE_RE = /(?:^\.?\.?[\\/]|[\\/]|\.ps(?:m|d)?1$)/i;
const COMMAND_PATH_RE = /(?:^\.{1,2}[\\/]|^[\\/]|[/]|\.ps(?:m|d)?1$)/i;

export const powershellExtractor: LanguageExtractor = {
  functionTypes: ['function_statement'],
  classTypes: ['class_statement'],
  methodTypes: ['class_method_definition'],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: ['enum_statement'],
  enumMemberTypes: ['enum_member'],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: ['assignment_expression'],
  propertyTypes: ['class_property_definition'],
  nameField: 'name',
  bodyField: 'script_block_body',
  paramsField: 'parameter_list',
  resolveName: (node, source) => {
    if (node.type === 'function_statement') {
      return childText(node, source, 'function_name');
    }
    if (node.type === 'class_statement' || node.type === 'enum_statement') {
      return childText(node, source, 'simple_name');
    }
    if (node.type === 'class_method_definition') {
      return childText(node, source, 'simple_name');
    }
    if (node.type === 'class_property_definition') {
      const variable = firstChildOfType(node, 'variable');
      return variable ? normalizeVariableName(getNodeText(variable, source)) : undefined;
    }
    if (node.type === 'enum_member') {
      return childText(node, source, 'simple_name');
    }
    return undefined;
  },
  extractPropertyName: (node, source) => {
    const variable = firstChildOfType(node, 'variable');
    return variable ? normalizeVariableName(getNodeText(variable, source)) : null;
  },
  resolveBody: (node) => {
    if (node.type === 'enum_statement') return node;
    const scriptBlock = node.type === 'script_block'
      ? node
      : firstChildOfType(node, 'script_block');
    if (!scriptBlock) return null;
    return getChildByField(scriptBlock, 'script_block_body') ?? scriptBlock;
  },
  getSignature: (node, source) => {
    if (node.type === 'function_statement') {
      const inlineParams = firstChildOfType(node, 'function_parameter_declaration');
      const scriptBlock = firstChildOfType(node, 'script_block');
      const paramBlock = scriptBlock ? firstChildOfType(scriptBlock, 'param_block') : null;
      const params = inlineParams ?? paramBlock;
      return params ? getNodeText(params, source).trim() : undefined;
    }

    if (node.type === 'class_method_definition') {
      const returnType = firstChildOfType(node, 'type_literal');
      const name = childText(node, source, 'simple_name');
      const params = firstChildOfType(node, 'class_method_parameter_list');
      const returnText = returnType ? `${getNodeText(returnType, source).trim()} ` : '';
      const paramText = params ? getNodeText(params, source).trim() : '';
      return name ? `${returnText}${name}(${paramText})` : undefined;
    }

    return undefined;
  },
  getVisibility: (node) => {
    return hasClassAttribute(node, 'hidden') ? 'private' : 'public';
  },
  isStatic: (node) => hasClassAttribute(node, 'static'),
  visitNode: (node, ctx) => {
    if (node.type === 'command') {
      visitPowerShellCommand(node, ctx);
      return true;
    }

    if (node.type === 'invokation_expression') {
      const callee = extractInvocationMethodName(node, ctx.source);
      if (callee) {
        addCallReference(ctx, node, callee);
      }
      return false;
    }

    return false;
  },
};

function visitPowerShellCommand(node: SyntaxNode, ctx: ExtractorContext): void {
  const importPath = extractImportPath(node, ctx.source);
  if (importPath) {
    ctx.createNode('import', importPath, node, {
      signature: getNodeText(node, ctx.source).trim(),
    });
    const parentId = ctx.nodeStack[ctx.nodeStack.length - 1];
    if (parentId) {
      ctx.addUnresolvedReference({
        fromNodeId: parentId,
        referenceName: importPath,
        referenceKind: 'imports',
        filePath: ctx.filePath,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  } else {
    const commandName = extractCommandName(node, ctx.source);
    if (commandName) addCallReference(ctx, node, commandName);
  }

  // Command arguments can contain script blocks (`Where-Object { Test-Thing }`)
  // or nested expressions. The hook consumes the command node, so explicitly walk
  // children that may hold more symbols/calls while skipping the command name
  // token itself to avoid treating it as a nested reference.
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (!child) continue;
    if (child.type === 'command_name' || child.type === 'command_name_expr' || child.type === 'path_command_name') {
      continue;
    }
    ctx.visitFunctionBody(child, '');
  }
}

function addCallReference(ctx: ExtractorContext, node: SyntaxNode, calleeName: string): void {
  const callerId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!callerId) return;
  ctx.addUnresolvedReference({
    fromNodeId: callerId,
    referenceName: calleeName,
    referenceKind: 'calls',
    filePath: ctx.filePath,
    line: node.startPosition.row + 1,
    column: node.startPosition.column,
  });
}

function extractCommandName(node: SyntaxNode, source: string): string | null {
  const commandName = getChildByField(node, 'command_name')
    ?? firstChildOfTypes(node, ['command_name', 'command_name_expr', 'path_command_name']);
  if (!commandName) return null;

  // Dynamic invocation (`& $cmd`, `${module}\Name`) is intentionally left
  // unresolved rather than guessed.
  if (hasDescendantType(commandName, 'variable') || hasDescendantType(commandName, 'sub_expression')) {
    return null;
  }

  let raw = getNodeText(commandName, source).trim();
  raw = stripQuotes(raw);
  if (!raw || raw.startsWith('$')) return null;
  if (COMMAND_PATH_RE.test(raw)) return null;

  // Module-qualified command names (`Module\Get-Thing`) still call the command
  // named by the final segment. The module dependency itself is represented by
  // Import-Module / using module / dot-sourcing edges when statically present.
  const slash = raw.lastIndexOf('\\');
  if (slash >= 0) raw = raw.slice(slash + 1);
  return raw || null;
}

function extractImportPath(node: SyntaxNode, source: string): string | null {
  const text = getNodeText(node, source).trim();
  const words = splitPowerShellWords(text);
  if (words.length === 0) return null;

  if (/^using$/i.test(words[0] ?? '') && /^module$/i.test(words[1] ?? '')) {
    return normalizeImportPath(words[2]);
  }

  if (/^Import-Module$/i.test(words[0] ?? '')) {
    const nameFlag = words.findIndex((w) => /^-Name$/i.test(w));
    if (nameFlag >= 0) return normalizeImportPath(words[nameFlag + 1]);
    const positional = words.slice(1).find((w) => !w.startsWith('-'));
    return normalizeImportPath(positional);
  }

  // Dot-sourcing: `. ./Private/Get-Widget.ps1` loads the target script into the
  // current scope, so model it as an import edge to that file.
  if (words[0] === '.') {
    return normalizeImportPath(words[1]);
  }

  return null;
}

function normalizeImportPath(raw: string | undefined): string | null {
  if (!raw) return null;
  let value = stripQuotes(raw.trim().replace(/[;,]$/, ''));
  if (!value || value.includes('*')) return null;
  value = value.replace(/\\/g, '/');
  value = value.replace(/^\$PSScriptRoot(?=\/|$)/i, '.');
  value = value.replace(/^\$\{PSScriptRoot\}(?=\/|$)/i, '.');
  if (!PATH_LIKE_RE.test(value)) return null;
  return value;
}

function splitPowerShellWords(text: string): string[] {
  const words: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|([^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    words.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return words;
}

function extractInvocationMethodName(node: SyntaxNode, source: string): string | null {
  const member = findLastDescendantOfType(node, 'member_name');
  if (!member) return null;
  const name = getNodeText(member, source).trim();
  if (!name || name.startsWith('$')) return null;
  return name;
}

function childText(node: SyntaxNode, source: string, type: string): string | undefined {
  const child = firstChildOfType(node, type);
  return child ? getNodeText(child, source) : undefined;
}

function normalizeVariableName(text: string): string {
  return text.trim().replace(/^\$\{?/, '').replace(/\}$/, '');
}

function stripQuotes(text: string): string {
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}

function hasClassAttribute(node: SyntaxNode, name: string): boolean {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === 'class_attribute' && child.text.toLowerCase() === name) return true;
  }
  return false;
}

function firstChildOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child?.type === type) return child;
  }
  return null;
}

function firstChildOfTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
  const set = new Set(types);
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && set.has(child.type)) return child;
  }
  return null;
}

function findLastDescendantOfType(node: SyntaxNode, type: string): SyntaxNode | null {
  let found: SyntaxNode | null = null;
  const visit = (n: SyntaxNode): void => {
    if (n.type === type) found = n;
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) visit(child);
    }
  };
  visit(node);
  return found;
}

function hasDescendantType(node: SyntaxNode, type: string): boolean {
  if (node.type === type) return true;
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && hasDescendantType(child, type)) return true;
  }
  return false;
}
