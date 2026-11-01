/**
 * A JS file that gives an object a member itself, `Sha256.prototype.update =
 * function…`, holds what the index has no node for. The one method of that
 * name elsewhere is no likelier then: rails' `buffer.update(data)` in
 * activestorage.js is its bundled sha256's, not the guides' turbo
 * `History#update`.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'guides/turbo.js': `export class History {
  update(method, location) {
    return method;
  }
}
`,
  'app/bundle.js': `(function () {
  function Sha256() {}
  Sha256.prototype.update = function (message) {
    return this;
  };
  window.sha = Sha256;
})();

export const sha256Algorithm = {
  append: (buffer, data) => buffer.update(data),
};
`,
  'app/other.js': `export const plain = {
  append: (buffer, data) => buffer.update(data),
};
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-js-prototype-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function callers(file: string): string[] {
  const db = (cg as unknown as { db: { getDb(): { prepare(sql: string): { all(...a: unknown[]): Array<{ q: string }> } } } }).db;
  return db.getDb().prepare(`
    SELECT t.qualified_name q FROM edges e
    JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
    WHERE e.kind = 'calls' AND s.file_path = ?`).all(file).map((r) => r.q);
}

describe('a lone method name in JS', () => {
  it('is no guess in a file that assigns a member of that name itself', () => {
    expect(callers('app/bundle.js')).not.toContain('History::update');
  });

  it('stays a guess elsewhere', () => {
    expect(callers('app/other.js')).toContain('History::update');
  });
});
