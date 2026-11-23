import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let root = '';
let cg: CodeGraph | undefined;
const prefix = 'external:apple:symbolgraph:';
const usr = (name: string): string => 'c:objc(cs)' + name;
const config = { appleExternalTypes: { symbolGraphs: ['Foundation.symbols.json', 'UIKit.symbols.json'] } };
function graph(module: string, entries: [string, string, string?, string?][]): string {
  return JSON.stringify({ module: { name: module },
    symbols: entries.map(([objc, name]) => ({ identifier: { precise: usr(objc), interfaceLanguage: 'swift' },
      kind: { identifier: 'swift.class' }, pathComponents: [name] })),
    relationships: entries.filter(e => e[2]).map(([objc, , parent, fallback]) => ({
      kind: 'inheritsFrom', source: usr(objc), target: usr(parent!), targetFallback: fallback })),
  });
}
function write(file: string, text: string): void { fs.writeFileSync(path.join(root, file), text); }
async function create(files: Record<string, string>, enabled = true): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apple-types-'));
  write('Foundation.symbols.json', graph('Foundation', [
    ['NSURLProtocol', 'URLProtocol', 'NSObject', 'ObjectiveC.NSObject'],
    ['NSOperation', 'Operation', 'NSObject', 'ObjectiveC.NSObject'],
    ['NSExampleBase', 'ExampleBase', 'NSObject', 'ObjectiveC.NSObject'],
  ]));
  write('UIKit.symbols.json', graph('UIKit', [
    ['UIViewController', 'UIViewController', 'UIResponder', 'UIKit.UIResponder'],
    ['UIResponder', 'UIResponder', 'NSObject', 'ObjectiveC.NSObject'],
  ]));
  if (enabled) write('codegraph.json', JSON.stringify(config));
  for (const [file, text] of Object.entries(files)) write(file, text);
  cg = await CodeGraph.init(root, { index: true });
}
function parents(name: string): string[] {
  const node = cg!.getNodesInFile('Types.swift').find(n => n.name === name && n.kind === 'class')!;
  return cg!.getOutgoingEdgesFrom([node.id]).filter(e => e.kind === 'extends').map(e => e.target);
}
afterEach(() => {
  cg?.close(); cg = undefined;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('opt-in Apple external inheritance Symbol Graph', () => {
  it('keeps the default graph source-only', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' }, false);
    expect(parents('Handler')).toEqual([]);
    expect(cg!.getNode(prefix + 'c:objc(cs)NSObject')).toBeNull();
  });

  it('links a Swift alias and only its Symbol Graph ancestors with explicit provenance', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    const id = prefix + 'c:objc(cs)NSURLProtocol';
    expect(parents('Handler')).toEqual([id]);
    const external = cg!.getNode(id)!;
    expect(external.filePath).toBe('@external/apple/symbolgraphs');
    expect(external.docstring).toContain('not indexed SDK source');
    expect(external.docstring).toContain('USR: c:objc(cs)NSURLProtocol');
    expect(cg!.getOutgoingEdgesFrom([id])).toEqual([expect.objectContaining({
      target: prefix + 'c:objc(cs)NSObject', kind: 'extends', provenance: 'heuristic',
    })]);
    expect(cg!.getNode(prefix + 'c:objc(cs)UIView')).toBeNull();
    expect(cg!.getStats().fileCount).toBe(1);
  });

  it('links Objective-C superclass names and UIKit ancestor chains', async () => {
    await create({
      'Handler.h': '#import <Foundation/Foundation.h>\n@interface Handler : NSURLProtocol\n@end\n',
      'Types.swift': 'import UIKit\nclass Screen: UIViewController {}\n',
    });
    const handler = cg!.getNodesInFile('Handler.h').find(n => n.kind === 'class')!;
    expect(cg!.getOutgoingEdgesFrom([handler.id]).some(e => e.target === prefix + 'c:objc(cs)NSURLProtocol')).toBe(true);
    expect(parents('Screen')).toEqual([prefix + 'c:objc(cs)UIViewController']);
    expect(cg!.getOutgoingEdgesFrom([prefix + 'c:objc(cs)UIViewController']).map(e => e.target)).toEqual([prefix + 'c:objc(cs)UIResponder']);
    expect(cg!.getOutgoingEdgesFrom([prefix + 'c:objc(cs)UIResponder']).map(e => e.target)).toEqual([prefix + 'c:objc(cs)NSObject']);
  });

  it('does not guess missing imports, unknown types or a shadowed project name', async () => {
    await create({
      'Types.swift': 'class NoImport: URLProtocol {}\n',
      'Unknown.swift': 'import Foundation\nclass Unknown: UnlistedFrameworkType {}\n',
      'Shadow.swift': 'import Foundation\nclass Operation {}\nclass Worker: Operation {}\n',
    });
    expect(parents('NoImport')).toEqual([]);
    expect(cg!.getNode(prefix + 'c:objc(cs)NSURLProtocol')).toBeNull();
    expect(cg!.getNode(prefix + 'c:objc(cs)NSOperation')).toBeNull();
    const worker = cg!.getNodesInFile('Shadow.swift').find(n => n.name === 'Worker')!;
    const targets = cg!.getOutgoingEdgesFrom([worker.id]).filter(e => e.kind === 'extends').map(e => cg!.getNode(e.target)!);
    expect(targets.map(n => n.filePath)).toEqual(['Shadow.swift']);
  });

  it('reconciles toggles, deleted sources and restored sources on one live graph', async () => {
    const source = 'import Foundation\nclass Handler: URLProtocol {}\n';
    await create({ 'Types.swift': source });
    const id = prefix + 'c:objc(cs)NSURLProtocol';
    expect(parents('Handler')).toEqual([id]);
    write('codegraph.json', '{"appleExternalTypes":false}');
    await cg!.sync();
    expect(parents('Handler')).toEqual([]);
    expect(cg!.getNode(id)).toBeNull();
    write('codegraph.json', JSON.stringify(config));
    await cg!.sync();
    expect(parents('Handler')).toEqual([id]);
    fs.unlinkSync(path.join(root, 'Types.swift'));
    await cg!.sync();
    expect(cg!.getNode(id)).toBeNull();
    write('Types.swift', source);
    await cg!.sync();
    expect(parents('Handler')).toEqual([id]);
    await cg!.sync();
    expect(parents('Handler')).toEqual([id]);
  });

  it('does not turn Symbol Graph entries into callable project definitions on a later sync', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    write('Call.swift', 'import Foundation\nfunc construct() { _ = Foundation.URLProtocol() }\n');
    await cg!.sync();
    const callers = cg!.getNodesInFile('Call.swift').map(node => node.id);
    expect(cg!.getOutgoingEdgesFrom(callers).filter(edge => edge.target.startsWith(prefix))).toEqual([]);
    expect(parents('Handler')).toEqual([prefix + 'c:objc(cs)NSURLProtocol']);
  });

  it('drops an external edge when a project declaration appears, and restores it when removed', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    write('Local.swift', 'class URLProtocol {}\n');
    await cg!.sync();
    expect(parents('Handler').some(id => id.startsWith(prefix))).toBe(false);
    expect(cg!.getNode(prefix + 'c:objc(cs)NSURLProtocol')).toBeNull();
    fs.unlinkSync(path.join(root, 'Local.swift'));
    await cg!.sync();
    expect(parents('Handler')).toEqual([prefix + 'c:objc(cs)NSURLProtocol']);
  });
});


