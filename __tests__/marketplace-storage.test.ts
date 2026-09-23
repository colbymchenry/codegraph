import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createDatabase } from '../src/db/sqlite-adapter';
import { initializeMarketplaceVolume, openMarketplaceVolume, backupMarketplaceVolume, restoreMarketplaceVolume, verifyMarketplaceDatabase } from '../src/plugins/marketplace-storage';
import { createMarketplaceStore } from '../src/plugins/marketplace';
const roots: string[] = [];
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'registry-unit-')); roots.push(dir); return dir; }
afterEach(() => roots.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
describe('registry volume and deployment guards', () => {
  it('rejects missing/relative volumes, unknown schemas and orphaned publishers', () => {
    expect(() => initializeMarketplaceVolume('relative')).toThrow('absolute');
    const dir = path.join(root(), 'volume'); expect(() => openMarketplaceVolume(dir)).toThrow(); expect(fs.existsSync(dir)).toBe(false);
    const { database } = initializeMarketplaceVolume(dir), { db } = createDatabase(database);
    try {
      db.prepare("UPDATE registry_meta SET value='2' WHERE key='schema'").run();
      expect(() => openMarketplaceVolume(dir)).toThrow('schema');
      db.prepare("UPDATE registry_meta SET value='1' WHERE key='schema'").run();
      db.prepare('INSERT INTO extensions VALUES (?,?)').run('orphan','publisher');
      expect(() => verifyMarketplaceDatabase(database)).toThrow('owner without');
    } finally { db.close(); }
  });
  it('rejects incomplete snapshots and inventory changes and never touches an existing destination', () => {
    const lab = root(), volume = path.join(lab,'volume'), backup = path.join(lab,'backup');
    initializeMarketplaceVolume(volume); backupMarketplaceVolume(volume,backup);
    const manifest = path.join(backup,'backup.json'), original = fs.readFileSync(manifest,'utf8');
    fs.writeFileSync(manifest,JSON.stringify({...JSON.parse(original),releases:[{id:'invented'}]}));
    expect(() => restoreMarketplaceVolume(backup,path.join(lab,'bad'))).toThrow('inventory');
    fs.unlinkSync(manifest); expect(() => restoreMarketplaceVolume(backup,path.join(lab,'bad'))).toThrow();
    fs.writeFileSync(manifest,original);
    expect(() => restoreMarketplaceVolume(backup,volume)).toThrow();
    expect(openMarketplaceVolume(volume).id).toBe(JSON.parse(original).id);
  });
  it('does not silently reuse an altered official seed', () => {
    const store = createMarketplaceStore(path.join(root(),'db'));
    const pkg = {format:'codegraph-extension-1',package:{name:'@test/drupal',version:'1.0.0',main:'index.cjs',codegraph:{id:'drupal',apiVersion:1,capabilities:['frameworks']}},files:{'index.cjs':'module.exports=()=>({frameworks:[]})'}};
    try {
      const bytes = Buffer.from(JSON.stringify(pkg)); store.seedOfficial(bytes); store.seedOfficial(bytes);
      pkg.files['index.cjs'] += ';'; expect(()=>store.seedOfficial(Buffer.from(JSON.stringify(pkg)))).toThrow('immutable');
      expect(store.download('drupal','1.0.0')).toEqual(bytes);
    } finally { store.close(); }
  });
  it('creates external HTTPS rewrites with no credentials/path and rejects unsafe origins', () => {
    const { configuration } = require('../marketplace/server/configure-vercel.cjs');
    expect(configuration('https://registry.example').rewrites[0]).toEqual({source:'/api/:path*',destination:'https://registry.example/api/:path*'});
    for (const origin of ['http://registry.example','https://a:b@registry.example','https://registry.example/base','https://registry.example/?secret=x','https://127.0.0.1']) expect(()=>configuration(origin)).toThrow();
  });
  it('reports missing and unreachable gateway backends as actionable 503s', async () => {
    const gateway = require('../marketplace/api/gateway.js'), prior = process.env.MARKETPLACE_API_ORIGIN;
    const response = { statusCode: 0, body: {} as any, status(n: number) { this.statusCode=n; return this; }, json(body: any) { this.body=body; return this; } };
    try {
      delete process.env.MARKETPLACE_API_ORIGIN; await gateway({url:'/api/health'},response);
      expect(response.statusCode).toBe(503); expect(response.body.error).toContain('not configured');
      process.env.MARKETPLACE_API_ORIGIN='https://127.0.0.1:1'; await gateway({url:'/api/health',method:'GET'},response);
      expect(response.statusCode).toBe(503); expect(response.body.error).toContain('unavailable');
    } finally { if(prior === undefined) delete process.env.MARKETPLACE_API_ORIGIN; else process.env.MARKETPLACE_API_ORIGIN=prior; }
  });
});
