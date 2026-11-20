/**
 * A Delphi `for … in` loop that declares its variable inline (#2546):
 * `for var lItem in AList do`, `for var lHandle: THandle in lHandles do`
 * (Delphi 10.3 and later).
 *
 * The Pascal grammar's for-in rule takes a plain variable, so the whole loop
 * was an ERROR node and no call in its body reached the graph. The extractor's
 * preParse now blanks the inline `var` and its type, offsets kept, so the loop
 * parses the way the grammar knows it. The resolver still finds the type: it
 * reads a receiver's declaration from the source as written.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { preParsePascal } from '../src/extraction/languages/pascal-preparse';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

// The issue's own unit.
const LOOP_PAS = `unit Loop;

interface

type
  TItem = class
  public
    function DropIfEmpty: Boolean;
  end;

procedure WithVar(const AList: TArray<TItem>);
procedure WithDecl(const AList: TArray<TItem>);

implementation

function TItem.DropIfEmpty: Boolean;
begin
  Result := True;
end;

procedure WithVar(const AList: TArray<TItem>);
begin
  for var lItem in AList do
    lItem.DropIfEmpty;
end;

procedure WithDecl(const AList: TArray<TItem>);
var
  lItem: TItem;
begin
  for lItem in AList do
    lItem.DropIfEmpty;
end;

end.
`;

function callsFrom(code: string, qualifiedName: string, file = 'Loop.pas'): string[] {
  const result = extractFromSource(file, code);
  const from = result.nodes.find((n) => n.qualifiedName === qualifiedName);
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === 'calls' && r.fromNodeId === from?.id)
    .map((r) => `${r.referenceName}:${r.line}`);
}

async function withIndex(files: Record<string, string>, check: (cg: CodeGraph) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-for-var-'));
  try {
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
    const cg = await CodeGraph.init(dir, { index: true });
    try {
      check(cg);
    } finally {
      cg.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function callerNames(cg: CodeGraph, qualifiedName: string): string[] {
  const target = cg.getNodesByKind('method').find((n) => n.qualifiedName === qualifiedName);
  if (!target) return [];
  return cg
    .getIncomingEdges(target.id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.source)?.name ?? '?')
    .sort();
}

describe('Delphi `for var … in` loops (#2546)', () => {
  it('reads the call in the body of a `for var x in` loop, as for a declared loop variable', () => {
    expect(callsFrom(LOOP_PAS, 'WithVar')).toEqual(['lItem.DropIfEmpty:24']);
    expect(callsFrom(LOOP_PAS, 'WithDecl')).toEqual(['lItem.DropIfEmpty:32']);
  });

  it('links both routines to the method the issue names', async () => {
    await withIndex({ 'Loop.pas': LOOP_PAS }, (cg) => {
      expect(callerNames(cg, 'TItem::DropIfEmpty')).toEqual(['WithDecl', 'WithVar']);
    });
  });

  it('resolves a typed loop variable on its declared type, not on a namesake', async () => {
    const code = `unit Recv;

interface

type
  THandleBox = class
  public
    procedure Close;
  end;

  TDecoy = class
  public
    procedure Close;
  end;

procedure UseTyped(const AHandles: TArray<THandleBox>);

implementation

procedure THandleBox.Close;
begin
end;

procedure TDecoy.Close;
begin
end;

procedure UseTyped(const AHandles: TArray<THandleBox>);
begin
  for var lHandle: THandleBox in AHandles do
    lHandle.Close;
end;

end.
`;
    await withIndex({ 'Recv.pas': code }, (cg) => {
      expect(callerNames(cg, 'THandleBox::Close')).toEqual(['UseTyped']);
      expect(callerNames(cg, 'TDecoy::Close')).toEqual([]);
    });
  });

  it('parses generic and dotted loop types, loops inside anonymous methods and one-line loops', () => {
    const code = `unit Forms;

interface

implementation

procedure Run(const D: TDictionary<string, TList<Integer>>; const L: TArray<TItem>);
begin
  for var P: TPair<string, TList<Integer>> in D do
    P.Value.Clear;
  for var Q: System.Generics.Collections.TPair<string, Integer> in Pairs do Q.Free;
  TParallel.For(0, 9, procedure(I: Integer)
    begin
      for var X in L do X.Reset;
    end);
  if Assigned(L) then for var Y in L do Y.Done;
end;

end.
`;
    const tree = getParser('pascal')!.parse(preParsePascal(code))!;
    try {
      expect(tree.rootNode.hasError).toBe(false);
    } finally {
      tree.delete();
    }
    // `P.Value.Clear` is a chain on a loop variable whose type the parse
    // doesn't keep, so no bare `Clear` is named for it (#2550); the anonymous
    // method's call belongs to `Run`.
    expect(callsFrom(code, 'Run', 'Forms.pas')).toEqual([
      'Q.Free:11',
      'TParallel.For:12',
      'X.Reset:14',
      'Assigned:16',
      'Y.Done:16',
    ]);
  });

  it('blanks only the inline `var` and its type, keeping every offset', () => {
    const blank = (line: string, ...parts: string[]) =>
      parts.reduce((s, part) => s.replace(part, ' '.repeat(part.length)), line);
    const lines = [
      'for var lItem in AList do',
      'for var lHandle: THandle in lHandles do',
      'for var P: TPair<string, TList<Integer>>',
      '  in D do',
    ];
    const out = preParsePascal(lines.join('\r\n'));
    expect(out.split('\r\n')).toEqual([
      blank(lines[0]!, 'var'),
      blank(lines[1]!, 'var', ': THandle'),
      blank(lines[2]!, 'var', ': TPair<string, TList<Integer>>'),
      lines[3],
    ]);
  });

  it('leaves every other `for` alone', () => {
    const code = `unit Keep;

interface

type
  TStringHelper = record helper for string
    function Upper: string;
  end;

implementation

procedure Run(const L: TArray<Integer>);
var
  N: Integer;
begin
  for var I := 0 to 9 do Use(I);
  for var J: Integer := 0 to 9 do Use(J);
  for N in L do Use(N);
  for N := High(L) downto 0 do Use(N);
  // for var Old in L do Use(Old);
  { for var Older in L do }
  WriteLn('for var Text in L do');
end;

end.
`;
    expect(preParsePascal(code)).toBe(code);
  });
});
