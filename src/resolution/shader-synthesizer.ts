import * as path from 'path';
import type { Edge, Node } from '../types';
import type { QueryBuilder } from '../db/queries';
import type { MaybeYield } from './cooperative-yield';
import type { ResolutionContext } from './types';
import { isShaderLanguage, ShaderResolver, SHADER_EXTENSIONS } from './shader-resolver';

const SHADER_LITERAL_RE = new RegExp(
  `["']([^"']+(?:${SHADER_EXTENSIONS.map((ext) => ext.replace('.', '\\.')).join('|')})(?:\\.[A-Za-z0-9_-]+)*(?:\\.spv)?)["']`,
  'gi',
);

function enclosingCallNames(source: string, literalOffset: number): string[] {
  const names: string[] = [];
  let closedParens = 0;
  const start = Math.max(0, literalOffset - 768);
  for (let index = literalOffset - 1; index >= start; index--) {
    const char = source[index]!;
    if (char === ')') {
      closedParens++;
      continue;
    }
    if (char === '(') {
      if (closedParens > 0) {
        closedParens--;
        continue;
      }
      const prefix = source.slice(start, index);
      const match = /([A-Za-z_]\w*(?:(?:::|->|\.)[A-Za-z_]\w*)*)\s*$/.exec(prefix);
      if (match) names.push(match[1]!.split(/::|->|\./).pop()!);
      continue;
    }
    if (closedParens === 0 && (char === ';' || char === '{' || char === '}')) break;
  }
  return names;
}

function createsShaderEntryAssociation(source: string, literalOffset: number): boolean {
  return enclosingCallNames(source, literalOffset).some((name) => {
    const lower = name.toLowerCase();
    const hasShaderObject = /shader|spirv|spv|pipeline|program/.test(lower);
    const hasLoaderVerb = /compile|load|create|build|make|open|read|register|attach|add|set/.test(lower);
    return hasShaderObject && hasLoaderVerb;
  });
}

function sourceFor(node: Node, ctx: ResolutionContext): string {
  const lines = ctx.getFileLines?.(node.filePath) ?? ctx.readFile(node.filePath)?.split(/\r?\n/) ?? [];
  return lines.slice(Math.max(0, node.startLine - 1), node.endLine).join('\n');
}

