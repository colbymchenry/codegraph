import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const cli = path.resolve(__dirname, '..', 'dist', 'bin', 'codegraph.js');

describe('installer TTY guard (#virtiofs hang prevention)', () => {
  it('refuses to run the interactive installer without a TTY and without --yes', () => {
    // stdin is a pipe (not a TTY), so the guard should fire.
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8',
      timeout: 15000,
      input: '',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(result.stderr).toContain('--yes');
  });

  it('does not hang when invoked without a TTY', () => {
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8',
      timeout: 5000,
      input: '',
    });
    // Either the guard fired (exit 1) or it completed; either way, no hang.
    expect(result.error).toBeUndefined();
  });
});