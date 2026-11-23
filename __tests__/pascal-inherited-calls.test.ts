/**
 * A Pascal `inherited` call runs a method of an ancestor of the calling
 * method's class: `inherited Run(N)` the nearest ancestor's `Run`, and a bare
 * `inherited;` the method of the calling routine's own name, with the
 * parameters it was given. Before, neither form left any reference, so a
 * method's call into the implementation it overrides was missing from the
 * graph, and a flow through an override stopped there.
 *
 * The ancestor is the class's own: the class it descends from and that
 * one's, never the calling class itself nor an interface it implements,
 * and only where the class can see it. A helper's method reaches the type it
 * helps. Of an ancestor's overloads, the one the arguments fit, and for a
 * bare call the one with the routine's own parameter types; an `overload`
 * set goes on up the hierarchy, and a class constructor, which only the
 * runtime runs, is never one. A name whose nearest declaration is data (a
 * property) runs nothing, and an ancestor outside the project links nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

const FILES: Record<string, string> = {
  'Base.pas': `unit Base;

interface

type
  TBase = class
  private
    function GetItem(I: Integer): Integer;
  public
    constructor Create; overload; virtual;
    constructor Create(AOwner: TObject); overload; virtual;
    procedure Run(N: Integer); virtual;
    procedure Stop; virtual;
    function Value: Integer; virtual;
    procedure Put(const S: string); overload; virtual;
    procedure Put(N: Integer); overload; virtual;
    procedure Log(const S: string; N: Integer); overload; virtual;
    property Items[I: Integer]: Integer read GetItem;
  end;

  IRunner = interface
    procedure Walk(N: Integer);
  end;

implementation

constructor TBase.Create;
begin
end;

constructor TBase.Create(AOwner: TObject);
begin
end;

function TBase.GetItem(I: Integer): Integer;
begin
  Result := I;
end;

procedure TBase.Run(N: Integer);
begin
end;

procedure TBase.Stop;
begin
end;

function TBase.Value: Integer;
begin
  Result := 0;
end;

procedure TBase.Put(const S: string);
begin
end;

procedure TBase.Put(N: Integer);
begin
end;

procedure TBase.Log(const S: string; N: Integer);
begin
end;

end.
`,
  'Mid.pas': `unit Mid;

interface

uses Classes, Base;

type
  TMid = class(TBase)
  public
    class constructor Create;
    procedure Stop; override;
    procedure Log(const S: string); overload;
  end;

  TPlain = class(TPersistent)
  public
    procedure Idle;
  end;

implementation

class constructor TMid.Create;
begin
end;

procedure TMid.Stop;
begin
end;

procedure TMid.Log(const S: string);
begin
end;

procedure TPlain.Idle;
begin
end;

end.
`,
  // A namesake of the RTL's TComponent, in a unit the caller doesn't use.
  'Other.pas': `unit Other;

interface

type
  TComponent = class
  public
    constructor Create(AOwner: TComponent); virtual;
  end;

implementation

constructor TComponent.Create(AOwner: TComponent);
begin
end;

end.
`,
  'Child.pas': `unit Child;

interface

uses Classes, Base, Mid;

type
  TChild = class(TMid)
  private
    FList: TObject;
  public
    constructor Create(AOwner: TObject); override;
    constructor CreateEmpty;
    procedure Run(N: Integer); override;
    procedure Stop; override;
    function Value: Integer; override;
    procedure Put(N: Integer); override;
    procedure Go;
  end;

  TImpl = class(TPlain, IRunner)
  public
    procedure Walk(N: Integer);
  end;

  TOutside = class(TComponent)
  public
    constructor Create(AOwner: TComponent); override;
  end;

  TBaseHelper = class helper for TBase
  public
    procedure Run(N: Integer);
  end;

function Compute(N: Integer): Integer;

implementation

function Compute(N: Integer): Integer;
begin
  Result := N;
end;

constructor TChild.Create(AOwner: TObject);
begin
  inherited; // c-bare-overload
end;

constructor TChild.CreateEmpty;
begin
  inherited Create; // c-named-overload
end;

procedure TChild.Run(N: Integer);
begin
  inherited Run(N); // c-named
  inherited; // c-bare
end;

procedure TChild.Stop;
begin
  inherited Stop; // c-nearest
end;

function TChild.Value: Integer;
begin
  Result := inherited Value + 1; // c-read
end;

procedure TChild.Put(N: Integer);
begin
  inherited; // c-bare-types
end;

procedure TChild.Go;
var
  X: Integer;
begin
  inherited Run(1); // c-other-name
  Run(2); // c-self
  inherited Log('a', 1); // c-overload-up
  X := inherited Items[0]; // c-property
  with FList do inherited Run(3); // c-with
  inherited Run(Compute(4)); // c-args
end;

procedure TImpl.Walk(N: Integer);
begin
  inherited Walk(N); // c-interface
end;

constructor TOutside.Create(AOwner: TComponent);
begin
  inherited Create(AOwner); // c-outside
end;

procedure TBaseHelper.Run(N: Integer);
begin
  inherited Run(N); // c-helper
end;

end.
`,
};

describe('a Pascal inherited call links the ancestor method it runs', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-pascal-inherited-'));
    for (const [rel, content] of Object.entries(FILES)) fs.writeFileSync(path.join(root, rel), content);
    cg = await CodeGraph.init(root, { index: true });
  }, 60_000);

  afterAll(() => {
    cg?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  /** What the calls on the line marked `// marker` reach, as `kind Owner::Name(signature) @file`. */
  function reached(marker: string, file = 'Child.pas'): string[] {
    const line = FILES[file]!.split('\n').findIndex((l) => l.trimEnd().endsWith(`// ${marker}`)) + 1;
    expect(line, marker).toBeGreaterThan(0);
    const out: string[] = [];
    for (const n of cg!.getNodesInFile(file)) {
      for (const e of cg!.getOutgoingEdges(n.id)) {
        if (e.kind !== 'calls' || e.line !== line) continue;
        const t = cg!.getNode(e.target)!;
        out.push(`${t.kind} ${t.qualifiedName}${t.signature ?? ''} @${t.filePath}`);
      }
    }
    return out.sort();
  }

  it("links `inherited Name(…)` to the ancestor's method, from the overriding method", () => {
    expect(reached('c-named')).toEqual(['method TBase::Run(N: Integer) @Base.pas']);
  });

  it("links a bare `inherited` to the ancestor's method of the routine's own name", () => {
    expect(reached('c-bare')).toEqual(['method TBase::Run(N: Integer) @Base.pas']);
  });

  it('links the nearest ancestor that declares the name, not one further up', () => {
    expect(reached('c-nearest')).toEqual(['method TMid::Stop @Mid.pas']);
  });

  it('links an inherited method of another name than the calling one', () => {
    expect(reached('c-other-name')).toEqual(['method TBase::Run(N: Integer) @Base.pas']);
  });

  it("leaves a plain call to the class's own method as it was", () => {
    expect(reached('c-self')).toEqual(['method TChild::Run(N: Integer) @Child.pas']);
  });

  it('links an inherited function read for its value', () => {
    expect(reached('c-read')).toEqual(['method TBase::Value: Integer @Base.pas']);
  });

  it('picks the overload a bare call passes its own parameters to', () => {
    expect(reached('c-bare-overload')).toEqual(['method TBase::Create(AOwner: TObject) @Base.pas']);
  });

  it('picks the overload a named call passes its arguments to, never a class constructor', () => {
    // TMid's `class constructor Create` takes no arguments either, but only the runtime runs it.
    expect(reached('c-named-overload')).toEqual(['method TBase::Create @Base.pas']);
  });

  it("picks, for a bare call, the overload with the routine's own parameter types", () => {
    expect(reached('c-bare-types')).toEqual(['method TBase::Put(N: Integer) @Base.pas']);
  });

  it('goes on up an overload set when the nearest overload takes other arguments', () => {
    expect(reached('c-overload-up')).toEqual(['method TBase::Log(const S: string; N: Integer) @Base.pas']);
  });

  it('links nothing where the nearest declaration of the name is a property', () => {
    expect(reached('c-property')).toEqual([]);
  });

  it('links the ancestor in a `with` body, whatever the subject', () => {
    expect(reached('c-with')).toEqual(['method TBase::Run(N: Integer) @Base.pas']);
  });

  it("still links the calls in an inherited call's arguments", () => {
    expect(reached('c-args')).toEqual(['function Compute(N: Integer): Integer @Child.pas', 'method TBase::Run(N: Integer) @Base.pas']);
  });

  it('links no method of an interface the class implements', () => {
    expect(reached('c-interface')).toEqual([]);
  });

  it('links nothing for an ancestor outside the project, nor a namesake the class cannot see', () => {
    expect(reached('c-outside')).toEqual([]);
  });

  it("links a helper's inherited call to the method of the type it helps", () => {
    expect(reached('c-helper')).toEqual(['method TBase::Run(N: Integer) @Base.pas']);
  });
});
