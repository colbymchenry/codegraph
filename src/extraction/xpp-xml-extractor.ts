import { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference } from '../types';
import { generateNodeId } from './tree-sitter-helpers';
import { getParser } from './grammars';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stitchXppSource, remapLine } = require('tree-sitter-xpp/lib/d365-xml');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractXppSymbols } = require('tree-sitter-xpp/lib/symbols');

/**
 * XppXmlExtractor — Dynamics 365 Finance & Operations X++ source embedded in
 * D365 AOT XML metadata (`AxClass/Foo.xml`, `AxTable/Bar.xml`, ...).
 *
 * D365FO does not store X++ as standalone files. A `PackagesLocalDirectory`
 * export splits source across disjoint XML text nodes (`SourceCode/
 * Declaration` + one `SourceCode/Methods/Method/Source` per method); see
 * `tree-sitter-xpp`'s `lib/d365-xml.js` for the exact shapes per AOT object
 * type (`AxClass`/`AxTable`/`AxForm`/`AxQuery`/`AxMacroDictionary`/...).
 *
 * Unlike RazorExtractor (which delegates embedded C# to the generic
 * TreeSitterExtractor but keeps only its `unresolvedReferences`, discarding
 * nodes/edges — markup is a reference *source*, not something to index in
 * its own right), this extractor emits real `class`/`method` nodes: X++
 * classes are first-class, independently queryable/traceable symbols, the
 * same as any other language here. It does NOT go through the generic
 * TreeSitterExtractor/LanguageExtractor engine — that engine's call-site and
 * inheritance extraction (`extractCall`/`extractInheritance` in
 * `tree-sitter.ts`) hardcode a per-language branch for each grammar's
 * member-access node shape (see the `csharp`-specific `member_access_expression`
 * branch), so wiring a new language through it means editing that shared
 * engine. tree-sitter-xpp's own `lib/symbols.js` already provides an
 * equivalent, consumer-agnostic class/method/call walker (ported from and
 * verified against GitNexus's production `xpp-processor.ts`), so this
 * extractor uses that directly — self-contained, no core-engine changes.
 *
 * Extends/ExtensionOf/Calls are emitted as `unresolvedReferences` (by name,
 * unresolved) exactly like every other language here — CodeGraph's existing
 * `ReferenceResolver`/`name-matcher.ts` does the cross-file resolution
 * generically, including a case-insensitive fuzzy fallback pass, which is
 * enough for D365FO's case-insensitive AOT object-name convention without any
 * xpp-specific resolution code.
 *
 * `[ExtensionOf(classStr(Target))]` (D365FO's class-extension customization
 * mechanism — an extension class's members are compile-time merged into the
 * target's own namespace, not a subclass relationship) is mapped to an
 * `extends`-kind reference: CodeGraph's `EdgeKind` has no bespoke kind for
 * this distinct relationship, and `extends` is the closer fit for graph
 * traversal/impact-analysis purposes than any of the other kinds.
 */
export class XppXmlExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    try {
      const fileNode = this.createFileNode();

      let stitched: { code: string; chunks: Array<{ stitchedStartLine: number; originalStartLine: number }> } | null;
      try {
        stitched = stitchXppSource(this.source);
      } catch (error) {
        this.errors.push({
          message: `X++ XML stitching error: ${error instanceof Error ? error.message : String(error)}`,
          filePath: this.filePath,
          severity: 'error',
          code: 'parse_error',
        });
        stitched = null;
      }

      // No SourceCode/Declaration to extract (e.g. metadata-only AOT elements
      // with no code-behind) — the file node above is still emitted so the
      // watcher tracks it, matching how non-mapper XML degrades in MyBatisExtractor.
      if (!stitched) {
        return this.finish(startTime);
      }

      const parser = getParser('xpp');
      if (!parser) {
        this.errors.push({
          message: 'Failed to get parser for language: xpp',
          filePath: this.filePath,
          severity: 'error',
          code: 'parser_error',
        });
        return this.finish(startTime);
      }

      const tree = parser.parse(stitched.code);
      if (!tree) {
        this.errors.push({
          message: 'X++ parser returned null tree',
          filePath: this.filePath,
          severity: 'error',
          code: 'parse_error',
        });
        return this.finish(startTime);
      }

      const { classes } = extractXppSymbols(tree);
      for (const cls of classes) {
        this.mapClass(cls, stitched.chunks, fileNode.id);
      }
    } catch (error) {
      this.errors.push({
        message: `X++ extraction error: ${error instanceof Error ? error.message : String(error)}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    }
    return this.finish(startTime);
  }

  private finish(startTime: number): ExtractionResult {
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
    const node: Node = {
      id: generateNodeId(this.filePath, 'file', this.filePath, 1),
      kind: 'file',
      name: this.filePath.split(/[/\\]/).pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language: 'xpp',
      startLine: 1,
      endLine: lines.length || 1,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(node);
    return node;
  }

  private mapClass(
    cls: {
      name: string;
      startRow: number;
      endRow: number;
      superclassName: string | null;
      extensionOfTarget: string | null;
      methods: Array<{ name: string; startRow: number; endRow: number; calls: string[] }>;
    },
    chunks: Array<{ stitchedStartLine: number; originalStartLine: number }>,
    fileNodeId: string,
  ): void {
    const startLine = remapLine(chunks, cls.startRow) + 1;
    const endLine = remapLine(chunks, cls.endRow) + 1;
    const classId = generateNodeId(this.filePath, 'class', cls.name, startLine);

    this.nodes.push({
      id: classId,
      kind: 'class',
      name: cls.name,
      qualifiedName: `${this.filePath}::${cls.name}`,
      filePath: this.filePath,
      language: 'xpp',
      startLine,
      endLine,
      startColumn: 0,
      endColumn: 0,
      isExported: true,
      updatedAt: Date.now(),
    });
    this.edges.push({
      source: fileNodeId,
      target: classId,
      kind: 'contains',
    });

    if (cls.superclassName) {
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: cls.superclassName,
        referenceKind: 'extends',
        line: startLine,
        column: 0,
        filePath: this.filePath,
        language: 'xpp',
      });
    }
    // See the class-level doc comment for why [ExtensionOf(...)] maps to `extends`.
    if (cls.extensionOfTarget) {
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: cls.extensionOfTarget,
        referenceKind: 'extends',
        line: startLine,
        column: 0,
        filePath: this.filePath,
        language: 'xpp',
      });
    }

    for (const method of cls.methods) {
      const methodStartLine = remapLine(chunks, method.startRow) + 1;
      const methodEndLine = remapLine(chunks, method.endRow) + 1;
      const methodId = generateNodeId(
        this.filePath,
        'method',
        `${cls.name}.${method.name}`,
        methodStartLine,
      );

      this.nodes.push({
        id: methodId,
        kind: 'method',
        name: method.name,
        qualifiedName: `${this.filePath}::${cls.name}.${method.name}`,
        filePath: this.filePath,
        language: 'xpp',
        startLine: methodStartLine,
        endLine: methodEndLine,
        startColumn: 0,
        endColumn: 0,
        isExported: true,
        updatedAt: Date.now(),
      });
      this.edges.push({
        source: classId,
        target: methodId,
        kind: 'contains',
      });

      for (const callName of method.calls) {
        this.unresolvedReferences.push({
          fromNodeId: methodId,
          referenceName: callName,
          referenceKind: 'calls',
          line: methodStartLine,
          column: 0,
          filePath: this.filePath,
          language: 'xpp',
        });
      }
    }
  }
}
