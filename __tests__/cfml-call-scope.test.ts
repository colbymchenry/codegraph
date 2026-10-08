/**
 * CFML types no receiver, so a component method reached by name alone must
 * be in reach:
 *
 * - a bare call inside a component (`.cfc`) is the component's own method or
 *   one of a component it `extends` — else a built-in: coldbox's `now()` went
 *   to a date helper's `now` 228 times;
 * - `receiver.m()` through an untyped receiver takes the one method named
 *   `m` only when the receiver is named after its component:
 *   `server.keyExists(…)` is the struct member function, not an interceptor
 *   buffer's `keyExists` (168 times).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfml-scope-'));
  const files: Record<string, string> = {
    'system/core/DateTimeHelper.cfc': `component {
  function now() {
    return createObject( "java", "java.time.LocalDateTime" ).now();
  }
}
`,
    'system/core/InterceptorBuffer.cfc': `component {
  function keyExists( required key ) {
    return false;
  }
}
`,
    'system/Base.cfc': `component {
  function getSetting( required name ) {
    return "";
  }
}
`,
    'system/models/UserService.cfc': `component {
  function list() {
    return [];
  }
}
`,
    'system/Handler.cfc': `component extends="app.system.Base" {
  function index( event, rc, prc, userService ) {
    var stamp = now();
    var lucee = server.keyExists( "lucee" );
    var name = getSetting( "appName" );
    var users = userService.list();
    return stamp;
  }
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('CFML calls reached by name alone', () => {
  it('keep the inherited method and the receiver named after its component; drop the built-ins', () => {
    const ids = cg.getNodesInFile('system/Handler.cfc').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).toEqual(['Base::getSetting', 'UserService::list']);
  });
});
