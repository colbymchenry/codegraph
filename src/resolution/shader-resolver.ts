import * as path from 'path';
import type { Language, Node, ReferenceKind } from '../types';
import { loadShaderIncludeAliases, loadShaderIncludePaths } from '../project-config';
import type { ResolutionContext, ResolvedRef, UnresolvedRef } from './types';

export const SHADER_EXTENSIONS = [
  '.glsl', '.vert', '.frag', '.comp', '.geom', '.tesc', '.tese',
  '.rgen', '.rmiss', '.rchit', '.rahit', '.rint', '.rcall', '.mesh', '.task',
  '.glslfx', '.hlsl', '.hlsli', '.fx', '.fxh',
] as const;

export function isShaderLanguage(language: Language): language is 'glsl' | 'hlsl' {
  return language === 'glsl' || language === 'hlsl';
}

function normalizeRelative(root: string, candidate: string): string | null {
  const absolute = path.resolve(root, candidate);
  const relative = path.relative(root, absolute);
  if (!relative || relative === '.') return null;
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.replace(/\\/g, '/');
}

function withExtensionFallback(value: string): string[] {
  if (path.posix.extname(value)) return [value];
  return [value, ...SHADER_EXTENSIONS.map((ext) => value + ext)];
}

export function resolveShaderPath(
  includePath: string,
  fromFile: string,
  context: ResolutionContext,
  line?: number,
): string | null {
  const projectRoot = context.getProjectRoot();
  const aliases = loadShaderIncludeAliases(projectRoot);
  const roots = loadShaderIncludePaths(projectRoot);
  let requested = includePath.replace(/\\/g, '/').trim();
  if (!requested) return null;

  for (const [prefix, target] of Object.entries(aliases)) {
    if (requested === prefix || requested.startsWith(prefix + '/')) {
      requested = path.posix.join(target, requested.slice(prefix.length).replace(/^\//, ''));
      const aliased = withExtensionFallback(requested)
        .map((p) => normalizeRelative(projectRoot, p))
        .filter((p): p is string => !!p && context.fileExists(p));
      return aliased.length === 1 ? aliased[0]! : null;
    }
  }

  const sourceLine = line ? context.getFileLines?.(fromFile)?.[line - 1] : undefined;
  const angleInclude = !!sourceLine && /#\s*(?:include|import)\s*</.test(sourceLine);
  const tiers: string[][] = [];
  if (!angleInclude) tiers.push([path.posix.join(path.posix.dirname(fromFile), requested)]);
  tiers.push(roots.map((root) => path.posix.join(root, requested)));
  tiers.push([requested]);

  for (const tier of tiers) {
    const matches = new Set<string>();
    for (const base of tier) {
      for (const candidate of withExtensionFallback(base)) {
        const relative = normalizeRelative(projectRoot, candidate);
        if (relative && context.fileExists(relative)) matches.add(relative);
      }
    }
    if (matches.size === 1) return [...matches][0]!;
    if (matches.size > 1) return null;
  }

  // Compiler include roots are often declared only in CMake and are not always
  // mirrored into codegraph.json. A project-wide suffix is still precise when
  // it identifies exactly one indexed file (`Rtxdi/DI/Reservoir.hlsli` ->
  // `Libraries/Rtxdi/Include/Rtxdi/DI/Reservoir.hlsli`). Ambiguous application
  // bridges deliberately remain unresolved.
  const suffixMatches = new Set<string>();
  for (const requestedPath of withExtensionFallback(requested)) {
    const normalized = requestedPath.replace(/^\.\//, '').replace(/^(?:\.\.\/)+/, '');
    const comparableRequest = process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    for (const file of context.getAllFiles()) {
      const candidate = file.replace(/\\/g, '/');
      if (!normalizeRelative(projectRoot, candidate)) continue;
      const comparableCandidate = process.platform === 'win32' ? candidate.toLowerCase() : candidate;
      if (comparableCandidate === comparableRequest || comparableCandidate.endsWith('/' + comparableRequest)) {
        suffixMatches.add(candidate);
      }
    }
  }
  if (suffixMatches.size === 1) return [...suffixMatches][0]!;
  return null;
}

function targetKinds(kind: ReferenceKind): Set<Node['kind']> | null {
  if (kind === 'calls' || kind === 'function_ref') return new Set(['function', 'method']);
  if (kind === 'extends' || kind === 'implements') return new Set(['struct', 'class', 'interface', 'type_alias']);
  return null;
}

function normalizedSignature(node: Node): string | null {
  let signature = node.signature?.replace(/\s+/g, ' ').trim();
  if (!signature) return null;
  // Parameter names differ across equivalent shader variants (`seed` vs
  // `state`) but their type/qualifier contract is what makes a call safe.
  signature = signature.replace(
    /\b(inout|out|in|const)\s+([A-Za-z_]\w*(?:\s*\[\s*\])?)\s+[A-Za-z_]\w*/g,
    '$1 $2 _',
  );
  signature = signature.replace(/\b([A-Za-z_]\w*(?:\s*\[\s*\])?)\s+[A-Za-z_]\w*(?=\s*(?:,|\)))/g, '$1 _');
  // Some bridge declarations omit parameter names entirely. Normalize those
  // to the same contract as a named parameter without erasing real type data.
  signature = signature.replace(
    /([,(]\s*)((?:inout|out|in|const)\s+)?([A-Za-z_]\w*(?:\s*\[\s*\])?)(?=\s*(?:,|\)))/g,
    '$1$2$3 _',
  );
  return signature ? signature : null;
}

function callArityHint(ref: UnresolvedRef): number | null {
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^arity:(\d+)$/);
    if (match) return Number(match[1]);
  }
  return null;
}

