import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { detectLanguage } from '../src/extraction/grammars';

// 自造的兼容宏前导，模拟生成头把第一个 OC 声明放在 8 KB 之后。
const preamble = Array.from({ length: 400 }, (_, i) => `#define BRIDGE_COMPAT_${i} ${i}\n`).join('');
const header = `${preamble}
#define SWIFT_CLASS(name)
SWIFT_CLASS("_TtC6Bridge10BridgeItem")
@interface BridgeItem : NSObject
- (void)perform;
@end
`;

describe('Objective-C declarations after a generated header preamble', () => {
  it('detects declarations beyond the initial sample with either line ending', () => {
    expect(header.indexOf('@interface')).toBeGreaterThan(8192);
    expect(detectLanguage('Bridge-Swift.h', header)).toBe('objc');
    expect(detectLanguage('Bridge-Swift.h', header.replace(/\n/g, '\r\n'))).toBe('objc');
    expect(detectLanguage('Protocol.h', `${preamble}@protocol Listener\n@end\n`)).toBe('objc');
  });

  it('does not treat comments, strings or macro bodies as Objective-C declarations', () => {
    const source = `${preamble}
/* @interface Example : NSObject */
// @protocol Example
const char *example = "@implementation Example";
#define EXAMPLE @interface Example
int plain(int value);
`;
    expect(detectLanguage('plain.h', source)).toBe('c');
    expect(detectLanguage('plain.h', '/* @interface Example */\nint plain;')).toBe('c');
    expect(detectLanguage('Bridge.h', header, { '.h': 'cpp' })).toBe('cpp');
  });

  let root = '';
  let cg: CodeGraph | undefined;
  afterEach(() => {
    cg?.close();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  it('indexes a header-only declaration and links its Swift subclass without an override', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-generated-objc-'));
    fs.writeFileSync(path.join(root, 'Bridge-Swift.h'), header);
    fs.writeFileSync(path.join(root, 'Child.swift'), 'class Child: BridgeItem {}\n');
    cg = await CodeGraph.init(root, { index: true });
    const parent = cg.getNodesInFile('Bridge-Swift.h').find(n => n.name === 'BridgeItem' && n.kind === 'class');
    const child = cg.getNodesInFile('Child.swift').find(n => n.name === 'Child' && n.kind === 'class');
    expect(parent?.language).toBe('objc');
    expect(child).toBeDefined();
    const edges = cg.getOutgoingEdgesFrom([child!.id]).filter(e => e.kind === 'extends');
    expect(edges.map(e => e.target)).toEqual([parent!.id]);
  });
});
