/**
 * `codegraph uninstall` — CLI binary removal (the #1071 shadow, uninstall
 * edition).
 *
 * Before this feature, `codegraph uninstall` removed agent configs only:
 * a user with both a bundle install and an npm global install (the shadow
 * scenario) still had a working `codegraph` on PATH afterward. The planner
 * must find EVERY install present on the machine — not just the one the
 * running binary belongs to — and the executor must remove them all, with
 * the Windows locked-exe rename dance instead of a hard failure.
 */
import { describe, it, expect } from 'vitest';
import * as path from 'path';
import {
  planBinaryRemoval,
  executeBinaryRemoval,
  type RemoveBinaryProbes,
  type BinaryRemovalPlan,
  type RemoveBinaryDeps,
} from '../src/upgrade/remove-binary';
import { NPM_PACKAGE, npmInvocation } from '../src/upgrade';

const HOME = '/home/u';
const STATE = `${HOME}/.codegraph`;

function probes(over: Partial<RemoveBinaryProbes> & { present?: Set<string>; links?: Map<string, string> }): RemoveBinaryProbes {
  const present = over.present ?? new Set<string>();
  const links = over.links ?? new Map<string, string>();
  return {
    filename: `${STATE}/versions/v1.4.0/lib/dist/bin/codegraph.js`,
    platform: 'linux',
    cwd: `${HOME}/project`,
    env: {},
    homedir: HOME,
    exists: (p) => present.has(p) || links.has(p),
    readlink: (p) => links.get(p) ?? null,
    capture: () => null, // no npm unless a test injects one
    ...over,
  };
}

/** A standard unix bundle install under ~/.codegraph, running from it. */
function bundlePresent(): Set<string> {
  const root = `${STATE}/versions/v1.4.0`;
  return new Set([
    STATE,
    `${STATE}/versions`,
    `${root}/node`,
    `${root}/bin/codegraph`,
  ]);
}

describe('planBinaryRemoval', () => {
  it('unix bundle at ~/.codegraph: removes artifacts only, never the state dir itself', () => {
    const links = new Map([
      [`${STATE}/current`, `${STATE}/versions/v1.4.0`],
      [`${HOME}/.local/bin/codegraph`, `${STATE}/versions/v1.4.0/bin/codegraph`],
    ]);
    const plan = planBinaryRemoval(probes({ present: bundlePresent(), links }));
    expect(plan.paths).toContain(`${STATE}/versions`);
    expect(plan.paths).toContain(`${STATE}/current`);
    expect(plan.paths).toContain(`${HOME}/.local/bin/codegraph`);
    // The state dir (telemetry choice, daemon records) must survive.
    expect(plan.paths).not.toContain(STATE);
    expect(plan.npmGlobal).toBe(false);
    expect(plan.sourceRoot).toBeNull();
  });

  it('a custom CODEGRAPH_INSTALL_DIR is removed wholesale (it is not the state dir)', () => {
    const dir = '/opt/cg';
    const present = new Set([dir, `${dir}/versions`, `${dir}/versions/v1.4.0/node`, `${dir}/versions/v1.4.0/bin/codegraph`]);
    const plan = planBinaryRemoval(probes({
      filename: `${dir}/versions/v1.4.0/lib/dist/bin/codegraph.js`,
      env: { CODEGRAPH_INSTALL_DIR: dir },
      present,
    }));
    expect(plan.paths).toContain(dir);
    expect(plan.paths).not.toContain(`${dir}/versions`); // covered by the whole dir
  });

  it('npm global install is found by asking npm, even when running from a bundle (the shadow case)', () => {
    const npmRoot = '/usr/local/lib/node_modules';
    const present = bundlePresent();
    present.add(`${npmRoot}/${NPM_PACKAGE}`);
    const plan = planBinaryRemoval(probes({
      present,
      capture: (cmd, args) =>
        cmd === 'npm' && args.join(' ') === 'root -g' ? { code: 0, stdout: `${npmRoot}\n` } : null,
    }));
    expect(plan.npmGlobal).toBe(true);
    expect(plan.npmRoot).toBe(npmRoot);
    expect(plan.paths).toContain(`${STATE}/versions`); // both installs planned
    expect(plan.summary.some((s) => s.includes(NPM_PACKAGE))).toBe(true);
  });

  it('npm not installed / no global package → npmGlobal false', () => {
    const plan = planBinaryRemoval(probes({
      present: bundlePresent(),
      capture: () => ({ code: 0, stdout: '/usr/local/lib/node_modules\n' }), // root exists, package doesn't
    }));
    expect(plan.npmGlobal).toBe(false);
  });

  it('a source checkout is reported and never listed for deletion', () => {
    const repo = `${HOME}/dev/codegraph`;
    const present = new Set([`${repo}/package.json`, `${repo}/.git`]);
    const plan = planBinaryRemoval(probes({
      filename: `${repo}/dist/bin/codegraph.js`,
      present,
    }));
    expect(plan.sourceRoot).toBe(repo);
    expect(plan.paths).toHaveLength(0);
  });

  it('a bin-dir shim pointing somewhere ELSE is left alone', () => {
    const links = new Map([
      [`${STATE}/current`, `${STATE}/versions/v1.4.0`],
      [`${HOME}/.local/bin/codegraph`, '/usr/local/other-tool/bin/codegraph'],
    ]);
    const plan = planBinaryRemoval(probes({ present: bundlePresent(), links }));
    expect(plan.paths).not.toContain(`${HOME}/.local/bin/codegraph`);
  });

  it('CODEGRAPH_BIN_DIR override is honored for the shim', () => {
    const links = new Map([
      [`${STATE}/current`, `${STATE}/versions/v1.4.0`],
      ['/opt/bin/codegraph', `${STATE}/versions/v1.4.0/bin/codegraph`],
    ]);
    const plan = planBinaryRemoval(probes({
      env: { CODEGRAPH_BIN_DIR: '/opt/bin' },
      present: bundlePresent(),
      links,
    }));
    expect(plan.paths).toContain('/opt/bin/codegraph');
  });

  it('nothing installed → empty plan', () => {
    const plan = planBinaryRemoval(probes({ filename: '/somewhere/odd/codegraph.js' }));
    expect(plan.paths).toHaveLength(0);
    expect(plan.npmGlobal).toBe(false);
    expect(plan.summary).toHaveLength(0);
  });
});

