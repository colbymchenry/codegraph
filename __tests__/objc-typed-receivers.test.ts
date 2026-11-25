/**
 * An Objective-C message to an instance variable or a property of the class
 * around it is typed by that declaration, as one to a local or a parameter
 * already was. The ivar is declared outside the calling method, in a
 * header's `@interface`, an `@implementation`'s ivar block, a superclass, or
 * synthesized for a property, so the method's own lines never typed it:
 * ObjFW's `[_headers mutableCopy]` reached nothing, and RN's `[_registry
 * objectForKey:]` on an `NSMapTable` reached a project class named after the
 * receiver. A declared class from outside the project has no project method.
 * A local or a parameter whose type ObjFW writes with `OF_GENERIC(…)` is
 * typed too.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('an Objective-C receiver declared by its class', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Index `files` and return the methods a method's calls reach, as `Class::selector`. */
  async function indexProject(files: Record<string, string>): Promise<(method: string, file?: string) => string[]> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-objc-receivers-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    return (method: string, file?: string) => {
      const node = graph.getNodesByName(method).find((n) => n.kind === 'method' && (!file || n.filePath === file))!;
      expect(node, method).toBeDefined();
      return graph
        .getOutgoingEdges(node.id)
        .filter((e) => e.kind === 'calls')
        .map((e) => graph.getNode(e.target)!.qualifiedName)
        .sort();
    };
  }

  const collections = [
    '@interface OFDictionary : OFObject',
    '- (id)mutableCopy;',
    '- (id)objectForKey: (id)key;',
    '@end',
    '@interface OFArray : OFObject',
    '- (id)mutableCopy;',
    '@end',
    '@interface RCTComposedViewRegistry : OFDictionary',
    '- (id)objectForKey: (id)key;',
    '@end',
    '',
  ].join('\n');
  const collectionsImpl = [
    '#import "Collections.h"',
    '@implementation OFDictionary',
    '- (id)mutableCopy { return self; }',
    '- (id)objectForKey: (id)key { return nil; }',
    '@end',
    '@implementation OFArray',
    '- (id)mutableCopy { return self; }',
    '@end',
    '@implementation RCTComposedViewRegistry',
    '- (id)objectForKey: (id)key { return nil; }',
    '@end',
    '',
  ].join('\n');

  for (const crlf of [false, true]) {
    const eol = (s: string) => (crlf ? s.replace(/\n/g, '\r\n') : s);
    const label = crlf ? ' (CRLF)' : '';

    it(`types ivars, synthesized ivars and self. properties, its own and its superclass's${label}`, async () => {
      const targetsOf = await indexProject({
        'src/Collections.h': eol(collections),
        'src/Collections.m': eol(collectionsImpl),
        'src/OFHTTPResponse.h': eol([
          '#import "Collections.h"',
          '@interface OFHTTPResponse : OFObject',
          '    <OFCopying>',
          '{',
          '\tOFDictionary *_headers;',
          '}',
          '@property (nonatomic, copy) OFArray *cookies;',
          '@end',
          '',
        ].join('\n')),
        'src/OFHTTPServerResponse.h': eol([
          '#import "OFHTTPResponse.h"',
          '@interface OFHTTPServerResponse : OFHTTPResponse <OFReadyForReadingObserving,',
          '    OFReadyForWritingObserving>',
          '/**',
          ' * @brief The trailer fields.',
          ' */',
          '@property OF_NULLABLE_PROPERTY (copy, nonatomic)',
          '    OFArray *trailerFields;',
          '@end',
          '',
        ].join('\n')),
        'src/OFHTTPServerResponse.m': eol([
          '#import "OFHTTPServerResponse.h"',
          '@interface OFHTTPServerResponse ()',
          '@property (nonatomic) OFArray *pending;',
          '@end',
          '',
          '@implementation OFHTTPServerResponse',
          '{',
          '\tOFArray *_trailers, *_parts;',
          '\tOFDictionary *mFields;',
          '}',
          '@synthesize pending = mPending;',
          '',
          '- (id)inherited',
          '{',
          '\treturn [_headers mutableCopy];',
          '}',
          '',
          '- (id)fromBlock',
          '{',
          '\t[_parts mutableCopy];',
          '\treturn [mFields objectForKey: @"Server"];',
          '}',
          '',
          '- (id)synthesizedByName',
          '{',
          '\treturn [mPending mutableCopy];',
          '}',
          '',
          '- (id)synthesized',
          '{',
          '\treturn [_trailerFields mutableCopy];',
          '}',
          '',
          '- (id)throughSelf',
          '{',
          '\treturn [self.cookies mutableCopy];',
          '}',
          '@end',
          '',
        ].join('\n')),
      });
      expect(targetsOf('inherited')).toEqual(['OFDictionary::mutableCopy']);
      expect(targetsOf('fromBlock')).toEqual(['OFArray::mutableCopy', 'OFDictionary::objectForKey:']);
      expect(targetsOf('synthesizedByName')).toEqual(['OFArray::mutableCopy']);
      expect(targetsOf('synthesized')).toEqual(['OFArray::mutableCopy']);
      expect(targetsOf('throughSelf')).toEqual(['OFArray::mutableCopy']);
    }, 60_000);
  }

  it('reaches no project method through a class from outside the project', async () => {
    const targetsOf = await indexProject({
      'React/Collections.h': collections,
      'React/Collections.m': collectionsImpl,
      'React/RCTSurfaceRegistry.m': [
        '#import "Collections.h"',
        '@implementation RCTSurfaceRegistry {',
        '  NSMapTable<id, id> *_registry;',
        '}',
        '- (id)surfaceForRootTag:(id)rootTag',
        '{',
        '  return [_registry objectForKey:rootTag];',
        '}',
        '@end',
        '',
      ].join('\n'),
    });
    // NSMapTable's own objectForKey:, not the registry class's by name.
    expect(targetsOf('surfaceForRootTag:')).toEqual([]);
  }, 60_000);

  it('types a parameter by its own declaration, and a bare name never by a property', async () => {
    const targetsOf = await indexProject({
      'src/Collections.h': collections,
      'src/Collections.m': collectionsImpl,
      'src/OFASN1ObjectIdentifier.m': [
        '#import "Collections.h"',
        '@interface OFASN1ObjectIdentifier : OFObject',
        '@property (readonly, nonatomic) OFDictionary *arcs;',
        '@end',
        '',
        '@implementation OFASN1ObjectIdentifier',
        '- (instancetype)initWithArcs: (OFArray OF_GENERIC(OFNumber *) *)arcs',
        '{',
        '\t[arcs mutableCopy];',
        '\treturn self;',
        '}',
        '',
        '- (instancetype)initWithAnyArcs: (id)arcs',
        '{',
        '\t[arcs mutableCopy];',
        '\treturn self;',
        '}',
        '@end',
        '',
      ].join('\n'),
    });
    expect(targetsOf('initWithArcs:')).toEqual(['OFArray::mutableCopy']);
    // The property is `self.arcs` or `_arcs`, never `arcs`.
    expect(targetsOf('initWithAnyArcs:')).not.toContain('OFDictionary::mutableCopy');
  }, 60_000);

  it('reads the class the call means when separate apps each declare one of its name', async () => {
    const viewController = (type: string) => [
      '#import "Gadgets.h"',
      '@interface ViewController : OFObject',
      `@property (weak, nonatomic) IBOutlet ${type} *imageView1;`,
      '@end',
      '',
    ].join('\n');
    const targetsOf = await indexProject({
      'Shared/Gadgets.h': [
        '@interface Widget : OFObject',
        '- (void)refresh;',
        '@end',
        '@interface Gadget : OFObject',
        '- (void)refresh;',
        '@end',
        '',
      ].join('\n'),
      'Shared/Gadgets.m': [
        '#import "Gadgets.h"',
        '@implementation Widget',
        '- (void)refresh { }',
        '@end',
        '@implementation Gadget',
        '- (void)refresh { }',
        '@end',
        '',
      ].join('\n'),
      'Examples/Demo A/ViewController.h': viewController('Widget'),
      'Examples/Demo B/ViewController.h': viewController('Gadget'),
      'Examples/Demo B/ViewController.m': [
        '#import "ViewController.h"',
        '@implementation ViewController',
        '- (void)viewDidLoad',
        '{',
        '\t[self.imageView1 refresh];',
        '}',
        '@end',
        '',
      ].join('\n'),
    });
    expect(targetsOf('viewDidLoad')).toEqual(['Gadget::refresh']);
  }, 60_000);
});
