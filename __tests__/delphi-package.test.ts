import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

const VISUAL_CONTROLS = `package ExampleVisualControls;

{$R *.res}
{$IFDEF IMPLICITBUILDING This IFDEF should not be used by users}
{$ALIGN 8}
{$ASSERTIONS ON}
{$DESCRIPTION 'Example visual controls'}
{$DESIGNONLY}
{$IMPLICITBUILD ON}
{$ENDIF IMPLICITBUILDING}

requires
  rtl,
  vcl,
  RaizeComponentsVcl;

contains
  ExampleGrid in 'Grid\\ExampleGrid.pas',
  ExampleTip in '..\\Shared Tips\\ExampleTip.pas';

end.
`;

function imports(source: string, file = 'Pkg.dpk') {
  const result = extractFromSource(file, source);
  return {
    result,
    names: result.nodes.filter((n) => n.kind === 'import').map((n) => n.name),
    signatures: result.nodes.filter((n) => n.kind === 'import').map((n) => n.signature),
  };
}

describe('Delphi package (.dpk) extraction', () => {
  it('indexes the package as a module with its requires and contains units', () => {
    const { result, names, signatures } = imports(VISUAL_CONTROLS, 'Components/ExampleVisualControls.dpk');
    const module = result.nodes.find((n) => n.kind === 'module');
    expect(module).toMatchObject({ name: 'ExampleVisualControls', language: 'pascal', startLine: 1, endLine: 21 });
    expect(names).toEqual(['rtl', 'vcl', 'RaizeComponentsVcl', 'ExampleGrid', 'ExampleTip']);
    expect(signatures).toEqual([
      'requires rtl',
      'requires vcl',
      'requires RaizeComponentsVcl',
      "contains ExampleGrid in 'Grid\\ExampleGrid.pas'",
      "contains ExampleTip in '..\\Shared Tips\\ExampleTip.pas'",
    ]);
    expect(result.errors).toEqual([]);
  });

  it('links every entry with an imports reference at its own position', () => {
    const { result } = imports(VISUAL_CONTROLS);
    const file = result.nodes.find((n) => n.kind === 'file')!;
    const refs = result.unresolvedReferences.filter((r) => r.referenceKind === 'imports');
    expect(refs.map((r) => [r.referenceName, r.line, r.column])).toEqual([
      ['rtl', 13, 2],
      ['vcl', 14, 2],
      ['RaizeComponentsVcl', 15, 2],
      ['ExampleGrid', 18, 2],
      ['ExampleTip', 19, 2],
    ]);
    expect(new Set(refs.map((r) => r.fromNodeId))).toEqual(new Set([file.id]));
    const contained = result.edges.filter((e) => e.source === file.id && e.kind === 'contains').length;
    expect(contained).toBe(6);
  });

  it('keeps namespaced unit names whole', () => {
    const { names } = imports(`package P; requires Vcl.Forms, System.SysUtils; contains Acme.Core.Units in 'a.pas'; end.`);
    expect(names).toEqual(['Vcl.Forms', 'System.SysUtils', 'Acme.Core.Units']);
  });

  it('matches keywords in any case and accepts a package without clauses', () => {
    const { result, names } = imports(`PACKAGE Empty;\nEND.`);
    expect(result.nodes.find((n) => n.kind === 'module')?.name).toBe('Empty');
    expect(names).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(imports(`Package P; Contains A in 'a.pas'; END.`).names).toEqual(['A']);
  });

  it('ignores keywords and separators inside comments, strings and directives', () => {
    const { result, names, signatures } = imports(`package P; // requires hidden;
(* contains hidden2; *)
{ requires hidden3 }
{$R *.res}
{$DEFINE contains}
requires A { , ghost } , B;
contains C in 'dir;with, requires.pas';
end.`);
    expect(names).toEqual(['A', 'B', 'C']);
    expect(signatures[2]).toBe("contains C in 'dir;with, requires.pas'");
    expect(result.errors).toEqual([]);
  });

  it('keeps a doubled quote in a contains path verbatim', () => {
    const { signatures, result } = imports(`package P; contains A in 'it''s.pas'; end.`);
    expect(signatures).toEqual(["contains A in 'it''s.pas'"]);
    expect(result.errors).toEqual([]);
  });

  it('reads CRLF line endings and a byte order mark', () => {
    const source = `\uFEFFpackage P;\r\nrequires\r\n  A;\r\nend.\r\n`;
    const { result } = imports(source);
    const ref = result.unresolvedReferences.find((r) => r.referenceName === 'A')!;
    expect([ref.line, ref.column]).toEqual([3, 2]);
    expect(result.nodes.find((n) => n.kind === 'module')).toMatchObject({ name: 'P', startLine: 1, startColumn: 0 });
    expect(result.errors).toEqual([]);
  });

  it('accepts requires lists split by conditional compilation without duplicates', () => {
    const { names, result } = imports(`package P;
requires
  rtl,
{$IFDEF FULL}
  requires vcl,
{$ELSE}
  requires vclx,
{$ENDIF}
  rtl;
end.`);
    expect(names).toEqual(['rtl', 'vcl', 'vclx']);
    expect(result.errors).toEqual([]);
  });

  it('does not treat a package header inside a comment as the package', () => {
    const { result } = imports(`{ package Fake; }\npackage Real;\nend.`);
    expect(result.nodes.find((n) => n.kind === 'module')?.name).toBe('Real');
  });

  it.each([
    ['empty file', '', 'expected \'package\', found end of file', 1, 0],
    ['a unit source', 'unit U;\ninterface\nimplementation\nend.', "expected 'package', found 'unit'", 1, 0],
    ['a missing semicolon after the header', 'package P\nrequires A;\nend.', "expected ';', found 'requires'", 2, 0],
    ['a missing list separator', 'package P;\nrequires A B;\nend.', "expected ',' or ';', found 'B'", 2, 11],
    ['an empty requires list', 'package P;\nrequires ;\nend.', "expected a unit name, found ';'", 2, 9],
    ['a missing end', 'package P;\nrequires A;\n', "expected 'requires', 'contains' or 'end', found end of file", 3, 0],
    ['a missing final dot', 'package P;\nend', "expected '.', found end of file", 2, 3],
    ['a path outside contains', "package P;\nrequires A in 'a.pas';\nend.", "expected ',' or ';', found 'in'", 2, 11],
    ['a contains path without quotes', 'package P;\ncontains A in a.pas;\nend.', 'expected a quoted file path, found \'a.pas\'', 2, 14],
    ['an unterminated string', "package P;\ncontains A in 'a.pas;\nend.", 'unterminated string', 2, 14],
    ['an unterminated comment', 'package P;\n{ requires A;\nend.', 'unterminated comment', 2, 0],
    ['a stray character', 'package P;\nrequires A#;\nend.', "unexpected character '#'", 2, 10],
    ['trailing source after end', 'package P;\nend.\nbegin', "expected end of file, found 'begin'", 3, 0],
    ['a missing semicolon before a plain directive', 'package P;\nrequires A\n{$R *.res}\ncontains B;\nend.', "expected ',' or ';', found 'contains'", 4, 0],
    ['a missing semicolon before a conditional directive', 'package P;\nrequires A\n{$IFDEF X}\ncontains B;\n{$ENDIF}\nend.', "expected ',' or ';', found 'contains'", 4, 0],
  ])('reports %s as a syntax error', (_name, source, message, line, column) => {
    const { result } = imports(source);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({
      message: `Delphi package syntax error: ${message}`,
      severity: 'error',
      code: 'parse_error',
      line,
      column,
    });
  });

  it('keeps the entries read before a syntax error', () => {
    const { result, names } = imports('package P;\nrequires A, B\ncontains C;\nend.');
    expect(names).toEqual(['A', 'B']);
    expect(result.nodes.find((n) => n.kind === 'module')?.name).toBe('P');
    expect(result.errors).toHaveLength(1);
  });

  it('falls back to the file name when the package name is missing, and says so', () => {
    const { result } = imports('package;\nend.', 'Missing.dpk');
    expect(result.nodes.find((n) => n.kind === 'module')?.name).toBe('Missing');
    expect(result.errors[0]).toMatchObject({ severity: 'error', line: 1, column: 7 });
  });

  it('leaves .dpr programs and .pas units on the Pascal grammar', () => {
    const program = extractFromSource('MyApp.dpr', 'program MyApp;\nbegin\nend.');
    expect(program.nodes.find((n) => n.kind === 'module')?.name).toBe('MyApp');
    expect(program.errors).toEqual([]);
    const unit = extractFromSource('U.pas', 'unit U;\ninterface\nuses Classes;\nimplementation\nend.');
    expect(unit.nodes.find((n) => n.kind === 'module')?.name).toBe('U');
  });
});

