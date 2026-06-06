/**
 * Terraform Framework Resolver
 *
 * Disambiguates Terraform references when the same qualified name exists in
 * multiple modules. The generic name matcher resolves by qualified-name only,
 * so a reference to `var.project_id` from `modules/net-vpc/main.tf` may bind
 * to a `variable "project_id"` declared in an unrelated module like
 * `modules/__experimental/net-neg/variables.tf`.
 *
 * Terraform's actual scoping rule is much narrower: `var.X`, `local.X`, and
 * unqualified resource refs only resolve inside the *same module directory*.
 * `module.M.<output>` is resolved against `modules/M/outputs.tf` etc. We
 * prefer:
 *   1. Same directory as the reference site (highest confidence).
 *   2. For `module.M` refs, the directory that contains a `module "M"` declaration.
 *   3. Closest common-ancestor directory (fallback for shared root files).
 */

import * as path from 'path';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const terraformResolver: FrameworkResolver = {
  name: 'terraform',
  languages: ['terraform'],

  detect(context: ResolutionContext): boolean {
    return context.getAllFiles().some((f) => f.endsWith('.tf') || f.endsWith('.tfvars') || f.endsWith('.tofu'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.language !== 'terraform') return null;

    const qname = ref.referenceName;
    const candidates = context.getNodesByQualifiedName(qname);
    if (candidates.length === 0) return null;

    const refDir = path.dirname(ref.filePath);

    if (candidates.length === 1) {
      // Cross-module module-output style refs (`module.M.<output>`) will only
      // ever have one variable matching `module.M`, but it could be anywhere
      // in the tree; same-dir preference still applies if present.
      const only = candidates[0]!;
      return {
        original: ref,
        targetNodeId: only.id,
        confidence: path.dirname(only.filePath) === refDir ? 0.95 : 0.8,
        resolvedBy: 'framework',
      };
    }

    // 1. Same directory wins — by far the most common case for var/local/resource refs.
    const sameDir = candidates.filter((c) => path.dirname(c.filePath) === refDir);
    if (sameDir.length > 0) {
      return {
        original: ref,
        targetNodeId: sameDir[0]!.id,
        confidence: 0.95,
        resolvedBy: 'framework',
      };
    }

    // 2. For `module.M[.X]` references, prefer the candidate whose directory
    //    matches the module name (e.g. `modules/iam` for `module.iam`).
    if (qname.startsWith('module.')) {
      const modName = qname.split('.')[1];
      if (modName) {
        const byModuleDir = candidates.filter((c) => path.dirname(c.filePath).split(path.sep).includes(modName));
        if (byModuleDir.length > 0) {
          return {
            original: ref,
            targetNodeId: byModuleDir[0]!.id,
            confidence: 0.85,
            resolvedBy: 'framework',
          };
        }
      }
    }

    // 3. Closest common-prefix directory among siblings.
    const ranked = [...candidates].sort(
      (a, b) => commonPathPrefixLength(b.filePath, ref.filePath) - commonPathPrefixLength(a.filePath, ref.filePath)
    );
    const best = ranked[0]!;
    return {
      original: ref,
      targetNodeId: best.id,
      // Lower confidence — this is a heuristic guess across modules.
      confidence: 0.6,
      resolvedBy: 'framework',
    };
  },
};

/** Length of the shared path prefix in path segments. */
function commonPathPrefixLength(a: string, b: string): number {
  const aSeg = path.dirname(a).split(path.sep);
  const bSeg = path.dirname(b).split(path.sep);
  const lim = Math.min(aSeg.length, bSeg.length);
  let i = 0;
  for (; i < lim; i++) {
    if (aSeg[i] !== bSeg[i]) break;
  }
  return i;
}

