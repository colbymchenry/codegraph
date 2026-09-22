/** Single-volume registry operations. No live-database file copies or remote mounts. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createDatabase } from '../db/sqlite-adapter';
import { createMarketplaceStore, type Listing } from './marketplace';
import { parsePackage, sha256 } from './package';

const databaseName = 'registry.sqlite';
const markerName = 'registry-volume.json';
function sync(file: string): void {
  const fd = fs.openSync(file, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function syncDir(directory: string): void { if (process.platform !== 'win32') sync(directory); }
function writeNew(file: string, data: string): void {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function absolute(directory: string): void {
  if (!path.isAbsolute(directory)) throw new Error('Registry data/backup directories must be absolute paths');
}
export function verifyMarketplaceDatabase(database: string) {
  if (!fs.statSync(database).isFile()) throw new Error('Registry database is missing');
  const { db } = createDatabase(database, { readOnly: true });
  try {
    if (db.pragma('integrity_check', { simple: true }) !== 'ok') throw new Error('Registry integrity_check failed');
    const metadata = Object.fromEntries((db.prepare('SELECT key,value FROM registry_meta').all() as { key: string; value: string }[]).map(r => [r.key, r.value]));
    if (metadata.schema !== '1' || !/^[a-f0-9-]{36}$/.test(metadata.id ?? '')) throw new Error('Unsupported or invalid registry schema/identity');
    const releases: { id: string; version: string; integrity: string }[] = [];
    for (const row of db.prepare('SELECT r.id,r.version,r.listing,r.bytes,e.publisher FROM releases r LEFT JOIN extensions e ON r.id=e.id').iterate()) {
      const bytes = Buffer.from(row.bytes), pkg = parsePackage(bytes).package, listing = JSON.parse(row.listing) as Listing;
      if (row.id !== pkg.codegraph.id || row.version !== pkg.version || listing.id !== row.id || listing.version !== row.version ||
          listing.publisherId !== row.publisher || sha256(bytes) !== listing.integrity ||
          (listing.apiVersion !== undefined && listing.apiVersion !== pkg.codegraph.apiVersion) || listing.engines !== (pkg.codegraph.engines ?? '*') ||
          JSON.stringify(listing.capabilities) !== JSON.stringify(pkg.codegraph.capabilities) || (listing.official && listing.publisherId !== 'codegraph')) throw new Error(`Registry listing/artifact/owner mismatch: ${row.id}@${row.version}`);
      releases.push({ id: row.id, version: row.version, integrity: listing.integrity });
    }
    if (db.prepare('SELECT id FROM extensions WHERE id NOT IN (SELECT id FROM releases)').get()) throw new Error('Registry has an owner without a release');
    return { schema: 1, id: metadata.id!, releases: releases.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version)) };
  } finally { db.close(); }
}
export function initializeMarketplaceVolume(directory: string): { database: string; id: string } {
  absolute(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.readdirSync(directory).length) throw new Error('Initialize requires an empty dedicated volume directory; existing data is never replaced');
  const database = path.join(directory, databaseName), store = createMarketplaceStore(database);
  const id = store.identity(); store.close();
  writeNew(path.join(directory, markerName), JSON.stringify({ format: 1, id, database: databaseName }));
  sync(database); syncDir(directory);
  return { database, id };
}
export function openMarketplaceVolume(directory: string): { database: string; id: string } {
  absolute(directory);
  // Fail closed if the mount is absent; normal startup never creates a registry.
  const marker = JSON.parse(fs.readFileSync(path.join(directory, markerName), 'utf8'));
  if (marker.format !== 1 || marker.database !== databaseName) throw new Error('Invalid registry volume marker');
  const database = path.join(directory, databaseName), verified = verifyMarketplaceDatabase(database);
  if (marker.id !== verified.id) throw new Error('Registry volume identity mismatch; attach the expected volume');
  return { database, id: verified.id };
}
export function backupMarketplaceVolume(directory: string, destination: string) {
  absolute(destination);
  const { database } = openMarketplaceVolume(directory);
  // Exclusive directory creation also prevents overwriting a previous backup.
  fs.mkdirSync(destination, { mode: 0o700 });
  const snapshot = path.join(destination, databaseName), pending = path.join(destination, 'snapshot.partial');
  const { db } = createDatabase(database);
  try {
    db.exec('PRAGMA busy_timeout=5000');
    // SQLite produces a transactionally consistent snapshot including live WAL.
    db.prepare('VACUUM INTO ?').run(pending);
  } finally { db.close(); }
  sync(pending);
  const verified = verifyMarketplaceDatabase(pending);
  fs.renameSync(pending, snapshot);
  writeNew(path.join(destination, 'backup.json'), JSON.stringify({ format: 1, created: new Date().toISOString(), ...verified, sha256: sha256(fs.readFileSync(snapshot)) }, null, 2));
  syncDir(destination); syncDir(path.dirname(destination));
  return verified;
}
export function restoreMarketplaceVolume(backup: string, destination: string) {
  absolute(backup); absolute(destination);
  const manifest = JSON.parse(fs.readFileSync(path.join(backup, 'backup.json'), 'utf8'));
  const source = path.join(backup, databaseName);
  if (manifest.format !== 1 || sha256(fs.readFileSync(source)) !== manifest.sha256) throw new Error('Backup checksum mismatch or incomplete backup');
  const verified = verifyMarketplaceDatabase(source);
  if (manifest.id !== verified.id || JSON.stringify(manifest.releases) !== JSON.stringify(verified.releases)) throw new Error('Backup inventory mismatch');
  // Restore to a NEW directory. Never copy over a running database or its WAL.
  const staging = destination + '.restore-' + randomUUID();
  fs.mkdirSync(staging, { mode: 0o700 });
  try {
    fs.copyFileSync(source, path.join(staging, databaseName), fs.constants.COPYFILE_EXCL);
    sync(path.join(staging, databaseName));
    writeNew(path.join(staging, markerName), JSON.stringify({ format: 1, id: verified.id, database: databaseName }));
    syncDir(staging);
    // mkdir is exclusive even on platforms where rename replaces an empty dir.
    fs.mkdirSync(destination, { mode: 0o700 });
    for (const name of [databaseName, markerName]) fs.renameSync(path.join(staging, name), path.join(destination, name));
    syncDir(destination); syncDir(path.dirname(destination));
    return openMarketplaceVolume(destination);
  } finally { fs.rmSync(staging, { recursive: true, force: true }); }
}
