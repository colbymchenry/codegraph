/**
 * ExtJS Framework Resolver
 *
 * Detects common ExtJS patterns (Ext.define, Ext.application, Ext.create, xtype/alias, requires)
 * and emits framework-specific nodes + unresolved references for the resolution pass.
 */

import { Node } from '../../types';
import { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types';

export const extjsResolver: FrameworkResolver = {
  name: 'extjs',
  languages: ['javascript', 'typescript', 'jsx', 'tsx'],

  detect(context: ResolutionContext): boolean {
    // 1) package.json mention
    const pkg = context.readFile('package.json');
    if (pkg) {
      try {
        const parsed = JSON.parse(pkg);
        const deps = { ...parsed.dependencies, ...parsed.devDependencies };
        if (deps['extjs'] || deps['sencha'] || deps['@sencha']) return true;
      } catch {
        // ignore
      }
    }

    // 2) quick heuristic: any file containing "Ext.define" or "Ext.application"
    const all = context.getAllFiles();
    for (const f of all) {
      if (/\.(js|ts|jsx|tsx)$/.test(f) && context.readFile(f)?.includes('Ext.define') === true) {
        return true;
      }
      if (/\.(js|ts|jsx|tsx)$/.test(f) && context.readFile(f)?.includes('Ext.application') === true) {
        return true;
      }
    }

    return false;
  },

  // Framework-specific resolution: tries to map names like xtype/class references
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // If reference looks like a namespaced class (MyApp.view.Foo) try exact name
    if (/\w+(\.\w+)+/.test(ref.referenceName)) {
      const candidates = context.getNodesByQualifiedName(ref.referenceName);
      if (candidates && candidates.length > 0) {
        return {
          original: ref,
          targetNodeId: candidates[0].id,
          confidence: 0.9,
          resolvedBy: 'framework',
        };
      }
    }

    // xtype references are usually short strings; try to find component nodes by name
    if (ref.referenceKind === 'references' && typeof ref.referenceName === 'string' && ref.referenceName.includes('-')) {
      const nodes = context.getNodesByName(ref.referenceName);
      if (nodes.length === 1) {
        return {
          original: ref,
          targetNodeId: nodes[0].id,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  // Extract framework-specific nodes and unresolved references from a file's text
  extract(filePath: string, content: string) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // Helper: compute line number from index
    function lineAt(idx: number) {
      return content.slice(0, idx).split('\n').length;
    }

    // 1) Ext.define('MyApp.view.Main', { ... })
    const extDefineRe = /Ext\.define\s*\(\s*(['"`])([^'"`]+)\1\s*,/g;
    let m: RegExpExecArray | null;
    while ((m = extDefineRe.exec(content)) !== null) {
      const fullName = m[2];
      const ln = lineAt(m.index);
      const id = `extjs:class:${filePath}:${ln}:${fullName}`;
      nodes.push({
        id,
        kind: 'class',
        name: fullName.split('.').pop() || fullName,
        qualifiedName: fullName,
        filePath,
        startLine: ln,
        endLine: ln,
        startColumn: 0,
        endColumn: 0,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
        updatedAt: now,
      });

      // file -> class contains
      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: fullName,
        referenceKind: 'contains',
        line: ln,
        column: 0,
        filePath,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
      });

      // try to extract xtype / alias / requires inside the object literal window
      // window after match
      const windowText = content.slice(m.index, Math.min(content.length, m.index + 1200));
      // alias: 'widget.foo' or alias: ['widget.foo']
      const aliasRe = /alias\s*:\s*(?:\[\s*)?(['"`])([^'"`]+)\1/g;
      let am: RegExpExecArray | null;
      while ((am = aliasRe.exec(windowText)) !== null) {
        const alias = am[2];
        const aliasLine = ln + windowText.slice(0, am.index).split('\n').length - 1;
        const compId = `extjs:component:${filePath}:${aliasLine}:${alias}`;
        nodes.push({
          id: compId,
          kind: 'component',
          name: alias,
          qualifiedName: alias,
          filePath,
          startLine: aliasLine,
          endLine: aliasLine,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
          updatedAt: now,
        });

        references.push({
          fromNodeId: id,
          referenceName: alias,
          referenceKind: 'references',
          line: aliasLine,
          column: 0,
          filePath,
          language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
        });
      }

      // requires: ['MyApp.store.Users', ...]
      const requiresRe = /requires\s*:\s*\[\s*([^\]]+)\]/g;
      const rm = requiresRe.exec(windowText);
      if (rm) {
        const listText = rm[1];
        const itemRe = /(['"`])([^'"`]+)\1/g;
        let im: RegExpExecArray | null;
        while ((im = itemRe.exec(listText)) !== null) {
          const req = im[2];
          references.push({
            fromNodeId: id,
            referenceName: req,
            referenceKind: 'imports',
            line: ln,
            column: 0,
            filePath,
            language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
          });
        }
      }
    }

    // 2) Ext.create('MyApp.view.Foo', ...) -> reference to module/class
    const extCreateRe = /Ext\.create\s*\(\s*(['"`])([^'"`]+)\1/g;
    while ((m = extCreateRe.exec(content)) !== null) {
      const target = m[2];
      const ln = lineAt(m.index);
      references.push({
        fromNodeId: `file:${filePath}`,
        referenceName: target,
        referenceKind: 'references',
        line: ln,
        column: 0,
        filePath,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
      });
    }

    // 3) Ext.application({ controllers: [...], views: [...], stores: [...] })
    const appRe = /Ext\.application\s*\(\s*\{/g;
    while ((m = appRe.exec(content)) !== null) {
      const ln = lineAt(m.index);
      const win = content.slice(m.index, Math.min(content.length, m.index + 1200));
      // controllers/views/stores arrays
      const arrayFields = ['controllers', 'views', 'stores'];
      for (const field of arrayFields) {
        const fieldRe = new RegExp(`${field}\\s*:\\s*\\[([^\\]]*)\\]`, 'g');
        const fm = fieldRe.exec(win);
        if (!fm) continue;
        const list = fm[1];
        const itemRe = /(['"`])([^'"`]+)\1/g;
        let im: RegExpExecArray | null;
        while ((im = itemRe.exec(list)) !== null) {
          const name = im[2];
          const nodeKind = field === 'controllers' ? 'module' : 'component';
          const nodeId = `extjs:${nodeKind}:${filePath}:${ln}:${name}`;
          nodes.push({
            id: nodeId,
            kind: nodeKind as any,
            name: name.split('.').pop() || name,
            qualifiedName: name,
            filePath,
            startLine: ln,
            endLine: ln,
            startColumn: 0,
            endColumn: 0,
            language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
            updatedAt: now,
          });
          references.push({
            fromNodeId: `file:${filePath}`,
            referenceName: name,
            referenceKind: 'references',
            line: ln,
            column: 0,
            filePath,
            language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
          });
        }
      }
    }

    return { nodes, references };
  },
};
