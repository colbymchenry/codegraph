/**
 * A Pascal routine may declare routines of its own between its header and
 * its `begin`. Their bodies were never walked, so whatever they called was
 * missing from the graph, and a call to one from the routine that declares
 * it went by name to any routine elsewhere that shares it. Now a nested
 * routine is a function qualified under the routine it is nested in
 * (`THost::Fire::Inner`), its calls are its own, and its name means it
 * wherever it is in scope: in the routine that declares it, in the routines
 * nested after it there, and in its own body. Its locals and parameters are
 * in scope for its body and for the routines nested inside it.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['pascal']);
});

async function withIndex(files: Record<string, string>, check: (cg: CodeGraph) => void): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-nested-'));
  try {
    for (const [name, code] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), code);
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

function routine(cg: CodeGraph, qualifiedName: string) {
  const node = cg.getNodesByKind('method').concat(cg.getNodesByKind('function')).find((n) => n.qualifiedName === qualifiedName);
  expect(node, qualifiedName).toBeDefined();
  return node!;
}

/** What a routine calls, as `file:Target`, sorted. */
function callsFrom(cg: CodeGraph, qualifiedName: string): string[] {
  return [...new Set(cg.getOutgoingEdges(routine(cg, qualifiedName).id)
    .filter((e) => e.kind === 'calls')
    .map((e) => cg.getNode(e.target)!)
    .map((n) => `${path.basename(n.filePath)}:${n.qualifiedName}`))].sort();
}

// The routines elsewhere a nested routine's name could be taken for.
const LIB = `unit Lib;

interface

procedure Inner(N: Integer);
procedure Helper(N: Integer);
procedure Log(const S: string);

implementation

procedure Inner(N: Integer); begin end;
procedure Helper(N: Integer); begin end;
procedure Log(const S: string); begin end;

end.
`;

function host(implementation: string): string {
  return `unit Host;

interface

uses Lib;

type
  THost = class
  public
    procedure Read;
    procedure Fire;
    function Count(O: TObject): Integer;
  end;

  TOther = class
  public
    function Count(O: TObject): Integer;
  end;

implementation

function THost.Count(O: TObject): Integer; begin Result := 0; end;
procedure THost.Read; begin end;
function TOther.Count(O: TObject): Integer; begin Result := 1; end;

${implementation}

end.
`;
}

