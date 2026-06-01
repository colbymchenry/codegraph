import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * OdooExtractor — parses Odoo XML data files.
 *
 * Odoo's data files declare UI views, menu items, window actions, reports,
 * QWeb templates, and arbitrary model records using a thin XML DSL rooted at
 * <odoo> (v8+) or <openerp> (v7 and earlier). Without these symbols in the
 * graph, `trace` and `callers` dead-end at Python model methods — the views
 * and actions that drive the UI are invisible.
 *
 * Emits one node per significant XML declaration:
 *   <record model="M" id="X">  → kind='class',  qualifiedName='M::X'
 *   <template id="X">          → kind='method', qualifiedName='qweb::X'
 *   <menuitem id="X">          → kind='method', qualifiedName='ir.ui.menu::X'
 *   <act_window id="X">        → kind='method', qualifiedName='ir.actions.act_window::X'
 *   <report id="X">            → kind='method', qualifiedName='ir.actions.report::X'
 *
 * inherit_id and ref attributes on <template>/<record> emit unresolved
 * references so `codegraph_callers` can trace view inheritance chains.
 *
 * Non-Odoo XML (no <odoo>/<openerp> root) returns just a file node.
 */
export class OdooExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.computeLineStarts();
  }

  isOdooFile(): boolean {
    return /<(odoo|openerp)\b/.test(this.source);
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const fileNode = this.createFileNode();

    try {
      this.extractRecords(fileNode.id);
      this.extractTemplates(fileNode.id);
      this.extractShorthand(fileNode.id, 'menuitem', 'ir.ui.menu', ['action', 'parent', 'groups']);
      this.extractShorthand(fileNode.id, 'act_window', 'ir.actions.act_window', ['src_model']);
      this.extractShorthand(fileNode.id, 'report', 'ir.actions.report', ['model', 'file']);
      this.extractShorthand(fileNode.id, 'act_server', 'ir.actions.server');
      this.extractShorthand(fileNode.id, 'act_client', 'ir.actions.client');
      this.extractShorthand(fileNode.id, 'url', 'ir.actions.url');
      this.extractTCall(fileNode.id);
      this.extractGenericRef(fileNode.id);
      this.extractFieldTextContent(fileNode.id);
      this.extractFunctionTag(fileNode.id);
    } catch (error) {
      this.errors.push({
        message: `Odoo extraction error: ${error instanceof Error ? error.message : String(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  private createFileNode(): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId(this.filePath, 'file', this.filePath, 1);
    const node: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'xml',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private extractRecords(fileNodeId: string): void {
    const recordRegex = /<record\b([^>]*)>([\s\S]*?)<\/record>/g;
    let m: RegExpExecArray | null;
    while ((m = recordRegex.exec(this.source)) !== null) {
      const attrs = m[1] ?? '';
      const body = m[2] ?? '';
      const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs);
      const modelMatch = /\bmodel\s*=\s*"([^"]+)"/.exec(attrs);
      if (!idMatch) continue;
      const xmlId = idMatch[1]!;
      const model = modelMatch?.[1] ?? 'unknown';
      const qualified = `${model}::${xmlId}`;
      const startLine = this.getLineNumber(m.index);
      const endLine = this.getLineNumber(m.index + m[0].length);
      const nodeId = generateNodeId(this.filePath, 'class', qualified, startLine);
      const node: Node = {
        id: nodeId,
        kind: 'class',
        name: xmlId,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'xml',
        signature: `model=${model}`,
        startLine,
        endLine,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // <field name="inherit_id" ref="X"/> → view inheritance reference
      const inheritRegex = /<field\s+name\s*=\s*"inherit_id"\s+ref\s*=\s*"([^"]+)"/g;
      let inc: RegExpExecArray | null;
      const bodyOffset = m.index + attrs.length + '<record'.length + 1;
      while ((inc = inheritRegex.exec(body)) !== null) {
        this.unresolvedReferences.push({
          fromNodeId: nodeId,
          referenceName: inc[1]!,
          referenceKind: 'references',
          line: this.getLineNumber(bodyOffset + inc.index),
          column: 0,
        });
      }

      // <field name="arch" type="xml"> nested content → field refs + button(type=object) refs
      const archRegex = /<field\s+name\s*=\s*"arch"[^>]*>([\s\S]*?)<\/field>/g;
      let arch: RegExpExecArray | null;
      while ((arch = archRegex.exec(body)) !== null) {
        const archContent = arch[1]!;
        const archOffset = bodyOffset + arch.index + arch[0].indexOf(arch[1]!);
        // <field name="X"/> or <field name="X" ...>
        const fieldRef = /<field\b[^>]*\bname\s*=\s*"([^"]+)"/g;
        let fr: RegExpExecArray | null;
        while ((fr = fieldRef.exec(archContent)) !== null) {
          this.unresolvedReferences.push({
            fromNodeId: nodeId,
            referenceName: fr[1]!,
            referenceKind: 'references',
            line: this.getLineNumber(archOffset + fr.index),
            column: 0,
          });
        }
        // <button name="method" type="object"> → Python method reference
        const buttonRef = /<button\b[^>]*\btype\s*=\s*"object"[^>]*\bname\s*=\s*"([^"]+)"/g;
        let br: RegExpExecArray | null;
        while ((br = buttonRef.exec(archContent)) !== null) {
          this.unresolvedReferences.push({
            fromNodeId: nodeId,
            referenceName: br[1]!,
            referenceKind: 'references',
            line: this.getLineNumber(archOffset + br.index),
            column: 0,
          });
        }
        // Also catch <button name="X" type="object"> in reverse attr order
        const buttonRef2 = /<button\b[^>]*\bname\s*=\s*"([^"]+)"[^>]*\btype\s*=\s*"object"/g;
        let br2: RegExpExecArray | null;
        while ((br2 = buttonRef2.exec(archContent)) !== null) {
          this.unresolvedReferences.push({
            fromNodeId: nodeId,
            referenceName: br2[1]!,
            referenceKind: 'references',
            line: this.getLineNumber(archOffset + br2.index),
            column: 0,
          });
        }
        // T1-E: <label for="field_name"> → field ref
        const labelRef = /<label\b[^>]*\bfor\s*=\s*"([^"]+)"/g;
        let lr: RegExpExecArray | null;
        while ((lr = labelRef.exec(archContent)) !== null) {
          this.unresolvedReferences.push({
            fromNodeId: nodeId,
            referenceName: lr[1]!,
            referenceKind: 'references',
            line: this.getLineNumber(archOffset + lr.index),
            column: 0,
          });
        }
        // T2-C: <field groups="X"> → group ref
        const fieldGroups = /<field\b[^>]*\bgroups\s*=\s*"([^"]+)"/g;
        let fg: RegExpExecArray | null;
        while ((fg = fieldGroups.exec(archContent)) !== null) {
          this.unresolvedReferences.push({
            fromNodeId: nodeId,
            referenceName: fg[1]!,
            referenceKind: 'references',
            line: this.getLineNumber(archOffset + fg.index),
            column: 0,
          });
        }
        // T1-G: <filter name="X"> → ir.filters node + optional group_by field ref
        const filterRegex = /<filter\b([^>]*?)(?:\/>|>)/g;
        let fil: RegExpExecArray | null;
        while ((fil = filterRegex.exec(archContent)) !== null) {
          const filterAttrs = fil[1] ?? '';
          const fNameMatch = /\bname\s*=\s*"([^"]+)"/.exec(filterAttrs);
          if (!fNameMatch) continue;
          const filterName = fNameMatch[1]!;
          const filterLine = this.getLineNumber(archOffset + fil.index);
          const filterNodeId = generateNodeId(this.filePath, 'method', `ir.filters::${filterName}`, filterLine);
          this.nodes.push({
            id: filterNodeId,
            kind: 'method',
            name: filterName,
            qualifiedName: `ir.filters::${filterName}`,
            filePath: this.filePath,
            language: 'xml',
            startLine: filterLine,
            endLine: filterLine,
            startColumn: 0,
            endColumn: 0,
            updatedAt: Date.now(),
          });
          this.edges.push({ source: nodeId, target: filterNodeId, kind: 'contains' });
          const ctxMatch = /\bcontext\s*=\s*"([^"]+)"/.exec(filterAttrs);
          if (ctxMatch) {
            const gbMatch = /['"]group_by['"]\s*:\s*['"]([^'"]+)['"]/.exec(ctxMatch[1]!);
            if (gbMatch) {
              this.unresolvedReferences.push({
                fromNodeId: filterNodeId,
                referenceName: gbMatch[1]!,
                referenceKind: 'references',
                line: filterLine,
                column: 0,
              });
            }
          }
        }
        // T2-O: <xpath expr="//field[@name='X']"> or //button[@name='X'] → refs
        const xpathRef = /<xpath\b[^>]*\bexpr\s*=\s*"([^"]+)"/g;
        let xp: RegExpExecArray | null;
        while ((xp = xpathRef.exec(archContent)) !== null) {
          const expr = xp[1]!;
          const fieldInXpath = /\/\/field\[@name=['"]([^'"]+)['"]\]/.exec(expr);
          if (fieldInXpath) {
            this.unresolvedReferences.push({ fromNodeId: nodeId, referenceName: fieldInXpath[1]!, referenceKind: 'references', line: this.getLineNumber(archOffset + xp.index), column: 0 });
          }
          const btnInXpath = /\/\/button\[@name=['"]([^'"]+)['"]\]/.exec(expr);
          if (btnInXpath) {
            this.unresolvedReferences.push({ fromNodeId: nodeId, referenceName: btnInXpath[1]!, referenceKind: 'references', line: this.getLineNumber(archOffset + xp.index), column: 0 });
          }
        }
      }
      // T2-B: <field name="code"> embedded Python in ir.actions.server / ir.cron
      if (['ir.actions.server', 'ir.cron'].includes(model)) {
        const codeFieldRegex = /<field\s+name\s*=\s*"code"\s*>([\s\S]*?)<\/field>/g;
        let cf: RegExpExecArray | null;
        while ((cf = codeFieldRegex.exec(body)) !== null) {
          const codeContent = cf[1]!;
          const codeOffset = bodyOffset + cf.index + cf[0].indexOf(codeContent);
          const envModel = /self\.env\[['"]([a-z][a-z0-9_.]+)['"]\]/g;
          let em: RegExpExecArray | null;
          while ((em = envModel.exec(codeContent)) !== null) {
            this.unresolvedReferences.push({ fromNodeId: nodeId, referenceName: em[1]!, referenceKind: 'references', line: this.getLineNumber(codeOffset + em.index), column: 0 });
          }
          const envRef = /env\.ref\(['"]([^'"]+)['"]/g;
          let er: RegExpExecArray | null;
          while ((er = envRef.exec(codeContent)) !== null) {
            this.unresolvedReferences.push({ fromNodeId: nodeId, referenceName: er[1]!, referenceKind: 'references', line: this.getLineNumber(codeOffset + er.index), column: 0 });
          }
        }
      }
    }
  }

  private extractTemplates(fileNodeId: string): void {
    // Match both self-closing <template .../> and opening <template ...>
    const regex = /<template\b([^>]*?)(?:\/>|>)/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(this.source)) !== null) {
      const attrs = m[1] ?? '';
      const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs);
      if (!idMatch) continue;
      const xmlId = idMatch[1]!;
      const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(attrs);
      const inheritMatch = /\binherit_id\s*=\s*"([^"]+)"/.exec(attrs);
      const qualified = `qweb::${xmlId}`;
      const startLine = this.getLineNumber(m.index);
      const nodeId = generateNodeId(this.filePath, 'method', qualified, startLine);
      const node: Node = {
        id: nodeId,
        kind: 'method',
        name: xmlId,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'xml',
        signature: nameMatch?.[1] ? `name=${nameMatch[1]}` : undefined,
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      if (inheritMatch) {
        this.unresolvedReferences.push({
          fromNodeId: nodeId,
          referenceName: `qweb::${inheritMatch[1]}`,
          referenceKind: 'references',
          line: startLine,
          column: 0,
        });
      }
    }
  }

  private extractShorthand(fileNodeId: string, tag: string, namespace: string, refAttrs?: string[]): void {
    const regex = new RegExp(`<${tag}\\b([^>]*?)(?:\\/>|>)`, 'g');
    let m: RegExpExecArray | null;
    while ((m = regex.exec(this.source)) !== null) {
      const attrs = m[1] ?? '';
      const idMatch = /\bid\s*=\s*"([^"]+)"/.exec(attrs);
      if (!idMatch) continue;
      const xmlId = idMatch[1]!;
      const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(attrs);
      const modelMatch = /\bmodel\s*=\s*"([^"]+)"/.exec(attrs);
      const qualified = `${namespace}::${xmlId}`;
      const startLine = this.getLineNumber(m.index);
      const nodeId = generateNodeId(this.filePath, 'method', qualified, startLine);
      const sig = [
        nameMatch?.[1] && `name=${nameMatch[1]}`,
        modelMatch?.[1] && `model=${modelMatch[1]}`,
      ]
        .filter(Boolean)
        .join(' ') || undefined;
      const node: Node = {
        id: nodeId,
        kind: 'method',
        name: xmlId,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'xml',
        signature: sig,
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });
      // T1-C / T2-P: emit unresolved refs for specified attribute values (action, parent, groups, src_model, etc.)
      if (refAttrs) {
        for (const attrName of refAttrs) {
          const attrMatch = new RegExp(`\\b${attrName}\\s*=\\s*"([^"]+)"`).exec(attrs);
          if (attrMatch) {
            this.unresolvedReferences.push({
              fromNodeId: nodeId,
              referenceName: attrMatch[1]!,
              referenceKind: 'references',
              line: startLine,
              column: 0,
            });
          }
        }
      }
    }
  }

  /** t-call="module.template" → UnresolvedReference to qweb::template */
  private extractTCall(fileNodeId: string): void {
    const regex = /t-call\s*=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(this.source)) !== null) {
      const templateRef = m[1]!;
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: `qweb::${templateRef}`,
        referenceKind: 'references',
        line: this.getLineNumber(m.index),
        column: 0,
      });
    }
  }

  /** Generic ref="module.xml_id" on any <field> element → UnresolvedReference */
  private extractGenericRef(fileNodeId: string): void {
    // Skip inherit_id refs (already handled in extractRecords) — match any other field with ref=
    const regex = /<field\b[^>]*\bname\s*=\s*"(?!inherit_id)[^"]*"[^>]*\bref\s*=\s*"([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(this.source)) !== null) {
      this.unresolvedReferences.push({
        fromNodeId: fileNodeId,
        referenceName: m[1]!,
        referenceKind: 'references',
        line: this.getLineNumber(m.index),
        column: 0,
      });
    }
  }

  /** T1-F: <field name="res_model|model|...">dotted.model.name</field> → model ref */
  private extractFieldTextContent(fileNodeId: string): void {
    const modelFieldNames = ['res_model', 'src_model', 'model', 'model_name'];
    const pattern = new RegExp(
      `<field\\s+name\\s*=\\s*"(${modelFieldNames.join('|')})"\\s*>([^<]+)<\\/field>`,
      'g'
    );
    const modelPattern = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]+)+$/;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(this.source)) !== null) {
      const value = m[2]!.trim();
      if (modelPattern.test(value)) {
        this.unresolvedReferences.push({
          fromNodeId: fileNodeId,
          referenceName: value,
          referenceKind: 'references',
          line: this.getLineNumber(m.index),
          column: 0,
        });
      }
    }
  }

  /** T2-Q: <function model="M" name="N"> → model + method refs */
  private extractFunctionTag(fileNodeId: string): void {
    const regex = /<function\b([^>]*)>/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(this.source)) !== null) {
      const attrs = m[1] ?? '';
      const modelMatch = /\bmodel\s*=\s*"([^"]+)"/.exec(attrs);
      const nameMatch = /\bname\s*=\s*"([^"]+)"/.exec(attrs);
      const line = this.getLineNumber(m.index);
      if (modelMatch) {
        this.unresolvedReferences.push({ fromNodeId: fileNodeId, referenceName: modelMatch[1]!, referenceKind: 'references', line, column: 0 });
      }
      if (nameMatch) {
        this.unresolvedReferences.push({ fromNodeId: fileNodeId, referenceName: nameMatch[1]!, referenceKind: 'references', line, column: 0 });
      }
    }
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private getLineNumber(offset: number): number {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >>> 1;
      if (this.lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }
}
