import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as assert from 'node:assert/strict';
import { version as engineVersion } from '../../package.json';
import type { CodeGraphPlugin } from './api';
import type { Node } from '../types';
import { NODE_KINDS } from '../types';
import { ExtensionManager } from './manager';
import { inside, packExtension, parsePackage, sha256, validateManifest } from './package';
import { extensionTemplate, extensionFixtures } from './author-template';

/** Typed identity helper; a factory is invoked independently in each worker. */
export function defineExtension(factory: CodeGraphPlugin): CodeGraphPlugin { return factory; }
export const EXTENSION_API_VERSION = 1 as const;

/** Creates a new directory only; never overwrites an author's existing work. */
export function createExtensionProject(directory: string, id: string): void {
  const manifest = { id, apiVersion: EXTENSION_API_VERSION, engines: `>=${engineVersion} <2`, capabilities: ['frameworks'] };
  validateManifest(manifest, engineVersion);
  const root = path.resolve(directory);
  fs.mkdirSync(root); // EEXIST is intentional, including symlinks and empty directories.
  const pkg = { name: `codegraph-extension-${id}`, version: '0.1.0', private: true,
    description: 'Python event-map framework extension', main: 'index.cjs', license: 'MIT', codegraph: manifest,
    scripts: { test: 'codegraph extensions test .', 'pack:extension': `codegraph extensions pack . --out ../${id}-0.1.0.cgext` } };
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'index.cjs'), extensionTemplate(id));
  fs.writeFileSync(path.join(root, 'extension.test.json'), JSON.stringify(extensionFixtures(), null, 2) + '\n');
  fs.writeFileSync(path.join(root, 'README.md'), `# ${id}\n\nGenerated CodeGraph API v1 example for a Python event-map framework.\n\nFrom this directory, with the preview CodeGraph CLI on PATH:\n\n\`\`\`sh\ncodegraph extensions test .\ncodegraph extensions pack . --out ../${id}-0.1.0.cgext\ncodegraph extensions install ../${id}-0.1.0.cgext --path /path/to/python-project\ncodegraph extensions remove ${id} --path /path/to/python-project\n\`\`\`\n\nCreate a file named checkout.events.yaml in the Python project containing\n\`order.created: send_receipt\` and a Python function named \`send_receipt\`.\nThe graph gains a labelled event-to-handler link. The target project needs no\npackage.json, npm install, or Python dependencies. The example supports only\nunquoted literal event and function names on a single YAML line. Unknown or\nambiguous handlers remain unresolved. It is a small reference framework, not\na claim of support for arbitrary Python event libraries.\n\nEdit index.cjs and add positive/negative cases in extension.test.json. The test\ncommand executes your code in disposable projects using the managed installer,\nchecks declared graph assertions, deterministic rebuild and removal cleanup.\nIt does not sandbox extension code. Keep pack output outside this directory.\n\nTypes: import CodeGraphPlugin, PluginContext, FrameworkResolver, ResolutionContext,\nSynthPass, Node and Edge from @colbymchenry/codegraph (public package root).\nThe JSDoc type in index.cjs needs the preview package as a development dependency\nfor editor/type checking; the installed extension has no runtime SDK import.\n\nFull author guide: docs/extensions/authoring.md in the CodeGraph source checkout.\nThis preview has not been released to npm. Do not install a public release and\nassume these commands exist.\n`);
}

export interface AuthorNodeExpectation { name: string; kind?: Node['kind']; filePath?: string }
export interface AuthorEdgeExpectation { source: string; target?: string; label?: string }
export interface AuthorFixtureCase {
  name: string;
  files: Record<string, string>;
  expect: {
    nodes?: AuthorNodeExpectation[];
    absentNodes?: AuthorNodeExpectation[];
    edges?: AuthorEdgeExpectation[];
    absentEdges?: AuthorEdgeExpectation[];
  };
}
export interface AuthorTestReport {
  apiVersion: 1;
  engineVersion: string;
  artifactSha256: string;
  cases: { name: string; assertions: number; deterministic: true; removalClean: true }[];
}

