/**
 * Calls through CommonJS `require` bindings (express's shape):
 * - `var express = require('../')` from `test/` is the project root's
 *   `index.js`, whose `module.exports = require('./lib/express')` forwards to
 *   `exports = module.exports = createApplication` — `express()` is that call;
 * - each declarator of a list is a binding: `var express = require('../'),
 *   request = require('supertest')` — `request(app)` is the package's, no edge;
 * - `require('./utils').setCharset` is the module's `setCharset`, written
 *   `exports.setCharset = function setCharset(…)`, not the module's first
 *   export (every such alias in express went to `normalizeType`).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cjs-require-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'web', main: 'index.js', devDependencies: { supertest: '^6' } }),
    'index.js': `'use strict';

module.exports = require('./lib/express');
`,
    'lib/express.js': `'use strict';

exports = module.exports = createApplication;

function createApplication() {
  return {};
}
`,
    'lib/utils.js': `'use strict';

exports.normalizeType = function (type) {
  return type;
};

exports.setCharset = function setCharset(type, charset) {
  return type + charset;
};
`,
    'lib/response.js': `'use strict';

var normalizeType = require('./utils').normalizeType;
var setCharset = require('./utils').setCharset;

function send(body) {
  return setCharset(normalizeType(body), 'utf-8');
}

module.exports = { send };
`,
    'test/app.js': `'use strict';

var express = require('../')
  , request = require('supertest');

describe('app', function () {
  it('responds', function () {
    var app = express();
    request(app);
  });
});
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

/** `file: qualified name` of every call edge out of a file. */
function callsFrom(file: string): string[] {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg
    .getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind === 'calls')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      return `${t.filePath}: ${t.qualifiedName}`;
    })
    .sort();
}

describe('calls through CommonJS require bindings', () => {
  it('follow `module.exports` through the root index to the exported function; an outside package is no edge', () => {
    expect(callsFrom('test/app.js')).toEqual(['lib/express.js: createApplication']);
  });

  it('read a `require(…).member` alias as that member', () => {
    expect(callsFrom('lib/response.js')).toEqual(['lib/utils.js: normalizeType', 'lib/utils.js: setCharset']);
  });
});
