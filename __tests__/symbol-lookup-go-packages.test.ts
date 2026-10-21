/**
 * Regression: a symbol written with its package resolves.
 *
 * Explore's token resolution (and codegraph_node's lookup) dropped every Go
 * symbol written the way Go code names it: `refresh.Discovery.refresh`,
 * `storage.Queryable.Querier` and `gin.Context.Next` resolved to nothing, and so
 * did `binding.Default`. Three gaps, each pinned below:
 *   - a qualified name was matched either against the qualifiedName (which holds
 *     the type, not the package) or entirely against the path (which holds the
 *     package, not the type), never as a package followed by a type;
 *   - a module's root package has no directory, so its name is only in the
 *     files' `package` clause (gin's `context.go` is `package gin`);
 *   - a qualified token was looked up in the full-text search's top hits only,
 *     and for `binding.Default` those were three `binding/default_validator*.go`
 *     files, not the function; the exact-name index is complete.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import CodeGraph from '../src/index';
import type { Node } from '../src/types';
import { matchesSymbol, lookupSymbolNodes } from '../src/graph/symbol-lookup';
import { goPackageClause, goPackageReaderFor } from '../src/graph/go-package';
import { findAllSymbols, resolveNamedTokens } from '../src/graph/named-symbol-flow';
import { ToolHandler } from '../src/mcp/tools';

function node(over: Partial<Node>): Node {
  return {
    id: `${over.kind ?? 'method'}:${over.filePath}:${over.qualifiedName}`,
    kind: 'method',
    name: 'x',
    qualifiedName: 'x',
    filePath: 'x.go',
    language: 'go',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 0,
    ...over,
  } as Node;
}

describe('matchesSymbol — a package, then the scope inside it', () => {
  const refresh = node({ name: 'refresh', qualifiedName: 'Discovery::refresh', filePath: 'discovery/refresh/refresh.go' });
  const uyuni = node({ name: 'refresh', qualifiedName: 'Discovery::refresh', filePath: 'discovery/uyuni/uyuni.go' });

  it('reads `pkg.Type.method` as the package in the path and the type in the scope', () => {
    expect(matchesSymbol(refresh, 'refresh.Discovery.refresh')).toBe(true);
    expect(matchesSymbol(uyuni, 'uyuni.Discovery.refresh')).toBe(true);
    // Every leading qualifier names the package — `discovery/refresh`.
    expect(matchesSymbol(refresh, 'discovery.refresh.Discovery.refresh')).toBe(true);
  });

  it('keeps the package: the same type in another package is not it', () => {
    expect(matchesSymbol(uyuni, 'refresh.Discovery.refresh')).toBe(false);
    expect(matchesSymbol(refresh, 'uyuni.Discovery.refresh')).toBe(false);
    expect(matchesSymbol(refresh, 'nope.Discovery.refresh')).toBe(false);
  });

  it('keeps the type: the scope must end with what the query writes', () => {
    expect(matchesSymbol(refresh, 'refresh.Other.refresh')).toBe(false);
    // A package can't stand in for the type.
    expect(matchesSymbol(refresh, 'Discovery.refresh.refresh')).toBe(false);
  });

  it("names a root package by the file's `package` clause", () => {
    const next = node({ name: 'Next', qualifiedName: 'Context::Next', filePath: 'context.go' });
    const fn = node({ kind: 'function', name: 'Default', qualifiedName: 'Default', filePath: 'utils.go' });
    const gin = (p: string) => (p === 'context.go' || p === 'utils.go' ? 'gin' : null);
    expect(matchesSymbol(next, 'gin.Context.Next', gin)).toBe(true);
    expect(matchesSymbol(fn, 'gin.Default', gin)).toBe(true);
    // Without the clause the path has no `gin`; another package name is not it.
    expect(matchesSymbol(next, 'gin.Context.Next')).toBe(false);
    expect(matchesSymbol(next, 'echo.Context.Next', gin)).toBe(false);
  });

  it('reads the package clause for Go files only', () => {
    const ts = node({ name: 'Next', qualifiedName: 'Context::Next', filePath: 'context.ts', language: 'typescript' });
    expect(matchesSymbol(ts, 'gin.Context.Next', () => 'gin')).toBe(false);
  });

  it('reads a Python `pkg.mod.Class.method` the same way', () => {
    const save = node({ name: 'save', qualifiedName: 'Model::save', filePath: 'app/models.py', language: 'python' });
    expect(matchesSymbol(save, 'app.models.Model.save')).toBe(true);
    expect(matchesSymbol(save, 'other.models.Model.save')).toBe(false);
  });
});

describe('goPackageClause', () => {
  it('reads the clause past comments and build constraints', () => {
    expect(goPackageClause('// Copyright\n\n//go:build !nomsgpack\n\npackage binding\n\nimport "x"\n')).toBe('binding');
    expect(goPackageClause('/* license\n package notthis */\npackage gin // the root\n')).toBe('gin');
    expect(goPackageClause('﻿package main\n')).toBe('main');
    expect(goPackageClause('// no clause\nfunc x() {}\n')).toBeNull();
  });
});

