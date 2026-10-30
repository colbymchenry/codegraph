import * as path from 'path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { getChildByField, getNodeText } from '../tree-sitter-helpers';
import type { ExtractorContext, LanguageExtractor } from '../tree-sitter-types';

const SHELL_SOURCE_COMMANDS = new Set(['source', '.']);
const SHELL_INTERPRETERS = new Set(['bash', 'sh']);
const SHELL_WRAPPER_COMMANDS = new Set(['exec', 'command']);
const SKIP_CALL_COMMANDS = new Set([':', '[', '[[', ']', ']]']);

/**
 * The running script's own path as the script-directory idioms spell it —
 * `$0`, `${BASH_SOURCE[0]}`, `${BASH_SOURCE[0]:-$0}`, … — or that path with
 * symlinks resolved (`$(readlink -f "$0")`, `$(realpath "$0")`), which is where
 * the file sits in the repository.
 */
const SCRIPT_REF = String.raw`(?:\$0|\$\{0\}|\$BASH_SOURCE|\$\{BASH_SOURCE(?:\[0\])?(?::-\$(?:0|\{0\}))?\})`;
const SCRIPT_PATH = String.raw`(?:${SCRIPT_REF}|\$\((?:readlink-[fe]|realpath)${SCRIPT_REF}\))`;
/** `$(dirname "$0")`, `${BASH_SOURCE%/*}`, `${0%/*}`. */
const SCRIPT_DIR = String.raw`(?:\$\(dirname${SCRIPT_PATH}\)|\$\{(?:BASH_SOURCE(?:\[0\])?|0)%/\*\})`;

/**
 * The script's directory in its canonical spellings, matched against
 * `compactExpression` text; group 1 is a `/..` chain inside the `cd`:
 *
 *   $(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)   — also `cd -P`, `/..`, `; pwd`, `pwd -P`
 *   $(cd "${BASH_SOURCE%/*}" && pwd)
 *   $(dirname "$0")   ${BASH_SOURCE%/*}   ${0%/*}
 */
const SCRIPT_DIR_FORMS: readonly RegExp[] = [
  new RegExp(String.raw`^\$\(cd(?:-P)?${SCRIPT_DIR}((?:/\.\.)*)(?:&&|;)pwd(?:-P)?\)$`),
  new RegExp(String.raw`^${SCRIPT_DIR}()$`),
];

/** Bats sets this to the directory of the test file being run. */
const BATS_TEST_DIRNAME = 'BATS_TEST_DIRNAME';

function isBatsFile(filePath: string): boolean {
  return /\.bats$/i.test(filePath);
}

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

/**
 * Shell text reduced to what tells the script-directory idioms apart: no
 * quotes, no `--` end-of-options markers, no output redirects to /dev/null,
 * no whitespace.
 */
