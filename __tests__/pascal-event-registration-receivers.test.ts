import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('Pascal event registration through cast and indexed receivers', () => {
  let directory: string;
  let graph: CodeGraph | undefined;
  beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascal-event-receivers-')); });
  afterEach(() => {
    graph?.close();
    graph = undefined;
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5 });
  });

  function write(files: Record<string, string>): void {
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(directory, name), text);
  }
  function calls(caller: string): string[] {
    const node = graph!.getNodesByKind('method').concat(graph!.getNodesByKind('function'))
      .find(n => n.qualifiedName === caller);
    if (!node) throw new Error(`missing node ${caller}`);
    return [...new Set(graph!.getOutgoingEdges(node.id).filter(e => e.kind === 'calls')
      .map(e => graph!.getNode(e.target)!.qualifiedName))].sort();
  }

  const consumerUnit = (wire: string, extra = ''): string => `unit Consumer;
interface
uses Types, Host, Other, Globals;
type
 TConsumer = class
 private
  FObj: TObject;
  FHost: THost;
  FHosts: array of THost;
  FStatic: array[0..1] of THost;
  FList: THostList;
  FBag: THostBag;
  FNamed: TNamedBag;
  FPlain: TPlainBag;
  FGeneric: TGenericBag<THost>;
  FFixed: TFixedBag<TObject>;
  FOwn: TNotify;
 public
  property OnNotify: TNotify read FOwn write FOwn;
  procedure Handle(Sender: TObject);
  procedure HandleLate(Sender: TObject);
  procedure FireOwn;
  procedure Wire(Sender: TObject);
  procedure WireAll(const Hosts: array of THost);
 end;
implementation
procedure TConsumer.Handle(Sender: TObject); begin end;
procedure TConsumer.HandleLate(Sender: TObject); begin end;
procedure TConsumer.FireOwn; begin FOwn(Self); end;
${wire}
${extra}
end.`;

  const units = (wire: string, extra = ''): Record<string, string> => ({
    'Types.pas': `unit Types;
interface
type
 TNotify = procedure(Sender: TObject) of object;
implementation
end.`,
    'Host.pas': `unit Host;
interface
uses Types;
type
 TInner = class
 private
  FNotify: TNotify;
 public
  property OnNotify: TNotify read FNotify write FNotify;
  procedure Fire;
 end;
 THost = class
 private
  FNotify: TNotify;
  FInner: TInner;
  function GetItem(I: Integer): THost;
 public
  property OnNotify: TNotify read FNotify write FNotify;
  property Inner: TInner read FInner;
  property Items[I: Integer]: THost read GetItem;
  procedure Fire;
 end;
 THostBag = class
 private
  function GetItem(I: Integer): THost;
 public
  property Items[I: Integer]: THost read GetItem; default;
 end;
 TNamedBag = class(THostBag)
 end;
 TPlainBag = class
 private
  function GetItem(I: Integer): THost;
 public
  property Items[I: Integer]: THost read GetItem;
 end;
 TGenericBag<T> = class
 private
  function GetItem(I: Integer): T;
 public
  property Items[I: Integer]: T read GetItem; default;
 end;
 TFixedBag<T> = class
 private
  function GetItem(I: Integer): THost;
 public
  property Items[I: Integer]: THost read GetItem; default;
 end;
implementation
procedure TInner.Fire; begin FNotify(Self); end;
function THost.GetItem(I: Integer): THost; begin Result := nil; end;
function THostBag.GetItem(I: Integer): THost; begin Result := nil; end;
function TPlainBag.GetItem(I: Integer): THost; begin Result := nil; end;
function TGenericBag<T>.GetItem(I: Integer): T; begin Result := Default(T); end;
function TFixedBag<T>.GetItem(I: Integer): THost; begin Result := nil; end;
procedure THost.Fire; begin FNotify(Self); end;
end.`,
    'Other.pas': `unit Other;
interface
uses Types;
type
 TOther = class
 private
  FNotify: TNotify;
 public
  property OnNotify: TNotify read FNotify write FNotify;
  procedure Fire;
 end;
implementation
procedure TOther.Fire; begin FNotify(Self); end;
end.`,
    'Globals.pas': `unit Globals;
interface
uses Host;
type
 THostList = array of THost;
var
 GlobalHosts: array of THost;
 AliasedHosts: THostList;
 GlobalBag: THostBag;
implementation
end.`,
    'Consumer.pas': consumerUnit(wire, extra),
  });

  async function index(wire: string, extra = ''): Promise<void> {
    write(units(wire, extra));
    graph = await CodeGraph.init(directory, { index: true });
  }

  const wire = (statement: string, vars = ''): string =>
    `procedure TConsumer.Wire(Sender: TObject); ${vars} begin ${statement} end;`;

  const noOtherChannel = (): void => {
    expect(calls('TOther::Fire')).toEqual([]);
    expect(calls('TConsumer::FireOwn')).toEqual([]);
  };

  it.each([
    ['a cast', 'THost(Sender).OnNotify := Handle;'],
    ['an as-cast', '(Sender as THost).OnNotify := Handle;'],
    ['an address-of handler through a cast', 'THost(Sender).OnNotify := @Handle;'],
    ['a cast of a field', 'THost(FObj).OnNotify := Handle;'],
  ])('links the handler registered through %s to the cast type event', async (_name, statement) => {
    await index(wire(statement));
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);
    expect(calls('TInner::Fire')).toEqual([]);
    noOtherChannel();
  });

  it('keeps the nested receiver chain behind a cast', async () => {
    await index(wire('THost(Sender).Inner.OnNotify := Handle;'));
    expect(calls('TInner::Fire')).toEqual(['TConsumer::Handle']);
    expect(calls('THost::Fire')).toEqual([]);
    noOtherChannel();
  });

  it('keeps the nested receiver chain behind an indexed element', async () => {
    await index(wire('FHosts[0].Inner.OnNotify := Handle;'));
    expect(calls('TInner::Fire')).toEqual(['TConsumer::Handle']);
    expect(calls('THost::Fire')).toEqual([]);
  });

  it.each([
    ['a dynamic array field', 'FHosts[0].OnNotify := Handle;', ''],
    ['a dynamic array field through Self', 'Self.FHosts[0].OnNotify := Handle;', ''],
    ['a dynamic array field with a variable index', 'FHosts[I].OnNotify := Handle;', 'var I: Integer;'],
    ['a static array field', 'FStatic[1].OnNotify := Handle;', ''],
    ['a field typed by an array alias from another unit', 'FList[0].OnNotify := Handle;', ''],
    ['a local dynamic array', 'Hosts[0].OnNotify := Handle;', 'var Hosts: array of THost;'],
    ['a global array from another unit', 'GlobalHosts[0].OnNotify := Handle;', ''],
    ['a global array alias from another unit', 'AliasedHosts[0].OnNotify := Handle;', ''],
    ['an indexed property of a field', 'FHost.Items[0].OnNotify := Handle;', ''],
    ['a default indexed property of a field', 'FBag[0].OnNotify := Handle;', ''],
    ['a default indexed property inherited from a base container', 'FNamed[0].OnNotify := Handle;', ''],
    ['a default indexed property of a local container', 'Bag[I].OnNotify := Handle;', 'var Bag: THostBag; I: Integer;'],
    ['a default indexed property of a global container from another unit', 'GlobalBag[0].OnNotify := Handle;', ''],
    ['a default indexed property with a concrete result in a generic container', 'FFixed[0].OnNotify := Handle;', ''],
    ['a unit-qualified cast', 'Host.THost(Sender).OnNotify := Handle;', ''],
    ['a unit-qualified cast of a field', 'Host.THost(FObj).OnNotify := Handle;', ''],
    ['a unit-qualified as-cast', '(Sender as Host.THost).OnNotify := Handle;', ''],
  ])('links the handler registered through %s to the element type event', async (_name, statement, vars) => {
    await index(wire(statement, vars));
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);
    expect(calls('TInner::Fire')).toEqual([]);
    noOtherChannel();
  });

  it('links an indexed element of an open array parameter', async () => {
    await index(wire(''), 'procedure TConsumer.WireAll(const Hosts: array of THost); begin Hosts[0].OnNotify := Handle; end;');
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);
    noOtherChannel();
  });

  it.each([
    ['a cast to an unknown type', 'TMissing(Sender).OnNotify := Handle;', ''],
    ['an as-cast to an unknown type', '(Sender as TMissing).OnNotify := Handle;', ''],
    ['an unknown array', 'Missing[0].OnNotify := Handle;', ''],
    ['an array of an unknown element type', 'Hosts[0].OnNotify := Handle;', 'var Hosts: array of TMissing;'],
    ['a scalar field used with an index', 'FHost[0].OnNotify := Handle;', ''],
    ['a field that is not a container', 'FObj[0].OnNotify := Handle;', ''],
    ['an unknown call result', 'Lookup(Sender).OnNotify := Handle;', ''],
    ['an indexed property that is not the default', 'FPlain[0].OnNotify := Handle;', ''],
    ['a generic default property whose result is the type parameter', 'FGeneric[0].OnNotify := Handle;', ''],
    ['a unit-qualified cast to an unknown type', 'Host.TMissing(Sender).OnNotify := Handle;', ''],
    ['a parenthesized expression without a cast', '(Sender).OnNotify := Handle;', ''],
  ])('leaves %s unresolved without falling back to the owner event', async (_name, statement, vars) => {
    await index(wire(statement, vars));
    expect(calls('THost::Fire')).toEqual([]);
    expect(calls('TInner::Fire')).toEqual([]);
    noOtherChannel();
  });

  it('does not link a cast registration to an unrelated class with the same event name', async () => {
    await index(wire('THost(Sender).OnNotify := Handle; TOther(FObj).OnNotify := HandleLate;'));
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);
    expect(calls('TOther::Fire')).toEqual(['TConsumer::HandleLate']);
    expect(calls('TConsumer::FireOwn')).toEqual([]);
  });

  it('replaces and clears the cast registration edge when the source changes on reindex', async () => {
    await index(wire('THost(Sender).OnNotify := Handle;'));
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);

    write({ 'Consumer.pas': consumerUnit(wire('THost(Sender).OnNotify := HandleLate;')) });
    await graph!.sync();
    expect(calls('THost::Fire')).toEqual(['TConsumer::HandleLate']);

    write({ 'Consumer.pas': consumerUnit(wire('FHosts[0].OnNotify := Handle;')) });
    await graph!.sync();
    expect(calls('THost::Fire')).toEqual(['TConsumer::Handle']);

    write({ 'Consumer.pas': consumerUnit(wire('FHosts[0] := nil;')) });
    await graph!.sync();
    expect(calls('THost::Fire')).toEqual([]);
  });
});
