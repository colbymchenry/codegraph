/**
 * `matchMethodCall` answers an absent method name without inferring a receiver
 * type. These tests observe the skip, and pin the boundary it must keep: same
 * targets and `resolvedBy` when the name exists, `this.`-receivers on their own
 * path, and the object-literal reader's `undefined` ("no holder") never counted
 * as an answer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodeGraph } from '../src';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';
import { createResolver } from '../src/resolution';
import { matchMethodCall } from '../src/resolution/name-matcher';
import type { ResolutionContext } from '../src/resolution';
import type { UnresolvedRef } from '../src/resolution/types';
import type { Node } from '../src/types';

/**
 * A context that answers no name and counts every source read, so a test can
 * tell "the matcher looked" from "the matcher decided without looking".
 */
function countingContext(readFileCalls: { n: number }, nameExists: boolean): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile: () => {
      readFileCalls.n++;
      return 'const svc = createService();\n';
    },
    getFileLines: () => {
      readFileCalls.n++;
      return ['const svc = createService();'];
    },
    getProjectRoot: () => '/',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    hasKnownName: () => nameExists,
  };
}

const absentCall = (name: string): UnresolvedRef => ({
  fromNodeId: 'fn:caller',
  referenceName: name,
  referenceKind: 'calls',
  line: 2,
  column: 2,
  filePath: 'caller.ts',
  language: 'typescript',
});

describe('A call whose method name no node carries is decided without inference', () => {
  let dir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-negative-name-'));
  });

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('answers an absent name without reading the calling file', () => {
    // The observable the optimization moves: receiver-type inference reads the
    // caller's source. No holder and no name means it must not be read at all.
    const reads = { n: 0 };
    const context = countingContext(reads, /* nameExists */ false);

    expect(matchMethodCall(absentCall('svc.absent'), context)).toBeNull();
    expect(reads.n).toBe(0);
  });

  it('reads the calling file when the name does exist, so the count is meaningful', () => {
    // Same call, same empty graph, one answer changed: "the name exists". The
    // inference runs and reads, which is what the first test proves is skipped.
    const reads = { n: 0 };
    const context = countingContext(reads, /* nameExists */ true);

    expect(matchMethodCall(absentCall('svc.absent'), context)).toBeNull();
    expect(reads.n).toBeGreaterThan(0);
  });

  it('reads the calling file when the context cannot say whether the name exists', () => {
    // "Cannot tell" (an unwarmed resolver) must never skip: the same call with
    // no hasKnownName capability pays for the inference, as it did before.
    const reads = { n: 0 };
    const context = countingContext(reads, /* nameExists */ true);
    delete (context as { hasKnownName?: unknown }).hasKnownName;

    expect(matchMethodCall(absentCall('svc.absent'), context)).toBeNull();
    expect(reads.n).toBeGreaterThan(0);
  });

  it('keeps every target and resolvedBy of the calls it does resolve', async () => {
    fs.writeFileSync(
      path.join(dir, 'service.ts'),
      [
        'export class Service {',
        '  known(): number { return 1; }',
        '}',
        '',
        'export class Other {',
        '  elsewhere(): number { return 2; }',
        '}',
        '',
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(dir, 'caller.ts'),
      [
        "import { Service } from './service';",
        '',
        'export function run(svc: Service): void {',
        '  svc.known();       // method of the receiver type',
        '  svc.elsewhere();   // name exists, on another class: receiver-word guess',
        '  svc.absent();      // name exists nowhere: the fast path',
        '  expect(svc).toBeTruthy();  // external call, name exists nowhere',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(dir, { index: true });

    const caller = cg.getNodesByKind('function').find((n) => n.filePath === 'caller.ts');
    const byName = (name: string) =>
      cg!.getCallees(caller!.id).filter((c) => c.node.name === name);

    expect(byName('known')).toHaveLength(1);
    expect(byName('known')[0]!.edge.metadata?.resolvedBy).toBe('instance-method');
    expect(byName('elsewhere')).toHaveLength(1);
    // Nothing the index holds has either name.
    expect(byName('absent')).toHaveLength(0);
    expect(byName('toBeTruthy')).toHaveLength(0);
  });

  it('leaves a call through an object-literal member to the literal reader', async () => {
    // `api.alias()` links `renamed`: the literal's member names a DIFFERENT
    // symbol, so a name-absent answer here would have been wrong (#1932).
    fs.writeFileSync(
      path.join(dir, 'api.ts'),
      [
        'function renamed(): number { return 1; }',
        'export const api = { alias: renamed };',
        'export function call(): number { return api.alias(); }',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(dir, { index: true });

    const call = cg.getNodesByKind('function').find((n) => n.name === 'call');
    expect(cg.getCallees(call!.id).map((c) => c.node.name)).toContain('renamed');
  });

  it('leaves a this-receiver call to its own branch', async () => {
    // `this.m()` and `this.field.m()` resolve through the enclosing class's
    // declaration, or to nothing — a path the fast path must not take over.
    fs.writeFileSync(
      path.join(dir, 'component.ts'),
      [
        'export class Component {',
        '  present(): number { return 1; }',
        '  run(): number {',
        '    this.present();',
        '    return this.absent();',
        '  }',
        '}',
        '',
      ].join('\n')
    );
    cg = await CodeGraph.init(dir, { index: true });

    const run = cg.getNodesByKind('method').find((n) => n.name === 'run');
    const callees = cg.getCallees(run!.id).map((c) => c.node.name);
    expect(callees).toContain('present');
    expect(callees).not.toContain('absent');
  });

  it('answers "cannot tell" until the name set is warmed', () => {
    const dbPath = path.join(dir, 'names.db');
    const db = DatabaseConnection.initialize(dbPath);
    const q = new QueryBuilder(db.getDb());
    const node = (id: string, name: string): Node => ({
      id,
      kind: 'method',
      name,
      qualifiedName: `Service::${name}`,
      filePath: 'service.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 2,
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    });
    q.insertNodes([node('m:known', 'known')]);

    const resolver = createResolver(dir, q);
    const context = resolver.getResolutionContext();

    // Before warmCaches the set is null: true means "cannot tell", never
    // "absent", so a caller that skips on false never skips on a guess.
    expect(context.hasKnownName?.('absent')).toBe(true);
    resolver.warmCaches();
    expect(context.hasKnownName?.('known')).toBe(true);
    expect(context.hasKnownName?.('absent')).toBe(false);

    db.close();
  });
});
