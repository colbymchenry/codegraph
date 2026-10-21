import type { Edge, Language, Node } from '../types';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadGrammarsForLanguages } from '../extraction/grammars';
import { attributesBefore, literalValue, visitSyntax, withSourceTree, type SyntaxNode } from '../graph/source-syntax';
import { enclosingFn, FN_KINDS } from './synth-utils';
import { jsCodeBindsName } from './name-matcher';

const JS_FILES = /\.(?:[cm]?[jt]sx?)$/;
const API_MODULES = new Set(['@tauri-apps/api/core', '@tauri-apps/api/tauri']);
interface Command { node: Node; qualified: string; }
interface Registration { file: string; line: number; qualified: string; }

function appForRust(file: string): string | null {
  const marker = file.indexOf('src-tauri/src/');
  return marker < 0 || (marker > 0 && file[marker - 1] !== '/') ? null : file.slice(0, marker).replace(/\/$/, '');
}
function modulePrefix(file: string): string {
  return file.slice(file.indexOf('src-tauri/src/') + 14).replace(/\.rs$/, '').replace(/(?:^|\/)(?:main|lib|mod)$/, '').split('/').filter(Boolean).join('::');
}
function inlineModules(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'mod_item') { const name = parent.childForFieldName('name')?.text; if (name) names.unshift(name); }
  }
  return names;
}
function qualifiedIn(file: string, node: SyntaxNode, name: string): string {
  if (name.startsWith('crate::')) return name.slice(7);
  return [modulePrefix(file), ...inlineModules(node), name].filter(Boolean).join('::');
}

function handlerCommands(macro: SyntaxNode): string[] {
  const tokenTree = macro.namedChildren.find(child => child.type === 'token_tree');
  if (!tokenTree) return [];
  const commands: string[] = []; let parts: string[] = [];
  const flush = () => { const name = parts.join(''); if (/^(?:crate::)?[A-Za-z_]\w*(?:::[A-Za-z_]\w*)*$/.test(name)) commands.push(name); parts = []; };
  for (const token of tokenTree.children) {
    if (['[', ']', '(', ')', '{', '}'].includes(token.text) || token.type.includes('comment')) continue;
    if (token.text === ',') flush(); else parts.push(token.type === 'identifier' || token.text === 'crate' || token.text === '::' ? token.text : '?');
  }
  flush(); return commands;
}
function isBuilderHandler(macro: SyntaxNode): boolean {
  const args = macro.parent; const call = args?.parent;
  if (args?.type !== 'arguments' || call?.type !== 'call_expression') return false;
  const fn = call.childForFieldName('function');
  if (fn?.type !== 'field_expression' || fn.childForFieldName('field')?.text !== 'invoke_handler') return false;
  const receiver = fn.childForFieldName('value'); let builder = false;
  if (receiver) visitSyntax(receiver, node => {
    if (node.type === 'call_expression' && /^tauri\s*::\s*Builder\s*::\s*default$/.test(node.childForFieldName('function')?.text ?? '')) builder = true;
  });
  return builder;
}

function patternBinds(pattern: SyntaxNode | null, name: string): boolean {
  if (!pattern) return false;
  if (['identifier', 'shorthand_property_identifier_pattern'].includes(pattern.type)) return pattern.text === name;
  if (['required_parameter', 'optional_parameter'].includes(pattern.type)) return patternBinds(pattern.childForFieldName('pattern'), name);
  if (pattern.type === 'assignment_pattern') return patternBinds(pattern.childForFieldName('left'), name);
  if (pattern.type === 'pair_pattern') return patternBinds(pattern.childForFieldName('value'), name);
  if (['formal_parameters', 'object_pattern', 'array_pattern', 'rest_pattern'].includes(pattern.type)) return pattern.namedChildren.some(child => patternBinds(child, name));
  return false;
}
function lexicalShadow(call: SyntaxNode, name: string): boolean {
  for (let scope: SyntaxNode | null = call; scope; scope = scope.parent) {
    if (patternBinds(scope.childForFieldName('parameters'), name) || patternBinds(scope.childForFieldName('parameter'), name)) return true;
    if (!['program', 'statement_block', 'for_statement', 'for_in_statement'].includes(scope.type)) continue;
    for (const entry of scope.namedChildren) {
      const declaration = entry.type === 'export_statement' ? entry.childForFieldName('declaration') : entry;
      if (!declaration) continue;
      if (['function_declaration', 'class_declaration'].includes(declaration.type) && declaration.childForFieldName('name')?.text === name) return true;
      if (['lexical_declaration', 'variable_declaration'].includes(declaration.type) && declaration.namedChildren.some(child => child.type === 'variable_declarator' && patternBinds(child.childForFieldName('name'), name))) return true;
    }
  }
  return false;
}
function callOwner(nodes: readonly Node[], line: number, column: number): Node | null {
  const eligible = nodes.filter(node => FN_KINDS.has(node.kind) && node.startLine <= line && node.endLine >= line
    && (node.startLine !== line || node.startColumn <= column) && (node.endLine !== line || node.endColumn > column))
    .sort((a, b) => a.startLine - b.startLine || a.startColumn - b.startColumn);
  return enclosingFn(eligible, line);
}

