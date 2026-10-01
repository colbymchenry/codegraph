/**
 * R looks a call's name up among functions only, skipping other bindings:
 * ggplot2's facet tests bind `c <- data_frame(b = 3)`, and every `c(1, 2)`
 * in those files — base R's `c` — went to that data frame. A project binding
 * made by a function factory (`geom_point <- make_constructor(…)`) stays.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-r-call-'));
  const files: Record<string, string> = {
    'DESCRIPTION': 'Package: ggplot2\n',
    'R/geom-point.R': `geom_point <- make_constructor(GeomPoint, position = "identity")
`,
    'tests/testthat/test-facet-wrap.R': `a <- data_frame(a = 1:3)
c <- data_frame(b = 3)

test_that("facets", {
  p <- geom_point()
  expect_equal(c(1, 2), a$a)
})
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

describe('R calls', () => {
  it('skip a data binding that shadows a base function, keep a factory-made function', () => {
    const ids = cg.getNodesInFile('tests/testthat/test-facet-wrap.R').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.name);
    expect(targets).not.toContain('c');
    expect(targets).toContain('geom_point');
  });
});