describe('Pascal nested routines', () => {
  it('indexes a nested routine as a function of its own, called by the routine that declares it', async () => {
    const main = host(`procedure THost.Fire;
var
  Count: Integer;

  procedure Inner(N: Integer);
  var
    K: Integer;
  begin
    K := N + Count;
    Helper(K);
  end;

begin
  Inner(1);
end;`);
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main }, (cg) => {
      const inner = routine(cg, 'THost::Fire::Inner');
      expect(inner.kind).toBe('function');
      const contains = cg.getOutgoingEdges(routine(cg, 'THost::Fire').id).filter((e) => e.kind === 'contains');
      expect(contains.map((e) => e.target)).toContain(inner.id);
      // Its call is its own, and the routine's call to `Inner` is to it, not to Lib's.
      expect(callsFrom(cg, 'THost::Fire::Inner')).toEqual(['Lib.pas:Helper']);
      expect(callsFrom(cg, 'THost::Fire')).toEqual(['Host.pas:THost::Fire::Inner']);
    });
  });

  it('follows calls through nesting levels, siblings above and the routine itself', async () => {
    const main = host(`procedure THost.Fire;

  procedure First;
  begin
    Log('first');
  end;

  procedure Again(N: Integer);
  begin
    if N > 0 then
      Again(N - 1);
    First;
  end;

  procedure Level1;

    procedure Level2;
    begin
      Again(2);
      Level1;
    end;

  begin
    Level2;
  end;

begin
  Level1;
end;`);
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main }, (cg) => {
      expect(callsFrom(cg, 'THost::Fire')).toEqual(['Host.pas:THost::Fire::Level1']);
      expect(callsFrom(cg, 'THost::Fire::Level1')).toEqual(['Host.pas:THost::Fire::Level1::Level2']);
      // A deeper routine reaches a routine nested further out, and the one it is in.
      expect(callsFrom(cg, 'THost::Fire::Level1::Level2')).toEqual([
        'Host.pas:THost::Fire::Again',
        'Host.pas:THost::Fire::Level1',
      ]);
      // A routine calls itself, and an earlier sibling, with or without parentheses.
      expect(callsFrom(cg, 'THost::Fire::Again')).toEqual(['Host.pas:THost::Fire::Again', 'Host.pas:THost::Fire::First']);
      expect(callsFrom(cg, 'THost::Fire::First')).toEqual(['Lib.pas:Log']);
    });
  });

  it('keeps a nested routine to the routine it is nested in', async () => {
    const main = host(`procedure THost.Fire;

  procedure Outer;

    procedure Hidden(N: Integer);
    begin
    end;

  begin
    Hidden(1);
  end;

  procedure Peer;
  begin
    Hidden(2);
    Helper(3);
  end;

begin
  Outer;
  Peer;
end;

procedure Tidy;

  procedure Helper(N: Integer);
  begin
  end;

begin
  Helper(4);
end;`);
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main }, (cg) => {
      expect(callsFrom(cg, 'THost::Fire::Outer')).toEqual(['Host.pas:THost::Fire::Outer::Hidden']);
      // Neither another routine's nested `Hidden` nor `Tidy`'s nested `Helper` is in scope here.
      expect(callsFrom(cg, 'THost::Fire::Peer')).toEqual(['Lib.pas:Helper']);
      expect(callsFrom(cg, 'Tidy')).toEqual(['Host.pas:Tidy::Helper']);
    });
  });

  it('keeps a later sibling out of scope, and a nested routine out of another unit', async () => {
    const main = host(`procedure THost.Fire;

  procedure Early;
  begin
    Inner(1);
  end;

  procedure Inner(N: Integer);
  begin
  end;

begin
  Early;
  Inner(2);
end;`);
    const other = `unit Other;

interface

uses Lib, Host;

procedure Run;

implementation

procedure Run;
begin
  Inner(3);
end;

end.
`;
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main, 'Other.pas': other }, (cg) => {
      // Declared after it, the sibling isn't one `Early` can call: Lib's `Inner` is.
      expect(callsFrom(cg, 'THost::Fire::Early')).toEqual(['Lib.pas:Inner']);
      expect(callsFrom(cg, 'THost::Fire')).toEqual(['Host.pas:THost::Fire::Early', 'Host.pas:THost::Fire::Inner']);
      expect(callsFrom(cg, 'Run')).toEqual(['Lib.pas:Inner']);
    });
  });

  it('gives a nested routine the class and the locals of the routines around it', async () => {
    const main = host(`procedure THost.Fire;
var
  Before: TObject;

  procedure Inner;
  begin
    Read;
    Before.Free;
    Helper(Count(Before));
  end;

var
  Log: Integer;

  procedure Second(Helper: Integer);
  begin
    Log := Helper + 1;
  end;

begin
  Inner;
  Second(1);
end;`);
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main }, (cg) => {
      // The class's `Read` and `Count` are in scope there, not `TOther`'s
      // `Count`, and `Before` is the routine's local.
      expect(callsFrom(cg, 'THost::Fire::Inner')).toEqual(['Host.pas:THost::Count', 'Host.pas:THost::Read', 'Lib.pas:Helper']);
      // A parameter and a local of the routine around it hide Lib's routines.
      expect(callsFrom(cg, 'THost::Fire::Second')).toEqual([]);
      expect(callsFrom(cg, 'THost::Fire')).toEqual(['Host.pas:THost::Fire::Inner', 'Host.pas:THost::Fire::Second']);
    });
  });

  it('takes a routine a broken parse nests, at the start of its line, for one of the unit', async () => {
    // The missing `;` after `procedure First` leaves `Second` inside it in the tree.
    const script = `procedure First
begin
end;

function Second : Integer
var
   i : Integer;
begin
   i := 1;
   Result := Helper(i);
end;

type
   TThing = class
      method Run : String;
      method Stop;
   end;

method TThing.Run : String
begin
   Result := '';
end;

method TThing.Stop
const
   c = 2;
begin
end;
`;
    const lib = `unit Lib;

interface

function Helper(N: Integer): Integer;

implementation

function Helper(N: Integer): Integer; begin Result := N; end;

end.
`;
    await withIndex({ 'Lib.pas': lib, 'Script.pas': script }, (cg) => {
      const names = cg.getNodesByKind('function').filter((n) => n.filePath === 'Script.pas').map((n) => n.qualifiedName);
      expect(names).toContain('Second');
      expect(names).not.toContain('First::Second');
      expect(callsFrom(cg, 'Second')).toEqual(['Lib.pas:Helper']);
    });
  });

  it('takes a nested function\'s own name for its result, and a nested name like a System routine\'s for the nested one', async () => {
    const main = host(`procedure THost.Fire;

  function Calc: Integer;
  begin
    Calc := 5;
  end;

  procedure Delete(Index: Integer);
  begin
  end;

begin
  if Calc > 0 then
    Delete(1);
end;`);
    await withIndex({ 'Lib.pas': LIB, 'Host.pas': main }, (cg) => {
      expect(callsFrom(cg, 'THost::Fire::Calc')).toEqual([]);
      expect(callsFrom(cg, 'THost::Fire')).toEqual(['Host.pas:THost::Fire::Calc', 'Host.pas:THost::Fire::Delete']);
    });
  });
});