describe('package-qualified Go names resolve on every surface', () => {
  let dir = '';
  let cg: CodeGraph;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-package-names-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('go.mod', 'module example.com/gin\n\ngo 1.22\n');
    // The root package: its name is in the clause only.
    write('context.go', '// Package gin is the root.\npackage gin\n\ntype Context struct{}\n\nfunc (c *Context) Next() {}\n');
    write(
      'binding/binding.go',
      'package binding\n\ntype Binding interface {\n\tBind(req string) error\n}\n\nfunc Default(method string) Binding {\n\treturn nil\n}\n'
    );
    // Gives the full-text search `binding` + `default` hits that are not the function.
    write(
      'binding/default_validator.go',
      'package binding\n\ntype defaultValidator struct{}\n\nfunc (v *defaultValidator) ValidateStruct(obj any) error {\n\treturn nil\n}\n'
    );
    write(
      'discovery/refresh/refresh.go',
      'package refresh\n\ntype Discovery struct {\n\trefreshf func() error\n}\n\nfunc (d *Discovery) refresh() error {\n\treturn d.refreshf()\n}\n'
    );
    write(
      'discovery/uyuni/uyuni.go',
      'package uyuni\n\ntype Discovery struct{}\n\nfunc (d *Discovery) refresh() error {\n\treturn nil\n}\n'
    );
    cg = CodeGraph.initSync(dir, { config: { include: ['**/*.go'], exclude: [] } });
    await cg.indexAll();
  }, 120_000);

  afterAll(() => {
    cg?.destroy();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  const where = (nodes: Node[]) => nodes.map((n) => `${n.qualifiedName}@${n.filePath}`).sort();

  it("explore's resolution finds each package's own symbol", () => {
    expect(where(findAllSymbols(cg, 'refresh.Discovery.refresh').nodes)).toEqual(['Discovery::refresh@discovery/refresh/refresh.go']);
    expect(where(findAllSymbols(cg, 'uyuni.Discovery.refresh').nodes)).toEqual(['Discovery::refresh@discovery/uyuni/uyuni.go']);
    expect(where(findAllSymbols(cg, 'gin.Context.Next').nodes)).toEqual(['Context::Next@context.go']);
    expect(findAllSymbols(cg, 'nope.Discovery.refresh').nodes).toEqual([]);
  });

  it('finds a definition the full-text search ranks below its cut', () => {
    // Precondition: the search answers `binding.Default`, with other nodes.
    const hits = cg.searchNodes('binding.Default', { limit: 50 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.some((h) => h.node.name === 'Default')).toBe(false);
    expect(where(findAllSymbols(cg, 'binding.Default').nodes)).toEqual(['Default@binding/binding.go']);
  });

  it('feeds explore its named symbols', () => {
    const flow = resolveNamedTokens(cg, 'refresh.Discovery.refresh gin.Context.Next');
    const named = [...flow.named.values()];
    expect(where(named)).toEqual(['Context::Next@context.go', 'Discovery::refresh@discovery/refresh/refresh.go']);
  });

  it('codegraph_node and the CLI lookup agree', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_node', { symbol: 'uyuni.Discovery.refresh' });
    const text = res.content[0].text as string;
    expect(text).toContain('discovery/uyuni/uyuni.go');
    expect(text).not.toContain('discovery/refresh/refresh.go');
    expect(where(lookupSymbolNodes(cg, 'gin.Context.Next', goPackageReaderFor(cg)).nodes)).toEqual(['Context::Next@context.go']);
  });
});