function compactExpression(text: string): string {
  return text
    .replace(/"/g, '')
    .replace(/(^|\s)--(?=\s)/g, '$1')
    .replace(/\s*(?:[12]|&)?>>?\s*\/dev\/null/g, '')
    .replace(/\s*[12]>&[12]/g, '')
    .replace(/\s+/g, '');
}

/** The `/..` chain a script-directory expression climbs, or null when it is not one. */
function matchScriptDirectory(compact: string): string | null {
  for (const form of SCRIPT_DIR_FORMS) {
    const match = form.exec(compact);
    if (match) return match[1] ?? '';
  }
  return null;
}

/**
 * The value `name` holds at `use`, when the last assignment to it before
 * `use` sits at the top level of the script (bare, or under
 * export/readonly/declare). One inside a function, a branch or a loop, or an
 * appending `+=`, makes the value depend on what ran — nothing is assumed.
 */
function topLevelValueAt(name: string, use: SyntaxNode, ctx: ExtractorContext): string | null {
  let root = use;
  while (root.parent) root = root.parent;
  let last: SyntaxNode | null = null;
  for (const assignment of root.descendantsOfType('variable_assignment', root.startPosition, use.startPosition)) {
    if (!assignment || assignment.startIndex >= use.startIndex) continue;
    if (assignmentName(assignment, ctx.source) === name) last = assignment;
  }
  if (!last) return null;
  const statement = last.parent?.type === 'declaration_command' ? last.parent : last;
  if (statement.parent?.type !== 'program') return null;
  const value = assignmentValue(last);
  if (!value || ctx.source.slice(last.startIndex, value.startIndex).includes('+=')) return null;
  return getNodeText(value, ctx.source);
}

/** The `/..` chain of a script-directory expression, read directly or through a variable. */
function scriptDirectoryOf(head: SyntaxNode, ctx: ExtractorContext): string | null {
  const compact = compactExpression(getNodeText(head, ctx.source));
  const variable = /^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/.exec(compact);
  if (!variable) return matchScriptDirectory(compact);
  const name = variable[1] ?? variable[2]!;
  if (name === BATS_TEST_DIRNAME && isBatsFile(ctx.filePath)) return '';
  const value = topLevelValueAt(name, head, ctx);
  return value === null ? null : matchScriptDirectory(compactExpression(value));
}

/**
 * A path anchored to the script's own directory — `"$DIR/lib.sh"` where `DIR`
 * holds a canonical script-directory value, `"$(dirname "$0")/lib.sh"`,
 * `"${BASH_SOURCE%/*}/lib.sh"` — as a project-relative path. Unlike a literal
 * `./lib.sh` it does not depend on the directory the script is run from, so
 * the resolver takes it as-is. Null for anything else, or a path that leaves
 * the project.
 */
function scriptRelativePath(arg: SyntaxNode, ctx: ExtractorContext): string | null {
  if (arg.type !== 'string' && arg.type !== 'concatenation') return null;
  const head = arg.namedChildren[0];
  if (!head) return null;
  const rest = ctx.source.slice(head.endIndex, arg.endIndex).replace(/"/g, '');
  if (!/^\/[\w./-]+$/.test(rest)) return null;
  const up = scriptDirectoryOf(head, ctx);
  if (up === null) return null;
  const scriptDir = path.posix.dirname(ctx.filePath.replace(/\\/g, '/'));
  const target = path.posix.join(scriptDir, `.${up}${rest}`);
  return target === '..' || target.startsWith('../') ? null : target;
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

/**
 * An `import` node named as the script writes the path, and the file
 * reference the resolver follows: a literal `./x` as written (it depends on
 * the working directory), a script-anchored path already made project-relative.
 */
function emitImport(ctx: ExtractorContext, anchor: SyntaxNode, written: string, target: string): void {
  const signature = getNodeText(anchor, ctx.source).trim();
  ctx.createNode('import', written, anchor, { signature });

  const fromNodeId = ctx.nodeStack[ctx.nodeStack.length - 1];
  if (!fromNodeId) return;
  ctx.addUnresolvedReference({
    fromNodeId,
    referenceName: target,
    referenceKind: 'imports',
    filePath: ctx.filePath,
    line: anchor.startPosition.row + 1,
    column: anchor.startPosition.column,
  });
}

/** The file a command's path argument names — a static `./x`, or one anchored to the script's directory. */
function emitPathImport(ctx: ExtractorContext, anchor: SyntaxNode, arg: SyntaxNode | undefined): void {
  if (!arg) return;
  const literal = staticShellWord(arg, ctx.source);
  if (literal !== null) {
    if (isStaticProjectPath(literal)) emitImport(ctx, anchor, literal, literal);
    return;
  }
  const anchored = scriptRelativePath(arg, ctx);
  if (anchored) emitImport(ctx, anchor, unquote(getNodeText(arg, ctx.source)), anchored);
}

/** A shell word without the quotes around the whole of it, as a path reads. */
function unquote(text: string): string {
  return text.replace(/^(['"])([\s\S]*)\1$/, '$2');
}

/**
 * What a Bats `load name` sources: `name.bash` in the test file's directory
 * (a name already ending in `.bash` or `.sh` as-is), so a script-anchored
 * path. `load "$BATS_TEST_DIRNAME/name"` is the same file spelled out.
 */
function batsLoadPath(arg: SyntaxNode, ctx: ExtractorContext): string | null {
  const literal = staticShellWord(arg, ctx.source);
  let target: string | null;
  if (literal !== null) {
    if (literal.startsWith('/') || !/^[\w./-]+$/.test(literal)) return null;
    target = path.posix.join(path.posix.dirname(ctx.filePath.replace(/\\/g, '/')), literal);
  } else {
    target = scriptRelativePath(arg, ctx);
  }
  if (!target || target === '..' || target.startsWith('../')) return null;
  return /\.(?:bash|sh)$/.test(target) ? target : `${target}.bash`;
}

/** The description of a Bats `@test "…" {` header, or null for any other statement. */
function batsTestName(statement: SyntaxNode, source: string): string | null {
  if (statement.type !== 'command') return null;
  const parts = statement.namedChildren;
  if (parts.length < 3 || getNodeText(parts[0]!, source) !== '@test') return null;
  if (getNodeText(parts[parts.length - 1]!, source) !== '{') return null;
  const description = parts.slice(1, -1)
    .map((part) => unquote(getNodeText(part, source)))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return description || null;
}

function isClosingBrace(statement: SyntaxNode, source: string): boolean {
  return statement.type === 'command' && getNodeText(statement, source).trim() === '}';
}

/**
 * A Bats test file. `@test "name" { … }` is not shell syntax — the grammar
 * reads the header as a command ending in `{` and the body as top-level
 * statements up to a lone `}` — so each test becomes a function named for its
 * description, and what it calls belongs to that test, not to the file.
 */
function visitBatsProgram(program: SyntaxNode, ctx: ExtractorContext): void {
  const statements = program.namedChildren;
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!;
    const name = batsTestName(statement, ctx.source);
    let close = i + 1;
    while (name !== null && close < statements.length && !isClosingBrace(statements[close]!, ctx.source)) close++;
    if (name === null || close >= statements.length) {
      ctx.visitNode(statement);
      continue;
    }
    const end = statements[close]!;
    const test = ctx.createNode('function', name, statement, {
      signature: '()',
      endLine: end.endPosition.row + 1,
      endColumn: end.endPosition.column,
    });
    if (test) ctx.pushScope(test.id);
    for (let j = i + 1; j < close; j++) ctx.visitNode(statements[j]!);
    if (test) ctx.popScope();
    i = close;
  }
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
    // `"$DIR/build.sh" args` runs a script anchored to this one's directory.
    const nameNode = getChildByField(node, 'name') || node.namedChildren.find((c) => c.type === 'command_name');
    emitPathImport(ctx, node, nameNode?.namedChildren[0]);
    visitCommandChildren(node, ctx);
    return;
  }

  const args = commandArguments(node);

  if (SHELL_SOURCE_COMMANDS.has(name)) {
    emitPathImport(ctx, node, args[0]);
    visitCommandChildren(node, ctx);
    return;
  }

  if (name === 'load' && isBatsFile(ctx.filePath)) {
    const target = args[0] && batsLoadPath(args[0], ctx);
    if (target) emitImport(ctx, node, unquote(getNodeText(args[0]!, ctx.source)), target);
    visitCommandChildren(node, ctx);
    return;
  }

  // `bash ./script.sh`, `sh ../lib/tool`, and wrapper forms such as
  // `exec ./script.sh` are file dependencies as well as command invocations.
  if (SHELL_INTERPRETERS.has(name) || SHELL_WRAPPER_COMMANDS.has(name)) {
    emitPathImport(ctx, node, args[0]);
  }
  if (isScriptPathCommand(name)) {
    emitImport(ctx, node, name, name);
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
    if (node.type === 'program' && isBatsFile(ctx.filePath)) {
      visitBatsProgram(node, ctx);
      return true;
    }

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
