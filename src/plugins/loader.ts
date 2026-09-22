import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { NODE_KINDS, EDGE_KINDS, LANGUAGES, type Node, type Edge } from '../types';
import type { FrameworkResolver, UnresolvedRef } from '../resolution/types';
import type { CodeGraphPlugin, PluginDiagnostic, PluginEntry, ResolvedPlugin } from './api';
import { emptyRegistry, type PluginRegistry } from './registry';
import { inside, packageDigest, validateManifest, sha256 } from './package';
import { loadPluginEntries } from '../project-config';
import { version as engineVersion } from '../../package.json';

const importESM = new Function('url', 'return import(url)') as (url: string) => Promise<unknown>;
export const pluginDirectory = (root: string): string => path.join(root, '.codegraph', 'plugins');

function resolveEntry(root: string, entry: PluginEntry): ResolvedPlugin {
  let packageRoot: string;
  if (entry.name.startsWith('managed:')) {
    const id = entry.name.slice(8);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !/^[a-f0-9]{64}$/.test(entry.integrity ?? '')) throw new Error('Managed package requires an immutable integrity pin');
    packageRoot = path.join(pluginDirectory(root), 'packages', entry.integrity!);
  } else if (entry.name.startsWith('./')) {
    packageRoot = path.resolve(root, entry.name);
    if (!inside(root, packageRoot)) throw new Error('Extension path escapes project');
  } else {
    if (!/^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9._-]*$/.test(entry.name)) throw new Error('Expected package name or ./package-directory');
    const requireFromProject = createRequire(path.join(root, 'package.json'));
    packageRoot = path.dirname(requireFromProject.resolve(entry.name + '/package.json'));
  }
  const realRoot = fs.realpathSync(packageRoot);
  if (!inside(fs.realpathSync(root), realRoot)) throw new Error('Extension resolves outside project');
  const pkg = JSON.parse(fs.readFileSync(path.join(realRoot, 'package.json'), 'utf8'));
  const manifest = validateManifest(pkg.codegraph, engineVersion);
  if (typeof pkg.version !== 'string' || typeof pkg.main !== 'string') throw new Error('Package requires version and main');
  const entryPath = fs.realpathSync(path.resolve(realRoot, pkg.main));
  if (!inside(realRoot, entryPath) || !/\.[cm]?js$/.test(entryPath)) throw new Error('Extension entry escapes package or is not JavaScript');
  const digest = packageDigest(realRoot);
  // Trust is machine-local and bound to the entire package content, including
  // helper files. A repository edit cannot reuse approval of different bytes.
  if (entry.name.startsWith('./') || entry.name.startsWith('managed:')) {
    let trusted: Record<string, string> = {};
    try { trusted = JSON.parse(fs.readFileSync(path.join(pluginDirectory(root), 'trust.json'), 'utf8')); } catch { /* no trust yet */ }
    if (trusted[realRoot] !== digest) throw new Error('Extension code is not trusted; install it with codegraph extensions install');
  }
  if (entry.version && entry.version !== pkg.version) throw new Error('Installed version does not match project pin');
  if (entry.name.startsWith('managed:') && entry.name.slice(8) !== manifest.id) throw new Error('Managed extension identity mismatch');
  return { manifest, name: entry.name, version: pkg.version, entryPath, packageRoot: realRoot, digest,
    options: entry.options ?? {}, replaces: entry.replaces ?? [] };
}

export function pluginFingerprint(entries: PluginEntry[]): string {
  // Order, options, enabled and replacement choices all affect graph output.
  return sha256(JSON.stringify(entries));
}

