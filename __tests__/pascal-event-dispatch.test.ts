import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Pascal event dispatch', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-events-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  function write(files: Record<string, string>): void {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  }
  async function index(files: Record<string, string>): Promise<void> {
    write(files);
    graph = await CodeGraph.init(directory, { index: true });
  }
  function find(qualifiedName: string) {
    const node = graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function'))
      .find(n => n.qualifiedName === qualifiedName || n.name === qualifiedName);
    if (!node) throw new Error(`missing node ${qualifiedName}`);
    return node;
  }
  function dependencies(caller: string): string[] {
    const node = find(caller);
    return [...new Set(graph!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls' || e.kind === 'references')
      .map(e => `${e.kind}:${graph!.getNode(e.target)!.qualifiedName}`))].sort();
  }
  function calls(caller: string): string[] {
    return dependencies(caller).filter(d => d.startsWith('calls:'));
  }

  const eventUnits = (consumerBody: string, hostBody: string, extra = ''): Record<string, string> => ({
    'Types.pas': `unit Types;
interface
type
 TGetEvent = function: Integer of object;
 TNotify = procedure(Sender: TObject) of object;
implementation
end.`,
    'Host.pas': `unit Host;
interface
uses Types;
type
 THost = class
 private
  FGet: TGetEvent;
  FNotify: TNotify;
 public
  property OnGet: TGetEvent read FGet write FGet;
  property OnNotify: TNotify read FNotify write FNotify;
  procedure Read;
  procedure Fire;
  procedure Guard;
  procedure Pointer;
 end;
${extra}
implementation
${hostBody}
end.`,
    'Owner.pas': `unit Owner;
interface
uses Types, Host;
type
 TOwner = class
 private
  FHost: THost;
 public
  function GetValue: Integer;
  procedure Click(Sender: TObject);
  procedure Wire;
 end;
implementation
function TOwner.GetValue: Integer; begin Result := 1; end;
procedure TOwner.Click(Sender: TObject); begin end;
${consumerBody}
end.`,
  });

  const defaultHost = `procedure THost.Read; var V: Integer; begin V := FGet; end;
procedure THost.Fire; begin FNotify(Self); end;
procedure THost.Guard; begin if Assigned(FGet) then Exit; end;
procedure THost.Pointer; var P: TGetEvent; begin P := FGet; end;`;

  it('links the handler from the dispatch and keeps the assignment a reference', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost));
    expect(dependencies('TOwner::Wire')).toEqual(['references:TOwner::GetValue']);
    expect(calls('THost::Read')).toContain('calls:TOwner::GetValue');
  });

  it('does not treat Assigned guards as invocations', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost));
    expect(calls('THost::Guard')).toEqual([]);
  });

  it('does not treat a pointer read into a procedural variable as an invocation', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost));
    expect(calls('THost::Pointer')).toEqual([]);
  });

  it('links a bare parameterless function event invocation', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;',
      `procedure THost.Read; var V: Integer; begin V := FGet; end;
procedure THost.Fire; begin end;
procedure THost.Guard; begin end;
procedure THost.Pointer; begin end;`));
    expect(calls('THost::Read')).toEqual(['calls:TOwner::GetValue']);
  });

  it('links an explicit procedure event invocation', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnNotify := Click; end;', defaultHost));
    expect(calls('THost::Fire')).toEqual(['calls:TOwner::Click']);
    expect(dependencies('TOwner::Wire')).toEqual(['references:TOwner::Click']);
  });

  it('links through a property whose backing field is typed in another file', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost));
    expect(calls('THost::Read')).toEqual(['calls:TOwner::GetValue']);
  });

  it('accepts an address-of handler assignment', async () => {
    await index(eventUnits('procedure TOwner.Wire; begin FHost.OnGet := @GetValue; end;', defaultHost));
    expect(calls('THost::Read')).toContain('calls:TOwner::GetValue');
    expect(calls('TOwner::Wire')).toEqual([]);
  });

  it('links every handler registered on the same event type', async () => {
    const files = eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost);
    files['Other.pas'] = `unit Other;
interface
uses Types, Host;
type
 TOther = class
 private
  FHost: THost;
 public
  function Alternate: Integer;
  procedure Wire;
 end;
implementation
function TOther.Alternate: Integer; begin Result := 2; end;
procedure TOther.Wire; begin FHost.OnGet := Alternate; end;
end.`;
    await index(files);
    expect(calls('THost::Read')).toEqual(['calls:TOther::Alternate', 'calls:TOwner::GetValue']);
  });

  it('does not link handlers registered on a same-named property of an unrelated class', async () => {
    const files = eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost);
    files['Unrelated.pas'] = `unit Unrelated;
interface
uses Types;
type
 TUnrelated = class
 private
  FGet: TGetEvent;
 public
  property OnGet: TGetEvent read FGet write FGet;
  procedure Read;
 end;
 TSetter = class
 private
  FUnrelated: TUnrelated;
 public
  function Other: Integer;
  procedure Wire;
 end;
implementation
procedure TUnrelated.Read; var V: Integer; begin V := FGet; end;
function TSetter.Other: Integer; begin Result := 3; end;
procedure TSetter.Wire; begin FUnrelated.OnGet := Other; end;
end.`;
    await index(files);
    expect(calls('THost::Read')).toEqual(['calls:TOwner::GetValue']);
    expect(calls('TUnrelated::Read')).toEqual(['calls:TSetter::Other']);
  });

  it('links an inherited event field to handlers assigned through the descendant', async () => {
    const files = eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost);
    files['Child.pas'] = `unit Child;
interface
uses Types, Host;
type
 TChild = class(THost)
 public
  function Mine: Integer;
  procedure Wire;
 end;
implementation
function TChild.Mine: Integer; begin Result := 4; end;
procedure TChild.Wire; begin OnGet := Mine; end;
end.`;
    await index(files);
    expect(calls('THost::Read')).toContain('calls:TChild::Mine');
  });

  it('does not link an inherited event to a descendant member that shadows it with another type', async () => {
    const files = eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost);
    files['Shadow.pas'] = `unit Shadow;
interface
uses Types, Host;
type
 TShadow = class(THost)
 private
  FGet: Integer;
 public
  procedure ReadShadow;
 end;
implementation
procedure TShadow.ReadShadow; var V: Integer; begin V := FGet; end;
end.`;
    await index(files);
    expect(calls('TShadow::ReadShadow')).toEqual([]);
  });

  it('replaces and clears stale handler edges when the assignment changes on reindex', async () => {
    const files = eventUnits('procedure TOwner.Wire; begin FHost.OnGet := GetValue; end;', defaultHost);
    files['Other.pas'] = `unit Other;
interface
uses Types, Host;
type
 TOther = class
 private
  FHost: THost;
 public
  function Alternate: Integer;
  procedure Wire;
 end;
implementation
function TOther.Alternate: Integer; begin Result := 2; end;
procedure TOther.Wire; begin end;
end.`;
    await index(files);
    expect(calls('THost::Read')).toEqual(['calls:TOwner::GetValue']);

    write({ 'Other.pas': files['Other.pas'].replace('procedure TOther.Wire; begin end;', 'procedure TOther.Wire; begin FHost.OnGet := Alternate; end;') });
    await graph!.sync();
    expect(calls('THost::Read')).toEqual(['calls:TOther::Alternate', 'calls:TOwner::GetValue']);

    write({ 'Owner.pas': files['Owner.pas'].replace('FHost.OnGet := GetValue;', 'FHost := nil;') });
    await graph!.sync();
    expect(calls('THost::Read')).toEqual(['calls:TOther::Alternate']);

    write({ 'Other.pas': files['Other.pas'] });
    await graph!.sync();
    expect(calls('THost::Read')).toEqual([]);
  });
});