function readFixtures(file: string): AuthorFixtureCase[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data?.format !== 'codegraph-extension-tests-1' || !Array.isArray(data.cases) || !data.cases.length) {
    throw new Error('Author fixtures require format codegraph-extension-tests-1 and at least one case');
  }
  for (const c of data.cases) {
    if (!c || typeof c.name !== 'string' || !c.name.trim() || !c.files || typeof c.files !== 'object' || Array.isArray(c.files) ||
        !Object.keys(c.files).length || !c.expect || typeof c.expect !== 'object' || Array.isArray(c.expect)) throw new Error('Each author case needs name, files and nonempty expect assertions');
    for (const [file, text] of Object.entries(c.files)) {
      if (typeof text !== 'string' || path.isAbsolute(file) || file.includes('\\') || file.includes(':') ||
          file.split('/').some(p => !p || p.startsWith('.')) || ['package.json', 'codegraph.json'].includes(file)) {
        throw new Error(`Author fixture ${c.name}: unsafe or reserved file ${file}; use relative source files only`);
      }
    }
    let count = 0;
    for (const [key, values] of Object.entries(c.expect)) {
      if (!['nodes', 'absentNodes', 'edges', 'absentEdges'].includes(key) || !Array.isArray(values)) throw new Error(`Author fixture ${c.name}: unknown or invalid expect.${key}`);
      for (const value of values) {
        if (!value || typeof value !== 'object') throw new Error(`Author fixture ${c.name}: assertions must be objects`);
        const allowed = key.endsWith('Nodes') || key === 'nodes' ? ['name', 'kind', 'filePath'] : ['source', 'target', 'label'];
        const required = allowed[0]!;
        if (typeof value[required] !== 'string' || !value[required].trim() || Object.keys(value).some(k => !allowed.includes(k) || typeof value[k] !== 'string') ||
            ('kind' in value && !NODE_KINDS.includes(value.kind))) throw new Error(`Author fixture ${c.name}: invalid ${key} assertion`);
        if (key === 'edges' && (!value.target || !value.label)) throw new Error(`Author fixture ${c.name}: expected edges need source, target and label`);
        count++;
      }
    }
    if (!count) throw new Error(`Author fixture ${c.name}: provide at least one graph assertion`);
  }
  return data.cases;
}

/** Runs actual compiled/runtime contributions, never a mock-only author contract. */
export async function testExtension(directory: string, options: { fixtures?: string } = {}): Promise<AuthorTestReport> {
  const root = fs.realpathSync(directory);
  const bytes = packExtension(root);
  const pkg = parsePackage(bytes, engineVersion);
  const fixtureFile = fs.realpathSync(path.resolve(root, options.fixtures ?? 'extension.test.json'));
  if (!inside(root, fixtureFile)) throw new Error('Author fixture file must be inside the extension directory');
  const cases = readFixtures(fixtureFile);
  const report: AuthorTestReport = { apiVersion: 1, engineVersion, artifactSha256: sha256(bytes), cases: [] };
  const { CodeGraph } = await import('../index');
  for (const fixture of cases) {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-author-'));
    try {
      for (const [file, content] of Object.entries(fixture.files)) {
        const destination = path.join(project, file);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, content);
      }
      const manager = new ExtensionManager(project);
      await manager.install({ bytes });
      const snapshot = async () => {
        const graph = await CodeGraph.open(project);
        try {
          const nodes = NODE_KINDS.flatMap(kind => graph.getNodesByKind(kind));
          const edges = graph.getOutgoingEdgesFrom(nodes.map(node => node.id)).filter(edge => edge.metadata?.synthesizedBy === pkg.package.codegraph.id);
          const contributions = nodes.filter(node => node.id.startsWith(`plugin:${pkg.package.codegraph.id}:`));
          return { nodes, edges, contributions };
        } finally { graph.close(); }
      };
      const before = await snapshot();
      const hasNode = (query: AuthorNodeExpectation) => before.contributions.some(node => Object.entries(query).every(([key, value]) => node[key as keyof Node] === value));
      const names = new Map(before.nodes.map(node => [node.id, node.name]));
      const hasEdge = (query: AuthorEdgeExpectation) => before.edges.some(edge => names.get(edge.source) === query.source &&
        (query.target === undefined || names.get(edge.target) === query.target) && (query.label === undefined || edge.metadata?.label === query.label));
      let assertions = 0;
      for (const q of fixture.expect.nodes ?? []) { assert.ok(hasNode(q), `Missing contributed node ${JSON.stringify(q)}`); assertions++; }
      for (const q of fixture.expect.absentNodes ?? []) { assert.ok(!hasNode(q), `Unexpected contributed node ${JSON.stringify(q)}`); assertions++; }
      for (const q of fixture.expect.edges ?? []) { assert.ok(hasEdge(q), `Missing labelled extension edge ${JSON.stringify(q)}`); assertions++; }
      for (const q of fixture.expect.absentEdges ?? []) { assert.ok(!hasEdge(q), `Unexpected extension edge ${JSON.stringify(q)}`); assertions++; }
      const canonical = (data: Awaited<ReturnType<typeof snapshot>>) => JSON.stringify({
        nodes: data.contributions.map(({ updatedAt: _time, ...node }) => node).sort((a, b) => a.id.localeCompare(b.id)),
        edges: [...data.edges].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
      });
      const graph = await CodeGraph.open(project);
      try { await graph.refreshPluginIndex(); } finally { graph.close(); }
      assert.equal(canonical(await snapshot()), canonical(before), 'Extension contribution changed after clean reindex');
      await manager.remove(pkg.package.codegraph.id);
      const after = await snapshot();
      assert.equal(after.contributions.length, 0, 'Contributed nodes remain after removal');
      assert.equal(after.edges.length, 0, 'Contributed edges remain after removal');
      report.cases.push({ name: fixture.name, assertions, deterministic: true, removalClean: true });
    } catch (error) {
      throw new Error(`Author case "${fixture.name}" failed: ${error instanceof Error ? error.message : String(error)}. Check your factory output and extension.test.json expectations.`, { cause: error });
    } finally { fs.rmSync(project, { recursive: true, force: true }); }
  }
  return report;
}
