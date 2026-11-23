import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

let root = '';
let cg: CodeGraph | undefined;
const prefix = 'external:apple:v1:';
function write(file: string, text: string): void { fs.writeFileSync(path.join(root, file), text); }
async function create(files: Record<string, string>, enabled = true): Promise<void> {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-apple-types-'));
  if (enabled) write('codegraph.json', '{"appleExternalTypes":true}');
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

describe('opt-in Apple external inheritance catalog', () => {
  it('keeps the default graph source-only', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' }, false);
    expect(parents('Handler')).toEqual([]);
    expect(cg!.getNode(prefix + 'Foundation:NSObject')).toBeNull();
  });

  it('links a Swift alias and only its catalog ancestors with explicit provenance', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    const id = prefix + 'Foundation:NSURLProtocol';
    expect(parents('Handler')).toEqual([id]);
    const external = cg!.getNode(id)!;
    expect(external.filePath).toBe('@external/apple/Foundation');
    expect(external.docstring).toContain('not indexed SDK source');
    expect(external.docstring).toContain('developer.apple.com/documentation/foundation/urlprotocol');
    expect(cg!.getOutgoingEdgesFrom([id])).toEqual([expect.objectContaining({
      target: prefix + 'Foundation:NSObject', kind: 'extends', provenance: 'heuristic',
    })]);
    expect(cg!.getNode(prefix + 'UIKit:UIView')).toBeNull();
    expect(cg!.getStats().fileCount).toBe(1);
  });

  it('links Objective-C superclass names and UIKit ancestor chains', async () => {
    await create({
      'Handler.h': '#import <Foundation/Foundation.h>\n@interface Handler : NSURLProtocol\n@end\n',
      'Types.swift': 'import UIKit\nclass Screen: UIViewController {}\n',
    });
    const handler = cg!.getNodesInFile('Handler.h').find(n => n.kind === 'class')!;
    expect(cg!.getOutgoingEdgesFrom([handler.id]).some(e => e.target === prefix + 'Foundation:NSURLProtocol')).toBe(true);
    expect(parents('Screen')).toEqual([prefix + 'UIKit:UIViewController']);
    expect(cg!.getOutgoingEdgesFrom([prefix + 'UIKit:UIViewController']).map(e => e.target)).toEqual([prefix + 'UIKit:UIResponder']);
    expect(cg!.getOutgoingEdgesFrom([prefix + 'UIKit:UIResponder']).map(e => e.target)).toEqual([prefix + 'Foundation:NSObject']);
  });

  it('does not guess missing imports, unknown types or a shadowed project name', async () => {
    await create({
      'Types.swift': 'class NoImport: URLProtocol {}\n',
      'Unknown.swift': 'import Foundation\nclass Unknown: UnlistedFrameworkType {}\n',
      'Shadow.swift': 'import Foundation\nclass Operation {}\nclass Worker: Operation {}\n',
    });
    expect(parents('NoImport')).toEqual([]);
    expect(cg!.getNode(prefix + 'Foundation:NSURLProtocol')).toBeNull();
    expect(cg!.getNode(prefix + 'Foundation:NSOperation')).toBeNull();
    const worker = cg!.getNodesInFile('Shadow.swift').find(n => n.name === 'Worker')!;
    const targets = cg!.getOutgoingEdgesFrom([worker.id]).filter(e => e.kind === 'extends').map(e => cg!.getNode(e.target)!);
    expect(targets.map(n => n.filePath)).toEqual(['Shadow.swift']);
  });

  it('reconciles toggles, deleted sources and restored sources on one live graph', async () => {
    const source = 'import Foundation\nclass Handler: URLProtocol {}\n';
    await create({ 'Types.swift': source });
    const id = prefix + 'Foundation:NSURLProtocol';
    expect(parents('Handler')).toEqual([id]);
    write('codegraph.json', '{"appleExternalTypes":false}');
    await cg!.sync();
    expect(parents('Handler')).toEqual([]);
    expect(cg!.getNode(id)).toBeNull();
    write('codegraph.json', '{"appleExternalTypes":true}');
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

  it('does not turn catalog entries into callable project definitions on a later sync', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    write('Call.swift', 'import Foundation\nfunc construct() { _ = Foundation.NSURLProtocol() }\n');
    await cg!.sync();
    const callers = cg!.getNodesInFile('Call.swift').map(node => node.id);
    expect(cg!.getOutgoingEdgesFrom(callers).filter(edge => edge.target.startsWith(prefix))).toEqual([]);
    expect(parents('Handler')).toEqual([prefix + 'Foundation:NSURLProtocol']);
  });

  it('drops an external edge when a project declaration appears, and restores it when removed', async () => {
    await create({ 'Types.swift': 'import Foundation\nclass Handler: URLProtocol {}\n' });
    write('Local.swift', 'class URLProtocol {}\n');
    await cg!.sync();
    expect(parents('Handler').some(id => id.startsWith(prefix))).toBe(false);
    expect(cg!.getNode(prefix + 'Foundation:NSURLProtocol')).toBeNull();
    fs.unlinkSync(path.join(root, 'Local.swift'));
    await cg!.sync();
    expect(parents('Handler')).toEqual([prefix + 'Foundation:NSURLProtocol']);
  });
});