function signatureParameters(node: Node): { params: string[]; variadic: boolean } | null {
  const signature = node.signature;
  if (!signature) return null;
  const open = signature.indexOf('(');
  if (open < 0) return null;
  let paren = 0;
  let square = 0;
  let angle = 0;
  let current = '';
  const params: string[] = [];
  for (let i = open + 1; i < signature.length; i++) {
    const char = signature[i]!;
    if (char === '(') paren++;
    else if (char === ')') {
      if (paren === 0) {
        if (current.trim()) params.push(current.trim());
        const meaningful = params.filter((param) => param !== 'void');
        const variadic = meaningful.some((param) => param.includes('...'));
        return { params: meaningful, variadic };
      }
      paren--;
    } else if (char === '[') square++;
    else if (char === ']') square = Math.max(0, square - 1);
    else if (char === '<') angle++;
    else if (char === '>') angle = Math.max(0, angle - 1);
    if (char === ',' && paren === 0 && square === 0 && angle === 0) {
      params.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  return null;
}

function signatureArity(node: Node): { minimum: number; variadic: boolean } | null {
  const parsed = signatureParameters(node);
  if (!parsed) return null;
  return {
    minimum: parsed.params.filter((param) => !param.includes('...')).length,
    variadic: parsed.variadic,
  };
}

function callTypeHints(ref: UnresolvedRef): Map<number, string> {
  const hints = new Map<number, string>();
  for (const candidate of ref.candidates ?? []) {
    const match = candidate.match(/^argtype:(\d+):([A-Za-z_]\w*)$/);
    if (match) hints.set(Number(match[1]), match[2]!.toLowerCase());
  }
  return hints;
}

function parameterType(param: string): string | null {
  const cleaned = param
    .replace(/\s*:\s*[A-Za-z_]\w*\s*$/, '')
    .replace(/\s*=.*$/, '')
    .replace(/\b(?:inout|out|in|const|static|uniform|groupshared)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.includes('...')) return null;
  const tokens = cleaned.split(' ');
  const type = tokens.length > 1 ? tokens.slice(0, -1).join(' ') : tokens[0]!;
  return type.replace(/\s+/g, '').toLowerCase();
}

function applyCallEvidence(candidates: Node[], ref: UnresolvedRef): Node[] {
  const arity = callArityHint(ref);
  let narrowed = candidates;
  if (arity !== null) {
    const matching = narrowed.filter((node) => {
      const parsed = signatureArity(node);
      return parsed && (parsed.variadic ? arity >= parsed.minimum : arity === parsed.minimum);
    });
    if (matching.length > 0) narrowed = matching;
  }
  const typeHints = callTypeHints(ref);
  if (typeHints.size > 0) {
    const matching = narrowed.filter((node) => {
      const parsed = signatureParameters(node);
      if (!parsed) return false;
      for (const [index, expected] of typeHints) {
        const actual = parsed.params[index] ? parameterType(parsed.params[index]!) : null;
        if (!actual || actual !== expected) return false;
      }
      return true;
    });
    if (matching.length > 0) narrowed = matching;
  }
  return narrowed;
}

export interface ContextualShaderTarget {
  node: Node;
  contextRoots: string[];
}

interface ConditionalBranchFrame {
  groupLine: number;
  branch: number;
}

function conditionalBranchesByLine(source: string): ConditionalBranchFrame[][] {
  const lines = source.split(/\r?\n/);
  const result: ConditionalBranchFrame[][] = Array.from({ length: lines.length + 1 }, () => []);
  const stack: ConditionalBranchFrame[] = [];
  for (let index = 0; index < lines.length; index++) {
    result[index + 1] = stack.map((frame) => ({ ...frame }));
    const line = lines[index]!;
    if (/^\s*#\s*(?:if|ifdef|ifndef)\b/.test(line)) {
      stack.push({ groupLine: index + 1, branch: 0 });
    } else if (/^\s*#\s*(?:elif|else)\b/.test(line) && stack.length > 0) {
      stack[stack.length - 1]!.branch++;
    } else if (/^\s*#\s*endif\b/.test(line)) {
      stack.pop();
    }
  }
  return result;
}

export class ShaderResolver {
  private closureCache = new Map<string, Map<string, number>>();
  private directIncludeCache = new Map<string, string[]>();
  private reverseIncludeCache = new Map<'glsl' | 'hlsl', Map<string, Set<string>>>();
  private contextRootCache = new Map<string, Map<string, number>>();
  private conditionalBranchCache = new Map<string, ConditionalBranchFrame[][]>();

  constructor(private readonly context: ResolutionContext) {}

  clear(): void {
    this.closureCache.clear();
    this.directIncludeCache.clear();
    this.reverseIncludeCache.clear();
    this.contextRootCache.clear();
    this.conditionalBranchCache.clear();
  }

  resolve(ref: UnresolvedRef): ResolvedRef | null {
    if (!isShaderLanguage(ref.language)) return null;
    if (ref.referenceKind === 'imports') {
      const file = resolveShaderPath(ref.referenceName, ref.filePath, this.context, ref.line);
      if (!file) return null;
      const target = this.context.getNodesInFile(file).find((n) => n.kind === 'file');
      return target ? { original: ref, targetNodeId: target.id, confidence: 1, resolvedBy: 'import' } : null;
    }

    const kinds = targetKinds(ref.referenceKind);
    const roots = this.getContextRoots(ref.filePath, ref.language);
    const candidates = applyCallEvidence(this.context.getNodesByName(ref.referenceName).filter((node) => {
      if (node.language !== ref.language || node.id === ref.fromNodeId) return false;
      if (node.kind === 'file' || node.kind === 'import') return false;
      return !kinds || kinds.has(node.kind);
    }), ref);
    if (candidates.length === 0) return null;
    const scored = candidates.map((node) => ({ node, distance: this.contextDistance(node.filePath, ref.language as 'glsl' | 'hlsl', roots) }))
      .filter((item) => Number.isFinite(item.distance));
    if (scored.length === 0) {
      // Some shared shader headers are injected by the build system rather than
      // included textually. If all matching declarations have the same callable
      // contract, resolve the equivalent variant deterministically instead of
      // leaving every call in that header unresolved.
      const signatures = new Set(candidates.map(normalizedSignature));
      if (signatures.size !== 1 || signatures.has(null)) return null;
      const target = [...candidates].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)[0]!;
      return { original: ref, targetNodeId: target.id, confidence: 0.72, resolvedBy: 'import' };
    }
    const minDepth = Math.min(...scored.map((item) => item.distance));
    const nearest = scored.filter((item) => item.distance === minDepth).map((item) => item.node);
    const files = new Set(nearest.map((node) => node.filePath));
    if (files.size !== 1) {
      // A shared HLSL library can be compiled under several application bridge
      // roots. One reference node therefore legitimately targets one callback
      // per translation-unit context; choosing a single file conflates those
      // implementations. Leave the ref for contextual edge synthesis.
      return null;
    }
    if (nearest.length > 1) {
      // Distinct overload contracts in one closure require type inference we do
      // not have. Equivalent conditional declarations can still collapse.
      const signatures = new Set(nearest.map(normalizedSignature));
      if (signatures.size !== 1 || signatures.has(null)) return null;
    }
    const target = [...nearest].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)[0]!;
    return { original: ref, targetNodeId: target.id, confidence: minDepth === 0 ? 0.98 : 0.95, resolvedBy: 'import' };
  }

  /**
   * Return one equivalent callable per nearest shader translation-unit context.
   * Used after ordinary resolution deliberately leaves a multi-root bridge call
   * unresolved; differing signatures stay ambiguous.
   */
  getContextualCallTargets(ref: UnresolvedRef): Node[] {
    return this.getContextualCallTargetContexts(ref).map((target) => target.node);
  }

  /**
   * Return one target from each mutually exclusive branch of the same shader
   * preprocessor conditional. This is a deliberate variant union: the active
   * compiler defines choose one branch, while source-only analysis must retain
   * every possible call edge. Independent guarded overloads remain ambiguous.
   */
  getConditionalCallTargets(ref: UnresolvedRef): Node[] {
    if (!isShaderLanguage(ref.language) || ref.referenceKind !== 'calls') return [];
    const language = ref.language as 'glsl' | 'hlsl';
    const roots = this.getContextRoots(ref.filePath, language);
    const candidates = applyCallEvidence(this.context.getNodesByName(ref.referenceName).filter((node) =>
      node.language === ref.language &&
      node.id !== ref.fromNodeId &&
      (node.kind === 'function' || node.kind === 'method')
    ), ref);
    const scored = candidates.map((node) => ({
      node,
      distance: this.contextDistance(node.filePath, language, roots),
    })).filter((item) => Number.isFinite(item.distance));
    if (scored.length < 2) return [];
    const minDepth = Math.min(...scored.map((item) => item.distance));
    const nearest = scored.filter((item) => item.distance === minDepth).map((item) => item.node);
    if (nearest.length < 2 || new Set(nearest.map((node) => node.filePath)).size !== 1) return [];

    const filePath = nearest[0]!.filePath;
    let branches = this.conditionalBranchCache.get(filePath);
    if (!branches) {
      const source = this.context.readFile(filePath);
      if (!source) return [];
      branches = conditionalBranchesByLine(source);
      this.conditionalBranchCache.set(filePath, branches);
    }
    const stacks = nearest.map((node) => branches![node.startLine] ?? []);
    if (stacks.some((stack) => stack.length === 0)) return [];

    for (const frame of stacks[0]!) {
      const selected = stacks.map((stack) => stack.find((candidate) => candidate.groupLine === frame.groupLine));
      if (selected.some((candidate) => !candidate)) continue;
      const branchIds = selected.map((candidate) => candidate!.branch);
      // One candidate per branch proves this is a conditional implementation
      // family, not an unresolved overload set inside one branch.
      if (new Set(branchIds).size !== nearest.length) continue;
      return [...nearest].sort((a, b) => a.startLine - b.startLine);
    }
    return [];
  }

  getContextualCallTargetContexts(ref: UnresolvedRef): ContextualShaderTarget[] {
    if (!isShaderLanguage(ref.language) || ref.referenceKind !== 'calls') return [];
    const language = ref.language as 'glsl' | 'hlsl';
    const roots = this.getContextRoots(ref.filePath, language);
    const candidates = applyCallEvidence(this.context.getNodesByName(ref.referenceName).filter((node) =>
      node.language === ref.language &&
      node.id !== ref.fromNodeId &&
      (node.kind === 'function' || node.kind === 'method')
    ), ref);
    const scored = candidates.map((node) => ({
      node,
      distance: this.contextDistance(node.filePath, language, roots),
    })).filter((item) => Number.isFinite(item.distance));
    if (scored.length < 2) return [];
    const minDepth = Math.min(...scored.map((item) => item.distance));
    const nearest = scored.filter((item) => item.distance === minDepth).map((item) => item.node);
    if (new Set(nearest.map((node) => node.filePath)).size < 2) return [];
    const signatures = new Set(nearest.map(normalizedSignature));
    if (signatures.size !== 1 || signatures.has(null)) return [];

    const byFile = new Map<string, Node>();
    for (const node of [...nearest].sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine)) {
      if (!byFile.has(node.filePath)) byFile.set(node.filePath, node);
    }
    const reverse = this.getReverseIncludes(language);
    return [...byFile.values()].map((node) => {
      const matching = new Set([...roots.keys()].filter((root) => this.getClosure(root, language).has(node.filePath)));
      const topLevel = [...matching].filter((root) =>
        ![...(reverse.get(root) ?? [])].some((parent) => matching.has(parent))
      );
      return { node, contextRoots: (topLevel.length > 0 ? topLevel : [...matching]).sort() };
    });
  }

  getClosure(filePath: string, language: 'glsl' | 'hlsl'): Map<string, number> {
    const key = `${language}\0${filePath}`;
    const cached = this.closureCache.get(key);
    if (cached) return cached;
    const depth = new Map<string, number>([[filePath, 0]]);
    const queue = [filePath];
    for (let index = 0; index < queue.length && index < 4096; index++) {
      const file = queue[index]!;
      const currentDepth = depth.get(file)!;
      if (currentDepth >= 32) continue;
      for (const target of this.getDirectIncludes(file, language)) {
        if (!target || depth.has(target)) continue;
        depth.set(target, currentDepth + 1);
        queue.push(target);
      }
    }
    this.closureCache.set(key, depth);
    return depth;
  }

  private getDirectIncludes(filePath: string, language: 'glsl' | 'hlsl'): string[] {
    const key = `${language}\0${filePath}`;
    const cached = this.directIncludeCache.get(key);
    if (cached) return cached;
    const targets = new Set<string>();
    const content = this.context.readFile(filePath);
    if (content) {
      const lines = content.split(/\r?\n/);
      for (let row = 0; row < lines.length; row++) {
        const match = lines[row]!.match(/^\s*#\s*(?:include|import)\s*[<"]([^>"]+)[>"]/);
        if (!match) continue;
        const target = resolveShaderPath(match[1]!, filePath, this.context, row + 1);
        if (!target) continue;
        const targetLanguage = this.context.getNodesInFile(target).find((node) => node.kind === 'file')?.language;
        if (targetLanguage === language) targets.add(target);
      }
    }
    const result = [...targets];
    this.directIncludeCache.set(key, result);
    return result;
  }

  private getReverseIncludes(language: 'glsl' | 'hlsl'): Map<string, Set<string>> {
    const cached = this.reverseIncludeCache.get(language);
    if (cached) return cached;
    const reverse = new Map<string, Set<string>>();
    for (const file of this.context.getAllFiles()) {
      const fileLanguage = this.context.getNodesInFile(file).find((node) => node.kind === 'file')?.language;
      if (fileLanguage !== language) continue;
      for (const target of this.getDirectIncludes(file, language)) {
        let parents = reverse.get(target);
        if (!parents) {
          parents = new Set<string>();
          reverse.set(target, parents);
        }
        parents.add(file);
      }
    }
    this.reverseIncludeCache.set(language, reverse);
    return reverse;
  }

  private getContextRoots(filePath: string, language: 'glsl' | 'hlsl'): Map<string, number> {
    const key = `${language}\0${filePath}`;
    const cached = this.contextRootCache.get(key);
    if (cached) return cached;
    const reverse = this.getReverseIncludes(language);
    const roots = new Map<string, number>([[filePath, 0]]);
    const queue = [filePath];
    for (let index = 0; index < queue.length && index < 4096; index++) {
      const file = queue[index]!;
      const currentDepth = roots.get(file)!;
      if (currentDepth >= 32) continue;
      for (const parent of reverse.get(file) ?? []) {
        if (roots.has(parent)) continue;
        roots.set(parent, currentDepth + 1);
        queue.push(parent);
      }
    }
    this.contextRootCache.set(key, roots);
    return roots;
  }

  private contextDistance(
    targetFile: string,
    language: 'glsl' | 'hlsl',
    roots: Map<string, number>,
  ): number {
    let best = Number.POSITIVE_INFINITY;
    for (const [root, reverseDepth] of roots) {
      const forwardDepth = this.getClosure(root, language).get(targetFile);
      if (forwardDepth !== undefined) best = Math.min(best, reverseDepth + forwardDepth);
    }
    return best;
  }
}
