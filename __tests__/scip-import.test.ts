import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-scip-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('SCIP import', () => {
  it('imports semantic reference edges and records provenance', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const source = [
      'export function target() {',
      '  return 1;',
      '}',
      '',
      'export function caller() {',
      '  return target();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'example.ts'), source, 'utf-8');

    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [
            {
              symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().',
              range: [0, 16, 22],
              symbolRoles: 1,
            },
            {
              symbol: 'scip-typescript npm test 0.0.0 src/example.ts/caller().',
              range: [4, 16, 22],
              symbolRoles: 1,
            },
            {
              symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().',
              range: [5, 9, 15],
              symbolRoles: 0,
            },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(tempDir, 'index.scip.json'), JSON.stringify(scipPayload), 'utf-8');

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll({ useScip: false });
    const result = await cg.importScip('index.scip.json');

    expect(result.documentsParsed).toBe(1);
    expect(result.importedEdges).toBeGreaterThan(0);

    const callerNode = cg.searchNodes('caller', { kinds: ['function'], limit: 1 })[0]?.node;
    const targetNode = cg.searchNodes('target', { kinds: ['function'], limit: 1 })[0]?.node;
    expect(callerNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const scipEdges = cg
      .getOutgoingEdges(callerNode!.id)
      .filter((edge) => edge.kind === 'references' && edge.metadata?.source === 'scip');
    expect(scipEdges.some((edge) => edge.target === targetNode!.id)).toBe(true);

    const stats = cg.getStats();
    expect(stats.scipProvenance?.lastImportedPath).toContain('index.scip.json');
    expect(stats.scipProvenance?.lastImportedEdges).toBe(result.importedEdges);

    cg.destroy();
    cleanupTempDir(tempDir);
  });

  it('skips SCIP re-import when source fingerprint is unchanged', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const source = [
      'export function target() {',
      '  return 1;',
      '}',
      '',
      'export function caller() {',
      '  return target();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'example.ts'), source, 'utf-8');

    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [0, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/caller().', range: [4, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [5, 9, 15], symbol_roles: 0 },
          ],
        },
      ],
    };
    const scipPath = path.join(tempDir, 'index.scip.json');
    fs.writeFileSync(scipPath, JSON.stringify(scipPayload), 'utf-8');

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll({ useScip: false });
    const first = await cg.importScip(scipPath);
    const second = await cg.importScip(scipPath);

    expect(first.importedEdges).toBeGreaterThan(0);
    expect(second.skipped).toBe(true);
    expect(second.importedEdges).toBe(0);
    expect(second.indexPath).toBe(scipPath);

    const stats = cg.getStats();
    expect(stats.scipProvenance?.lastImportedFingerprint).toBeDefined();

    cg.destroy();
    cleanupTempDir(tempDir);
  });

  it('auto-imports SCIP from .codegraph/index.scip.json by default during indexAll', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    const codegraphDir = path.join(tempDir, '.codegraph');
    fs.mkdirSync(srcDir, { recursive: true });

    const source = [
      'export function target() {',
      '  return 1;',
      '}',
      '',
      'export function caller() {',
      '  return target();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'example.ts'), source, 'utf-8');

    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [0, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/caller().', range: [4, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [5, 9, 15], symbol_roles: 0 },
          ],
        },
      ],
    };

    const cg = await CodeGraph.init(tempDir);
    fs.mkdirSync(codegraphDir, { recursive: true });
    fs.writeFileSync(path.join(codegraphDir, 'index.scip.json'), JSON.stringify(scipPayload), 'utf-8');
    await cg.indexAll();

    const callerNode = cg.searchNodes('caller', { kinds: ['function'], limit: 1 })[0]?.node;
    const targetNode = cg.searchNodes('target', { kinds: ['function'], limit: 1 })[0]?.node;
    expect(callerNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const scipEdges = cg
      .getOutgoingEdges(callerNode!.id)
      .filter((edge) => edge.kind === 'references' && edge.metadata?.source === 'scip');
    expect(scipEdges.some((edge) => edge.target === targetNode!.id)).toBe(true);

    const stats = cg.getStats();
    expect(stats.scipProvenance?.lastImportedPath).toContain('.codegraph/index.scip.json');

    cg.destroy();
    cleanupTempDir(tempDir);
  });

  it('collapses repeated reference occurrences into a single SCIP edge with occurrence count', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const source = [
      'export function target() {',
      '  return 1;',
      '}',
      '',
      'export function caller() {',
      '  const a = target();',
      '  return target() + a;',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'example.ts'), source, 'utf-8');

    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [0, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/caller().', range: [4, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [5, 12, 18], symbol_roles: 0 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/target().', range: [6, 9, 15], symbol_roles: 0 },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(tempDir, 'index.scip.json'), JSON.stringify(scipPayload), 'utf-8');

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll({ useScip: false });
    const result = await cg.importScip('index.scip.json');

    const callerNode = cg.searchNodes('caller', { kinds: ['function'], limit: 1 })[0]?.node;
    const targetNode = cg.searchNodes('target', { kinds: ['function'], limit: 1 })[0]?.node;
    expect(callerNode).toBeDefined();
    expect(targetNode).toBeDefined();

    const scipEdges = cg
      .getOutgoingEdges(callerNode!.id)
      .filter((edge) => edge.kind === 'references' && edge.metadata?.source === 'scip' && edge.target === targetNode!.id);

    expect(result.referencesMapped).toBe(2);
    expect(scipEdges).toHaveLength(1);
    expect((scipEdges[0]!.metadata as { scipOccurrences?: number }).scipOccurrences).toBe(2);

    cg.destroy();
    cleanupTempDir(tempDir);
  });

  it('supports disabling default SCIP auto-import during indexAll', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    const codegraphDir = path.join(tempDir, '.codegraph');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'example.ts'), 'export function target() { return 1; }', 'utf-8');
    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [{ symbol: 's', range: [0, 16, 22], symbol_roles: 1 }],
        },
      ],
    };

    const cg = await CodeGraph.init(tempDir);
    fs.mkdirSync(codegraphDir, { recursive: true });
    fs.writeFileSync(path.join(codegraphDir, 'index.scip.json'), JSON.stringify(scipPayload), 'utf-8');

    await cg.indexAll({ useScip: false });
    const stats = cg.getStats();
    expect(stats.scipProvenance?.lastImportedPath).toBeUndefined();

    cg.destroy();
    cleanupTempDir(tempDir);
  });

  it('uses SCIP-first resolution for refs skipped by heuristic built-in filters', async () => {
    const tempDir = createTempDir();
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const source = [
      'export function useState() {',
      '  return 1;',
      '}',
      '',
      'export function caller() {',
      '  return useState();',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(srcDir, 'example.ts'), source, 'utf-8');

    const scipPayload = {
      documents: [
        {
          relative_path: 'src/example.ts',
          occurrences: [
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/useState().', range: [0, 16, 24], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/caller().', range: [4, 16, 22], symbol_roles: 1 },
            { symbol: 'scip-typescript npm test 0.0.0 src/example.ts/useState().', range: [5, 9, 17], symbol_roles: 0 },
          ],
        },
      ],
    };
    fs.writeFileSync(path.join(tempDir, 'index.scip.json'), JSON.stringify(scipPayload), 'utf-8');

    const cg = await CodeGraph.init(tempDir);
    await cg.indexAll({ useScip: false });

    const callerNode = cg.searchNodes('caller', { kinds: ['function'], limit: 1 })[0]?.node;
    const useStateNode = cg.searchNodes('useState', { kinds: ['function'], limit: 1 })[0]?.node;
    expect(callerNode).toBeDefined();
    expect(useStateNode).toBeDefined();

    const beforeEdges = cg
      .getOutgoingEdges(callerNode!.id)
      .filter((edge) => edge.kind === 'calls' && edge.target === useStateNode!.id);
    expect(beforeEdges).toHaveLength(0);

    const resolution = await cg.resolveReferences(1, undefined, 'index.scip.json');
    expect(resolution.stats.byMethod.scip).toBeGreaterThan(0);

    const afterEdges = cg
      .getOutgoingEdges(callerNode!.id)
      .filter((edge) => edge.kind === 'calls' && edge.target === useStateNode!.id);
    expect(afterEdges.length).toBeGreaterThan(0);
    expect((afterEdges[0]!.metadata as { resolvedBy?: string }).resolvedBy).toBe('scip');

    cg.destroy();
    cleanupTempDir(tempDir);
  });
});