export async function loadPlugins(projectRoot: string, resolved?: ResolvedPlugin[], context: 'main' | 'parse' | 'resolver' = 'main'): Promise<PluginRegistry> {
  const registry = emptyRegistry(projectRoot);
  const ids = new Set<string>();
  const candidates: ResolvedPlugin[] = [];
  if (resolved) candidates.push(...resolved);
  else for (const entry of loadPluginEntries(projectRoot)) {
    if (entry.enabled === false) continue;
    try { candidates.push(resolveEntry(projectRoot, entry)); }
    catch (err) { registry.diagnostics.push({ id: entry.name, state: 'skipped', message: String(err) }); }
  }
  for (const p of candidates) {
    const diag: PluginDiagnostic = { id: p.manifest.id, version: p.version, state: 'loaded' };
    const start = performance.now();
    try {
      if (ids.has(p.manifest.id)) throw new Error('Duplicate extension id');
      ids.add(p.manifest.id);
      if (context === 'parse' && !p.manifest.capabilities.includes('frameworks')) continue;
      if (packageDigest(p.packageRoot) !== p.digest) throw new Error('Extension bytes changed during indexing');
      let mod: unknown;
      try { mod = require(p.entryPath); }
      catch (err) {
        if (!['ERR_REQUIRE_ESM', 'ERR_REQUIRE_ASYNC_MODULE'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        mod = await importESM(pathToFileURL(p.entryPath).href);
      }
      const factory = (typeof mod === 'function' ? mod : (mod as { default?: unknown })?.default) as CodeGraphPlugin;
      if (typeof factory !== 'function') throw new Error('Extension must default-export a factory');
      const result = await factory({ projectRoot, options: structuredClone(p.options), engineVersion,
        log: { warn: message => { diag.message = message; }, debug: message => { if (process.env.CODEGRAPH_PLUGIN_TIMINGS) console.error(`[${p.manifest.id}] ${message}`); } } });
      if (!result || (result.frameworks && !p.manifest.capabilities.includes('frameworks')) ||
          (result.synthPasses && !p.manifest.capabilities.includes('synthPasses'))) throw new Error('Undeclared extension capability');
      if ((result.frameworks && !Array.isArray(result.frameworks)) || (result.synthPasses && !Array.isArray(result.synthPasses))) throw new Error('Contributions must be arrays');
      const names = new Set<string>();
      const frameworks = (result.frameworks ?? []).map(fw => {
        if (!fw || typeof fw.name !== 'string' || typeof fw.detect !== 'function' || typeof fw.resolve !== 'function' ||
            (fw.languages && (!Array.isArray(fw.languages) || fw.languages.some(l => !LANGUAGES.includes(l))))) throw new Error('Invalid framework contribution');
        if (names.has(fw.name)) throw new Error('Duplicate framework name');
        names.add(fw.name);
        return guardFramework(fw, p, diag, projectRoot);
      });
      names.clear();
      const passes = (result.synthPasses ?? []).map(pass => {
        if (!pass || typeof pass.name !== 'string' || typeof pass.run !== 'function' || names.has(pass.name)) throw new Error('Invalid or duplicate synthesis pass');
        names.add(pass.name);
        return { name: `${p.manifest.id}:${pass.name}`, gate: (has: (...ls: string[]) => boolean) => !pass.languages || has(...pass.languages),
          run: async (_queries: unknown, ctx: Parameters<FrameworkResolver['detect']>[0], yieldToLoop: () => Promise<void> | undefined): Promise<Edge[]> => {
            if (diag.state === 'disabled') return [];
            try {
              return (await pass.run(ctx, yieldToLoop)).map(e => validateEdge(e, p.manifest.id)).filter(e => {
                if (ctx.getNodeById && (!ctx.getNodeById(e.source) || !ctx.getNodeById(e.target))) throw new Error('Edge endpoint does not exist');
                return true;
              });
            } catch (err) { disable(diag, 'synth:' + pass.name, err); return []; }
          } };
      });
      // Commit the entire factory result together, never half a registration.
      registry.frameworks.push(...frameworks);
      registry.synthPasses.push(...passes);
      for (const name of p.replaces) registry.replaces.add(name);
      registry.resolved.push(p);
    } catch (err) { diag.state = 'skipped'; diag.message = String(err); }
    diag.loadMs = Math.round(performance.now() - start);
    registry.diagnostics.push(diag);
  }
  return registry;
}

function disable(diag: PluginDiagnostic, hook: string, err: unknown): void {
  diag.state = 'disabled'; diag.message = `${hook}: ${String(err)}`;
  console.error(`[CodeGraph extension ${diag.id}] ${diag.message}`);
}
function validPath(root: string, file: string): boolean {
  return typeof file === 'string' && !!file && !path.isAbsolute(file) && !file.includes('\\') &&
    inside(root, path.resolve(root, file));
}
function validateNode(node: Node, id: string, root: string): Node {
  if (!node || typeof node.id !== 'string' || !node.id.startsWith(`plugin:${id}:`) || !node.name || !node.qualifiedName ||
      !NODE_KINDS.includes(node.kind) || !LANGUAGES.includes(node.language) || !validPath(root, node.filePath) ||
      !Number.isInteger(node.startLine) || node.startLine < 1 || !Number.isInteger(node.endLine) || node.endLine < node.startLine ||
      !Number.isInteger(node.startColumn) || node.startColumn < 0 || !Number.isInteger(node.endColumn) || node.endColumn < 0) throw new Error('Invalid contributed node');
  return { ...node, updatedAt: 0 };
}
function validateEdge(edge: Edge, id: string): Edge {
  if (!edge || !edge.source || !edge.target || !EDGE_KINDS.includes(edge.kind) ||
      typeof edge.metadata?.label !== 'string' || !edge.metadata.label.trim() || edge.metadata.label.length > 160) throw new Error('Invalid contributed edge or missing label');
  return { ...edge, provenance: 'heuristic', metadata: { ...edge.metadata, synthesizedBy: id } };
}
function guardFramework(fw: FrameworkResolver, p: ResolvedPlugin, diag: PluginDiagnostic, root: string): FrameworkResolver {
  const id = p.manifest.id;
  function call<T>(hook: string, fallback: T, fn: () => T): T {
    if (diag.state === 'disabled') return fallback;
    try { return fn(); } catch (err) { disable(diag, hook, err); return fallback; }
  }
  return {
    name: `${id}:${fw.name}`, languages: fw.languages,
    detect: ctx => call('detect', false, () => fw.detect(ctx)),
    claimsReference: name => call('claimsReference', false, () => fw.claimsReference?.(name) ?? false),
    resolve: (ref, ctx) => call('resolve', null, () => {
      const r = fw.resolve(ref, ctx);
      if (!r) return null;
      if (!r.targetNodeId || !Number.isFinite(r.confidence) || r.confidence < 0 || r.confidence > 1 ||
          (r.edgeKind && !EDGE_KINDS.includes(r.edgeKind)) || (ctx.getNodeById && !ctx.getNodeById(r.targetNodeId))) throw new Error('Invalid resolved reference');
      if (typeof r.metadata?.label !== 'string' || !r.metadata.label) throw new Error('Resolved extension references require a label');
      return { ...r, original: ref, metadata: { ...r.metadata, synthesizedBy: id } };
    }),
    extract: fw.extract ? (file, source) => call('extract', { nodes: [], references: [] }, () => {
      const out = fw.extract!(file, source);
      const nodes = out.nodes.map(n => validateNode(n, id, root));
      const references = out.references.map((r: UnresolvedRef) => {
        if (!r.fromNodeId.startsWith(`plugin:${id}:`) || !nodes.some(n => n.id === r.fromNodeId) || !r.referenceName ||
            !validPath(root, r.filePath) || !Number.isInteger(r.line) || r.line < 1 || !Number.isInteger(r.column) || r.column < 0) throw new Error('Invalid contributed reference');
        return r;
      });
      return { nodes, references };
    }) : undefined,
    postExtract: fw.postExtract ? ctx => call('postExtract', [], () => fw.postExtract!(ctx).map(n => {
      validateNode(n, id, root);
      if (!ctx.getNodesInFile(n.filePath).some(existing => existing.id === n.id && existing.qualifiedName === n.qualifiedName)) throw new Error('postExtract must preserve node identity');
      return n;
    })) : undefined,
  };
}
