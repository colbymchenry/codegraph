import { afterEach, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { trustedPackageDigest } from '../src/plugins/package';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(p => fs.rmSync(p, { recursive: true, force: true })));
it('matches the same directory through a real filesystem alias without trusting a different directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trust-')); roots.push(root);
  const directory = path.join(root, 'Package'), alias = path.join(root, 'Alias'), other = path.join(root, 'Other');
  fs.mkdirSync(directory); fs.mkdirSync(other);
  fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(trustedPackageDigest(directory, { [alias]: 'approved' })).toBe('approved');
  expect(trustedPackageDigest(other, { [alias]: 'approved' })).toBeUndefined();
  expect(trustedPackageDigest(directory, { [other]: 'approved' })).toBeUndefined();
});
it('refuses conflicting alias approvals instead of guessing one', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trust-')); roots.push(root);
  const directory = path.join(root, 'Package'), a = path.join(root, 'AliasA'), b = path.join(root, 'AliasB');
  fs.mkdirSync(directory);
  for (const alias of [a,b]) fs.symlinkSync(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(() => trustedPackageDigest(directory, { [a]: 'first', [b]: 'second' })).toThrow(/Conflicting trust/);
});
