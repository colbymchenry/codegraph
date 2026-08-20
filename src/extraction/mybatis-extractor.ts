import { Edge, ExtractionError, ExtractionResult, Node, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';

/**
 * MyBatisExtractor — parses MyBatis mapper XML files.
 *
 * MyBatis splits a DAO interface across two files: a Java interface (parsed by
 * tree-sitter) declares the method, and an XML mapper file holds the SQL keyed
 * by `<namespace>` (the fully-qualified Java type name) and `id` (the method
 * name). Without the XML side in the graph, `trace(Controller, ...DAO.method)`
 * dead-ends at the interface method — the SQL it actually runs is invisible,
 * and "what does this query touch" / "where is this column written" can't be
 * answered.
 *
 * This extractor emits one method-shaped node per `<select|insert|update|
 * delete>` and per `<sql>` fragment, qualified as `<namespace>::<id>` so the
 * MyBatis framework synthesizer can link the matching Java method → XML
 * statement by suffix-matching qualified names. `<include refid="...">` inside
 * a statement yields an unresolved reference to the SQL fragment, also keyed
 * by `<namespace>::<refid>`.
 *
 * Both dialects are covered: MyBatis 3 `<mapper namespace="...">` and the
 * legacy iBatis 2 `<sqlMap>` (namespaced, or namespace-less with `Map.stmt`
 * ids, plus its extra `<statement>`/`<procedure>` verbs). Attribute values may
 * use either quote style, and statements commented out with `<!-- ... -->` are
 * ignored (see the constructor's comment-stripping pre-pass).
 *
 * Non-mapper XML (Maven `pom.xml`, Spring beans XML, `web.xml`, log4j config,
 * etc.) is detected by the absence of a `<mapper namespace="...">` /
 * `<sqlMap>` root and returns just a file node — we still need the file row so
 * the watcher can track it, but we emit no symbols.
 */
export class MyBatisExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private lineStarts: number[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    // Blank out XML comments up front so commented-out statements and includes
    // aren't matched by the scans below (a `<!-- <select id="old">…</select> -->`
    // block must not produce a phantom node). Length-preserving — comment bytes
    // become spaces, newlines are kept — so the offsets and line numbers
    // computed afterwards still map to the original source. Text inside
    // `<![CDATA[ … ]]>` is left intact: a literal `<!--` there is SQL data, not
    // an XML comment.
    this.source = MyBatisExtractor.stripXmlComments(source);
    this.computeLineStarts();
  }

  private static stripXmlComments(source: string): string {
    const out = source.split('');
    const n = source.length;
    let i = 0;
    while (i < n) {
      if (source.startsWith('<![CDATA[', i)) {
        const end = source.indexOf(']]>', i + 9);
        i = end >= 0 ? end + 3 : n;
        continue;
      }
      if (source.startsWith('<!--', i)) {
        const end = source.indexOf('-->', i + 4);
        const stop = end >= 0 ? end + 3 : n;
        for (let j = i; j < stop; j++) {
          if (source.charCodeAt(j) !== 10) out[j] = ' ';
        }
        i = stop;
        continue;
      }
      i++;
    }
    return out.join('');
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const fileNode = this.createFileNode();

    try {
      const root = this.findMapperRoot();
      if (root) {
        this.extractMapper(fileNode.id, root.namespace, root.dialect, root.bodyStart, root.bodyEnd);
      }
    } catch (error) {
      this.errors.push({
        message: `MyBatis extraction error: ${error instanceof Error ? error.message : String(error)}`,
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

  /**
   * Find the mapper root and its dialect. Two shapes are recognized:
   *   - MyBatis 3: `<mapper namespace="com.foo.Bar">` — namespace required.
   *   - iBatis 2:  `<sqlMap namespace="Account">`, or a namespace-less
   *     `<sqlMap>` whose statement ids carry the qualifier as `Map.statement`.
   * Returns the namespace, the dialect, and the byte offsets of the body
   * (between the opening and closing tag) so statement extraction is scoped to
   * the root's contents. Either quote style is accepted for the namespace
   * (`namespace='X'` is legal XML and common in older mappers).
   */
  private findMapperRoot():
    | { namespace: string; dialect: 'mybatis' | 'ibatis'; bodyStart: number; bodyEnd: number }
    | null {
    const mapper = /<mapper\b([^>]*)>/.exec(this.source);
    if (mapper) {
      const nsMatch = /\bnamespace\s*=\s*(["'])([^"']+)\1/.exec(mapper[1] ?? '');
      if (nsMatch) {
        const bodyStart = mapper.index + mapper[0].length;
        const closeIdx = this.source.indexOf('</mapper>', bodyStart);
        return {
          namespace: nsMatch[2]!,
          dialect: 'mybatis',
          bodyStart,
          bodyEnd: closeIdx >= 0 ? closeIdx : this.source.length,
        };
      }
    }
    // iBatis 2 SqlMap. `\b` keeps `<sqlMapConfig>` (the iBatis config root,
    // which holds no statements) from matching here. namespace is optional.
    const sqlMap = /<sqlMap\b([^>]*)>/.exec(this.source);
    if (sqlMap) {
      const nsMatch = /\bnamespace\s*=\s*(["'])([^"']+)\1/.exec(sqlMap[1] ?? '');
      const bodyStart = sqlMap.index + sqlMap[0].length;
      const closeIdx = this.source.indexOf('</sqlMap>', bodyStart);
      return {
        namespace: nsMatch?.[2] ?? '',
        dialect: 'ibatis',
        bodyStart,
        bodyEnd: closeIdx >= 0 ? closeIdx : this.source.length,
      };
    }
    return null;
  }

  private extractMapper(
    fileNodeId: string,
    namespace: string,
    dialect: 'mybatis' | 'ibatis',
    bodyStart: number,
    bodyEnd: number
  ): void {
    const body = this.source.slice(bodyStart, bodyEnd);
    // Match each top-level statement-shaped element. The body may have nested
    // tags (`<if>`, `<foreach>`, `<include>`), so we scan with a regex that
    // pairs an opening tag to its matching close — the simple form below works
    // because MyBatis/iBatis statement elements are not themselves nested.
    // iBatis 2 adds the generic `<statement>` and `<procedure>` on top of the
    // MyBatis 3 verbs; gating by dialect keeps MyBatis extraction unchanged.
    const verbs =
      dialect === 'ibatis'
        ? 'select|insert|update|delete|sql|statement|procedure'
        : 'select|insert|update|delete|sql';
    const stmtRegex = new RegExp(`<(${verbs})\\b([^>]*)>([\\s\\S]*?)</\\1>`, 'g');
    let m: RegExpExecArray | null;
    while ((m = stmtRegex.exec(body)) !== null) {
      const elemType = m[1]!;
      const attrs = m[2] ?? '';
      const elemBody = m[3] ?? '';
      // Accept either quote style (`(["'])…\1`). The identifier-shaped MyBatis
      // attributes matched here and below (namespace/id/refid/resultType/
      // parameterType) are Java FQNs, method names, or type aliases and never
      // contain a quote character, so excluding both quotes from the value is safe.
      const idMatch = /\bid\s*=\s*(["'])([^"']+)\1/.exec(attrs);
      if (!idMatch) continue;
      const id = idMatch[2]!;
      const absoluteIndex = bodyStart + m.index;
      const startLine = this.getLineNumber(absoluteIndex);
      const endLine = this.getLineNumber(absoluteIndex + m[0].length);
      const { qualifiedName: qualified, name } = this.qualifyStatement(namespace, id);
      const isSqlFragment = elemType === 'sql';
      // The id-hash folds in the statement's byte offset (unique per statement
      // in the file), not just the start line: two statements sharing a
      // qualifiedName AND a start line — e.g. a vendor-split `databaseId` pair
      // (`<select id="x" databaseId="oracle">…</select><select id="x"
      // databaseId="mysql">…`) written on one line — would otherwise hash to
      // the same node id, and `INSERT OR REPLACE INTO nodes` (id is the PRIMARY
      // KEY) would silently drop one. qualifiedName and startLine are stored
      // unchanged, so the Java↔XML suffix-match bridge is untouched.
      const nodeId = generateNodeId(this.filePath, 'method', qualified, absoluteIndex);
      const node: Node = {
        id: nodeId,
        kind: 'method',
        name,
        qualifiedName: qualified,
        filePath: this.filePath,
        language: 'xml',
        signature: this.buildSignature(elemType, attrs, isSqlFragment),
        startLine,
        endLine,
        startColumn: 0,
        endColumn: 0,
        docstring: this.previewSql(elemBody),
        updatedAt: Date.now(),
      };
      this.nodes.push(node);
      this.edges.push({ source: fileNodeId, target: nodeId, kind: 'contains' });

      // <include refid="X"/> → reference to the SQL fragment in this mapper
      // (or in another mapper, when the refid is qualified — `ns.X`).
      const includeRegex = /<include\b[^>]*\brefid\s*=\s*(["'])([^"']+)\1/g;
      let inc: RegExpExecArray | null;
      while ((inc = includeRegex.exec(elemBody)) !== null) {
        const refid = inc[2]!;
        const refQualified = refid.includes('.')
          ? refid.replace(/\./g, '::')
          : namespace
            ? `${namespace}::${refid}`
            : refid;
        const includeOffset = absoluteIndex + (m[0].length - m[3]!.length - `</${elemType}>`.length) + inc.index;
        const line = this.getLineNumber(includeOffset);
        this.unresolvedReferences.push({
          fromNodeId: nodeId,
          referenceName: refQualified,
          referenceKind: 'references',
          line,
          column: 0,
        });
      }
    }
  }

  private buildSignature(elemType: string, attrs: string, isSqlFragment: boolean): string {
    if (isSqlFragment) return '<sql>';
    const verb = elemType.toUpperCase();
    const result = /\bresultType\s*=\s*(["'])([^"']+)\1/.exec(attrs)?.[2];
    const param = /\bparameterType\s*=\s*(["'])([^"']+)\1/.exec(attrs)?.[2];
    // A vendor-split statement carries `databaseId`; surface it so the two
    // otherwise-identical `<namespace>::<id>` nodes are distinguishable.
    const dbId = /\bdatabaseId\s*=\s*(["'])([^"']+)\1/.exec(attrs)?.[2];
    const parts = [verb];
    if (param) parts.push(`param=${param}`);
    if (result) parts.push(`result=${result}`);
    if (dbId) parts.push(`databaseId=${dbId}`);
    return parts.join(' ');
  }

  /**
   * Build the `<namespace>::<id>` qualified name the MyBatis synthesizer
   * suffix-matches against a Java `<Class>::<method>`, and the display name.
   * For a namespace-less iBatis `<sqlMap>`, the statement id carries the
   * qualifier as `Map.statement`, so split on the last dot to reach the same
   * shape (`Account.getById` → `Account::getById`, name `getById`).
   */
  private qualifyStatement(namespace: string, id: string): { qualifiedName: string; name: string } {
    if (namespace) return { qualifiedName: `${namespace}::${id}`, name: id };
    const dot = id.lastIndexOf('.');
    if (dot >= 0) {
      return { qualifiedName: `${id.slice(0, dot)}::${id.slice(dot + 1)}`, name: id.slice(dot + 1) };
    }
    return { qualifiedName: id, name: id };
  }

  private previewSql(body: string): string {
    return body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  }

  private computeLineStarts(): void {
    this.lineStarts = [0];
    for (let i = 0; i < this.source.length; i++) {
      if (this.source.charCodeAt(i) === 10) this.lineStarts.push(i + 1);
    }
  }

  private getLineNumber(offset: number): number {
    // Binary search
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
