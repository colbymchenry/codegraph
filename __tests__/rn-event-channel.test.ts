import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

/**
 * End-to-end synthesizer test: write a fixture project with a native ObjC
 * `sendEventWithName:` site and a JS `addListener('x', fn)` subscriber,
 * index it, and verify the synthesized cross-language event edge.
 */
describe('RN event channel synthesizer', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-event-fixture-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('synthesizes an edge from ObjC sendEventWithName: to JS addListener handler', async () => {
    // package.json so the RN detector / general resolver sees the project as RN.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"name":"x","dependencies":{"react-native":"^0.73"}}'
    );
    fs.writeFileSync(
      path.join(dir, 'Emitter.m'),
      `
@implementation Emitter
- (void)reportLocation {
    [self sendEventWithName:@"locationUpdate" body:@{}];
}
@end
`
    );
    fs.writeFileSync(
      path.join(dir, 'App.js'),
      `
function onLocation(payload) {
    console.log(payload);
}
emitter.addListener('locationUpdate', onLocation);
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, s.language sl, t.name target_name, t.language tl,
                json_extract(e.metadata,'$.event') event
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'rn-event-channel'`
      )
      .all();
    cg.close?.();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    // The edge should point from the ObjC method that emits to the JS handler.
    const edge = rows.find((r: any) => r.event === 'locationUpdate');
    expect(edge).toBeDefined();
    expect(edge.sl).toBe('objc');
    expect(edge.tl).toBe('javascript');
    expect(edge.target_name).toBe('onLocation');
  });

  it('falls back to enclosing JS function when addListener handler is a parameter (wrapper-API pattern)', async () => {
    // Matches the real RNFirebase shape: `messaging().onMessage(listener)`
    // is a subscribe-wrapper whose body does
    // `addListener('messaging_message_received', listener)` where `listener`
    // is the parameter — not a globally-named symbol. Synthesizer should
    // still produce an edge, attributed to the enclosing wrapper function.
    fs.writeFileSync(
      path.join(dir, 'package.json'),
      '{"dependencies":{"react-native":"^0.73"}}'
    );
    fs.writeFileSync(
      path.join(dir, 'Native.m'),
      `
@implementation MyEmitter
- (void)pushMessage {
    [[Shared shared] sendEventWithName:@"messaging_message_received" body:@{}];
}
@end
`
    );
    fs.writeFileSync(
      path.join(dir, 'messaging.ts'),
      `
import { NativeEventEmitter } from 'react-native';
const emitter = new NativeEventEmitter();
export function onMessage(listener: (m: any) => void) {
    return emitter.addListener('messaging_message_received', listener);
}
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, t.name target_name, t.kind target_kind, t.language tl,
                json_extract(e.metadata,'$.event') event
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'rn-event-channel'`
      )
      .all();
    cg.close?.();
    const edge = rows.find((r: any) => r.event === 'messaging_message_received');
    expect(edge).toBeDefined();
    // Target should be the wrapper function `onMessage` — the enclosing
    // function of the addListener call, not a bareword named handler.
    expect(edge.target_name).toBe('onMessage');
    expect(['function', 'method']).toContain(edge.target_kind);
  });
});
