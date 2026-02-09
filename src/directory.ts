/**
 * Directory Management
 *
 * Manages the .codegraph/ directory structure.
 */

import * as fs from 'fs';
import * as path from 'path';

/**
 * CodeGraph directory name
 */
export const CODEGRAPH_DIR = '.codegraph';

/**
 * Get the .codegraph directory path for a project
 */
export function getCodeGraphDir(projectRoot: string): string {
  return path.join(projectRoot, CODEGRAPH_DIR);
}

/**
 * Check if a project has been initialized with CodeGraph
 */
export function isInitialized(projectRoot: string): boolean {
  const codegraphDir = getCodeGraphDir(projectRoot);
  return fs.existsSync(codegraphDir) && fs.statSync(codegraphDir).isDirectory();
}

/**
 * Create the .codegraph directory structure
 */
export function createDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (fs.existsSync(codegraphDir)) {
    throw new Error(`CodeGraph already initialized in ${projectRoot}`);
  }

  // Create main directory
  fs.mkdirSync(codegraphDir, { recursive: true });

  // Create .gitignore inside .codegraph
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  const gitignoreContent = `# CodeGraph data files
# These are local to each machine and should not be committed

# Database
*.db
*.db-wal
*.db-shm

# Cache
cache/

# Logs
*.log
`;

  fs.writeFileSync(gitignorePath, gitignoreContent, 'utf-8');
}

/**
 * Remove the .codegraph directory
 */
export function removeDirectory(projectRoot: string): void {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return;
  }

  // Recursively remove directory
  fs.rmSync(codegraphDir, { recursive: true, force: true });
}

/**
 * Get all files in the .codegraph directory
 */
export function listDirectoryContents(projectRoot: string): string[] {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return [];
  }

  const files: string[] = [];

  function walkDir(dir: string, prefix: string = ''): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        walkDir(path.join(dir, entry.name), relativePath);
      } else {
        files.push(relativePath);
      }
    }
  }

  walkDir(codegraphDir);
  return files;
}

/**
 * Get the total size of the .codegraph directory in bytes
 */
export function getDirectorySize(projectRoot: string): number {
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    return 0;
  }

  let totalSize = 0;

  function walkDir(dir: string): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        walkDir(fullPath);
      } else {
        const stats = fs.statSync(fullPath);
        totalSize += stats.size;
      }
    }
  }

  walkDir(codegraphDir);
  return totalSize;
}

/**
 * Ensure a subdirectory exists within .codegraph
 */
export function ensureSubdirectory(projectRoot: string, subdirName: string): string {
  if (subdirName.includes('..') || subdirName.includes(path.sep) || subdirName.includes('/')) {
    throw new Error(`Invalid subdirectory name: ${subdirName}`);
  }

  const subdirPath = path.join(getCodeGraphDir(projectRoot), subdirName);

  if (!fs.existsSync(subdirPath)) {
    fs.mkdirSync(subdirPath, { recursive: true });
  }

  return subdirPath;
}

/**
 * Check if the .codegraph directory has valid structure
 */
export function validateDirectory(projectRoot: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  const codegraphDir = getCodeGraphDir(projectRoot);

  if (!fs.existsSync(codegraphDir)) {
    errors.push('CodeGraph directory does not exist');
    return { valid: false, errors };
  }

  if (!fs.statSync(codegraphDir).isDirectory()) {
    errors.push('.codegraph exists but is not a directory');
    return { valid: false, errors };
  }

  // Check for required files
  const gitignorePath = path.join(codegraphDir, '.gitignore');
  if (!fs.existsSync(gitignorePath)) {
    errors.push('.gitignore missing in .codegraph directory');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
