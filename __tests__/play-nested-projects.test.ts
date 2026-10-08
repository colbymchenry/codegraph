/**
 * A repository of Play projects — playframework/play-samples keeps each one's
 * `conf/routes` in its own directory, with no build at the root — still reads
 * as Play: it had no routes at all.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-play-nested-'));
  const files: Record<string, string> = {
    'play-java-hello/conf/routes': `GET     /                controllers.HomeController.index()
GET     /count           controllers.CountController.count()
`,
    'play-java-hello/app/controllers/HomeController.java': `package controllers;
public class HomeController {
    public Result index() { return null; }
}
`,
    'play-java-hello/app/controllers/CountController.java': `package controllers;
public class CountController {
    public Result count() { return null; }
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

describe('Play projects in subdirectories', () => {
  it('have their routes, linked to the actions', () => {
    const routes = cg.getNodesByKind('route');
    expect(routes.map((r) => r.name).sort()).toEqual(['GET /', 'GET /count']);
    const count = routes.find((r) => r.name === 'GET /count')!;
    const target = cg.getOutgoingEdges(count.id).map((e) => cg.getNode(e.target)!.qualifiedName);
    expect(target.some((t) => t.endsWith('CountController::count'))).toBe(true);
  });
});
