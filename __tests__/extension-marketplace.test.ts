import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { createMarketplaceStore, startMarketplaceServer } from '../src/plugins/marketplace';
import { startExtensionBridge } from '../src/plugins/bridge';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-marketplace-')); roots.push(dir); return dir; }
function artifact(version = '1.0.0') {
  return Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: {
    name: '@test/example', version, main: 'index.cjs', codegraph: { id: 'example', apiVersion: 1, capabilities: ['frameworks'] },
  }, files: { 'index.cjs': 'module.exports=()=>({frameworks:[]});' } }));
}
const identity = () => generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
function submission(keys: ReturnType<typeof identity>, version = '1.0.0', bytes = artifact(version)) {
  const payload = JSON.stringify({ name: 'Example', description: 'Example support', publisher: 'Test publisher',
    source: 'https://example.com/source', readme: 'Documentation', artifact: bytes.toString('base64'), timestamp: Date.now(), nonce: randomUUID() });
  return { payload, publicKey: keys.publicKey.export({ format: 'jwk' }),
    signature: sign('sha256', Buffer.from(payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64') };
}
describe('extension publishing and connection contract', () => {
  it('persists immutable releases, enforces ownership, and keeps community publication separate from official status', () => {
    const database = path.join(root(), 'registry.db'), owner = identity();
    let store = createMarketplaceStore(database);
    try {
      const first = submission(owner);
      expect(store.submit(first).official).toBe(false);
      expect(() => store.submit(first)).toThrow(); // replay
      expect(() => store.submit(submission(owner))).toThrow(); // immutable version
      expect(() => store.submit(submission(identity(), '2.0.0'))).toThrow('another publisher');
      expect(store.download('example', '1.0.0')).toEqual(artifact());
      store.close(); store = createMarketplaceStore(database);
      expect(store.releases('example')).toHaveLength(1);
      expect(store.submit(submission(owner, '1.1.0')).publisherId).toBe(store.releases('example')[1].publisherId);
      expect(store.releases('example')).toHaveLength(2);
    } finally { store.close(); }
  });
  it('rejects invalid signatures, tampered payloads, malformed packages and expired submissions without publishing', () => {
    const store = createMarketplaceStore(path.join(root(), 'registry.db')), keys = identity();
    try {
      expect(() => store.submit({ ...submission(keys), signature: 'invalid' })).toThrow('signature');
      const altered = submission(keys); altered.payload = altered.payload.replace('Example support', 'Tampered');
      expect(() => store.submit(altered)).toThrow('signature');
      expect(() => store.submit(submission(keys, '1.0.0', Buffer.from('{}')))).toThrow('package');
      const expired = submission(keys); expired.payload = expired.payload.replace(/"timestamp":\d+/, '"timestamp":0');
      expired.signature = sign('sha256', Buffer.from(expired.payload), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64');
      expect(() => store.submit(expired)).toThrow('expired');
      expect(store.list()).toEqual([]);
    } finally { store.close(); }
  });
  it('publishes and downloads through real HTTP, reporting invalid submissions as failures', async () => {
    const dir = root();
    const server = await startMarketplaceServer({ database: path.join(dir, 'registry.db'), publicDirectory: path.resolve('marketplace/public') });
    const url = `http://127.0.0.1:${server.port}`;
    try {
      const response = await fetch(url + '/api/publish', { method: 'POST', body: JSON.stringify(submission(identity())), headers: { 'Content-Type': 'application/json' } });
      expect(response.status).toBe(201);
      const listing = await response.json() as { integrity: string };
      expect(listing.integrity).toMatch(/^[a-f0-9]{64}$/);
      expect(Buffer.from(await (await fetch(url + '/api/download/example/1.0.0')).arrayBuffer())).toEqual(artifact());
      expect((await fetch(url + '/api/publish', { method: 'POST', body: '{}' })).status).toBe(400);
    } finally { await server.close(); }
  });
  it('refuses unauthorized HTTP, cross origins, forged hosts, unknown destinations and foreign artifacts', async () => {
    const dir = root(), bridge = await startExtensionBridge([dir], 'https://marketplace.example');
    const token = new URLSearchParams(new URL(bridge.connectionUrl).hash.slice(1)).get('token')!;
    const headers = { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
    try {
      expect((await fetch(bridge.url + '/status')).status).toBe(401);
      expect((await fetch(bridge.url + '/status', { headers: { ...headers, Origin: 'https://evil.example' } })).status).toBe(403);
      // fetch normalizes Host; use the HTTP transport to actually send a forged header.
      const forgedHost = await new Promise<number | undefined>((resolve, reject) => {
        http.get(bridge.url + '/status', { headers: { ...headers, Host: 'evil.example' } }, res => {
          res.resume(); resolve(res.statusCode);
        }).on('error', reject);
      });
      expect(forgedHost).toBe(403);
      const ok = await fetch(bridge.url + '/status', { headers });
      expect(ok.status).toBe(200);
      expect((await ok.json() as { projects: unknown[] }).projects).toHaveLength(1);
      for (const command of [{ action: 'remove', id: 'example', project: 'missing' },
        { action: 'install', project: '0', url: 'https://evil.example/artifact', integrity: '0'.repeat(64) }]) {
        expect((await fetch(bridge.url + '/command', { method: 'POST', headers, body: JSON.stringify(command) })).status).toBe(400);
      }
    } finally { await bridge.close(); }
  });
});