describe('toolchain-derived identities and input refresh', () => {
  it('supports a class absent from the old fixed list', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Example: ExampleBase {}\n' });
    expect(parents('Example')).toEqual([prefix + usr('NSExampleBase')]);
  });

  it('refreshes changed Symbol Graphs and removes stale relationships without source edits', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Example: ExampleBase {}\n' });
    expect(parents('Example')).toHaveLength(1);
    write('Foundation.symbols.json', graph('Foundation', []));
    await cg!.sync();
    expect(parents('Example')).toEqual([]);
    write('Foundation.symbols.json', graph('Foundation', [['NSReplacementBase', 'ExampleBase']]));
    await cg!.sync();
    expect(parents('Example')).toEqual([prefix + usr('NSReplacementBase')]);
  });

  it('does not choose between different identities with the same imported name', async () => {
    await create({
      'Types.swift': 'import Foundation\nimport UIKit\nclass Example: ExampleBase {}\n',
      'UIKit.symbols.json': graph('UIKit', [['OtherExample', 'ExampleBase']]),
    });
    expect(parents('Example')).toEqual([]);
  });

  it('does not link qualified names or files without the supplying module import', async () => {
    await create({ 'Types.swift': 'import UIKit\nclass Example: ExampleBase {}\nclass Qualified: Foundation.ExampleBase {}\n' });
    expect(parents('Example')).toEqual([]);
    expect(parents('Qualified')).toEqual([]);
  });

  it('keeps source indexing usable with invalid, missing or deleted graph inputs', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    write('Foundation.symbols.json', '{bad json');
    await cg!.sync();
    expect(parents('Handler')).toEqual([]);
    fs.unlinkSync(path.join(root, 'Foundation.symbols.json'));
    await cg!.sync();
    expect(parents('Handler')).toEqual([]);
    expect(cg!.getNodesInFile('Types.swift').some(n => n.name === 'Handler')).toBe(true);
  });

  it('rejects the old boolean option instead of silently guessing a target SDK', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n',
      'codegraph.json': '{"appleExternalTypes":true}' });
    expect(parents('Handler')).toEqual([]);
  });
  it('uses a native Swift USR and ignores nested types and protocol symbols', async () => {
    const symbols = [
      { identifier: { precise: 's:7Example4BaseC' }, kind: { identifier: 'swift.class' }, pathComponents: ['Base'] },
      { identifier: { precise: 's:7Example5OuterC4BaseC' }, kind: { identifier: 'swift.class' }, pathComponents: ['Outer', 'Base'] },
      { identifier: { precise: 's:7Example4BaseP' }, kind: { identifier: 'swift.protocol' }, pathComponents: ['Base'] },
    ];
    await create({ 'Types.swift': 'import Example\nclass Derived: Base {}\n',
      'Foundation.symbols.json': JSON.stringify({ module: { name: 'Example' }, symbols, relationships: [] }) });
    expect(parents('Derived')).toEqual([prefix + 's:7Example4BaseC']);
  });

  it('refreshes ancestor labels even if their USRs and edges do not change', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    const parent = prefix + usr('NSObject');
    expect(cg!.getNode(parent)?.name).toBe('ObjectiveC.NSObject');
    write('Foundation.symbols.json', graph('Foundation', [
      ['NSURLProtocol', 'URLProtocol', 'NSObject', 'ObjectiveC.RenamedRoot'],
    ]));
    await cg!.sync();
    expect(cg!.getNode(parent)?.name).toBe('ObjectiveC.RenamedRoot');
  });

});
