/**
 * `require('./x').default` reads the `default` PROPERTY of the module's
 * exports, and so does `const { default: X } = require('./x')`. The import
 * mapping records it as a named import of `default`, which is right for a
 * CommonJS module that sets the property by name (`exports.default = fn`, or
 * the dual `module.exports = X; module.exports.default = X`). A module
 * written as an ES module and compiled to CommonJS sets it to its default
 * export, `export default class Foo`, which is no named export: bitwarden's
 * desktop app loads its macOS biometrics service with
 * `require("./os-biometrics-mac.service").default` and `new`s it, and that
 * `instantiates` reference stayed unresolved. The named property is still
 * looked up first; the ES module's default export answers only when there is
 * no such property, and only in the module asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Edge } from '../src/types';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-require-default-'));
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'desktop', devDependencies: { svelte: '^4' } }),
    // bitwarden's shape: an ES module with an unexported helper above its
    // default-exported class, loaded with `require(...).default` on one
    // platform only.
    'src/biometrics/os-biometrics.service.ts': `export interface OsBiometricService {
  enrollPersistent(userId: string): Promise<string>;
}
`,
    'src/biometrics/os-biometrics-mac.service.ts': `import { OsBiometricService } from './os-biometrics.service';

function getLookupKeyForUser(userId: string): string {
  return \`\${userId}_user_biometric\`;
}

export default class OsBiometricsServiceMac implements OsBiometricService {
  async enrollPersistent(userId: string): Promise<string> {
    return getLookupKeyForUser(userId);
  }
}
`,
    'src/biometrics/main-biometrics.service.ts': `import { OsBiometricService } from './os-biometrics.service';

export class MainBiometricsService {
  private osBiometricsService: OsBiometricService | undefined;

  constructor(platform: string) {
    if (platform === 'darwin') {
      // eslint-disable-next-line
      const OsBiometricsServiceMac = require('./os-biometrics-mac.service').default;
      this.osBiometricsService = new OsBiometricsServiceMac();
    }
  }
}
`,
    'src/biometrics/os-biometrics-mac.service.spec.ts': `describe('OsBiometricsServiceMac', () => {
  it('enrolls in an isolated module registry', async () => {
    const { default: ServiceCtor } = require('./os-biometrics-mac.service');
    const isolated = new ServiceCtor();
    await isolated.enrollPersistent('user');
  });
});
`,
    // A single-file component is its module's default export.
    'src/App.svelte': `<script>
  export let name = 'world';
</script>

<h1>Hello {name}!</h1>
`,
    'src/main.js': `const App = require('./App.svelte').default;

const app = new App({ target: document.body });

module.exports = app;
`,
    // CommonJS modules that set the property by name.
    'lib/format.js': `'use strict';

exports.pad = function (value) {
  return String(value).padStart(2, '0');
};

function formatDate(date) {
  return exports.pad(date.getDate());
}

exports.default = formatDate;
`,
    'lib/server.js': `'use strict';

function createServer(options) {
  return { options };
}

module.exports = createServer;
module.exports.default = createServer;
module.exports.createServer = createServer;
`,
    // A CommonJS module without the property: its exports are no default.
    'lib/plain.js': `'use strict';

exports.first = function () {
  return 1;
};

exports.second = () => 2;
`,
    // `export * from` forwards every export but the default.
    'src/widgets/Dial.ts': `export const DIAL_SIZE = 3;

export default class Dial {
  size = DIAL_SIZE;
}
`,
    'src/widgets/index.ts': `export * from './Dial';
`,
    'src/dashboard.ts': `export function mountDashboard(): unknown {
  const Widget = require('./widgets').default;
  return new Widget();
}
`,
    'lib/app.js': `'use strict';

const format = require('./format').default;
const build = require('./server').default;
const { default: fastify } = require('./server');
const plain = require('./plain').default;

function start() {
  const server = build({ port: 3000 });
  fastify({ logger: true });
  plain();
  return format(new Date()) + server.options.port;
}

module.exports = start;
`,
    // Python has no default export: `default` is an attribute's name.
    'py/__init__.py': '',
    'py/mod.py': `def first():
    return 1
`,
    'py/use.py': `from .mod import default


def run():
    return default()
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

const node = (file: string, name: string) => {
  const found = cg.getNodesInFile(file).find((n) => n.name === name && n.kind !== 'import');
  expect(found, `${file}: ${name}`).toBeDefined();
  return found!;
};

/** The edges into `target`, as `kind source-file resolvedBy`. */
const into = (target: { id: string }, kinds: Edge['kind'][]) =>
  cg
    .getIncomingEdges(target.id)
    .filter((e) => kinds.includes(e.kind))
    .map((e) => `${e.kind} ${cg.getNode(e.source)!.filePath} ${(e.metadata as { resolvedBy?: string }).resolvedBy}`)
    .sort();

/** The call and instantiation edges out of a file's nodes, as `kind target-file:target-name`. */
const outOf = (file: string) =>
  cg
    .getOutgoingEdgesFrom(cg.getNodesInFile(file).map((n) => n.id))
    .filter((e) => e.kind === 'calls' || e.kind === 'instantiates')
    .map((e) => {
      const target = cg.getNode(e.target)!;
      return `${e.kind} ${target.filePath}:${target.name}`;
    })
    .sort();

describe('`require(…).default` of an ES module', () => {
  it('is the module’s default export, as `.default` and as `{ default: X }`', () => {
    expect(into(node('src/biometrics/os-biometrics-mac.service.ts', 'OsBiometricsServiceMac'), ['instantiates'])).toEqual([
      'instantiates src/biometrics/main-biometrics.service.ts import',
      'instantiates src/biometrics/os-biometrics-mac.service.spec.ts import',
    ]);
  });

  it('is the component a single-file component file is', () => {
    expect(into(node('src/App.svelte', 'App'), ['instantiates'])).toEqual(['instantiates src/main.js import']);
  });
});

describe('`require(…).default` of a CommonJS module', () => {
  it('is what `exports.default` names, not the module’s first export', () => {
    expect(outOf('lib/app.js')).toContain('calls lib/format.js:formatDate');
    expect(into(node('lib/format.js', 'pad'), ['calls'])).toEqual([]);
  });

  it('is X in the dual export `module.exports = X; module.exports.default = X`', () => {
    expect(into(node('lib/server.js', 'createServer'), ['calls'])).toEqual([
      'calls lib/app.js import',
      'calls lib/app.js import',
    ]);
  });

  it('is nothing when the module sets no `default`: its exports are no default', () => {
    expect(into(node('lib/plain.js', 'first'), ['calls'])).toEqual([]);
    expect(into(node('lib/plain.js', 'second'), ['calls'])).toEqual([]);
  });
});

describe('what the fallback leaves alone', () => {
  it('a default behind `export * from`, which forwards none', () => {
    expect(into(node('src/widgets/Dial.ts', 'Dial'), ['instantiates', 'calls'])).toEqual([]);
    expect(outOf('src/dashboard.ts')).toEqual([]);
  });

  it('every other require binding, which reaches only what it names', () => {
    expect(outOf('lib/app.js').filter((e) => !e.includes(' lib/app.js:'))).toEqual([
      'calls lib/format.js:formatDate',
      'calls lib/server.js:createServer',
      'calls lib/server.js:createServer',
    ]);
  });

  it('Python’s `from .mod import default`, an attribute of that name', () => {
    expect(into(node('py/mod.py', 'first'), ['calls'])).toEqual([]);
  });
});
