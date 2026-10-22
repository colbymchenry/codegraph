/**
 * The receiver of a chained Delphi call (#2547): in
 * `MD5FileSized(TMeta.ExtendedPath(APath)).IsSame(AKey)` only `IsSame` was
 * recorded. The receiver call `MD5FileSized` and the `TMeta.ExtendedPath` in
 * its arguments were dropped, and so were the paren'd calls deeper in a chain
 * (`A(1).B.C`) or in an index (`List[GetIndex(x)].Free`). The extractor now
 * reads every paren'd call in a receiver chain. A paren-less link (`.B`) may
 * read a field or property, so it is still not a call, and a typecast like
 * `TButton(Sender)` creates nothing, so it no longer reads as a construction.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

// The issue's own unit.
const CHAIN_PAS = `unit Chain;

interface

type
  TKey = record
    function IsSame(const AOther: TKey): Boolean;
    procedure Reset;
  end;

  TMeta = class
    class function ExtendedPath(const APath: string): string; static;
  end;

function MD5FileSized(const APath: string): TKey;
function TargetIsTheSame(const APath: string; const AKey: TKey): Boolean;
procedure Stmt(const APath: string);

implementation

function TKey.IsSame(const AOther: TKey): Boolean;
begin
  Result := True;
end;

procedure TKey.Reset;
begin
end;

class function TMeta.ExtendedPath(const APath: string): string;
begin
  Result := APath;
end;

function MD5FileSized(const APath: string): TKey;
begin
end;

function TargetIsTheSame(const APath: string; const AKey: TKey): Boolean;
begin
  Result := MD5FileSized(TMeta.ExtendedPath(APath)).IsSame(AKey);
end;

procedure Stmt(const APath: string);
begin
  MD5FileSized(TMeta.ExtendedPath(APath)).Reset;
end;

end.
`;

function refsFrom(code: string, qualifiedName: string, kind = 'calls'): string[] {
  const result = extractFromSource('Unit1.pas', code);
  const from = result.nodes.find((n) => n.qualifiedName === qualifiedName);
  return result.unresolvedReferences
    .filter((r) => r.referenceKind === kind && r.fromNodeId === from?.id)
    .map((r) => `${r.referenceName}:${r.line}`)
    .sort();
}

async function withIndex(code: string, check: (cg: CodeGraph) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-chain-'));
  try {
    fs.writeFileSync(path.join(dir, 'Unit1.pas'), code);
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

function edgesFrom(cg: CodeGraph, sourceName: string): string[] {
  const source = cg.getNodesByKind('function').concat(cg.getNodesByKind('method')).find((n) => n.name === sourceName);
  if (!source) return [];
  return cg
    .getOutgoingEdges(source.id)
    .filter((e) => e.kind !== 'contains')
    .map((e) => `${e.kind} ${cg.getNode(e.target)?.qualifiedName ?? '?'}`)
    .sort();
}

describe('Delphi chained calls (#2547)', () => {
  it('records the receiver call and the calls in its arguments', () => {
    expect(refsFrom(CHAIN_PAS, 'TargetIsTheSame')).toEqual(['IsSame:41', 'MD5FileSized:41', 'TMeta.ExtendedPath:41']);
    expect(refsFrom(CHAIN_PAS, 'Stmt')).toEqual(['MD5FileSized:46', 'Reset:46', 'TMeta.ExtendedPath:46']);
  });

  it('links each routine to all three callees the issue names', async () => {
    await withIndex(CHAIN_PAS, (cg) => {
      expect(edgesFrom(cg, 'TargetIsTheSame')).toEqual([
        'calls MD5FileSized',
        'calls TKey::IsSame',
        'calls TMeta::ExtendedPath',
      ]);
      expect(edgesFrom(cg, 'Stmt')).toEqual(['calls MD5FileSized', 'calls TKey::Reset', 'calls TMeta::ExtendedPath']);
    });
  });

  it('reads paren\'d calls anywhere in a receiver chain, in every context', () => {
    const code = `unit Unit1;

interface

implementation

procedure Run;
begin
  A(1).B.C(2);
  X := A(3).B.C;
  if F(4).Ready then Exit;
  List[GetIndex(5)].Free;
  Y := Items[Find(6)].Value;
  GetHandler(7)(8);
  Z := Obj.Prop.Method(9);
end;

end.
`;
    // `B`, `C` (line 10), `Ready`, `Value` and `Prop` are paren-less links: reads, not calls.
    expect(refsFrom(code, 'Run')).toEqual([
      'A:10',
      'A:9',
      'C:9',
      'F:11',
      'Find:13',
      'Free:12',
      'GetHandler:14',
      'GetIndex:12',
      'Method:15',
    ]);
  });

  it('names a fluent chain\'s inner links only where they can be named precisely', () => {
    const code = `unit Unit1;

interface

implementation

procedure Run;
begin
  Client.New.BaseURL('x').Accept('y').Get('/');
  RESTClient.HandleRedirects(False).Accept('z').Get('/');
  Builder.WithName(Name).Build;
end;

end.
`;
    // The outer `Get` keeps the name a call has always had. `BaseURL` and
    // `Accept` would be bare names on a chain whose type is unknown, which
    // match namesakes, so they are left out; `RESTClient.HandleRedirects`
    // and `Builder.WithName` name their receiver.
    expect(refsFrom(code, 'Run')).toEqual(['Build:11', 'Builder.WithName:11', 'Get:10', 'Get:9', 'RESTClient.HandleRedirects:10']);
  });

  it('gives a factory its caller and still resolves the chain on what it returns', async () => {
    const code = `unit Unit1;

interface

type
  TBar = class
    procedure DoIt;
  end;
  TDecoy = class
    procedure DoIt;
  end;
  TFoo = class
    class function GetInstance: TBar;
  end;

procedure Run;

implementation

procedure TBar.DoIt; begin end;
procedure TDecoy.DoIt; begin end;
class function TFoo.GetInstance: TBar; begin Result := nil; end;

procedure Run;
begin
  TFoo.GetInstance().DoIt();
end;

end.
`;
    await withIndex(code, (cg) => {
      expect(edgesFrom(cg, 'Run')).toEqual(['calls TBar::DoIt', 'calls TFoo::GetInstance']);
    });
  });

  it('reads a typecast as a reference to its type, never a construction, wherever it is written', async () => {
    const code = `unit Unit1;

interface

type
  TFoo = class
  public
    procedure DoIt;
    function Ready: Boolean;
  end;

  TDecoy = class
  public
    procedure DoIt;
  end;

  NullableInt = record
    procedure SetNull;
  end;

  TPair = record
    Lo, Hi: Integer;
  end;
  PPair = ^TPair;

function GetObj(N: Integer): TObject;
procedure Run(Sender: TObject; var V; P: Pointer);

implementation

procedure TFoo.DoIt; begin end;
function TFoo.Ready: Boolean; begin Result := True; end;
procedure TDecoy.DoIt; begin end;
procedure NullableInt.SetNull; begin end;
function GetObj(N: Integer): TObject; begin Result := nil; end;

procedure Run(Sender: TObject; var V; P: Pointer);
var
  F: TFoo;
begin
  TFoo(Sender).DoIt;
  TFoo(GetObj(1)).DoIt();
  if TFoo(Sender).Ready then Exit;
  F := TFoo(Sender);
  NullableInt(V).SetNull;
  PPair(P)^.Lo := 1;
end;

end.
`;
    await withIndex(code, (cg) => {
      expect(edgesFrom(cg, 'Run')).toEqual([
        'calls GetObj',
        'calls NullableInt::SetNull',
        'calls TFoo::DoIt',
        'calls TFoo::DoIt',
        'references NullableInt',
        'references PPair',
        'references TFoo',
        'references TFoo',
        'references TFoo',
        'references TFoo',
      ]);
    });
  });

  it('captures a routine passed by name to a receiver call, as for any call', async () => {
    const code = `unit Unit1;

interface

type
  TJob = class
    procedure Start;
  end;

function Schedule(Proc: TProc): TJob;
procedure Worker;
procedure Run;

implementation

procedure TJob.Start; begin end;
function Schedule(Proc: TProc): TJob; begin Result := nil; end;
procedure Worker; begin end;

procedure Run;
begin
  Schedule(Worker).Start;
end;

end.
`;
    await withIndex(code, (cg) => {
      expect(edgesFrom(cg, 'Run')).toEqual(['calls Schedule', 'calls TJob::Start', 'references Worker']);
    });
  });
});
