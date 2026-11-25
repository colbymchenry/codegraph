/**
 * Terraform Framework Resolver
 *
 * Terraform's scoping rule is narrow and directory-shaped: `var.X`,
 * `local.X`, `module.M`, and resource/data references resolve ONLY inside
 * the same module directory as the reference site. The generic name matcher
 * resolves by qualified-name alone, so a reference to `var.project_id` from
 * `modules/net-vpc/main.tf` could bind to a `variable "project_id"` declared
 * in an unrelated module — a wrong cross-module edge that poisons impact
 * analysis. This resolver enforces the real semantics:
 *
 *   1. Same directory as the reference site → resolve (highest confidence).
 *   2. `.tfvars` files additionally walk UP to the nearest ancestor
 *      directory declaring the variable (`terraform apply -var-file=envs/prod.tfvars`
 *      sets ROOT module variables from a subdirectory).
 *   3. Otherwise: no edge. Terraform cannot reference across sibling module
 *      directories, so a non-local candidate is never a correct target.
 *
 * It also bridges the module boundary through `:`-scoped references that
 * only this resolver understands (see the extractor's emitModuleWiring):
 *
 *   - `module.M:file`       → the entry file of the module's local source
 *     directory (an `imports` edge, so a module call connects to the code
 *     it instantiates).
 *   - `module.M:var.<in>`   → the child module's `variable "<in>"` node —
 *     the module block sets that variable, so "what depends on the child's
 *     var.cidr" reaches every caller.
 *   - `module.M:output.<o>` → the child module's `output "<o>"` node —
 *     `module.M.o` uses flow through to the output's definition instead of
 *     dead-ending at the module declaration.
 *
 * The module's `source` is re-read from the declaration's file (cached
 * lines); only local `./`/`../` sources bridge. Registry/git sources stay
 * unresolved — an out-of-repo module is a visible boundary, never a guess.
 */

import * as path from 'path';
import type { Node } from '../../types';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

/** `module.M:file` / `module.M:var.X` / `module.M:output.X` / `module.M:remote-output.X` — extractor-emitted scoped refs. */
const SCOPED_REF = /^module\.([^.:\s]+):(file$|var\.|output\.|remote-output\.)/;

export const terraformResolver: FrameworkResolver = {
  name: 'terraform',
  languages: ['terraform'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => f.endsWith('.tf') || f.endsWith('.tfvars') || f.endsWith('.tofu'));
  },

  // Scoped refs name no declared symbol; opt them through the resolver's
  // name-exists pre-filter so they reach resolve() at all.
  claimsReference(name: string): boolean {
    return SCOPED_REF.test(name);
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'terraform') return null;

    const qname = ref.referenceName;
    const refDir = dirOf(ref.filePath);

    // --- module-boundary bridge: module.M:file / module.M:var.X / module.M:output.X ---
    const scoped = qname.match(/^module\.([^.:\s]+):(.+)$/);
    if (scoped) {
      return resolveScopedModuleRef(ref, scoped[1]!, scoped[2]!, refDir, context);
    }

    const candidates = context.getNodesByQualifiedName(qname);
    if (candidates.length === 0) return null;

    // 1. Same directory — the only scope Terraform can actually reference.
    const sameDir = candidates.filter((c) => dirOf(c.filePath) === refDir);
    if (sameDir.length > 0) {
      return {
        original: ref,
        targetNodeId: sameDir[0]!.id,
        confidence: 0.95,
        resolvedBy: 'framework',
      };
    }

    // 2. `.tfvars` assignments set ROOT module variables, and var-files are
    //    routinely kept in a subdirectory (`envs/prod.tfvars`). Walk up to
    //    the nearest ancestor directory that declares the variable.
    if (ref.filePath.endsWith('.tfvars') && qname.startsWith('var.')) {
      const up = nearestAncestorMatch(candidates, refDir);
      if (up) {
        return { original: ref, targetNodeId: up.id, confidence: 0.9, resolvedBy: 'framework' };
      }
    }

    // 2b. Provider configurations are the one construct Terraform inherits
    //     across the module tree: they're declared in the root (or a parent)
    //     module and passed down, so `provider = aws.east` inside a child
    //     module legitimately names a configuration declared above it.
    if (qname.startsWith('provider.')) {
      const configs = candidates.filter((c) => c.kind === 'namespace');
      const up = nearestAncestorMatch(configs, refDir);
      if (up) {
        return { original: ref, targetNodeId: up.id, confidence: 0.9, resolvedBy: 'framework' };
      }
      return null;
    }

    // 3. No same-directory declaration → no edge. A candidate in another
    //    module directory is never the real target (cross-module access only
    //    exists through module.M inputs/outputs, bridged above), and a wrong
    //    edge is worse than none.
    return null;
  },
};

/** Nearest candidate walking UP the directory tree from refDir (exclusive). */
function nearestAncestorMatch<T extends { filePath: string }>(candidates: T[], refDir: string): T | null {
  for (let dir = parentOf(refDir); dir !== null; dir = parentOf(dir)) {
    const inDir = candidates.filter((c) => dirOf(c.filePath) === dir);
    if (inDir.length > 0) return inDir[0]!;
  }
  return null;
}

/**
 * Resolve `module.M:<child>` by locating the `module "M"` declaration in the
 * reference's own directory, reading its `source` attribute, and looking the
 * child symbol up inside that directory.
 */
