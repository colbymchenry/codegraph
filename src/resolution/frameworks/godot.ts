import * as path from 'path';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const godotResolver: FrameworkResolver = {
  name: 'godot',
  languages: ['gdscript', 'godot_resource'],

  detect(context: ResolutionContext): boolean {
    return context.fileExists('project.godot')
      || context.getAllFiles().some((f) => f.endsWith('.tscn') || f.endsWith('.gd'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    const result = tryResolveResPath(ref, context);
    if (result) return result;

    const result2 = tryResolveUniqueName(ref, context);
    if (result2) return result2;

    const result3 = tryResolveGodotAlias(ref, context);
    if (result3) return result3;

    const result4 = tryResolveUid(ref, context);
    if (result4) return result4;

    const result5 = tryResolveSignal(ref, context);
    if (result5) return result5;

    return null;
  },

  claimsReference(name: string): boolean {
    return /^(BT|Limbo|BTAction|BTTask|BTDecorator|BTComposite|BTCondition)/.test(name);
  },
};

function tryResolveResPath(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!ref.referenceName.startsWith('res://')) return null;

  const relativePath = ref.referenceName.replace(/^res:\/\//, '');
  const projectRoot = context.getProjectRoot();
  const fsPath = path.join(projectRoot, relativePath);
  const normalized = path.normalize(fsPath);

  if (context.fileExists(normalized)) {
    const nodes = context.getNodesInFile(normalized);
    const fileNode = nodes.find((n) => n.kind === 'file');
    if (fileNode) {
      return {
        original: ref,
        targetNodeId: fileNode.id,
        confidence: 0.9,
        resolvedBy: 'file-path',
      };
    }
  }

  return null;
}

function tryResolveUniqueName(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName.startsWith('%') ? ref.referenceName.slice(1) : ref.referenceName;
  if (!name) return null;

  const target = context.getNodesByName(name).find(
    (n) => n.kind === 'component' && n.language === 'godot_resource'
  );
  if (target) {
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.85,
      resolvedBy: 'framework',
    };
  }

  return null;
}

function tryResolveSignal(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  if (!name || ref.referenceKind !== 'calls') return null;

  const target = context.getNodesByName(name).find(
    (n) => n.kind === 'signal' && n.language === 'gdscript'
  );
  if (target) {
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.85,
      resolvedBy: 'framework',
    };
  }

  return null;
}

function tryResolveUid(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const uid = ref.referenceName;
  if (!/^[a-z0-9]{16,}$/.test(uid)) return null;

  const nodes = context.getNodesByKind('import').filter(
    (n) => n.language === 'godot_resource'
  );
  for (const node of nodes) {
    if (node.qualifiedName.includes(uid) || node.name.includes(uid)) {
      return {
        original: ref,
        targetNodeId: node.id,
        confidence: 0.85,
        resolvedBy: 'framework',
      };
    }
  }

  return null;
}

function tryResolveGodotAlias(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const name = ref.referenceName;
  if (!/^[A-Z][A-Za-z0-9]*$/.test(name)) return null;

  const target = context.getNodesByKind('class').find(
    (n) => n.language === 'gdscript' && n.name === name
  );
  if (target) {
    return {
      original: ref,
      targetNodeId: target.id,
      confidence: 0.8,
      resolvedBy: 'framework',
    };
  }

  return null;
}
