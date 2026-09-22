import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { MAX_PACKAGE_BYTES, parsePackage } from './package-validation';
export { MAX_PACKAGE_BYTES, safeFile, validateManifest, parsePackage, type ExtensionPackage } from './package-validation';

export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}
/** Package author source without evaluating it or running install scripts. */
export function packExtension(directory: string): Buffer {
  const root = fs.realpathSync(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const files: Record<string, string> = {};
  function walk(dir: string): void {
    for (const file of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (file.name.startsWith('.') || file.name === 'node_modules' || (dir === root && file.name === 'package.json')) continue;
      const absolute = path.join(dir, file.name);
      if (file.isSymbolicLink()) throw new Error('Package symlinks are unsupported');
      if (file.isDirectory()) walk(absolute);
      else {
        const bytes = fs.readFileSync(absolute);
        const content = bytes.toString('utf8');
        if (!Buffer.from(content).equals(bytes)) throw new Error(`Package file must be UTF-8: ${file.name}`);
        files[path.relative(root, absolute).split(path.sep).join('/')] = content;
      }
    }
  }
  walk(root);
  const bytes = Buffer.from(JSON.stringify({ format: 'codegraph-extension-1', package: pkg, files }));
  parsePackage(bytes);
  return bytes;
}
export const sha256 = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');

/** Hash all package bytes, not just its entry point; symlink escapes are refused. */
export function packageDigest(root: string): string {
  const hash = createHash('sha256');
  let total = 0;
  function walk(dir: string): void {
    for (const name of fs.readdirSync(dir).sort()) {
      if (name === '.git') continue;
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Extension packages cannot contain symlinks');
      if (stat.isDirectory()) walk(file);
      else {
        if (file.endsWith('.node')) throw new Error('Native addons are unsupported; bundle portable JavaScript');
        total += stat.size;
        if (total > MAX_PACKAGE_BYTES) throw new Error('Extension package exceeds 8 MiB');
        hash.update(path.relative(root, file).split(path.sep).join('/') + '\0');
        hash.update(fs.readFileSync(file));
      }
    }
  }
  walk(root);
  return hash.digest('hex');
}

/** Trust follows the same existing directory across filesystem case/short-name
 * aliases, never a lowercased string or a different directory with equal bytes. */
export function trustedPackageDigest(directory: string, trusted: Record<string, unknown>): string | undefined {
  const real = fs.realpathSync(directory);
  if (typeof trusted[real] === 'string') return trusted[real] as string;
  const target = fs.statSync(real, { bigint: true });
  if (!target.isDirectory() || target.ino === 0n) return;
  const matches = new Set<string>();
  for (const [approved, digest] of Object.entries(trusted)) {
    if (typeof digest !== 'string' || !path.isAbsolute(approved)) continue;
    try {
      const candidate = fs.statSync(approved, { bigint: true });
      if (candidate.isDirectory() && candidate.dev === target.dev && candidate.ino === target.ino) matches.add(digest);
    } catch { /* An absent historical package is not this directory. */ }
  }
  if (matches.size > 1) throw new Error('Conflicting trust records for aliases of the same package directory');
  return matches.values().next().value;
}
