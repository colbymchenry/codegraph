import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import * as path from 'path';

const cli = path.resolve(__dirname, '..', 'dist', 'bin', 'codegraph.js');

describe('installer TTY guard', () => {
  it('refuses to run the interactive installer without a TTY instead of hanging', () => {
    const started = Date.now();
    // stdin is a pipe (not a TTY), so the guard should fire.
    const result = spawnSync(process.execPath, [cli], {
      encoding: 'utf8',
      timeout: 15000,
      input: '',
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interactive terminal');
    expect(result.stderr).toContain('--yes');
    // A guard that fires immediately, not a timeout.
    expect(Date.now() - started).toBeLessThan(10000);
  });
});
