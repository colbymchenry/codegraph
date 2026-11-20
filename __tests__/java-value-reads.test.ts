/**
 * `InferenceString.PARSER` reads that class's constant, not the `PARSER` of the
 * file reading it, but value references went by the identifier alone: a method
 * of elasticsearch's `RerankRequest` passed for a reader of its own `PARSER`
 * because it read `InferenceString.PARSER`. A read through a qualifier counts
 * when the qualifier is `this` or names the class that declares the constant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';

const FILES: Record<string, string> = {
  'src/p/Other.java': 'package p;\n\npublic class Other {\n    public static final Object PARSER = new Object();\n}\n',
  'src/p/Req.java': `package p;

public class Req {
    public static final Object PARSER = new Object();
    public static final Object FIELDS = new Object();

    public static class Inner {
        public static final Object DEEP_ONE = new Object();
    }

    Object foreign() {
        return Other.PARSER;
    }

    Object foreignChain() {
        return Other.PARSER.toString();
    }

    Object bare() {
        return PARSER;
    }

    Object ownClass() {
        return Req.PARSER;
    }

    Object viaThis() {
        return this.PARSER;
    }

    Object bothForms() {
        return Other.PARSER == null ? FIELDS : PARSER;
    }

    Object nested() {
        return Inner.DEEP_ONE;
    }
}
`,
};

describe('a Java read through a qualifier', () => {
  let dir: string;
  let cg: CodeGraph;

  const reads = (name: string): string[] => {
    const from = cg.getNodesByKind('method').find((m: Node) => m.name === name);
    expect(from, name).toBeDefined();
    return cg.getOutgoingEdges(from!.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!)
      .filter((n) => n.kind === 'constant').map((n) => n.qualifiedName).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-value-reads-'));
    for (const [rel, text] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), text);
    }
    cg = await CodeGraph.init(dir, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('keeps another class\'s constant from reading this file\'s', () => {
    expect(reads('foreign')).toEqual([]);
    expect(reads('foreignChain')).toEqual([]);
  });

  it('keeps a read that is bare, through the class itself, or through `this`', () => {
    expect(reads('bare')).toEqual(['p::Req::PARSER']);
    expect(reads('ownClass')).toEqual(['p::Req::PARSER']);
    expect(reads('viaThis')).toEqual(['p::Req::PARSER']);
    expect(reads('bothForms')).toEqual(['p::Req::FIELDS', 'p::Req::PARSER']);
    expect(reads('nested')).toEqual(['p::Req::Inner::DEEP_ONE']);
  });
});
