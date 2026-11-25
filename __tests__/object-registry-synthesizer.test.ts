/**
 * Object-literal registry dispatch synthesizer.
 *
 * A command registry maps keys → handler classes/functions in an object literal, then
 * dispatches by a RUNTIME key (`new registry[command]().execute()`) that static parsing
 * can't follow. The synthesizer links each dispatching method → each registered handler's
 * callable entry. Validates: a class registry resolves to the handler's `.execute` method;
 * the field-initializer form (`commands = {…}` matched against a `this.commands[k]` dispatch);
 * and the dispatch GATE — a look-alike object literal that is only ever accessed statically
 * (never `registry[var]`) yields no edges.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('object-registry synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'obj-registry-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('links a dispatcher to each registered command class’s execute method, gated on dynamic dispatch', async () => {
    fs.writeFileSync(
      path.join(dir, 'commands.ts'),
      `export class AddCommand { execute() { return 'add'; } }
export class RemoveCommand { execute() { return 'remove'; } }
export class MoveCommand { execute() { return 'move'; } }
`
    );
    fs.writeFileSync(
      path.join(dir, 'manager.ts'),
      `import { AddCommand, RemoveCommand, MoveCommand } from './commands';

const Cmd = { ADD: 'add', REMOVE: 'remove', MOVE: 'move' };

class CommandManager {
  commands = {
    [Cmd.ADD]: AddCommand,
    [Cmd.REMOVE]: RemoveCommand,
    [Cmd.MOVE]: MoveCommand,
  };

  executeCommand(command: string) {
    return new this.commands[command]().execute();
  }
}
`
    );
    // A look-alike registry that is NEVER dynamically dispatched (only a static `.add`
    // member access) — must yield NO edges. The dynamic `registry[var]` dispatch is the gate.
    fs.writeFileSync(
      path.join(dir, 'static.ts'),
      `import { AddCommand, RemoveCommand } from './commands';
const table = { add: AddCommand, remove: RemoveCommand };
export function direct() { return new table.add().execute(); }
`
    );

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();

    const db = (cg as any).db.db;
    const rows = db
      .prepare(
        `SELECT s.name source_name, t.name target_name, t.kind target_kind, t.file_path target_file
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'object-registry'`
      )
      .all();
    cg.close?.();

    // Exactly the 3 dispatcher→handler-entry edges: executeCommand → {Add,Remove,Move}Command.execute.
    expect(rows.length).toBe(3);
    expect(rows.every((r: any) => r.source_name === 'executeCommand')).toBe(true);
    expect(rows.every((r: any) => r.target_kind === 'method' && r.target_name === 'execute')).toBe(true);
    expect(rows.every((r: any) => /commands\.ts$/.test(r.target_file))).toBe(true);
    // The statically-accessed look-alike registry contributed nothing.
    expect(rows.some((r: any) => /static\.ts$/.test(r.target_file))).toBe(false);
  });
});