describe('executeBinaryRemoval', () => {
  function deps(over: Partial<RemoveBinaryDeps> & { rmFails?: Set<string>; calls?: string[] }): RemoveBinaryDeps & { calls: string[] } {
    const calls = over.calls ?? [];
    const rmFails = over.rmFails ?? new Set<string>();
    return {
      platform: 'linux',
      execPath: '/usr/bin/node',
      rm: (p) => {
        if (rmFails.has(p)) { rmFails.delete(p); throw new Error('EBUSY'); }
        calls.push(`rm ${p}`);
      },
      rename: (from, to) => calls.push(`mv ${from} ${to}`),
      run: (cmd, args) => { calls.push(`run ${cmd} ${args.join(' ')}`); return 0; },
      calls,
      ...over,
    };
  }

  const plan = (over: Partial<BinaryRemovalPlan> = {}): BinaryRemovalPlan => ({
    paths: [],
    npmGlobal: false,
    npmRoot: null,
    sourceRoot: null,
    summary: [],
    ...over,
  });

  it('removes planned paths and runs npm uninstall -g', () => {
    const d = deps({});
    const result = executeBinaryRemoval(
      plan({ paths: [`${STATE}/versions`, `${STATE}/current`], npmGlobal: true, npmRoot: '/usr/local/lib/node_modules' }),
      d,
    );
    expect(result.removed).toEqual([`${STATE}/versions`, `${STATE}/current`]);
    expect(result.npm).toBe('removed');
    expect(d.calls).toContain(`run npm uninstall -g ${NPM_PACKAGE}`);
    expect(result.leftovers).toHaveLength(0);
  });

  it('npm failure is reported, not thrown', () => {
    const d = deps({ run: () => 1 });
    const result = executeBinaryRemoval(plan({ npmGlobal: true }), d);
    expect(result.npm).toBe('failed');
  });

  it('windows: a locked exe inside the tree is renamed aside, then the tree deletes', () => {
    const dir = 'C:\\Users\\u\\AppData\\Local\\codegraph';
    const exe = path.join(dir, 'current', 'node.exe');
    const d = deps({ platform: 'win32', execPath: exe, rmFails: new Set([dir]) });
    const result = executeBinaryRemoval(plan({ paths: [dir] }), d);
    expect(result.removed).toEqual([dir]);
    // The renamed exe is surfaced as a leftover for the user to delete.
    expect(result.leftovers).toHaveLength(1);
    expect(result.leftovers[0]).toContain('codegraph-old-node-');
    expect(d.calls.some((c) => c.startsWith(`mv ${exe} `))).toBe(true);
  });

  it('an unremovable path becomes a leftover, never an exception', () => {
    const d = deps({ rm: () => { throw new Error('EPERM'); } });
    const result = executeBinaryRemoval(plan({ paths: ['/opt/cg'] }), d);
    expect(result.removed).toHaveLength(0);
    expect(result.leftovers).toEqual(['/opt/cg']);
  });

  it('refuses a filesystem root even if a planner bug ever emitted one', () => {
    const d = deps({});
    const result = executeBinaryRemoval(plan({ paths: ['/'] }), d);
    expect(result.removed).toHaveLength(0);
    expect(result.leftovers).toEqual(['/']);
    expect(d.calls).toHaveLength(0);
  });
});

describe('npmInvocation', () => {
  it('unix: plain npm', () => {
    expect(npmInvocation('linux', ['root', '-g'])).toEqual({ cmd: 'npm', args: ['root', '-g'] });
  });
  it('windows: routed through cmd.exe (npm is a .cmd — direct spawn EINVALs on modern Node)', () => {
    const inv = npmInvocation('win32', ['uninstall', '-g', NPM_PACKAGE]);
    expect(inv.cmd).toBe('cmd.exe');
    expect(inv.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(inv.args[3]).toBe(`npm uninstall -g ${NPM_PACKAGE}`);
  });
});
