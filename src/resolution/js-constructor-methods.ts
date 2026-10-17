import type { Node } from '../types';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';
import { blankStringContents, stripCommentsForRegex } from './strip-comments';

const LANGUAGES = new Set(['javascript', 'jsx', 'typescript', 'tsx', 'arkts']);
const sourceCache = new WeakMap<ResolutionContext, Map<string, { raw: string[]; code?: string[]; comments: string; starts: number[] }>>();
const staticCache = new WeakMap<ResolutionContext, Map<string, boolean>>();
export function clearJsConstructorMemos(context: ResolutionContext): void {
  sourceCache.delete(context);
  staticCache.delete(context);
}

function sourceFor(ref: UnresolvedRef, context: ResolutionContext) {
  let files = sourceCache.get(context);
  if (!files) sourceCache.set(context, files = new Map());
  let cached = files.get(ref.filePath);
  if (!cached) {
    const raw = context.getFileLines?.(ref.filePath) ?? (context.readFile(ref.filePath) ?? '').split(/\r?\n/);
    const source = raw.join('\n');
    const comments = stripCommentsForRegex(source, 'javascript');
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === '\n') starts.push(i + 1);
    cached = { raw, comments, starts };
    files.set(ref.filePath, cached);
  }
  return cached;
}
function lines(ref: UnresolvedRef, context: ResolutionContext, raw = false): string[] {
  const cached = sourceFor(ref, context);
  if (raw) return cached.raw;
  return cached.code ??= blankStringContents(cached.comments).split(/\r?\n/);
}
const escape = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function isStaticMethod(node: Node, ref: UnresolvedRef, context: ResolutionContext): boolean {
  if (node.language !== 'javascript' && node.language !== 'jsx') return !!node.isStatic;
  let nodes = staticCache.get(context);
  if (!nodes) staticCache.set(context, nodes = new Map());
  const hit = nodes.get(node.id);
  if (hit !== undefined) return hit;
  // The JS extractor does not yet populate isStatic (SQLite reads its absent
  // flag as false); both backends retain the exact method source position.
  // TS nodes use their existing flag.
  const source = sourceFor({ ...ref, filePath: node.filePath }, context);
  const at = (source.starts[node.startLine - 1] ?? 0) + node.startColumn;
  const pattern = /static\s+/y;
  pattern.lastIndex = at;
  const value = !!pattern.exec(source.comments);
  nodes.set(node.id, value);
  return value;
}

/** A method on one particular class, never the union of all its namesakes. */
export function methodOnJsClass(cls: Node, method: string, ref: UnresolvedRef, context: ResolutionContext,
  seen = new Set<string>(), isStatic = false): ResolvedRef | null {
  if (seen.has(cls.id) || seen.size >= 16) return null;
  seen.add(cls.id);
  const members = context.getMethodMatches?.(cls.name, method, ref.language) ?? context.getNodesByName(method);
  const own = members.filter(n => n.kind === 'method' && n.filePath === cls.filePath &&
    n.qualifiedName === `${cls.qualifiedName}::${method}` && n.startLine >= cls.startLine && n.endLine <= cls.endLine &&
    isStaticMethod(n, ref, context) === isStatic);
  if (own.length === 1) return { original: ref, targetNodeId: own[0]!.id, confidence: 0.95, resolvedBy: 'instance-method' };
  if (own.length > 1) return null;
  for (const parent of context.getSuperclassNodes?.(cls.id) ?? []) {
    if (parent.kind !== 'class') continue;
    const match = methodOnJsClass(parent, method, ref, context, seen, isStatic);
    if (match) return match;
  }
  return null;
}