function resolveScopedModuleRef(
  ref: UnresolvedRef,
  moduleName: string,
  child: string,
  refDir: string,
  context: ResolutionContext
): ResolvedRef | null {
  const decls = context
    .getNodesByQualifiedName(`module.${moduleName}`)
    .filter((n) => n.kind === 'module');
  if (decls.length === 0) return null;
  // Terraform scoping: the declaration lives in the reference's directory.
  const decl = decls.find((d) => dirOf(d.filePath) === refDir) ?? (decls.length === 1 ? decls[0]! : null);
  if (!decl) return null;

  const source = readModuleAttr(decl, 'source', context);
  if (!source) return null;

  // --- cloudposse/atmos remote-state: module.M.outputs.X where M is the
  // stack-config remote-state module reading another COMPONENT's state. The
  // component name is static in the monorepo case (`component = "vpc"` or
  // "eks/cluster"), so bridge to that component directory's own
  // `output "X"` — but only when every gate holds: the module source is the
  // remote-state module, the component is a string literal, and exactly ONE
  // directory in the repo matches the component name and declares that
  // output. Anything dynamic or ambiguous stays a visible boundary.
  if (child.startsWith('remote-output.')) {
    if (!/\/remote-state(\/|$)/.test(source)) return null;
    let component = readModuleAttr(decl, 'component', context);
    if (!component) {
      // The other half of real-world declarations indirect through a
      // variable with a literal default in the same directory
      // (`component = var.vpc_component_name` + `default = "vpc"`) — the
      // component's declared static wiring. One hop, same literal gate.
      const viaVar = readNodeSpanMatch(decl, /^\s*component\s*=\s*var\.([A-Za-z0-9_-]+)\s*$/, context);
      if (viaVar) {
        const declared = context
          .getNodesByQualifiedName(`var.${viaVar}`)
          .filter((n) => dirOf(n.filePath) === dirOf(decl.filePath));
        if (declared.length === 1) {
          component = readNodeSpanMatch(declared[0]!, /^\s*default\s*=\s*"([^"]+)"/, context);
        }
      }
    }
    if (!component) return null;
    const outName = child.slice('remote-output.'.length);
    const outs = context
      .getNodesByQualifiedName(`output.${outName}`)
      .filter((o) => {
        const d = dirOf(o.filePath);
        return d === component || d.endsWith('/' + component);
      });
    if (outs.length === 0) return null;
    const dirs = new Set(outs.map((o) => dirOf(o.filePath)));
    if (dirs.size > 1) return null; // two directories claim this component name — never guess
    return { original: ref, targetNodeId: outs[0]!.id, confidence: 0.9, resolvedBy: 'framework' };
  }

  if (!(source.startsWith('./') || source.startsWith('../'))) {
    // Registry / git / absolute sources are out-of-repo: stay unresolved.
    return null;
  }
  const targetDir = normalizeRel(joinDirs(dirOf(decl.filePath), source));

  if (child === 'file') {
    const tfFiles = context
      .getAllFiles()
      .filter((f) => dirOf(f) === targetDir && (f.endsWith('.tf') || f.endsWith('.tofu')))
      .sort();
    if (tfFiles.length === 0) return null;
    const entry = tfFiles.find((f) => f.endsWith('/main.tf') || f === 'main.tf') ?? tfFiles[0]!;
    const fileNode = context.getNodesInFile(entry).find((n) => n.kind === 'file');
    if (!fileNode) return null;
    return { original: ref, targetNodeId: fileNode.id, confidence: 0.95, resolvedBy: 'framework' };
  }

  // child is `var.X` or `output.X` — the child module's own qualified names.
  const target = context
    .getNodesByQualifiedName(child)
    .filter((c) => dirOf(c.filePath) === targetDir);
  if (target.length === 0) return null;
  return { original: ref, targetNodeId: target[0]!.id, confidence: 0.95, resolvedBy: 'framework' };
}

/**
 * A direct string-literal attribute (`source = "…"`, `component = "…"`) of a
 * module declaration, re-read from its file (project paths are stored
 * relative; node metadata isn't persisted, so the declaration's line span +
 * cached file lines are the durable carrier). Non-literal values (variables,
 * expressions) return null — dynamic wiring is never guessed.
 */
function readModuleAttr(decl: Node, name: string, context: ResolutionContext): string | null {
  return readNodeSpanMatch(decl, new RegExp(`^\\s*${name}\\s*=\\s*"([^"]+)"`), context);
}

/** First capture of `re` across the node's line span, or null. */
function readNodeSpanMatch(node: Node, re: RegExp, context: ResolutionContext): string | null {
  const lines =
    context.getFileLines?.(node.filePath) ?? context.readFile(node.filePath)?.split('\n') ?? null;
  if (!lines) return null;
  const end = Math.min(node.endLine, lines.length);
  for (let i = Math.max(node.startLine - 1, 0); i < end; i++) {
    const m = lines[i]!.match(re);
    if (m) return m[1]!;
  }
  return null;
}

/** Directory of a stored (forward-slash, project-relative) path. */
function dirOf(p: string): string {
  const d = path.dirname(p);
  return d === '' ? '.' : d;
}

/** Parent directory, or null above the project root. */
function parentOf(dir: string): string | null {
  if (dir === '.' || dir === '') return null;
  const parent = path.dirname(dir);
  return parent === dir ? null : parent;
}

/** Join a base directory with a `./`/`../` relative source path. */
function joinDirs(base: string, rel: string): string {
  return path.join(base === '.' ? '' : base, rel);
}

/** Normalize to the stored path shape: forward slashes, '.' for the root. */
function normalizeRel(p: string): string {
  const n = path.normalize(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return n === '' ? '.' : n;
}
