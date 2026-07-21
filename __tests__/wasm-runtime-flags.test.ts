/**
 * WASM runtime flags — the workaround for the V8 turboshaft WASM Zone OOM
 * (`Fatal process out of memory: Zone`) that crashed `codegraph index` on large
 * polyglot repos under Node >= 22. See issues #293 and #298.
 *
 * The crash was reproduced with the real indexer on the bundled Node 24 runtime;
 * empirically only `--liftoff-only` prevents it (`--no-wasm-tier-up` /
 * `--no-wasm-dynamic-tiering` do not), and the flag must be on node's command
 * line — `setFlagsFromString`, worker `execArgv`, and `NODE_OPTIONS` all fail.
 * These tests pin that contract so it can't silently regress.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WASM_RUNTIME_FLAGS,
  NODE_RUNTIME_FLAGS,
  nodeRuntimeFlagsFor,
  processHasWasmRuntimeFlags,
  buildRelaunchArgv,
} from '../src/extraction/wasm-runtime-flags';

describe('WASM_RUNTIME_FLAGS', () => {
  it('pins --liftoff-only (the only flag shown to stop the turboshaft Zone OOM)', () => {
    // On Node 24, --no-wasm-tier-up and --no-wasm-dynamic-tiering both still
    // crash; only --liftoff-only forces grammars onto the Liftoff baseline and
    // off the optimizing tier. Pin it so it can't be swapped for an ineffective
    // flag.
    expect(WASM_RUNTIME_FLAGS).toContain('--liftoff-only');
  });

  it('every flag is a real, accepted flag on the running Node/V8 runtime', () => {
    // node rejects unknown CLI flags at startup, so a renamed/removed flag would
    // break the bundled launcher and make the relaunch guard a silent no-op.
    // Prove each flag actually launches node here.
    const res = spawnSync(
      process.execPath,
      [...WASM_RUNTIME_FLAGS, '-e', 'process.exit(0)'],
      { encoding: 'utf8' }
    );
    expect(res.status, `node rejected ${WASM_RUNTIME_FLAGS.join(' ')}:\n${res.stderr}`).toBe(0);
  });
});

describe('NODE_RUNTIME_FLAGS', () => {
  it('suppresses the node:sqlite ExperimentalWarning on this runtime', () => {
    // The warning is emitted once per THREAD (main + every parse worker), so
    // during indexing it repeatedly interleaves with the progress UI. Prove
    // the flag both launches node and actually silences the warning.
    expect(NODE_RUNTIME_FLAGS).toContain('--disable-warning=ExperimentalWarning');
    const res = spawnSync(
      process.execPath,
      [...NODE_RUNTIME_FLAGS, '-e', "require('node:sqlite'); process.exit(0)"],
      { encoding: 'utf8' }
    );
    expect(res.status, res.stderr).toBe(0);
    expect(res.stderr).not.toMatch(/ExperimentalWarning/);
  });

  it('is empty on nodes too old for --disable-warning (fatal "bad option" there)', () => {
    expect(nodeRuntimeFlagsFor('20.10.0')).toEqual([]);
    expect(nodeRuntimeFlagsFor('21.2.0')).toEqual([]);
    expect(nodeRuntimeFlagsFor('20.11.0')).toContain('--disable-warning=ExperimentalWarning');
    expect(nodeRuntimeFlagsFor('21.3.0')).toContain('--disable-warning=ExperimentalWarning');
    expect(nodeRuntimeFlagsFor('22.5.0')).toContain('--disable-warning=ExperimentalWarning');
  });

  it('is NOT required by the re-exec gate (old-launcher compat)', () => {
    // An installed bundle launcher that passes only the WASM flags must not
    // trigger a pointless re-exec over a cosmetic warning flag.
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
  });
});

describe('processHasWasmRuntimeFlags', () => {
  it('is true only when every required flag is present', () => {
    expect(processHasWasmRuntimeFlags(['--liftoff-only'])).toBe(true);
    expect(processHasWasmRuntimeFlags(['--liftoff-only', '--enable-source-maps'])).toBe(true);
  });

  it('is false when the flags are absent', () => {
    expect(processHasWasmRuntimeFlags([])).toBe(false);
    expect(processHasWasmRuntimeFlags(['--max-old-space-size=4096'])).toBe(false);
  });
});

describe('buildRelaunchArgv', () => {
  it('places our flags first, then the script and its args', () => {
    expect(buildRelaunchArgv('/x/codegraph.js', ['index', '/repo'], [])).toEqual([
      ...NODE_RUNTIME_FLAGS,
      '--liftoff-only',
      '/x/codegraph.js',
      'index',
      '/repo',
    ]);
  });

  it('preserves other existing node flags without duplicating ours', () => {
    expect(
      buildRelaunchArgv('/x/codegraph.js', ['status'], [
        '--liftoff-only',
        ...NODE_RUNTIME_FLAGS,
        '--enable-source-maps',
      ])
    ).toEqual([
      ...NODE_RUNTIME_FLAGS,
      '--liftoff-only',
      '--enable-source-maps',
      '/x/codegraph.js',
      'status',
    ]);
  });

  it('produces an argv that actually launches node WITH the flag applied', () => {
    // End-to-end proof of the delivery mechanism without needing the crash:
    // run the constructed argv and confirm the child sees the flag in execArgv.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-relaunch-'));
    try {
      const harness = path.join(dir, 'harness.cjs');
      fs.writeFileSync(harness, 'process.stdout.write(JSON.stringify(process.execArgv));');
      const res = spawnSync(process.execPath, buildRelaunchArgv(harness, []), { encoding: 'utf8' });
      expect(res.status, res.stderr).toBe(0);
      expect(JSON.parse(res.stdout)).toContain('--liftoff-only');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
