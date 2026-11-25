/**
 * A bare Java type name is its package's type, an import's, or a nested type
 * in reach — inside its owner, a type deriving from it (an anonymous
 * `new NodeFilter() { … }` included), or written through its owner
 * (`new Retrofit.Builder()`). retrofit's `new Retrofit.Builder()` went to
 * `RequestFactory.Builder`, halo's micrometer `Counter` to its own
 * `core.extension.Counter`, and a constructor never stands in for its type.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-vis-'));
  const files: Record<string, string> = {
    'src/main/java/retrofit2/RequestFactory.java': `package retrofit2;

final class RequestFactory {
  static final class Builder {
    Builder() { }
  }
}
`,
    'src/main/java/retrofit2/Retrofit.java': `package retrofit2;

public final class Retrofit {
  public static final class Builder {
    public Builder() { }
  }
}
`,
    'src/test/java/retrofit2/CallTest.java': `package retrofit2;

class CallTest {
  Object make() {
    return new Retrofit.Builder();
  }
}
`,
    'src/main/java/run/halo/core/extension/Counter.java': `package run.halo.core.extension;

public class Counter { }
`,
    'src/main/java/run/halo/core/counter/MeterUtils.java': `package run.halo.core.counter;

import io.micrometer.core.instrument.Counter;

class MeterUtils {
  static Counter counter() { return null; }
}
`,
    'src/main/java/org/jsoup/select/NodeFilter.java': `package org.jsoup.select;

public interface NodeFilter {
  enum FilterResult { CONTINUE }
  FilterResult head(Object node);
}
`,
    'src/test/java/org/jsoup/select/TraversorTest.java': `package org.jsoup.select;

class TraversorTest {
  void filter() {
    run(new NodeFilter() {
      public FilterResult head(Object node) { return null; }
    });
  }
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

const targetsFrom = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind !== 'contains').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('bare Java type names', () => {
  it('written through their owner are that owner’s nested type, never a constructor', () => {
    const targets = targetsFrom('src/test/java/retrofit2/CallTest.java');
    expect(targets).toContain('retrofit2::Retrofit::Builder');
    expect(targets.filter((t) => t.startsWith('retrofit2::RequestFactory') || t.endsWith('::Builder::Builder'))).toEqual([]);
  });

  it('imported from a library are nothing in the project', () => {
    expect(targetsFrom('src/main/java/run/halo/core/counter/MeterUtils.java')).not.toContain('run.halo.core.extension::Counter');
  });

  it('reach a nested type of what an anonymous class implements', () => {
    expect(targetsFrom('src/test/java/org/jsoup/select/TraversorTest.java')).toContain('org.jsoup.select::NodeFilter::FilterResult');
  });
});
