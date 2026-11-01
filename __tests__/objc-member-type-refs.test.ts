/**
 * An Objective-C struct references the types its members are declared with, as
 * a C or C++ one does (#3144), and an alias references what it names. 1.6.2
 * linked many of them with a false `extends`; #2394 removed the label and left
 * nothing, so on GNUstep's libs-base impact on a class missed every struct that
 * holds one.
 *
 * Only a type can be named there. A struct, alias or enum an `.m` file defines
 * is that file's own, and a class's node in some other `.m` (an `@implementation`
 * or a category) yields to a header's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';

describe('an Objective-C struct and the types of its members', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Index `files` and return what a type references, as `kind name @file`. */
  async function index(files: Record<string, string>): Promise<(holder: string, file?: string) => string[]> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-members-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    return (holder, file) => {
      const node = graph.getNodesByName(holder).find((n) =>
        (n.kind === 'struct' || n.kind === 'union' || n.kind === 'type_alias') && (!file || n.filePath === file));
      expect(node, holder).toBeDefined();
      return graph
        .getOutgoingEdges(node!.id)
        .filter((e) => e.kind === 'references')
        .map((e) => graph.getNode(e.target)!)
        .map((n) => `${n.kind} ${n.name} @${n.filePath}`)
        .sort();
    };
  }

  const types = [
    '@interface NSObject',
    '@end',
    '@interface NSString : NSObject',
    '@end',
    '@protocol Delegate',
    '@end',
    'typedef struct pause_event { int paused; } pause_event;',
    'struct client { int fd; };',
    'enum Color { Red, Green };',
    'typedef union { int i; } value;',
    'typedef long MyInt;',
    '',
  ].join('\n');

  it('links a member declared by value, by pointer, by tag and through a callback', async () => {
    const referenced = await index({
      'Types.h': types,
      'Server.h': [
        '#import "Types.h"',
        'struct server {',
        '    pause_event pauses[3];',
        '    struct client *current;',
        '    enum Color color;',
        '    value in_union;',
        '    MyInt count;',
        '    NSString *name;',
        '    pause_event (*callback)(MyInt);',
        '    int port;',
        '    char *text;',
        '};',
        'typedef struct server Server;',
        '@interface Controller : NSObject',
        '@end',
        '',
      ].join('\n'),
    });
    expect(referenced('server')).toEqual([
      'class NSString @Types.h',
      'enum Color @Types.h',
      'struct client @Types.h',
      'struct pause_event @Types.h',
      'struct pause_event @Types.h',
      'type_alias MyInt @Types.h',
      'type_alias MyInt @Types.h',
      'union value @Types.h',
    ]);
    expect(referenced('Server')).toEqual(['struct server @Server.h']);
  });

  it('names no extends edge, and links no function or variable of the name', async () => {
    await index({
      'Types.h': [
        types,
        'void helper(void);',
        'int counter;',
        '',
      ].join('\n'),
      'Holder.h': [
        '#import "Types.h"',
        'struct holder { helper *a; counter *b; pause_event c; };',
        '@interface H : NSObject',
        '@end',
        '',
      ].join('\n'),
    });
    const holder = cg!.getNodesByName('holder').find((n) => n.kind === 'struct')!;
    const edges = cg!.getOutgoingEdges(holder.id);
    expect(edges.filter((e) => e.kind === 'extends')).toEqual([]);
    expect(edges.filter((e) => e.kind === 'references').map((e) => cg!.getNode(e.target)!.name)).toEqual(['pause_event']);
  });

  it('a type an `.m` file defines is its own', async () => {
    const referenced = await index({
      'Types.h': types,
      'One.m': [
        '#import "Types.h"',
        'struct local { int a; };',
        'struct mine { struct local *l; };',
        '@implementation NSString',
        '@end',
        '',
      ].join('\n'),
      'Two.m': [
        '#import "Types.h"',
        'struct other { struct local *l; NSString *s; };',
        '',
      ].join('\n'),
    });
    expect(referenced('mine')).toEqual(['struct local @One.m']);
    expect(referenced('other')).toEqual(['class NSString @Types.h']);
  });

  it('explore spends no window on a member: a struct\'s types are not its flow', async () => {
    const members = Array.from({ length: 600 }, (_, i) => `  Type${i} member_with_a_long_name_${i};`).join('\n');
    const types = Array.from({ length: 600 }, (_, i) => `typedef struct Type${i} { int x; } Type${i};`).join('\n');
    const referenced = await index({
      'Types.h': `@interface NSObject\n@end\n${types}\n`,
      'Reader.h': [
        '#import "Types.h"',
        '@interface ReaderHost : NSObject',
        '@end',
        'struct Reader {',
        members,
        '};',
        '',
      ].join('\n'),
      'Reader.m': [
        '#import "Reader.h"',
        'static int lookup(int key) { return key + 1; }',
        'static int reader_size(struct Reader *r) { return 1; }',
        'int reader_get(struct Reader *r, int key) {',
        '  return lookup(key) + reader_size(r);',
        '}',
        '',
      ].join('\n'),
    });
    expect(referenced('Reader')).toHaveLength(600);
    const result = await new ToolHandler(cg!).execute('codegraph_explore', { query: 'Reader reader_get reader_size lookup' });
    const text = result.content[0]!.text;
    expect(text).toContain('return lookup(key) + reader_size(r);');
    expect(text).not.toContain('(references)');
    expect(text).not.toContain('member_with_a_long_name_50');
  });

  it('a member\'s type links once its file is added', async () => {
    const referenced = await index({
      'Holder.h': '#import "Late.h"\nstruct holder { late_t *l; };\n@interface H\n@end\n',
    });
    expect(referenced('holder')).toEqual([]);
    fs.writeFileSync(path.join(root, 'Late.h'), 'typedef struct late { int x; } late_t;\n@interface Late\n@end\n');
    await cg!.sync();
    expect(referenced('holder')).toEqual(['struct late_t @Late.h']);
  });

  it('a class is the one in its own header before a category in another', async () => {
    const referenced = await index({
      'Base.h': '@interface NSObject\n@end\n',
      'Widget.h': '#import "Base.h"\n@interface Widget : NSObject\n@end\n',
      'Widget+Extra.h': '#import "Widget.h"\n@interface Widget (Extra)\n@end\n',
      'Aaa.h': '#import "Widget.h"\n@interface Widget (Aaa)\n@end\n',
      'Holder.h': '#import "Widget.h"\nstruct holder { Widget *w; };\n@interface Holder : NSObject\n@end\n',
    });
    expect(referenced('holder')).toEqual(['class Widget @Widget.h']);
  });
});
