/**
 * A Java receiver's declared type is read through generics and for-each
 * loops (`final Pair<L, R> pair`, `for (Element el : this)`), from a field of
 * the class (`private DateFormat dateTimeParser;` — outside the project, so
 * no edge), or as the bound of a type parameter (`T extends ExceptionContext`).
 * A constant's receiver is its type (`Phase.CONTROLLERS.getPhase()`). None of
 * these fall back to a same-named method of some other project class:
 * commons-lang's `dateTimeParser.parse(…)` went to its own `DateParser.parse`
 * 284 times.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-receiver-'));
  const files: Record<string, string> = {
    'src/main/java/app/Pair.java': `package app;

public abstract class Pair<L, R> {
    public abstract L getKey();
}
`,
    'src/main/java/app/MutablePair.java': `package app;

public class MutablePair<L, R> extends Pair<L, R> {
    private L left;

    public L getKey() { return left; }

    /**
     * Copies the key of each element into this pair.
     */
    public void setValue(final Pair<L, R> pair) {
        left = pair.getKey();
    }
}
`,
    'src/main/java/app/DateParser.java': `package app;

public interface DateParser {
    Object parse(String source);
}
`,
    'src/main/java/app/Element.java': `package app;

public class Element {
    public void val(String value) { }
}
`,
    'src/main/java/app/Elements.java': `package app;

import java.util.ArrayList;

public class Elements extends ArrayList<Element> {
    public Elements val(String value) {
        for (Element element : this)
            element.val(value);
        return this;
    }
}
`,
    'src/main/java/app/Phase.java': `package app;

public enum Phase {
    CONTROLLERS;

    public int getPhase() { return 0; }
}
`,
    'src/main/java/app/ExceptionContext.java': `package app;

public interface ExceptionContext {
    int getContextEntries();
}
`,
    'src/test/java/app/DateUtilsTest.java': `package app;

import java.text.DateFormat;

public abstract class DateUtilsTest<T extends ExceptionContext> {
    private DateFormat dateTimeParser;
    protected T exceptionContext;

    void rounds() throws Exception {
        dateTimeParser.parse("January 1, 2008");
        exceptionContext.getContextEntries();
        Phase.CONTROLLERS.getPhase();
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

/** `Owner::member` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!.qualifiedName)
    .sort();
}

describe('Java calls through declared receivers', () => {
  it('read a generic parameter’s type', () => {
    expect(callsFrom('src/main/java/app/MutablePair.java')).toEqual(['app::Pair::getKey']);
  });

  it('read a for-each variable’s type', () => {
    expect(callsFrom('src/main/java/app/Elements.java')).toEqual(['app::Element::val']);
  });

  it('follow a field’s type, a type parameter’s bound and a constant’s type — and stop at an outside type', () => {
    expect(callsFrom('src/test/java/app/DateUtilsTest.java')).toEqual([
      'app::ExceptionContext::getContextEntries',
      'app::Phase::getPhase',
    ]);
  });
});