export async function tauriCommandEdges(context: ResolutionContext, onYield: MaybeYield): Promise<Edge[]> {
  const rustFiles = context.getAllFiles().filter(file => file.endsWith('.rs') && appForRust(file) !== null);
  if (!rustFiles.length) return [];
  await loadGrammarsForLanguages(['rust']);
  const apps = new Map<string, { commands: Command[]; registrations: Registration[] }>();
  for (const file of rustFiles) {
    await onYield();
    const app = appForRust(file)!;
    if (!apps.has(app)) apps.set(app, { commands: [], registrations: [] });
    const records = apps.get(app)!; const source = context.readFile(file);
    if (!source || !/tauri\s*::\s*(?:command|generate_handler)/.test(source)) continue;
    const nodes = context.getNodesInFile(file);
    withSourceTree(source, 'rust', root => {
      if (root.hasError) return;
      visitSyntax(root, node => {
        if (node.type === 'function_item' && /#\s*\[\s*tauri\s*::\s*command\b/.test(attributesBefore(node))) {
          const name = node.childForFieldName('name')?.text;
          const target = nodes.find(candidate => candidate.kind === 'function' && candidate.name === name && candidate.startLine === node.startPosition.row + 1);
          if (target && name) records.commands.push({ node: target, qualified: qualifiedIn(file, node, name) });
        }
        if (node.type === 'macro_invocation' && /^tauri\s*::\s*generate_handler$/.test(node.childForFieldName('macro')?.text ?? '') && isBuilderHandler(node)) {
          for (const name of handlerCommands(node)) records.registrations.push({ file, line: node.startPosition.row + 1, qualified: qualifiedIn(file, node, name) });
        }
      });
    });
  }
  const registered = new Map<string, Map<string, { command: Command; registration: Registration }[]>>();
  for (const [app, records] of apps) {
    const table = new Map<string, { command: Command; registration: Registration }[]>();
    for (const registration of records.registrations) {
      const candidates = records.commands.filter(command => command.qualified === registration.qualified);
      if (candidates.length !== 1) continue;
      const command = candidates[0]!; const name = command.node.name;
      const entries = table.get(name) ?? [];
      if (!entries.some(entry => entry.command.node.id === command.node.id)) entries.push({ command, registration });
      table.set(name, entries);
    }
    if (table.size) registered.set(app, table);
  }
  if (!registered.size) return [];
  const roots = [...apps.keys()].sort((a, b) => b.length - a.length);
  const edges: Edge[] = []; const seen = new Set<string>();
  for (const file of context.getAllFiles()) {
    if (!JS_FILES.test(file)) continue;
    await onYield();
    const app = roots.find(root => !root || file.startsWith(root + '/'));
    if (app === undefined) continue;
    const source = context.readFile(file);
    if (!source || !source.includes('@tauri-apps/api/')) continue;
    const language: Language = file.endsWith('tsx') ? 'tsx' : file.endsWith('jsx') ? 'jsx' : /\.[cm]?js$/.test(file) ? 'javascript' : 'typescript';
    await loadGrammarsForLanguages([language]);
    const nodes = context.getNodesInFile(file);
    withSourceTree(source, language, root => {
      if (root.hasError) return;
      const direct = new Set<string>(); const namespaces = new Set<string>();
      for (const statement of root.namedChildren) {
        if (statement.type !== 'import_statement' || !API_MODULES.has(literalValue(statement.childForFieldName('source')) ?? '')) continue;
        if (statement.text.startsWith('import type ')) continue;
        visitSyntax(statement, node => {
          if (node.type === 'import_specifier' && node.childForFieldName('name')?.text === 'invoke' && !node.text.startsWith('type ')) direct.add(node.childForFieldName('alias')?.text ?? 'invoke');
          if (node.type === 'namespace_import') { const name = node.namedChildren[0]?.text; if (name) namespaces.add(name); }
        });
      }
      if (!direct.size && !namespaces.size) return;
      visitSyntax(root, call => {
        if (call.type !== 'call_expression') return;
        const fn = call.childForFieldName('function'); let binding: string | undefined;
        if (fn?.type === 'identifier' && direct.has(fn.text)) binding = fn.text;
        if (fn?.type === 'member_expression' && fn.childForFieldName('property')?.text === 'invoke') {
          const object = fn.childForFieldName('object'); if (object?.type === 'identifier' && namespaces.has(object.text)) binding = object.text;
        }
        if (!binding || lexicalShadow(call, binding)) return;
        const key = literalValue(call.childForFieldName('arguments')?.namedChildren[0] ?? null);
        if (!key || key.startsWith('plugin:')) return;
        const targets = registered.get(app)?.get(key); if (targets?.length !== 1) return;
        const line = call.startPosition.row + 1; const column = call.startPosition.column;
        const owner = callOwner(nodes, line, column);
        if (!owner || jsCodeBindsName(binding, owner, file, line, context)) return;
        const target = targets[0]!; const edgeKey = owner.id + '>' + target.command.node.id;
        if (seen.has(edgeKey)) return; seen.add(edgeKey);
        edges.push({ source: owner.id, target: target.command.node.id, kind: 'calls', line, column, provenance: 'heuristic', metadata: { synthesizedBy: 'tauri-command', confidence: 0.95, command: key, registeredAt: target.registration.file + ':' + target.registration.line } });
      });
    });
  }
  return edges;
}
