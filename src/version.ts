/**
 * Version and Provenance Tracking
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

interface RuntimeVersion {
  package: string;
  git: string | null;
}

let cachedVersion: RuntimeVersion | null = null;

export function getRuntimeVersion(): RuntimeVersion {
  if (cachedVersion) return cachedVersion;

  let packageVersion = 'unknown';
  try {
    const pkgPath = path.join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    packageVersion = pkg.version || 'unknown';
  } catch {
    /* Fall back to unknown */
  }

  let gitVersion: string | null = null;
  try {
    const rev = execSync('git rev-parse --short HEAD', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const status = execSync('git status --porcelain', {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    gitVersion = status.length > 0 ? `${rev}-dirty` : rev;
  } catch {
    /* Not a git repo or git not available */
  }

  cachedVersion = { package: packageVersion, git: gitVersion };
  return cachedVersion;
}

