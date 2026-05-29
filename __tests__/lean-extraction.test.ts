import { describe, expect, it, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { extractFromSource, scanDirectory } from '../src/extraction';
import {
  detectLanguage,
  getLanguageDisplayName,
  getSupportedLanguages,
  initGrammars,
  isGrammarLoaded,
  isLanguageSupported,
  loadGrammarsForLanguages,
} from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['lean']);
});

const LEAN_ENV_KEYS = [
  'CODEGRAPH_LEAN_SEMANTICS',
  'CODEGRAPH_LEAN_LSP_COMMAND',
  'CODEGRAPH_LEAN_LSP_TIMEOUT_MS',
  'CODEGRAPH_LEAN_LSP_REF_LIMIT',
  'FAKE_LEAN_TARGET_URI',
  'FAKE_LEAN_TARGET_LINE',
  'FAKE_LEAN_TARGET_COLUMN',
  'FAKE_LEAN_SKIP_DEFINITION',
] as const;

function snapshotLeanEnv(): Partial<Record<typeof LEAN_ENV_KEYS[number], string>> {
  const snapshot: Partial<Record<typeof LEAN_ENV_KEYS[number], string>> = {};
  for (const key of LEAN_ENV_KEYS) {
    if (process.env[key] !== undefined) snapshot[key] = process.env[key];
  }
  return snapshot;
}