function resolveShaderAsset(literal: string, fromFile: string, shaderFiles: string[]): string | null {
  let requested = literal.replace(/\\/g, '/').replace(/^\.\//, '');
  const derivedSpv = requested.toLowerCase().endsWith('.spv');
  if (derivedSpv) requested = requested.slice(0, -4);
  const fromDir = path.posix.dirname(fromFile);
  const tiers = [
    shaderFiles.filter((file) => file === path.posix.normalize(path.posix.join(fromDir, requested))),
    shaderFiles.filter((file) => file === requested),
    shaderFiles.filter((file) => file.endsWith('/' + requested)),
    ...(derivedSpv ? [shaderFiles.filter((file) => {
      const base = path.posix.basename(file);
      const requestedBase = path.posix.basename(requested);
      return requested.startsWith(file + '.') || requestedBase.startsWith(base + '.');
    })] : []),
    shaderFiles.filter((file) => path.posix.basename(file) === path.posix.basename(requested)),
  ];
  for (const tier of tiers) {
    const unique = [...new Set(tier)];
    if (unique.length === 1) return unique[0]!;
    if (unique.length > 1) return null;
  }
  return null;
}

function decoratorValue(node: Node, prefix: string): string | undefined {
  return node.decorators?.find((value) => value.startsWith(prefix + ':'))?.slice(prefix.length + 1);
}

function resourceClass(node: Node): string | undefined {
  const explicit = node.decorators?.find((value) => value.startsWith('resource:'))?.slice('resource:'.length);
  if (explicit === 'buffer') return 'storage';
  if (explicit) return explicit;
  if (node.decorators?.includes('storage:buffer')) return 'storage';
  if (node.decorators?.includes('storage:uniform')) return 'constant-buffer';
  return undefined;
}

function descriptorClass(text: string): string | undefined {
  if (/STORAGE_(?:IMAGE|BUFFER)|STORAGE_BUFFER/i.test(text)) return 'storage';
  if (/COMBINED_IMAGE_SAMPLER|SAMPLED_IMAGE/i.test(text)) return 'texture';
  if (/\bSAMPLER\b/i.test(text)) return 'sampler';
  if (/UNIFORM_BUFFER/i.test(text)) return 'constant-buffer';
  if (/ACCELERATION_STRUCTURE/i.test(text)) return 'acceleration-structure';
  return undefined;
}

function resourcesFor(shaderFile: string, resolver: ShaderResolver, ctx: ResolutionContext): Node[] {
  const language = ctx.getNodesInFile(shaderFile).find((node) => node.kind === 'file')?.language;
  if (!language || !isShaderLanguage(language)) return [];
  const closure = resolver.getClosure(shaderFile, language);
  const resources: Node[] = [];
  for (const file of closure.keys()) {
    resources.push(...ctx.getNodesInFile(file).filter((node) =>
      node.kind === 'variable' || node.kind === 'constant' || node.kind === 'struct'
    ));
  }
  return resources;
}

function uniqueResource(candidates: Node[]): Node | null {
  const unique = [...new Map(candidates.map((node) => [node.id, node])).values()];
  return unique.length === 1 ? unique[0]! : null;
}

function interfaceEdges(owner: Node, shaderFile: string, entry: Node, body: string, resolver: ShaderResolver, ctx: ResolutionContext): Edge[] {
  const out: Edge[] = [];
  const resources = resourcesFor(shaderFile, resolver, ctx);
  const registeredAt = `${owner.filePath}:${owner.startLine}`;
  const add = (target: Node | null, metadata: Record<string, unknown>): void => {
    if (!target) return;
    out.push({ source: owner.id, target: target.id, kind: 'references', provenance: 'heuristic', line: owner.startLine,
      metadata: { synthesizedBy: 'shader-interface', shaderEntry: entry.qualifiedName, registeredAt, ...metadata } });
  };

  const bindingRe = /\b(?:dstBinding|binding)\b\s*(?:=\s*)?(?:\{\s*)?(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = bindingRe.exec(body))) {
    const binding = match[1]!;
    const nearby = body.slice(Math.max(0, match.index - 140), Math.min(body.length, match.index + 280));
    const expectedClass = descriptorClass(nearby);
    const expectedSet = nearby.match(/\b(?:set|space)\b\s*(?:=\s*)?(\d+)/i)?.[1];
    const candidates = resources.filter((node) => {
      const explicit = decoratorValue(node, 'binding');
      const register = decoratorValue(node, 'register')?.match(/^[tsub](\d+)$/)?.[1];
      if (explicit !== binding && register !== binding) return false;
      const actualSet = decoratorValue(node, 'set') ?? decoratorValue(node, 'space');
      if (expectedSet !== undefined && actualSet !== expectedSet) return false;
      const actualClass = resourceClass(node);
      return !expectedClass || !actualClass || actualClass === expectedClass ||
        (expectedClass === 'constant-buffer' && actualClass === 'buffer');
    });
    add(uniqueResource(candidates), { binding: Number(binding), set: expectedSet === undefined ? undefined : Number(expectedSet), descriptorType: expectedClass });
  }

  const constantIds = new Set<string>();
  for (const id of body.matchAll(/\bconstantID\b\s*=\s*(\d+)/g)) constantIds.add(id[1]!);
  for (const id of body.matchAll(/VkSpecializationMapEntry(?:\s+[A-Za-z_]\w*)?\s*\{\s*(\d+)/g)) constantIds.add(id[1]!);
  for (const id of constantIds) add(uniqueResource(resources.filter((node) => decoratorValue(node, 'constant_id') === id)), { constantId: Number(id) });

  const locations = new Set<string>();
  for (const location of body.matchAll(/\blocation\b\s*=\s*(\d+)/g)) locations.add(location[1]!);
  for (const location of body.matchAll(/VkVertexInputAttributeDescription(?:\s+[A-Za-z_]\w*)?\s*(?:=\s*)?\{\s*(\d+)/g)) locations.add(location[1]!);
  for (const location of locations) add(uniqueResource(resources.filter((node) => decoratorValue(node, 'location') === location)), { location: Number(location) });

  if (/\bvkCmdPushConstants\b|\bVkPushConstantRange\b/.test(body)) {
    add(uniqueResource(resources.filter((node) => node.decorators?.includes('push_constant'))), { pushConstant: true });
  }
  return out;
}

export async function shaderIntegrationEdges(
  queries: QueryBuilder,
  ctx: ResolutionContext,
  onYield: MaybeYield,
): Promise<Edge[]> {
  const shaderFiles = ctx.getAllFiles().filter((file) => {
    const language = ctx.getNodesInFile(file).find((node) => node.kind === 'file')?.language;
    return !!language && isShaderLanguage(language);
  });
  if (shaderFiles.length === 0) return [];

  const resolver = new ShaderResolver(ctx);
  const edges: Edge[] = [];
  const seen = new Set<string>();

  // A shared shader library is compiled once per application bridge. The same
  // indexed call site can therefore target several equivalent implementations,
  // one in each include-root context. Ordinary resolution intentionally leaves
  // that multi-target ref unresolved; represent every proven context here.
  let contextualScanned = 0;
  for (const ref of queries.getUnresolvedReferences?.() ?? []) {
    if (!ref.language || !ref.filePath || !isShaderLanguage(ref.language) || ref.referenceKind !== 'calls') continue;
    if ((++contextualScanned & 127) === 0) await onYield();
    for (const target of resolver.getContextualCallTargetContexts({
      ...ref,
      filePath: ref.filePath,
      language: ref.language,
    })) {
      edges.push({
        source: ref.fromNodeId,
        target: target.node.id,
        kind: 'calls',
        line: ref.line,
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: 'shader-context-variant',
          reference: ref.referenceName,
          targetFile: target.node.filePath,
          contextRoots: target.contextRoots,
          registeredAt: `${ref.filePath}:${ref.line}`,
        },
      });
    }
  }

  const interfaceOwners = new Map<string, { owner: Node; shaders: Map<string, Node> }>();
  const callable = [
    ...(ctx.iterateNodesByKind?.('function') ?? ctx.getNodesByKind('function')),
    ...(ctx.iterateNodesByKind?.('method') ?? ctx.getNodesByKind('method')),
  ];
  let scanned = 0;
  for (const node of callable) {
    if (node.language !== 'c' && node.language !== 'cpp') continue;
    if ((++scanned & 127) === 0) await onYield();
    const body = sourceFor(node, ctx);
    SHADER_LITERAL_RE.lastIndex = 0;
    const associated = new Map<string, Node>();
    let match: RegExpExecArray | null;
    while ((match = SHADER_LITERAL_RE.exec(body))) {
      const shaderFile = resolveShaderAsset(match[1]!, node.filePath, shaderFiles);
      if (!shaderFile) continue;
      const fileNode = ctx.getNodesInFile(shaderFile).find((candidate) => candidate.kind === 'file');
      if (!fileNode) continue;
      const literalLine = node.startLine + body.slice(0, match.index).split('\n').length - 1;
      edges.push({ source: node.id, target: fileNode.id, kind: 'references', provenance: 'heuristic', line: literalLine,
        metadata: { synthesizedBy: 'shader-file', literal: match[1], registeredAt: `${node.filePath}:${literalLine}` } });

      if (!createsShaderEntryAssociation(body, match.index)) continue;
      const entry = ctx.getNodesInFile(shaderFile).find((candidate) => candidate.kind === 'function' && candidate.decorators?.includes('entrypoint'))
        ?? ctx.getNodesInFile(shaderFile).find((candidate) => candidate.kind === 'function' && candidate.name === 'main');
      if (!entry) continue;
      associated.set(shaderFile, entry);
      edges.push({ source: node.id, target: entry.id, kind: 'calls', provenance: 'heuristic', line: literalLine,
        metadata: { synthesizedBy: 'shader-entry', shaderFile, registeredAt: `${node.filePath}:${literalLine}` } });
    }
    if (associated.size === 0) continue;

    const owners = new Map<string, Node>([[node.id, node]]);
    let frontier = [node];
    for (let depth = 0; depth < 2; depth++) {
      const next: Node[] = [];
      for (const owner of frontier) {
        for (const edge of queries.getOutgoingEdges(owner.id, ['calls'])) {
          const target = queries.getNodeById(edge.target);
          if (!target || (target.language !== 'c' && target.language !== 'cpp') || owners.has(target.id)) continue;
          owners.set(target.id, target);
          next.push(target);
        }
      }
      frontier = next;
    }
    for (const owner of owners.values()) {
      const aggregate = interfaceOwners.get(owner.id) ?? { owner, shaders: new Map<string, Node>() };
      for (const [shaderFile, entry] of associated) aggregate.shaders.set(shaderFile, entry);
      interfaceOwners.set(owner.id, aggregate);
    }
  }

  // Descriptor coordinates without a uniquely associated shader are unsafe:
  // binding 0 is common across unrelated pipelines and generic helper calls.
  for (const { owner, shaders } of interfaceOwners.values()) {
    if (shaders.size !== 1) continue;
    const association = shaders.entries().next().value;
    if (!association) continue;
    const [shaderFile, entry] = association;
    edges.push(...interfaceEdges(owner, shaderFile, entry, sourceFor(owner, ctx), resolver, ctx));
  }

  return edges.filter((edge) => {
    const key = `${edge.source}>${edge.target}>${edge.kind}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
