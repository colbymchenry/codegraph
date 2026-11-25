/**
 * A vendored minified script's names are mangled, so no other file's call
 * means one of them by name: healthchecks' 369 `$(…)` calls — jQuery, loaded
 * as a global — went to a one-letter helper inside bootstrap-native.min.js.
 * Detected by name (`*.min.js`) or by text (a few enormous lines).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-minified-'));
  const bundle = `!function(){${Array.from({ length: 120 }, (_, i) => `function f${i}(e,t){return e+t+${i}}`).join(';')};function u(e){return f1(e,2)}}();\n`;
  const files: Record<string, string> = {
    'static/js/vendor.min.js': `function $(e){return document.querySelector(e)}function q(e){return $(e)}\n`,
    'static/js/bundle.js': bundle.repeat(4),
    'static/js/app.js': `function init() {
  $("#edit-name").click(function () {});
  u("x");
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

describe('calls into minified scripts', () => {
  it('never resolve by name from another file', () => {
    const ids = cg.getNodesInFile('static/js/app.js').map((n) => n.id);
    const targets = cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.filePath);
    expect(targets).not.toContain('static/js/vendor.min.js');
    expect(targets).not.toContain('static/js/bundle.js');
  });
});