/** undefined: no imported constructor binding; null: an import we cannot prove. */
export function matchImportedConstructorMethod(type: string, receiver: string, method: string,
  ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (!LANGUAGES.has(ref.language) || !/^[\w$]+$/.test(receiver)) return undefined;
  if (!context.resolveImport || !context.getNodeById) return undefined;
  const binding = context.getImportMappings?.(ref.filePath, ref.language)?.find(i => i.localName === type && !i.isNamespace);
  if (!binding) return undefined;
  const imported = context.resolveImport({ ...ref, referenceName: type, referenceKind: 'instantiates' });
  const cls = imported && context.getNodeById(imported.targetNodeId);
  // Ordinary unaliased receivers already have the right class identity. Do
  // not replace their existing inference for returned/destructured values.
  // Keep recovery for aliases/re-exports and genuinely ambiguous namesakes.
  if (binding.localName === binding.exportedName && !binding.isDefault && cls?.kind === 'class' && cls.name === type) {
    const matches = context.getNodesByName(type).filter(n => n.kind === 'class' && LANGUAGES.has(n.language));
    if (matches.length === 1 && matches[0]!.id === cls.id) return undefined;
  }
  const scopes = context.getNodesInFile(ref.filePath).filter(n =>
    (n.kind === 'function' || n.kind === 'method') && n.startLine <= ref.line && n.endLine >= ref.line);
  const code = lines(ref, context);
  const begin = scopes.reduce((line, n) => Math.max(line, n.startLine), 1);
  const prefix = code.slice(begin - 1, ref.line).join('\n');
  // The blanker intentionally hides executable template substitutions too.
  // Leave that unsupported binding shape to the existing resolver, rather
  // than miss a reassignment inside it while adding an alias-derived edge.
  if (lines(ref, context, true).slice(begin - 1, ref.line).join('\n').includes('${')) return undefined;
  const t = escape(type), r = escape(receiver);
  if (!new RegExp(`\\b(?:const|let|var)\\s+${r}\\s*=\\s*new\\s+${t}\\s*\\(`).test(prefix)) return undefined;
  // Do not recover an import through a shadowing parameter/local, or recover
  // the original instance after reassignment. These guards are conservative:
  // unsupported binding forms stay unresolved instead of choosing a namesake.
  if (scopes.some(n => new RegExp(`(?:[(,]|\\.\\.\\.)\\s*${t}\\s*(?:[:=,)]|$)`).test(n.signature ?? ''))) return null;
  const scopeCode = code.slice(begin - 1, Math.max(ref.line, ...scopes.map(n => n.endLine))).join('\n');
  if (new RegExp(`\\b(?:const|let|var|class|function)\\s+${t}(?![\\w$])`).test(scopeCode)) {
    const localClass = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'class' && n.name === type &&
      n.startLine >= begin && n.startLine <= ref.line).sort((a, b) => b.startLine - a.startLine)[0];
    // A known local class belongs to ordinary local receiver resolution; the
    // import recovery must not introduce a new target through a shadow name.
    return localClass ? undefined : null;
  }
  // A recovery is deliberately narrower than JavaScript binding analysis:
  // destructured/catch/arrow parameters and other uses of the alias cannot
  // prove that a `new` still names the import. Existing unaliased resolution
  // remains authoritative for sibling blocks with separate declarations.
  const scopeWithoutImports = scopeCode.replace(/\bimport\b[^;\n]*(?:;|$)/gm, '');
  if (binding.localName !== binding.exportedName || binding.isDefault) {
    for (const use of scopeWithoutImports.matchAll(new RegExp(`(?<![\\w$])${t}(?![\\w$])`, 'g'))) {
      if (!/\bnew\s+$/.test(scopeWithoutImports.slice(0, use.index))) return null;
    }
  }
  if ([...prefix.matchAll(new RegExp(`(?<![\\w$.])${r}\\s*(?:=(?!=|>)|[+*/%&|^\\-]=|\\*\\*=|&&=|\\|\\|=|\\?\\?=|\\+\\+|--)`, 'g'))].length !== 1) {
    return binding.localName === binding.exportedName && !binding.isDefault ? undefined : null;
  }
  if (new RegExp(`(?:\\[[^\\]\\n]*\\b${r}\\b[^\\]\\n]*\\]|\\{[^}\\n]*\\b${r}\\b[^}\\n]*\\})\\s*=`).test(prefix)) return null;
  return cls?.kind === 'class' ? methodOnJsClass(cls, method, ref, context) : null;
}

/** Match explicit super calls by their call-site position and resolved parent. */
export function matchJsSuperCall(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null | undefined {
  if (!LANGUAGES.has(ref.language) || ref.referenceKind !== 'calls') return undefined;
  const code = sourceCache.get(context)?.get(ref.filePath)?.raw ?? context.getFileLines?.(ref.filePath) ?? lines(ref, context, true);
  const head = code[ref.line - 1]?.slice(ref.column) ?? '';
  if (!/^super\b/.test(head)) return undefined;
  const cached = sourceFor(ref, context);
  // Sticky matching reads the call at its exact offset in the one cached
  // comment-stripped source, without copying/re-stripping the file suffix.
  const pattern = /super\s*\.\s*([\w$]+)\s*\(/y;
  pattern.lastIndex = (cached.starts[ref.line - 1] ?? 0) + ref.column;
  const call = pattern.exec(cached.comments);
  if (!call) return null; // an explicit but unsupported super expression is never a name guess
  const cls = context.getNodesInFile(ref.filePath).filter(n => n.kind === 'class' &&
    (n.startLine < ref.line || (n.startLine === ref.line && n.startColumn <= ref.column)) &&
    (n.endLine > ref.line || (n.endLine === ref.line && n.endColumn >= ref.column)))
    .sort((a, b) => b.startLine - a.startLine || b.startColumn - a.startColumn)[0];
  if (!cls) return null;
  const caller = context.getNodeById?.(ref.fromNodeId);
  for (const parent of context.getSuperclassNodes?.(cls.id) ?? []) {
    if (parent.kind !== 'class') continue;
    const match = methodOnJsClass(parent, call[1]!, ref, context, new Set(), caller ? isStaticMethod(caller, ref, context) : false);
    if (match) return match;
  }
  return null;
}
