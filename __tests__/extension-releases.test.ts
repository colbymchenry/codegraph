import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { resolveRelease } from '../src/plugins/releases';
import { ExtensionManager } from '../src/plugins/manager';
import { sha256 } from '../src/plugins/package';
import { clearProjectConfigCache } from '../src/project-config';
import { version as engineVersion } from '../package.json';

const release = (version: string, extra: Record<string, unknown> = {}) => ({ id: 'example', version,
  engines: '>=1.6.0 <2', apiVersion: 1, capabilities: ['frameworks'], integrity: 'a'.repeat(64), ...extra });
const choose = (rows: unknown, options = {}) => resolveRelease(rows, 'example', { engineVersion, ...options });

describe('compatible registry selection', () => {
  it('chooses highest compatible stable semver regardless of array/publication order', () => {
    const rows = [release('1.9.0'), release('4.0.0', { engines: '>=9' }), release('1.10.0'), release('1.2.0'), release('10.0.0-beta.1')];
    expect(choose(rows).version).toBe('1.10.0');
    expect(choose(rows.reverse()).version).toBe('1.10.0');
    expect(choose([release('2.0.0', { engines: '>=2' }), release('1.0.0')], { engineVersion: '2.1.0' }).version).toBe('2.0.0');
  });
  it('skips invalid metadata and unsupported APIs instead of adopting them', () => {
    expect(choose([null, release('bad'), release('9.0.0', { apiVersion: 2 }), release('8.0.0', { engines: 'nonsense' }),
      release('7.0.0', { integrity: 'bad' }), release('6.0.0', { id: 'other' }), release('5.0.0', { capabilities: ['languages'] }),
      release('4.0.0', { apiVersion: undefined }), release('1.0.0')]).version).toBe('1.0.0');
    expect(() => choose({})).toThrow('invalid release catalog');
    expect(() => choose([release('1.0.0'), release('1.0.0')])).toThrow('duplicate immutable');
  });
  it('requires exact opt-in to prereleases and never substitutes an incompatible or absent pin', () => {
    const rows = [release('2.0.0-beta.1'), release('1.0.0'), release('3.0.0', { engines: '>=9' })];
    expect(choose(rows, { version: '2.0.0-beta.1' }).version).toBe('2.0.0-beta.1');
    expect(() => choose(rows, { version: '3.0.0' })).toThrow('requires CodeGraph >=9');
    expect(() => choose(rows, { version: '1.5.0' })).toThrow('Release not found');
    expect(() => choose(rows, { version: '^1' })).toThrow('exact semantic version');
    expect(() => choose([release('2.0.0-beta.1')])).toThrow('prerelease requires an exact');
  });
  it('honors disjoint engine ranges and prerelease engine semantics', () => {
    expect(choose([release('1.0.0', { engines: '^1.6.0 || ^3.0.0' })]).version).toBe('1.0.0');
    expect(() => choose([release('1.0.0', { engines: '^1.6.0' })], { engineVersion: '1.7.0-beta.1' })).toThrow('No compatible');
    expect(choose([release('1.0.0', { engines: '>=1.7.0-beta.1 <2' })], { engineVersion: '1.7.0-beta.1' }).version).toBe('1.0.0');
  });
  it('refuses automatic downgrades but permits explicit requested versions', () => {
    expect(() => choose([release('1.0.0')], { currentVersion: '2.0.0' })).toThrow('would downgrade');
    expect(choose([release('1.0.0')], { version: '1.0.0', currentVersion: '2.0.0' }).version).toBe('1.0.0');
    expect(choose([release('2.0.0')], { currentVersion: '2.0.0' }).version).toBe('2.0.0');
    expect(() => choose([], { currentVersion: '2.0.0' })).toThrow('installed 2.0.0 is unchanged');
  });
});

const roots: string[] = [];
afterEach(() => { clearProjectConfigCache(); roots.splice(0).forEach(r => fs.rmSync(r, { recursive: true, force: true })); });
function artifact(extra: Record<string, unknown> = {}, version = '1.0.0') {
  return Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: { name: 'example', version, main: 'index.cjs',
    codegraph: { id: 'example', apiVersion: 1, capabilities: ['frameworks'], ...extra } }, files: { 'index.cjs': 'module.exports=()=>({frameworks:[]});' } }));
}

describe('trusted registry installer', () => {
  it('revalidates identity, version, API, engine and integrity without altering existing config/graph', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-')); roots.push(root);
    const config = JSON.stringify({ plugins: [{ name: 'managed:example', version: '0.9.0', enabled: true }] });
    fs.writeFileSync(path.join(root, 'codegraph.json'), config);
    fs.mkdirSync(path.join(root, '.codegraph')); fs.writeFileSync(path.join(root, '.codegraph/codegraph.db'), 'unchanged graph sentinel');
    let bytes = artifact(), rows: unknown = [];
    const server = http.createServer((req, res) => { res.end(req.url?.startsWith('/api/extensions/') ? JSON.stringify(rows) : bytes); });
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    const registry = `http://127.0.0.1:${(server.address() as { port: number }).port}`, manager = new ExtensionManager(root);
    try {
      for (const [payload, error] of [
        [artifact({ id: 'other' }), 'identity/version'], [artifact({}, '2.0.0'), 'identity/version'],
        [artifact({ apiVersion: 2 }), 'unsupported API'], [artifact({ engines: '>=9' }), 'requires CodeGraph'],
      ] as const) {
        bytes = payload; rows = [release('1.0.0', { integrity: sha256(bytes) })];
        await expect(manager.installFromRegistry({ registry, id: 'example' })).rejects.toThrow(error);
      }
      bytes = artifact(); rows = [release('1.0.0')];
      await expect(manager.installFromRegistry({ registry, id: 'example' })).rejects.toThrow('integrity');
      rows = [release('1.0.0', { engines: '>=9' })];
      await expect(manager.installFromRegistry({ registry, id: 'example' })).rejects.toThrow('No compatible');
      rows = [release('1.0.0', { integrity: sha256(bytes) })];
      await expect(manager.installFromRegistry({ registry, id: 'example', selected: { version: '0.9.0', integrity: sha256(bytes) } })).rejects.toThrow('changed since selection');
      await expect(manager.installFromRegistry({ registry, id: 'missing', update: true })).rejects.toThrow('not installed');
      expect(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8')).toBe(config);
      expect(fs.readFileSync(path.join(root, '.codegraph/codegraph.db'), 'utf8')).toBe('unchanged graph sentinel');
      expect(fs.existsSync(path.join(root, '.codegraph/plugins/packages'))).toBe(false);
    } finally { await new Promise<void>(r => server.close(() => r())); }
  });
  it('checks the actual destination again under the install lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-release-race-')); roots.push(root);
    const config = JSON.stringify({ plugins: [{ name: 'managed:example', version: '3.0.0' }] });
    fs.writeFileSync(path.join(root, 'codegraph.json'), config);
    await expect(new ExtensionManager(root).install({ bytes: artifact(), automatic: true })).rejects.toThrow('would downgrade');
    expect(fs.readFileSync(path.join(root, 'codegraph.json'), 'utf8')).toBe(config);
  });
});
