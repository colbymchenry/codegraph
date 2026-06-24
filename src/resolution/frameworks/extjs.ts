/**
 * ExtJS Framework Resolver
 *
 * Detects common ExtJS patterns (Ext.define, Ext.application, Ext.create, xtype/alias, requires)
 * and emits framework-specific nodes + unresolved references for the resolution pass.
 *
 * Note: This is a regex-based starter implementation. Future work: replace with
 * tree-sitter AST parsing for higher accuracy and support for more dynamic forms.
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
        // ignore invalid JSON
      }
    }

    // 2) Heuristic: look at likely ExtJS locations first to avoid reading every file
    const all = context.getAllFiles();
    const candidates = all.filter((f) => /\.(js|ts|jsx|tsx)$/.test(f)).filter((f) =>
      f.includes('/app/') || f.includes('/view') || f.includes('/views') || f.includes('/app/view') || f.includes('ext')
    ).slice(0, 200);

    for (const f of candidates) {
      const txt = context.readFile(f);
      if (!txt) continue;
      if (txt.includes('Ext.define') || txt.includes('Ext.application') || txt.includes('Ext.create')) return true;
    }

    // Fallback: sample a few JS/TS files (cheap) if nothing found above
    const sample = all.filter((f) => /\.(js|ts|jsx|tsx)$/.test(f)).slice(0, 200);
    for (const f of sample) {
      const txt = context.readFile(f);
      if (!txt) continue;
      if (txt.includes('Ext.define') || txt.includes('Ext.application') || txt.includes('Ext.create')) return true;
    }

    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // If reference looks like a namespaced class (MyApp.view.Foo) try exact qualified name
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

    // xtype references often contain a dash (widget-name). Try name lookup.
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

  extract(filePath: string, content: string) {
    const nodes: Node[] = [];
    const references: UnresolvedRef[] = [];
    const now = Date.now();

    // Dedup helpers scoped to this extraction run
    const seenNodes = new Set<string>();
    const seenRefs = new Set<string>();
    function pushNodeMaybe(n: Node) {
      const key = `${n.kind}::${n.qualifiedName}::${n.filePath}`;
      if (seenNodes.has(key)) return;
      seenNodes.add(key);
      nodes.push(n);
    }
    function pushRefMaybe(r: UnresolvedRef) {
      const key = `${r.fromNodeId}::${r.referenceKind}::${r.referenceName}::${r.line}`;
      if (seenRefs.has(key)) return;
      seenRefs.add(key);
      references.push(r);
    }

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

      const classNode: Node = {
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
      };

      pushNodeMaybe(classNode);

      // Represent that this file contains this class (use class node as subject)
      pushRefMaybe({
        fromNodeId: id,
        referenceName: fullName,
        referenceKind: 'contains',
        line: ln,
        column: 0,
        filePath,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
      });

      // window of text after the define to find alias/xtype/requires inside object literal
      const windowText = content.slice(m.index, Math.min(content.length, m.index + 1200));

      // alias may be a string or an array: alias: 'widget.x' OR alias: ['widget.x','widget.y']
      const aliasItemRe = /(['"`])([^'"`]+)\1/g;
      const aliasArrayRe = /alias\s*:\s*\[([^\]]*)\]/g;
      const aliasSingleRe = /alias\s*:\s*(['"`])([^'"`]+)\1/;

      let ar: RegExpExecArray | null;
      if ((ar = aliasArrayRe.exec(windowText)) !== null) {
        const listText = ar[1];
        let im: RegExpExecArray | null;
        while ((im = aliasItemRe.exec(listText)) !== null) {
          const alias = im[2];
          const aliasLine = ln + windowText.slice(0, ar.index + im.index).split('\n').length - 1;
          const compId = `extjs:component:${filePath}:${aliasLine}:${alias}`;
          pushNodeMaybe({
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
          pushRefMaybe({
            fromNodeId: id,
            referenceName: alias,
            referenceKind: 'references',
            line: aliasLine,
            column: 0,
            filePath,
            language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
          });
        }
      } else if ((ar = aliasSingleRe.exec(windowText)) !== null) {
        const alias = ar[2];
        const aliasLine = ln + windowText.slice(0, ar.index).split('\n').length - 1;
        const compId = `extjs:component:${filePath}:${aliasLine}:${alias}`;
        pushNodeMaybe({
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
        pushRefMaybe({
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
      const requiresRe = /requires\s*:\s*\[([^\]]*)\]/g;
      const rm = requiresRe.exec(windowText);
      if (rm) {
        const listText = rm[1];
        let im: RegExpExecArray | null;
        while ((im = aliasItemRe.exec(listText)) !== null) {
          const req = im[2];
          pushRefMaybe({
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

      // alternateClassName sometimes defines legacy names
      const altRe = /alternateClassName\s*:\s*(['"`])([^'"`]+)\1/g;
      let altm: RegExpExecArray | null;
      while ((altm = altRe.exec(windowText)) !== null) {
        const alt = altm[2];
        pushRefMaybe({
          fromNodeId: id,
          referenceName: alt,
          referenceKind: 'references',
          line: ln,
          column: 0,
          filePath,
          language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
        });
      }
    }

    // 2) Ext.create('MyApp.view.Foo', ...) -> reference to module/class
    const extCreateRe = /Ext\.create\s*\(\s*(['"`])([^'"`]+)\1/g;
    while ((m = extCreateRe.exec(content)) !== null) {
      const target = m[2];
      const ln = lineAt(m.index);
      pushRefMaybe({
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
          pushNodeMaybe({
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
          pushRefMaybe({
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

    // 4) Extract inline xtype occurrences anywhere in the file (items: [{ xtype: 'grid' }])
    const xtypeRe = /xtype\s*:\s*(['"`])([^'"`]+)\1/g;
    let xm: RegExpExecArray | null;
    while ((xm = xtypeRe.exec(content)) !== null) {
      const xtype = xm[2];
      const xtypeLine = lineAt(xm.index);
      const compId = `extjs:component:${filePath}:${xtypeLine}:${xtype}`;
      pushNodeMaybe({
        id: compId,
        kind: 'component',
        name: xtype,
        qualifiedName: xtype,
        filePath,
        startLine: xtypeLine,
        endLine: xtypeLine,
        startColumn: 0,
        endColumn: 0,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
        updatedAt: now,
      });
      pushRefMaybe({
        fromNodeId: `file:${filePath}`,
        referenceName: xtype,
        referenceKind: 'references',
        line: xtypeLine,
        column: 0,
        filePath,
        language: filePath.endsWith('.ts') ? 'typescript' : 'javascript',
      });
    }

    return { nodes, references };
  },
};
