/**
 * The last-resort fuzzy match compares names without regard to case. That
 * is right for PHP, Pascal, CFML, COBOL and VB.NET, whose identifiers
 * resolve that way, and wrong everywhere else: jsoup's 1,844 `@Test`
 * annotations decorated a `CharPredicate.test` method, `new CookieManager()`
 * instantiated a `cookieManager()` getter, gson's `Method` type referenced a
 * test's `method()`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fuzzy-case-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return CodeGraph.init(root, { index: true });
}

const targetsFrom = (cg: CodeGraph, file: string): string[] =>
  cg
    .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
    .filter((e) => e.kind !== 'contains')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${n.kind}:${n.name}`)
    .sort();

describe('fuzzy matching and case', () => {
  it('Java: an annotation or a type is not a method whose name differs only in case', async () => {
    const cg = await project({
      'src/main/java/app/CharPredicate.java': `package app;
public interface CharPredicate {
  boolean test(char c);
}
`,
      'src/main/java/app/Request.java': `package app;
public class Request {
  public Object cookieManager() { return null; }
}
`,
      'src/test/java/app/ParserTest.java': `package app;
import org.junit.jupiter.api.Test;
import java.net.CookieManager;
public class ParserTest {
  @Test void parses() {
    Object manager = new CookieManager();
  }
}
`,
    });
    try {
      const targets = targetsFrom(cg, 'src/test/java/app/ParserTest.java');
      expect(targets).not.toContain('method:test');
      expect(targets).not.toContain('method:cookieManager');
    } finally {
      cg.close();
    }
  });

  it('PHP still resolves a function whatever case the call is written in', async () => {
    const cg = await project({
      'src/helpers.php': `<?php
function FormatPrice($amount) { return $amount; }
`,
      'src/view.php': `<?php
function render() { return formatprice(10); }
`,
    });
    try {
      expect(targetsFrom(cg, 'src/view.php')).toContain('function:FormatPrice');
    } finally {
      cg.close();
    }
  });

  it('PHP: a call written after `=>` in an array is a function call, not some class’s method', async () => {
    const cg = await project({
      'app/CommentTree.php': `<?php
class CommentTree {
  public function count(): int { return 0; }
}
`,
      'app/helpers.php': `<?php
function user() { return null; }
`,
      'app/Controller.php': `<?php
function summary($items) {
  return ['total' => count($items), 'by' => user()];
}
`,
    });
    try {
      const targets = targetsFrom(cg, 'app/Controller.php');
      expect(targets).not.toContain('method:count');
      expect(targets).toContain('function:user');
    } finally {
      cg.close();
    }
  });
});
