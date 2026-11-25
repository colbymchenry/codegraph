/**
 * testthat runs each test file in an environment of its own: a variable one
 * test assigns is invisible to the package and to other tests. ggplot2's
 * `c <- ggplot(…)` in one test took the package's 2,455 `c(…)` calls. A
 * `helper-*.R` file is sourced for every test, so its bindings stay shared,
 * and a package function defined through a factory
 * (`geom_point <- make_constructor(…)`) stays callable.
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

describe('R test-file bindings', () => {
  it('stay in their file, except helpers; package bindings stay callable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-r-tests-'));
    roots.push(root);
    const files: Record<string, string> = {
      DESCRIPTION: 'Package: demo\n',
      'R/geom-point.R': `geom_point <- make_constructor(GeomPoint)
table_of <- function() {
  c("a", "b")
}
`,
      'tests/testthat/helper-s3.R': `quux <- structure(list(), class = "quux")
`,
      'tests/testthat/test-scales.R': `c <- ggplot(df, aes(x, y))
test_that("works", {
  geom_point()
  quux()
})
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const targets = (file: string) =>
        cg
          .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id), ['calls'])
          .map((e) => `${cg.getNode(e.target)!.name}@${cg.getNode(e.target)!.filePath}`)
          .sort();
      expect(targets('R/geom-point.R')).toEqual([]);
      expect(targets('tests/testthat/test-scales.R')).toEqual(['geom_point@R/geom-point.R', 'quux@tests/testthat/helper-s3.R']);
    } finally {
      cg.close();
    }
  });
});
