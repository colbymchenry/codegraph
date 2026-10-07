/**
 * A Swift call on a just-constructed value — `URLQueryDecoder().decode(…)`,
 * `JSONDecoder().decode(…)` — is a member of the type constructed (or of what
 * it inherits), never some other type's method of that name: vapor's
 * `JSONDecoder().decode` went to a request's private
 * `_URLQueryContainer.decode`, and so did its own decoders' calls.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-constructed-'));
  const files: Record<string, string> = {
    'Sources/App/URLQueryDecoder.swift': `struct URLQueryDecoder {
    func decode<D>(_ type: D.Type) -> Int {
        return 0
    }
}
`,
    'Sources/App/Request.swift': `struct Request {
    struct _Container {
        func decode<D>(_ type: D.Type) -> Int {
            return 1
        }
    }
}
`,
    'Sources/App/Use.swift': `import Foundation

func run(data: Data) throws -> Int {
    let a = URLQueryDecoder().decode(Int.self)
    let b = try JSONDecoder().decode(Int.self, from: data)
    return a + b
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Swift calls on a constructed value', () => {
  it('reach the constructed type’s member, and no other type’s', () => {
    const run = cg.getNodesInFile('Sources/App/Use.swift').find((n) => n.name === 'run')!;
    const decodes = cg.getOutgoingEdges(run.id).filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!).filter((t) => t.name === 'decode').map((t) => t.qualifiedName);
    expect(decodes).toEqual(['URLQueryDecoder::decode']);
  });
});
