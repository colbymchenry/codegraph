import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractFromSource, detectLanguage, getSupportedLanguages } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { CodeGraph } from '../src/index';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('rego language registration', () => {
  it('detects .rego files as rego', () => {
    expect(detectLanguage('policy/backstage.rego')).toBe('rego');
    expect(detectLanguage('policy/helm.rego')).toBe('rego');
  });

  it('lists rego as a supported language', () => {
    expect(getSupportedLanguages()).toContain('rego');
  });
});

describe('rego extraction', () => {
  const policy = [
    'package whiteblossom.security',
    '',
    'import future.keywords',
    'import data.constants as c',
    '',
    'default authorized := false',
    '',
    'authorized := true if {',
    '    is_allowed(input.user)',
    '}',
    '',
    'is_allowed(user) if {',
    '    data.whiteblossom.allowlist[user]',
    '}',
    '',
    'deny contains msg if {',
    '    not authorized',
    '    msg := "not authorized"',
    '}',
  ].join('\n');

  it('emits a node per rule head, including default and helper rules', () => {
    const result = extractFromSource('policy/example.rego', policy);
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('authorized');
    expect(names).toContain('is_allowed');
    expect(names).toContain('deny');
    // `default authorized` and `authorized := true` are the same name with
    // different semantics, so the fallback keeps its own node.
    expect(names).toContain('authorized (default)');
  });

  it('records the package and imports', () => {
    const result = extractFromSource('policy/example.rego', policy);
    const names = result.nodes.map((n) => n.name);
    expect(names).toContain('whiteblossom.security');
    expect(names.some((n) => n.includes('future.keywords'))).toBe(true);
    expect(names.some((n) => n.includes('data.constants'))).toBe(true);
  });

  it('emits an unresolved calls reference for a rule calling another rule', () => {
    const result = extractFromSource('policy/example.rego', policy);
    const calls = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'calls')
      .map((r) => r.referenceName);
    expect(calls).toContain('is_allowed');
  });

  it('emits a reference for a data/input ref, and not for a bare local variable', () => {
    const result = extractFromSource('policy/example.rego', policy);
    const refs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'references')
      .map((r) => r.referenceName);
    expect(refs.some((r) => r.startsWith('data.whiteblossom.allowlist'))).toBe(true);
    expect(refs).toContain('whiteblossom.security');
    expect(refs.some((r) => r === 'authorized')).toBe(false);
  });

  it('records every rule head as a function node', () => {
    const result = extractFromSource('policy/example.rego', policy);
    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.map((f) => f.name).sort()).toEqual(
      ['authorized', 'authorized (default)', 'deny', 'is_allowed'].sort(),
    );
  });
});

describe('rego resolved call edges', () => {
  let root: string;
  let cg: CodeGraph;

  beforeAll(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'cg-rego-'));
    const dir = path.join(root, 'policy');
    mkdirSync(dir, { recursive: true });
    // The shape real policy files use: one rule calls a helper rule.
    writeFileSync(
      path.join(dir, 'governance.rego'),
      [
        'package whiteblossom.governance',
        '',
        'is_authorized_subdomain(subdomain, entity) if {',
        '    entity.metadata.name == subdomain',
        '}',
        '',
        'deny contains msg if {',
        '    subdomain := input.subdomain',
        '    not is_authorized_subdomain(subdomain, input)',
        '    msg := "reserved"',
        '}',
      ].join('\n'),
    );
    cg = await CodeGraph.init(root, { index: true });
  });

  afterAll(() => {
    cg?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('links the calling rule to the helper rule with a calls edge', () => {
    const nodes = cg.getNodesInFile('policy/governance.rego');
    const deny = nodes.find((n) => n.name === 'deny');
    const helper = nodes.find((n) => n.name === 'is_authorized_subdomain');
    expect(deny).toBeDefined();
    expect(helper).toBeDefined();

    const edge = cg
      .getOutgoingEdgesFrom(nodes.map((n) => n.id))
      .find((e) => e.kind === 'calls' && e.target === helper!.id);
    expect(edge).toBeDefined();
    expect(edge!.source).toBe(deny!.id);
  });
});
