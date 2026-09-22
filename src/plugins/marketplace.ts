/** Durable marketplace service. May run beside a Vercel frontend or on a Node host. */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as semver from 'semver';
import { createPublicKey, verify, randomUUID, type JsonWebKey } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { createDatabase } from '../db/sqlite-adapter';
import { parsePackage, sha256, MAX_PACKAGE_BYTES } from './package';

interface Submission {
  payload: string;
  publicKey: JsonWebKey;
  signature: string;
}
export interface Listing {
  id: string; name: string; description: string; publisher: string; publisherId: string;
  official: boolean; version: string; apiVersion: number; engines: string; capabilities: string[]; integrity: string;
  readme: string; source: string; publishedAt: string;
}
export function createMarketplaceStore(database: string) {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const { db } = createDatabase(database);
  db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS registry_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, publisher TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS releases (id TEXT NOT NULL, version TEXT NOT NULL, listing TEXT NOT NULL, bytes BLOB NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(id,version));
    CREATE TABLE IF NOT EXISTS submissions (nonce TEXT PRIMARY KEY, created INTEGER NOT NULL);`);
  db.prepare('INSERT OR IGNORE INTO registry_meta VALUES (?,?)').run('id', randomUUID());
  db.prepare('INSERT OR IGNORE INTO registry_meta VALUES (?,?)').run('schema', '1');
  const transaction = <T>(fn: () => T): T => {
    // Acquire the writer before reading ownership. A deferred read->write
    // upgrade can fail immediately under concurrent publication despite timeout.
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  function publish(bytes: Buffer, details: { publisherId: string; publisher: string; readme: string; source: string; name: string; description: string; official?: boolean }): Listing {
    const pkg = parsePackage(bytes).package;
    const id = pkg.codegraph.id;
    const listing: Listing = { id, version: pkg.version, name: details.name, description: details.description,
      publisherId: details.publisherId, publisher: details.publisher, official: details.official === true,
      readme: details.readme, source: details.source, apiVersion: pkg.codegraph.apiVersion, engines: pkg.codegraph.engines ?? '*',
      capabilities: pkg.codegraph.capabilities, integrity: sha256(bytes), publishedAt: new Date().toISOString() };
    const owner = db.prepare('SELECT publisher FROM extensions WHERE id = ?').get(id) as { publisher: string } | undefined;
    if (owner && owner.publisher !== details.publisherId) throw new Error('This extension id belongs to another publisher');
    db.prepare('INSERT OR IGNORE INTO extensions VALUES (?,?)').run(id, details.publisherId);
    db.prepare('INSERT INTO releases VALUES (?,?,?,?,?)').run(id, pkg.version, JSON.stringify(listing), bytes, Date.now());
    // Validation-only subscribers can pause a test-owned process here.
    channel('codegraph.marketplace.publication').publish({ database, id, version: pkg.version, phase: 'before-commit' });
    return listing;
  }
  // Old persisted listings predate apiVersion. Recover it from their immutable
  // package, never guess that a missing API marker is supported.
  function listings(id?: string): Listing[] {
    const rows = (id === undefined ? db.prepare('SELECT id, version, listing FROM releases').all() :
      db.prepare('SELECT id, version, listing FROM releases WHERE id=?').all(id)) as { id: string; version: string; listing: string }[];
    return rows.map(row => {
      const listing = JSON.parse(row.listing) as Listing;
      if (listing.apiVersion === undefined) {
        const artifact = db.prepare('SELECT bytes FROM releases WHERE id=? AND version=?').get(row.id, row.version) as { bytes: Uint8Array };
        listing.apiVersion = parsePackage(Buffer.from(artifact.bytes)).package.codegraph.apiVersion;
      }
      return listing;
    }).sort((a, b) => Number(!!semver.prerelease(a.version)) - Number(!!semver.prerelease(b.version)) || semver.rcompare(a.version, b.version) || a.version.localeCompare(b.version));
  }
  return {
    close: () => db.close(),
    identity: () => (db.prepare("SELECT value FROM registry_meta WHERE key='id'").get() as { value: string }).value,
    health: () => { db.prepare('SELECT count(*) FROM registry_meta').get(); return { ok: true, publishing: true, protocol: 1, storage: 'sqlite-atomic', schema: 1 }; },
    seedOfficial(bytes: Buffer): void {
      const pkg = parsePackage(bytes).package;
      transaction(() => {
        const existing = db.prepare('SELECT listing, bytes FROM releases WHERE id=? AND version=?').get(pkg.codegraph.id, pkg.version) as { listing: string; bytes: Uint8Array } | undefined;
        if (existing) {
          if (JSON.parse(existing.listing).publisherId !== 'codegraph' || !Buffer.from(existing.bytes).equals(bytes)) throw new Error('Official seed conflicts with an immutable existing release');
          return;
        }
        publish(bytes, { publisherId: 'codegraph', publisher: 'CodeGraph', official: true, name: 'Drupal',
          description: 'Follow Drupal routes, services, hooks, plugins and events through your codebase.',
          source: 'https://github.com/colbymchenry/codegraph',
          readme: 'Understand the framework connections that ordinary function calls cannot show.\n\nRoutes and forms connect to their handlers. Service definitions connect to implementations and explicit injected services. Documented procedural hooks and Hook attributes connect to literal invocations. Plugin annotations and attributes identify implementations. Literal event dispatch connects to declared subscribers.\n\nInstall replaces the built-in Drupal resolver for this project. Requires CodeGraph 1.6.0 with extension support (preview build).\n\nComputed identifiers, external dependencies outside your index, ambiguous classes and unknown entity handlers remain unresolved. New programming languages and PHP branch-condition analysis are outside this extension API.' });
      });
    },
    list(): Listing[] {
      const seen = new Set<string>();
      return listings().filter(l => { if (seen.has(l.id)) return false; seen.add(l.id); return true; });
    },
    releases(id: string): Listing[] {
      return listings(id);
    },
    download(id: string, version: string): Buffer | undefined {
      const row = db.prepare('SELECT bytes FROM releases WHERE id=? AND version=?').get(id, version) as { bytes: Uint8Array } | undefined;
      return row ? Buffer.from(row.bytes) : undefined;
    },
    submit(submission: Submission): Listing {
      if (typeof submission.payload !== 'string' || submission.payload.length > MAX_PACKAGE_BYTES * 1.5 ||
          typeof submission.signature !== 'string' || submission.publicKey?.kty !== 'EC' || submission.publicKey.crv !== 'P-256') throw new Error('Invalid signed submission');
      const publicKey = createPublicKey({ key: submission.publicKey, format: 'jwk' });
      if (!verify('sha256', Buffer.from(submission.payload), { key: publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(submission.signature, 'base64'))) throw new Error('Publisher signature is invalid');
      const payload = JSON.parse(submission.payload);
      if (!Number.isFinite(payload.timestamp) || Math.abs(Date.now() - payload.timestamp) > 10 * 60 * 1000 || typeof payload.nonce !== 'string') throw new Error('Submission expired');
      for (const key of ['name', 'description', 'publisher', 'readme', 'source', 'artifact']) if (typeof payload[key] !== 'string') throw new Error(`Missing ${key}`);
      if (!payload.name.trim() || payload.name.length > 80 || !payload.publisher.trim() || payload.publisher.length > 80 ||
          payload.description.length > 240 || payload.readme.length > 30_000) throw new Error('Listing fields exceed allowed length');
      const source = new URL(payload.source);
      if (source.protocol !== 'https:' || source.username || source.password) throw new Error('Source repository must be an HTTPS URL');
      const publisherId = sha256(publicKey.export({ type: 'spki', format: 'der' }));
      let result!: Listing;
      transaction(() => {
        db.prepare('INSERT INTO submissions VALUES (?,?)').run(payload.nonce, Date.now());
        result = publish(Buffer.from(payload.artifact, 'base64'), { ...payload, publisherId, official: false });
      });
      channel('codegraph.marketplace.publication').publish({ database, id: result.id, version: result.version, phase: 'after-commit' });
      return result;
    },
  };
}

export async function startMarketplaceServer(options: { database: string; publicDirectory: string; officialArtifact?: string; port?: number; host?: string }) {
  const store = createMarketplaceStore(options.database);
  try { if (options.officialArtifact) store.seedOfficial(fs.readFileSync(options.officialArtifact)); }
  catch (error) { store.close(); throw error; }
  const attempts = new Map<string, { time: number; count: number }>();
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const url = new URL(req.url ?? '/', 'http://marketplace.local');
    const json = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
    try {
      if (req.method === 'GET' && url.pathname === '/api/extensions') { json(200, store.list()); return; }
      if (req.method === 'GET' && url.pathname === '/api/health') { json(200, store.health()); return; }
      const release = /^\/api\/extensions\/([a-z0-9-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && release) { json(200, store.releases(release[1]!)); return; }
      const download = /^\/api\/download\/([a-z0-9-]+)\/([^/]+)$/.exec(url.pathname);
      if (req.method === 'GET' && download) {
        const bytes = store.download(download[1]!, decodeURIComponent(download[2]!));
        if (!bytes) { json(404, { error: 'Release not found' }); return; }
        res.writeHead(200, { 'Content-Type': 'application/vnd.codegraph.extension+json', 'Content-Length': bytes.length,
          'Cache-Control': 'public, max-age=31536000, immutable', 'Content-Disposition': `attachment; filename="${download[1]}-${download[2]}.cgext"` });
        res.end(bytes); return;
      }
      if (req.method === 'POST' && url.pathname === '/api/publish') {
        const key = req.socket.remoteAddress ?? 'unknown';
        for (const [address, attempt] of attempts) if (Date.now() - attempt.time >= 60_000) attempts.delete(address);
        const previous = attempts.get(key);
        const rate = previous && Date.now() - previous.time < 60_000 ? previous : { time: Date.now(), count: 0 };
        attempts.set(key, rate);
        if (++rate.count > 10) { json(429, { error: 'Too many submissions; try again in a minute' }); return; }
        let size = 0; const chunks: Buffer[] = [];
        for await (const chunk of req) { size += chunk.length; if (size > MAX_PACKAGE_BYTES * 1.5) throw new Error('Submission too large'); chunks.push(Buffer.from(chunk)); }
        json(201, store.submit(JSON.parse(Buffer.concat(chunks).toString('utf8')))); return;
      }
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed' }); return; }
      const files: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
      const file = files[url.pathname] ?? (url.pathname.startsWith('/extensions/') || url.pathname === '/publish' ? 'index.html' : undefined);
      if (!file) { json(404, { error: 'Not found' }); return; }
      res.writeHead(200, { 'Content-Type': file.endsWith('.html') ? 'text/html; charset=utf-8' : file.endsWith('.js') ? 'text/javascript' : 'text/css' });
      res.end(fs.readFileSync(path.join(options.publicDirectory, file)));
    } catch (err) { json(400, { error: err instanceof Error ? err.message : String(err) }); }
  });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve); }); }
  catch (error) { store.close(); throw error; }
  return { port: (server.address() as { port: number }).port, close: () => new Promise<void>(resolve => server.close(() => { store.close(); resolve(); })) };
}