describe('Delphi package (.dpk) consumers', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'delphi-package-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  it('connects a package to the units it contains and the units that use it', async () => {
    fs.mkdirSync(path.join(directory, 'Components'));
    fs.writeFileSync(path.join(directory, 'Components', 'ExampleVisualControls.dpk'), VISUAL_CONTROLS);
    fs.writeFileSync(path.join(directory, 'Components', 'ExampleGrid.pas'),
      'unit ExampleGrid;\ninterface\ntype TGrid = class end;\nimplementation\nend.');
    fs.writeFileSync(path.join(directory, 'Components', 'ExampleTip.pas'),
      'unit ExampleTip;\ninterface\ntype TTip = class end;\nimplementation\nend.');
    graph = await CodeGraph.init(directory, { index: true });

    const files = graph.getNodesByKind('file');
    const dpk = files.find((n) => n.filePath.endsWith('.dpk'))!;
    const targets = graph.getOutgoingEdges(dpk.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => graph!.getNode(e.target)!)
      .map((n) => `${n.kind}:${n.name}:${path.basename(n.filePath)}`)
      .sort();
    expect(targets).toEqual([
      'module:ExampleGrid:ExampleGrid.pas',
      'module:ExampleTip:ExampleTip.pas',
    ]);
    expect(graph.getNodesByKind('module').map((n) => n.name).sort())
      .toEqual(['ExampleGrid', 'ExampleTip', 'ExampleVisualControls']);
  });

  it('shows a contained unit as used by its package', async () => {
    fs.writeFileSync(path.join(directory, 'Pkg.dpk'), "package Pkg;\ncontains Shared in 'Shared.pas';\nend.");
    fs.writeFileSync(path.join(directory, 'Shared.pas'), 'unit Shared;\ninterface\nimplementation\nend.');
    graph = await CodeGraph.init(directory, { index: true });

    const shared = graph.getNodesByKind('module').find((n) => n.name === 'Shared')!;
    const dependents = graph.getIncomingEdges(shared.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => path.basename(graph!.getNode(e.source)!.filePath));
    expect(dependents).toEqual(['Pkg.dpk']);
  });

  it('still indexes the file and module of a malformed package', async () => {
    fs.writeFileSync(path.join(directory, 'Bad.dpk'), 'package Bad;\nrequires A B;\nend.');
    graph = await CodeGraph.init(directory, { index: true });

    const dpk = graph.getNodesByKind('file').find((n) => n.filePath.endsWith('Bad.dpk'));
    expect(dpk).toBeDefined();
    expect(graph.getNodesByKind('module').map((n) => n.name)).toEqual(['Bad']);
  });

  it('keeps the units read from a package with trailing source after end', async () => {
    fs.writeFileSync(path.join(directory, 'Pkg.dpk'), "package Pkg;\ncontains Shared in 'Shared.pas';\nend.\nbegin");
    fs.writeFileSync(path.join(directory, 'Shared.pas'), 'unit Shared;\ninterface\nimplementation\nend.');
    graph = await CodeGraph.init(directory, { index: true });

    const shared = graph.getNodesByKind('module').find((n) => n.name === 'Shared')!;
    const dependents = graph.getIncomingEdges(shared.id)
      .filter((e) => e.kind === 'imports')
      .map((e) => path.basename(graph!.getNode(e.source)!.filePath));
    expect(dependents).toEqual(['Pkg.dpk']);
  });
});
