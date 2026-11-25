/**
 * Node's compile cache never returns on Windows when its folder's drive doesn't
 * exist, so a temp folder on an unplugged disk hung every command at start.
 */
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';

const BIN = path.resolve(__dirname, '../dist/bin/codegraph.js');

function missingDrive(): string {
  for (const letter of 'ZYXWVUTSRQPONMLKJIHGFED') if (!fs.existsSync(`${letter}:\\`)) return letter;
  throw new Error('every drive letter is taken');
}

describe('a temp folder on a missing drive', () => {
  it.runIf(process.platform === 'win32')('leaves the CLI working', () => {
    const drive = missingDrive();
    const env: NodeJS.ProcessEnv = { ...process.env, TEMP: `${drive}:\\tmp`, TMP: `${drive}:\\tmp`, CODEGRAPH_WASM_RELAUNCHED: '1' };
    delete env.NODE_COMPILE_CACHE;
    const version = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')).version as string;
    const run = spawnSync(process.execPath, [...WASM_RUNTIME_FLAGS, BIN, '--version'], { env, encoding: 'utf8', timeout: 20_000, killSignal: 'SIGKILL' });
    expect(run.error).toBeUndefined();
    expect(run.stdout.trim()).toBe(version);
  });
});
