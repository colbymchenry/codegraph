import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';

const LANGUAGES = new Set(['javascript', 'jsx', 'typescript', 'tsx', 'arkts', 'vue', 'svelte']);
const owners = new WeakMap<ResolutionContext, Map<string, Map<string, Node>>>();
const scopes = new WeakMap<ResolutionContext, Map<string, { starts: number[]; frames: Int32Array; parents: number[] }>>();

export function clearClassExpressionMemos(context: ResolutionContext): void {
  owners.delete(context);
  scopes.delete(context);
}

/** Named class expressions bind their inner name only inside the expression. */
export function gateClassExpression(
  resolved: ResolvedRef | null, ref: UnresolvedRef, context: ResolutionContext,
): ResolvedRef | null {
  if (!resolved) return resolved;
  const target = context.getNodeById?.(resolved.targetNodeId);
  if (!target || (target.kind !== 'class' && target.kind !== 'method')) return resolved;
  if (!LANGUAGES.has(target.language)) return resolved;
  let files = owners.get(context);
  if (!files) owners.set(context, files = new Map());
  let byId = files.get(target.filePath);
  if (!byId) {
    byId = new Map();
    const nodes = context.getNodesInFile(target.filePath);
    // Only expressions carry a class header in signature. Declarations retain
    // their existing representation, and the marker survives DB round-trips.
    const expressions = nodes.filter(n => n.kind === 'class' && LANGUAGES.has(n.language) && !!n.signature);
    for (const n of nodes) {
      if (n.kind !== 'class' && n.kind !== 'method') continue;
      const owner = expressions.filter(c => encloses(c, n.startLine, n.startColumn) &&
        encloses(c, n.endLine, n.endColumn)).sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
      if (owner) byId.set(n.id, owner);
    }
    files.set(target.filePath, byId);
  }
  const owner = byId.get(target.id);
  if (!owner || (ref.filePath === owner.filePath && encloses(owner, ref.line, ref.column))) return resolved;
  // A proven instance receiver may expose methods of the returned class value;
  // it does not make the expression's inner class name visible to the caller.
  if (target.kind === 'method' && resolved.resolvedBy === 'instance-method' &&
      ref.referenceName.includes('.') && ref.referenceName.split('.')[0] !== owner.name) return resolved;
  // The expression's inner name may share a spelling with a legitimate
  // outer declaration or class-valued constant. Reject the expression, not
  // the independent binding (including when name matching chose it first).
  if (ref.filePath !== owner.filePath || target.kind !== 'class' || ref.referenceName !== owner.name) return null;
  const outer = context.getNodesInFile(ref.filePath).filter(n => n.name === owner.name &&
    ((n.kind === 'class' && !n.signature) || n.kind === 'constant' || n.kind === 'variable') && visible(n, ref, context));
  if (outer.length !== 1) return null;
  return { ...resolved, targetNodeId: outer[0]!.id };
}

/** Brace ancestry is only used to recover an independently indexed binding;
 * it never invents an expression name outside its body. Templates containing
 * executable substitutions stay unsupported by this conservative fallback. */
function visible(node: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  let files = scopes.get(context);
  if (!files) scopes.set(context, files = new Map());
  let source = files.get(ref.filePath);
  if (!source) {
    const text = context.getFileLines?.(ref.filePath)?.join('\n') ?? context.readFile(ref.filePath) ?? '';
    if (text.includes('${')) return false;
    const regex: number[] = [];
    const chars = blankStringContents(stripCommentsForRegex(text, 'javascript'), regex).split('');
    for (let i = 0; i < regex.length; i += 2) for (let at = regex[i]!; at <= regex[i + 1]!; at++) chars[at] = ' ';
    const code = chars.join('');
    const starts = [0], frames = new Int32Array(code.length + 1), parents = [-1];
    let frame = 0;
    for (let i = 0; i < code.length; i++) {
      frames[i] = frame;
      if (code[i] === '{') { parents.push(frame); frame = parents.length - 1; }
      if (code[i] === '}') frame = parents[frame] ?? 0;
      if (code[i] === '\n') starts.push(i + 1);
    }
    source = { starts, frames, parents };
    files.set(ref.filePath, source);
  }
  const bindingAt = (source.starts[node.startLine - 1] ?? 0) + node.startColumn;
  const callAt = (source.starts[ref.line - 1] ?? 0) + ref.column;
  // Preserve block-level TDZ instead of recovering a later declaration.
  if (bindingAt > callAt) return false;
  const bindingFrame = source.frames[bindingAt];
  let callFrame = source.frames[callAt];
  while (callFrame !== undefined && callFrame >= 0) {
    if (callFrame === bindingFrame) return true;
    callFrame = source.parents[callFrame];
  }
  return false;
}

function encloses(node: Node, line: number, column: number): boolean {
  return (line > node.startLine || (line === node.startLine && column >= node.startColumn)) &&
    (line < node.endLine || (line === node.endLine && column <= node.endColumn));
}
