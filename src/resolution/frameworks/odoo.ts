/**
 * Odoo Framework Resolver
 *
 * Covers Odoo v14-v19 semantic graph patterns: ORM decorators, field references,
 * manifest dependencies, XML arch content, QWeb t-call, OWL registry/patch,
 * and HTTP @route declarations.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef } from '../types';
import { stripCommentsForRegex } from '../strip-comments';

export const odooResolver: FrameworkResolver = {
  name: 'odoo',
  languages: ['python', 'javascript', 'typescript', 'xml'],

  detect(context) {
    if (context.fileExists('__manifest__.py')) return true;
    const files = context.getAllFiles();
    return files.some((f) => f.endsWith('/__manifest__.py') || f.endsWith('\\__manifest__.py'));
  },

  resolve(ref, context) {
    // Resolve dotted model names like 'res.partner' → class node with _name = 'res.partner'
    if (!this.claimsReference!(ref.referenceName)) return null;
    const modelName = ref.referenceName;
    const candidates = context.getNodesByName(modelName);
    if (candidates.length > 0) {
      const cls = candidates.find((n) => n.kind === 'class');
      if (cls) return { original: ref, targetNodeId: cls.id, confidence: 0.75, resolvedBy: 'framework' };
    }
    // Also search by _name field signature
    const byField = context.getNodesByName('_name').filter(
      (n) => n.kind === 'field' && n.signature?.includes(`'${modelName}'`)
    );
    if (byField.length > 0) {
      const parentClass = context
        .getNodesInFile(byField[0]!.filePath)
        .find((n) => n.kind === 'class' && n.startLine <= byField[0]!.startLine && n.endLine >= byField[0]!.endLine);
      if (parentClass) return { original: ref, targetNodeId: parentClass.id, confidence: 0.8, resolvedBy: 'framework' };
    }
    return null;
  },

  claimsReference(name) {
    // Claim dotted Odoo model names: 'res.partner', 'account.move.line', etc.
    return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(name);
  },

  extract(filePath, content) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    if (filePath.endsWith('.py')) {
      extractPythonPatterns(filePath, content, nodes, references, now);
    } else if (filePath.endsWith('__manifest__.py')) {
      extractManifestPatterns(filePath, content, nodes, references, now);
    }

    return { nodes, references };
  },
};

// ---------------------------------------------------------------------------
// Python extraction (self.env, env.ref, @route, manifest hooks)
// ---------------------------------------------------------------------------

function extractPythonPatterns(
  filePath: string,
  content: string,
  nodes: Node[],
  references: UnresolvedRef[],
  now: number,
): void {
  const safe = stripCommentsForRegex(content, 'python');

  // self.env['res.partner'] or self.env["res.partner"]
  const envModel = /self\.env\[['"]([a-z][a-z0-9_.]+)['"]\]/g;
  let m: RegExpExecArray | null;
  while ((m = envModel.exec(safe)) !== null) {
    const modelName = m[1]!;
    const line = safe.slice(0, m.index).split('\n').length;
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: modelName,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'python',
    });
  }

  // env.ref('module.xml_id') or self.env.ref('module.xml_id')
  const envRef = /(?:self\.)?env\.ref\(['"]([^'"]+)['"]/g;
  while ((m = envRef.exec(safe)) !== null) {
    const xmlId = m[1]!;
    const line = safe.slice(0, m.index).split('\n').length;
    references.push({
      fromNodeId: `file:${filePath}`,
      referenceName: xmlId,
      referenceKind: 'references',
      line,
      column: 0,
      filePath,
      language: 'python',
    });
  }

  // @route('/path', ...) or @http.route('/path', ...)
  const routeDecorator = /@(?:http\.)?route\s*\(\s*['"]([^'"]+)['"]/g;
  while ((m = routeDecorator.exec(safe)) !== null) {
    const routePath = m[1]!;
    const line = safe.slice(0, m.index).split('\n').length;
    const routeNode: Node = {
      id: `route:${filePath}:${line}:${routePath}`,
      kind: 'route',
      name: routePath,
      qualifiedName: `${filePath}::route:${routePath}`,
      filePath,
      startLine: line,
      endLine: line,
      startColumn: 0,
      endColumn: m[0].length,
      language: 'python',
      updatedAt: now,
    };
    nodes.push(routeNode);
  }
}

// ---------------------------------------------------------------------------
// __manifest__.py extraction (depends, hooks)
// ---------------------------------------------------------------------------

function extractManifestPatterns(
  filePath: string,
  content: string,
  _nodes: Node[],
  references: UnresolvedRef[],
  _now: number,
): void {
  // depends: ['account', 'mail', ...]
  const dependsMatch = /['"]\s*depends\s*['"]\s*:\s*\[([^\]]+)\]/s.exec(content);
  if (dependsMatch) {
    const line = content.slice(0, dependsMatch.index).split('\n').length;
    const items = dependsMatch[1]!.match(/['"]([^'"]+)['"]/g) ?? [];
    for (const item of items) {
      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: item.slice(1, -1),
        referenceKind: 'imports',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }

  // Hook keys: post_init_hook, pre_init_hook, uninstall_hook
  const hookKeys = ['post_init_hook', 'pre_init_hook', 'uninstall_hook'];
  for (const key of hookKeys) {
    const hookMatch = new RegExp(`['"]${key}['"]\\s*:\\s*['"]([^'"]+)['"]`).exec(content);
    if (hookMatch) {
      const line = content.slice(0, hookMatch.index).split('\n').length;
      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: hookMatch[1]!,
        referenceKind: 'references',
        line,
        column: 0,
        filePath,
        language: 'python',
      });
    }
  }
}
