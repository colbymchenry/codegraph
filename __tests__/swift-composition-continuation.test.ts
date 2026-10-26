/**
 * A protocol composition continued on `&` lines, inside a type's body.
 *
 *     typealias EditorClient = AutocompleteService.Client
 *       & MediaUploadService.Client
 *
 * is valid Swift, but tree-sitter-swift ends the member at the newline and
 * the `&` line becomes an ERROR that swallows the whole enclosing type:
 * IceCubesApp's 980-line `EditorStore` class came out as loose variables and
 * functions, no class and no methods.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { joinSwiftCompositionContinuations as join } from '../src/extraction/languages/swift';

describe('joinSwiftCompositionContinuations', () => {
  it("moves a body declaration's line-leading & onto the line before, keeping length and lines", () => {
    const src = `class Store {
    typealias Client = A.Client
      & B.Client
      & C.Client
    let service: any P
      & Q
}
`;
    const out = join(src);
    expect(out.length).toBe(src.length);
    expect(out.split('\n').length).toBe(src.split('\n').length);
    expect(out).toBe(`class Store {
    typealias Client = A.Client&
       B.Client&
       C.Client
    let service: any P&
       Q
}
`);
  });

  it('keeps CRLF line ends', () => {
    const src = 'struct S {\r\n  typealias X = A\r\n    & B\r\n}\r\n';
    expect(join(src)).toBe('struct S {\r\n  typealias X = A&\r\n     B\r\n}\r\n');
  });

  it('leaves everything else as written', () => {
    for (const src of [
      // A top-level declaration parses as written.
      'typealias X = A\n    & B\n',
      // Logical and, overflow arithmetic, an inout argument: not compositions.
      'func f() {\n  let ok = a\n    && b\n  let n = x\n    &+ y\n  foo(\n    &z)\n}\n',
      // A trailing comment would swallow a moved `&`.
      'class C {\n  typealias X = A // the client\n    & B\n}\n',
      // An `&` line that continues no typealias / let / var.
      'class C {\n  func f() -> Int {\n    mask\n      & 1\n  }\n}\n',
    ]) {
      expect(join(src)).toBe(src);
    }
  });
});

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe('Swift: a type with a composition typealias is extracted whole', () => {
  it('keeps the class, its methods, its init and the protocols the typealias composes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-composition-'));
    projects.push(root);
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    };
    write(
      'Sources/Editor/Services.swift',
      `enum StatusEditor {}
extension StatusEditor {
    enum AutocompleteService { protocol Client {} }
    enum PostingService { protocol Client {} }
}
enum Assistant {
    static func prewarm() {}
}
`
    );
    write(
      'Sources/Editor/EditorStore.swift',
      `extension StatusEditor {
    final class EditorStore {
        typealias EditorClient = AutocompleteService.Client
          & PostingService.Client
        var client: (any EditorClient)?

        init() {
            #if !targetEnvironment(macCatalyst)
              Assistant.prewarm()
            #endif
        }

        func post() -> Bool { validate() }
        func validate() -> Bool { true }
    }
}
`
    );
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const inFile = cg.getNodesInFile('Sources/Editor/EditorStore.swift');
      const store = inFile.find((n) => n.name === 'EditorStore' && n.kind === 'class');
      expect(store?.qualifiedName).toBe('StatusEditor::EditorStore');
      expect(store?.endLine).toBe(15);
      expect(inFile.filter((n) => n.kind === 'method').map((n) => n.qualifiedName).sort()).toEqual([
        'StatusEditor::EditorStore::post',
        'StatusEditor::EditorStore::validate',
      ]);
      const post = inFile.find((n) => n.name === 'post')!;
      expect(cg.getCallees(post.id).map((c) => c.node.qualifiedName)).toEqual(['StatusEditor::EditorStore::validate']);
      // The call inside init's #if is no longer attributed to the file.
      const fileNode = inFile.find((n) => n.kind === 'file')!;
      expect(cg.getCallees(fileNode.id).map((c) => c.node.qualifiedName)).not.toContain('Assistant::prewarm');
      // The typealias's composed protocols, read on the rewritten `&` line one column left.
      const alias = inFile.find((n) => n.name === 'EditorClient')!;
      expect(cg.getCallees(alias.id).map((c) => c.node.qualifiedName).sort()).toEqual(
        expect.arrayContaining(['StatusEditor::AutocompleteService::Client', 'StatusEditor::PostingService::Client'])
      );
    } finally {
      cg.close();
    }
  });
});
