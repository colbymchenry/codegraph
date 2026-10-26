/**
 * A Java enum constant or Kotlin enum entry with a body of its own
 * (`PLUS { int apply(…) { … } }`, `NewBuffer { override fun pipe() … }`)
 * declares members of its own, and the calls in them are calls. Neither
 * extractor visited those bodies: jsoup's tokenizer — an enum whose every
 * state implements `read` — was absent from the graph, 2,000 calls in all.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-enum-bodies-'));
  const files: Record<string, string> = {
    'src/main/java/app/Op.java': `package app;

public enum Op {
  PLUS {
    @Override
    int apply(int a, int b) {
      return helper(a) + b;
    }
  },
  MINUS {
    @Override
    int apply(int a, int b) { return a - b; }
  };

  abstract int apply(int a, int b);

  static int helper(int x) { return x; }
}
`,
    'src/main/kotlin/app/Factory.kt': `package app

enum class Factory {
  NewBuffer {
    override val isOneByteAtATime: Boolean
      get() = false

    override fun pipe(): Int {
      val buffer = 1
      return helper(buffer)
    }
  },
  Other {
    override val isOneByteAtATime: Boolean = true
    override fun pipe(): Int = 2
  };

  abstract val isOneByteAtATime: Boolean
  abstract fun pipe(): Int

  fun helper(x: Int): Int = x
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

const methods = (file: string) =>
  cg.getNodesInFile(file).filter((n) => n.kind === 'method').map((n) => n.qualifiedName).sort();

const calls = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => `${cg.getNode(e.source)!.qualifiedName} -> ${cg.getNode(e.target)!.qualifiedName}`)
    .sort();
};

describe('enum constants with bodies', () => {
  it('Java: each constant’s methods are extracted and their calls resolved', () => {
    expect(methods('src/main/java/app/Op.java')).toEqual([
      'app::Op::MINUS::apply',
      'app::Op::PLUS::apply',
      'app::Op::apply',
      'app::Op::helper',
    ]);
    expect(calls('src/main/java/app/Op.java')).toEqual(['app::Op::PLUS::apply -> app::Op::helper']);
  });

  it('Kotlin: each entry’s methods are extracted and their calls resolved', () => {
    expect(methods('src/main/kotlin/app/Factory.kt')).toEqual([
      'app::Factory::NewBuffer::pipe',
      'app::Factory::Other::pipe',
      'app::Factory::helper',
      'app::Factory::pipe',
    ]);
    expect(calls('src/main/kotlin/app/Factory.kt')).toEqual(['app::Factory::NewBuffer::pipe -> app::Factory::helper']);
  });
});
