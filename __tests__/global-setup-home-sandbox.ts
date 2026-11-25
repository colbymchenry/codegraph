/**
 * Remove the home sandboxes `setup-home-sandbox.ts` could not.
 *
 * Each test file removes its own sandbox in an `afterAll`, but Vitest runs no
 * hooks at all for a file whose every test is skipped — a platform-gated suite
 * skips that way, and each one left its home dir behind on every run — and a
 * straggling child can still hold a file there when `afterAll` runs. So every
 * sandbox records its path in this run's registry dir, and the end of the run
 * removes whatever is still listed.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { GlobalSetupContext } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    /** The dir each test file's home sandbox records its path in. */
    homeSandboxRegistry: string;
  }
}

export default function setup({ provide }: GlobalSetupContext): () => void {
  const registry = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-test-homes-'));
  provide('homeSandboxRegistry', registry);
  return () => {
    const held: string[] = [];
    for (const entry of fs.readdirSync(registry)) {
      const home = fs.readFileSync(path.join(registry, entry), 'utf8');
      try {
        fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        held.push(home);
      }
    }
    fs.rmSync(registry, { recursive: true, force: true });
    if (held.length > 0) {
      process.stderr.write(`[test teardown] ${held.length} home sandbox dir(s) still in use, left behind:\n`
        + held.map((home) => `  ${home}\n`).join(''));
    }
  };
}