function restoreLeanEnv(snapshot: Partial<Record<typeof LEAN_ENV_KEYS[number], string>>): void {
  for (const key of LEAN_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

function writeFakeLeanLsp(): string {
  const serverPath = path.join(os.tmpdir(), `codegraph-fake-lean-lsp-${process.pid}-${Date.now()}.cjs`);
  fs.writeFileSync(serverPath, String.raw`
const { pathToFileURL } = require('url');

let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  process.stdout.write(Buffer.from('Content-Length: ' + body.length + '\r\n\r\n', 'ascii'));
  process.stdout.write(body);
}

function handle(message) {
  if (!message || !message.id) return;
  if (message.method === 'initialize') {
    send({ jsonrpc: '2.0', id: message.id, result: { capabilities: { definitionProvider: true } } });
    return;
  }
  if (message.method === 'textDocument/definition') {
    if (process.env.FAKE_LEAN_SKIP_DEFINITION === '1') return;
    const uri = process.env.FAKE_LEAN_TARGET_URI || pathToFileURL('/tmp/outside.lean').href;
    const line = Number.parseInt(process.env.FAKE_LEAN_TARGET_LINE || '0', 10);
    const character = Number.parseInt(process.env.FAKE_LEAN_TARGET_COLUMN || '0', 10);
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        uri,
        range: {
          start: { line, character },
          end: { line, character: character + 6 },
        },
      },
    });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd < 0) return;
    const header = buffer.slice(0, headerEnd).toString('ascii');
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const length = Number.parseInt(match[1], 10);
    const start = headerEnd + 4;
    const end = start + length;
    if (buffer.length < end) return;
    const body = buffer.slice(start, end).toString('utf8');
    buffer = buffer.slice(end);
    try {
      handle(JSON.parse(body));
    } catch {
      // Ignore malformed input.
    }
  }
});
`, 'utf-8');
  return serverPath;
}

describe('Lean support', () => {
  it('detects and reports Lean as a grammar-backed supported language', () => {
    expect(detectLanguage('Example.lean')).toBe('lean');
    expect(isLanguageSupported('lean')).toBe(true);
    expect(isGrammarLoaded('lean')).toBe(true);
    expect(getSupportedLanguages()).toContain('lean');
    expect(getLanguageDisplayName('lean')).toBe('Lean');
  });

  it('extracts namespaces, imports, declarations, fields, constructors, docs, visibility, and references', () => {
    const code = `
import Foo.Bar

namespace Demo

/-- doubles a number -/
def twice (n : Nat) : Nat := Nat.succ n

private lemma hidden : twice 0 = 1 := by
  rfl

structure Point where
  /-- x coordinate -/
  x : Nat
  y : Nat := Nat.zero

class Size (α : Type) where
  size : α → Nat

inductive Color where
  | red
  | blue : Color

opaque mystery : Nat
axiom trusted : Nat
constant answer : Nat
abbrev Alias := Nat

end Demo
`;

    const result = extractFromSource('Demo.lean', code);
    expect(result.errors).toHaveLength(0);

    expect(result.nodes.find((n) => n.kind === 'file' && n.language === 'lean')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'Foo.Bar')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'namespace' && n.qualifiedName === 'Demo')).toBeDefined();

    const twice = result.nodes.find((n) => n.kind === 'function' && n.qualifiedName === 'Demo.twice');
    expect(twice?.docstring).toBe('doubles a number');
    expect(twice?.isExported).toBe(true);

    const hidden = result.nodes.find((n) => n.name === 'hidden');
    expect(hidden).toMatchObject({ kind: 'function', visibility: 'private', isExported: false });

    expect(result.nodes.find((n) => n.kind === 'struct' && n.qualifiedName === 'Demo.Point')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'class' && n.qualifiedName === 'Demo.Size')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'enum' && n.qualifiedName === 'Demo.Color')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'field' && n.qualifiedName === 'Demo.Point.x')).toMatchObject({
      docstring: 'x coordinate',
    });
    expect(result.nodes.find((n) => n.kind === 'field' && n.qualifiedName === 'Demo.Size.size')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'enum_member' && n.qualifiedName === 'Demo.Color.red')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'enum_member' && n.qualifiedName === 'Demo.Color.blue')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'type_alias' && n.qualifiedName === 'Demo.Alias')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'constant' && n.qualifiedName === 'Demo.trusted')).toBeDefined();

    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({ referenceKind: 'imports', referenceName: 'Foo.Bar' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'Nat.succ' }),
      expect.objectContaining({ referenceKind: 'calls', referenceName: 'twice' }),
      expect.objectContaining({ referenceKind: 'references', referenceName: 'Nat' }),
    ]));
    expect(result.unresolvedReferences.some((r) => r.fromNodeId === twice?.id && r.referenceName === 'twice')).toBe(false);
  });

  it('extracts Lean open/export/section/attributes/extends/anonymous instances and candidates', () => {
    const code = `
import Foo.Bar
open Helpers
export Helpers (helper)

namespace Demo
section Tools

@[simp, inline] def use (n : Nat) : Nat := helper n

structure Point extends ToString where
  x : Nat

class Sized (α : Type) extends Inhabited α where
  size : α → Nat

instance : Inhabited Point where
  default := { x := 0 }

theorem t : use 0 = 0 := by
  simp [use]

end Tools
end Demo
`;

    const result = extractFromSource('Demo.lean', code);
    expect(result.errors).toHaveLength(0);

    expect(result.nodes.find((n) => n.kind === 'import' && n.name === 'open Helpers')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'export' && n.name === 'Helpers (helper)')).toBeDefined();
    expect(result.nodes.find((n) => n.kind === 'module' && n.name === 'Tools')).toBeDefined();

    const use = result.nodes.find((n) => n.kind === 'function' && n.qualifiedName === 'Demo.use');
    expect(use?.decorators).toEqual(['simp', 'inline']);

    expect(result.nodes.find((n) => n.kind === 'constant' && n.name.startsWith('instInhabitedPoint@'))).toBeDefined();
    expect(result.unresolvedReferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        referenceKind: 'extends',
        referenceName: 'ToString',
        candidates: expect.arrayContaining(['Demo.ToString', 'Helpers.ToString']),
      }),
      expect.objectContaining({
        referenceKind: 'extends',
        referenceName: 'Inhabited',
        candidates: expect.arrayContaining(['Demo.Inhabited', 'Helpers.Inhabited']),
      }),
      expect.objectContaining({
        referenceKind: 'calls',
        referenceName: 'helper',
        candidates: expect.arrayContaining(['Demo.helper', 'Helpers.helper', 'Foo.Bar.helper']),
      }),
      expect.objectContaining({
        referenceKind: 'references',
        referenceName: 'use',
        candidates: expect.arrayContaining(['Demo.use']),
      }),
    ]));
  });

  it('resolves local Lean module imports and qualified calls end-to-end', async () => {
    const env = snapshotLeanEnv();
    process.env.CODEGRAPH_LEAN_SEMANTICS = 'off';
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lean-e2e-'));
    let cg: CodeGraph | null = null;
    try {
      fs.mkdirSync(path.join(tempProject, 'Foo'), { recursive: true });
      fs.writeFileSync(
        path.join(tempProject, 'Foo', 'Bar.lean'),
        `namespace Foo\n\ndef bar (n : Nat) : Nat := n\n\nend Foo\n`
      );
      fs.writeFileSync(
        path.join(tempProject, 'Main.lean'),
        `import Foo.Bar\n\nnamespace Main\n\ndef main : Nat := Foo.bar 1\n\nend Main\n`
      );

      cg = await CodeGraph.init(tempProject, { index: true });
      const db = DatabaseConnection.open(path.join(tempProject, '.codegraph', 'codegraph.db'));
      const rows = db.getDb().prepare(`
        select src.kind as srcKind, src.file_path as srcPath, dst.kind as dstKind,
               dst.file_path as dstPath, dst.qualified_name as dstQName, e.kind as edgeKind
        from edges e
        join nodes src on e.source = src.id
        join nodes dst on e.target = dst.id
        where src.file_path = 'Main.lean'
      `).all() as Array<{
        srcKind: string;
        srcPath: string;
        dstKind: string;
        dstPath: string;
        dstQName: string;
        edgeKind: string;
      }>;
      db.close();

      expect(rows.some((r) =>
        r.srcKind === 'file' &&
        r.edgeKind === 'imports' &&
        r.dstKind === 'file' &&
        r.dstPath === 'Foo/Bar.lean'
      )).toBe(true);
      expect(rows.some((r) =>
        r.edgeKind === 'calls' &&
        r.dstKind === 'function' &&
        r.dstQName === 'Foo.bar'
      )).toBe(true);
    } finally {
      if (cg) cg.destroy();
      fs.rmSync(tempProject, { recursive: true, force: true });
      restoreLeanEnv(env);
    }
  });

  it('uses fake Lean LSP definition results when semantic resolution is available', async () => {
    const env = snapshotLeanEnv();
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lean-lsp-'));
    const fakeServer = writeFakeLeanLsp();
    let cg: CodeGraph | null = null;
    try {
      fs.writeFileSync(path.join(tempProject, 'Lib.lean'), `namespace Lib\n\ndef target : Nat := 1\n\nend Lib\n`);
      fs.writeFileSync(path.join(tempProject, 'Main.lean'), `import Lib\n\nnamespace Main\n\ndef caller : Nat := alias 0\n\nend Main\n`);

      process.env.CODEGRAPH_LEAN_SEMANTICS = 'auto';
      process.env.CODEGRAPH_LEAN_LSP_COMMAND = `${process.execPath} ${fakeServer}`;
      process.env.CODEGRAPH_LEAN_LSP_TIMEOUT_MS = '1000';
      process.env.CODEGRAPH_LEAN_LSP_REF_LIMIT = '10';
      process.env.FAKE_LEAN_TARGET_URI = new URL(`file://${path.join(tempProject, 'Lib.lean')}`).href;
      process.env.FAKE_LEAN_TARGET_LINE = '2';
      process.env.FAKE_LEAN_TARGET_COLUMN = '4';

      cg = await CodeGraph.init(tempProject, { index: true });
      const caller = cg.getNodesByKind('function').find((n) => n.name === 'caller');
      expect(caller).toBeDefined();
      const edge = cg.getOutgoingEdges(caller!.id).find((e) => e.kind === 'calls');
      expect(edge?.metadata?.resolvedBy).toBe('lean-lsp');
      expect(cg.getNode(edge!.target)?.qualifiedName).toBe('Lib.target');
    } finally {
      if (cg) cg.destroy();
      fs.rmSync(tempProject, { recursive: true, force: true });
      fs.rmSync(fakeServer, { force: true });
      restoreLeanEnv(env);
    }
  });

  it('falls back when Lean LSP returns a project-external location, times out, or is disabled', async () => {
    const run = async (configure: (project: string, fakeServer: string) => void) => {
      const env = snapshotLeanEnv();
      const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lean-lsp-fallback-'));
      const fakeServer = writeFakeLeanLsp();
      let cg: CodeGraph | null = null;
      try {
        fs.writeFileSync(path.join(tempProject, 'Lib.lean'), `namespace Lib\n\ndef target : Nat := 1\n\nend Lib\n`);
        fs.writeFileSync(path.join(tempProject, 'Main.lean'), `import Lib\n\nnamespace Main\n\ndef caller : Nat := alias 0\n\nend Main\n`);
        configure(tempProject, fakeServer);

        cg = await CodeGraph.init(tempProject, { index: true });
        const caller = cg.getNodesByKind('function').find((n) => n.name === 'caller');
        expect(caller).toBeDefined();
        expect(cg.getOutgoingEdges(caller!.id).filter((e) => e.kind === 'calls')).toHaveLength(0);
      } finally {
        if (cg) cg.destroy();
        fs.rmSync(tempProject, { recursive: true, force: true });
        fs.rmSync(fakeServer, { force: true });
        restoreLeanEnv(env);
      }
    };

    await run((_project, fakeServer) => {
      process.env.CODEGRAPH_LEAN_SEMANTICS = 'auto';
      process.env.CODEGRAPH_LEAN_LSP_COMMAND = `${process.execPath} ${fakeServer}`;
      process.env.CODEGRAPH_LEAN_LSP_TIMEOUT_MS = '1000';
      process.env.FAKE_LEAN_TARGET_URI = new URL('file:///tmp/outside.lean').href;
    });

    await run((project, fakeServer) => {
      process.env.CODEGRAPH_LEAN_SEMANTICS = 'auto';
      process.env.CODEGRAPH_LEAN_LSP_COMMAND = `${process.execPath} ${fakeServer}`;
      process.env.CODEGRAPH_LEAN_LSP_TIMEOUT_MS = '50';
      process.env.FAKE_LEAN_SKIP_DEFINITION = '1';
      process.env.FAKE_LEAN_TARGET_URI = new URL(`file://${path.join(project, 'Lib.lean')}`).href;
    });

    await run((project, fakeServer) => {
      process.env.CODEGRAPH_LEAN_SEMANTICS = 'off';
      process.env.CODEGRAPH_LEAN_LSP_COMMAND = `${process.execPath} ${fakeServer}`;
      process.env.FAKE_LEAN_TARGET_URI = new URL(`file://${path.join(project, 'Lib.lean')}`).href;
      process.env.FAKE_LEAN_TARGET_LINE = '2';
      process.env.FAKE_LEAN_TARGET_COLUMN = '4';
    });
  });

  it('skips Lake dependency packages by default unless explicitly unignored', () => {
    const tempProject = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-lean-ignore-'));
    try {
      fs.mkdirSync(path.join(tempProject, '.lake', 'packages', 'Dep'), { recursive: true });
      fs.writeFileSync(path.join(tempProject, 'Main.lean'), 'def main := 1\n');
      fs.writeFileSync(path.join(tempProject, '.lake', 'packages', 'Dep', 'Lib.lean'), 'def dep := 1\n');

      let files = scanDirectory(tempProject);
      expect(files).toContain('Main.lean');
      expect(files).not.toContain('.lake/packages/Dep/Lib.lean');

      fs.writeFileSync(
        path.join(tempProject, '.gitignore'),
        '!.lake/\n!.lake/packages/\n!.lake/packages/**\n'
      );
      files = scanDirectory(tempProject);
      expect(files).toContain('.lake/packages/Dep/Lib.lean');
    } finally {
      fs.rmSync(tempProject, { recursive: true, force: true });
    }
  });
});
