import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import {
  detectLanguage,
  initGrammars,
  isLanguageSupported,
  isSourceFile,
  loadAllGrammars,
} from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('repository Markdown extraction', () => {
  it('registers Markdown as a custom indexable language', () => {
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('docs/guide.mdx')).toBe('markdown');
    expect(detectLanguage('notes.markdown')).toBe('markdown');
    expect(isSourceFile('README.md')).toBe(true);
    expect(isLanguageSupported('markdown')).toBe(true);
  });

  it('extracts section hierarchy, prose, local links, and inline symbols', () => {
    const result = extractFromSource(
      'docs/architecture.md',
      [
        'Repository overview.',
        '',
        '# Architecture',
        'Credential orchestration uses `AuthService` and `Store`.',
        'See [source](../src/auth.ts), [details](#details), and [web](https://example.com).',
        '',
        '## Details',
        'Calls `Graph.open()` and `parse_config`.',
        '',
        '```ts',
        '# Not a heading',
        'const HiddenSymbol = true;',
        '[fake](../src/fake.ts)',
        '```',
        '',
        '# Architecture',
        'Duplicate title.',
      ].join('\n')
    );

    expect(result.errors).toEqual([]);
    const file = result.nodes.find((node) => node.kind === 'file');
    const sections = result.nodes.filter((node) => node.kind === 'section');
    const architecture = sections.find(
      (node) => node.qualifiedName === 'docs/architecture.md#architecture'
    );
    const details = sections.find((node) => node.name === 'Details');
    const duplicate = sections.find(
      (node) => node.qualifiedName === 'docs/architecture.md#architecture-1'
    );

    expect(file?.language).toBe('markdown');
    expect(file?.docstring).toBe('Repository overview.');
    expect(architecture?.docstring).toContain('Credential orchestration');
    expect(details).toBeDefined();
    expect(duplicate).toBeDefined();
    expect(sections.some((node) => node.name === 'Not a heading')).toBe(false);

    expect(
      result.edges.some(
        (edge) =>
          edge.kind === 'contains' &&
          edge.source === architecture?.id &&
          edge.target === details?.id
      )
    ).toBe(true);
    expect(
      result.edges.some(
        (edge) =>
          edge.kind === 'references' &&
          edge.source === architecture?.id &&
          edge.target === details?.id
      )
    ).toBe(true);

    const refs = result.unresolvedReferences.map((ref) => [
      ref.referenceKind,
      ref.referenceName,
    ]);
    expect(refs).toContainEqual(['document_link', 'src/auth.ts']);
    expect(refs).toContainEqual(['document_symbol', 'AuthService']);
    expect(refs).toContainEqual(['document_symbol', 'Store']);
    expect(refs).toContainEqual(['document_symbol', 'Graph.open']);
    expect(refs).toContainEqual(['document_symbol', 'parse_config']);
    expect(refs).not.toContainEqual(['document_link', 'src/fake.ts']);
    expect(
      result.unresolvedReferences.some((ref) =>
        ref.referenceName.includes('example.com')
      )
    ).toBe(false);
  });

  it('supports Setext headings and reference-style local links', () => {
    const result = extractFromSource(
      'docs/guide.md',
      [
        'Guide',
        '=====',
        '',
        'Read the [design][design-doc].',
        '',
        '[design-doc]: ./design.md#storage',
      ].join('\n')
    );

    const guide = result.nodes.find(
      (node) =>
        node.kind === 'section' &&
        node.qualifiedName === 'docs/guide.md#guide'
    );
    expect(guide?.startLine).toBe(1);
    expect(result.unresolvedReferences).toContainEqual(
      expect.objectContaining({
        fromNodeId: guide?.id,
        referenceKind: 'document_link',
        referenceName: 'docs/design.md#storage',
      })
    );
  });
});

describe('repository Markdown indexing', () => {
  let tempDir: string | undefined;
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.close();
    graph = undefined;
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('resolves document links and unique code symbols end to end', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-markdown-'));
    const write = (relativePath: string, content: string): void => {
      const target = path.join(tempDir!, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };

    write(
      'src/auth.ts',
      'export class AuthService { authenticate(): boolean { return true; } }\n'
    );
    write('src/config-a.ts', 'export function parseConfig(): void {}\n');
    write('src/config-b.ts', 'export function parseConfig(): void {}\n');
    write(
      'docs/architecture.md',
      [
        '# Architecture',
        'Credential orchestration uses `AuthService` and the ambiguous `parseConfig`.',
        'Read the [implementation](../src/auth.ts) and [API](./details.md#api).',
        'The [external guide](https://example.com/guide) stays outside the graph.',
      ].join('\n')
    );
    write('docs/details.md', '# API\nStable authentication surface.\n');

    graph = CodeGraph.initSync(tempDir);
    await graph.indexAll();

    const architecture = graph
      .getNodesByKind('section')
      .find(
        (node) =>
          node.qualifiedName === 'docs/architecture.md#architecture'
      );
    const api = graph
      .getNodesByKind('section')
      .find((node) => node.qualifiedName === 'docs/details.md#api');
    const auth = graph
      .getNodesByKind('class')
      .find((node) => node.name === 'AuthService');
    const authFile = graph.getNode('file:src/auth.ts');

    expect(architecture).toBeDefined();
    expect(api).toBeDefined();
    expect(auth).toBeDefined();
    expect(authFile).toBeDefined();

    const outgoing = graph.getOutgoingEdges(architecture!.id);
    expect(outgoing).toContainEqual(
      expect.objectContaining({
        target: authFile!.id,
        kind: 'references',
        metadata: expect.objectContaining({ docRef: 'link' }),
      })
    );
    expect(outgoing).toContainEqual(
      expect.objectContaining({
        target: api!.id,
        kind: 'references',
        metadata: expect.objectContaining({ docRef: 'link' }),
      })
    );
    expect(outgoing).toContainEqual(
      expect.objectContaining({
        target: auth!.id,
        kind: 'references',
        metadata: expect.objectContaining({ docRef: 'symbol' }),
      })
    );

    const ambiguousTargets = new Set(
      graph
        .getNodesByKind('function')
        .filter((node) => node.name === 'parseConfig')
        .map((node) => node.id)
    );
    expect(outgoing.some((edge) => ambiguousTargets.has(edge.target))).toBe(false);
    expect(
      graph
        .searchNodes('credential orchestration')
        .some((result) => result.node.id === architecture!.id)
    ).toBe(true);

    // The normal per-file lifecycle also applies to documents: changing a
    // heading removes its old node/edge and resolves the updated anchor.
    write(
      'docs/architecture.md',
      [
        '# Architecture',
        'Credential orchestration uses `AuthService` and the ambiguous `parseConfig`.',
        'Read the [implementation](../src/auth.ts) and [API](./details.md#public-api).',
      ].join('\n')
    );
    write('docs/details.md', '# Public API\nStable authentication surface.\n');
    await graph.sync();

    const publicApi = graph
      .getNodesByKind('section')
      .find((node) => node.qualifiedName === 'docs/details.md#public-api');
    expect(graph.getNode(api!.id)).toBeNull();
    expect(publicApi).toBeDefined();
    expect(
      graph
        .getOutgoingEdges(architecture!.id)
        .some(
          (edge) =>
            edge.target === publicApi!.id &&
            edge.metadata?.docRef === 'link'
        )
    ).toBe(true);
  });

  it('preserves every existing source node and relationship when Markdown is added', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-markdown-additive-'));
    const write = (relativePath: string, content: string): void => {
      const target = path.join(tempDir!, relativePath);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    };

    write(
      'src/service.ts',
      [
        'export function helper(): number { return 42; }',
        'export class Service {',
        '  run(): number { return helper(); }',
        '}',
      ].join('\n')
    );
    write(
      'src/main.ts',
      [
        "import { Service } from './service';",
        'export function main(): number {',
        '  return new Service().run();',
        '}',
      ].join('\n')
    );

    graph = CodeGraph.initSync(tempDir);
    await graph.indexAll();

    const beforeNodes = graph
      .getFiles()
      .flatMap((file) => graph!.getNodesInFile(file.path))
      .filter((node) => node.language !== 'markdown');
    const beforeNodeIds = new Set(beforeNodes.map((node) => node.id));
    const edgeKey = (edge: ReturnType<CodeGraph['getOutgoingEdges']>[number]): string =>
      JSON.stringify([
        edge.source,
        edge.target,
        edge.kind,
        edge.line ?? null,
        edge.column ?? null,
        edge.metadata ?? null,
        edge.provenance ?? null,
      ]);
    const beforeEdges = new Set(
      beforeNodes.flatMap((node) => graph!.getOutgoingEdges(node.id)).map(edgeKey)
    );

    expect(beforeNodeIds.size).toBeGreaterThan(4);
    expect(beforeEdges.size).toBeGreaterThan(2);
    expect(
      [...beforeEdges].some((key) => key.includes('"calls"'))
    ).toBe(true);

    write(
      'docs/architecture.md',
      [
        '# Architecture',
        'The entry point uses `Service`, `main`, and `helper`.',
        'See the [implementation](../src/service.ts).',
      ].join('\n')
    );
    await graph.sync();

    const afterNodes = graph
      .getFiles()
      .flatMap((file) => graph!.getNodesInFile(file.path))
      .filter((node) => node.language !== 'markdown');
    const afterNodeIds = new Set(afterNodes.map((node) => node.id));
    const afterEdges = new Set(
      afterNodes.flatMap((node) => graph!.getOutgoingEdges(node.id)).map(edgeKey)
    );

    expect(afterNodeIds).toEqual(beforeNodeIds);
    for (const edge of beforeEdges) {
      expect(afterEdges.has(edge), `missing original edge ${edge}`).toBe(true);
    }
  });
});
