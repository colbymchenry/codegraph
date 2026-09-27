/**
 * Build what the suite reads from `dist/` before tests spawn the CLI or load
 * workers and the viewer (#1879). Keep the engine first: the viewer build
 * checks the engine's copied grammars.
 */
import { execFileSync, execSync } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
type BuildPart = 'engine' | 'viewer';
type BuildRunner = (part: BuildPart, root: string) => void;

function filesUnder(root: string, relative: string): string[] {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) return [];
  if (!fs.statSync(full).isDirectory()) return [relative];
  return fs.readdirSync(full).sort()
    .filter(name => !['node_modules', 'dist', '.git'].includes(name))
    .flatMap(name => filesUnder(root, path.join(relative, name)));
}

function inputFingerprint(root: string, part: BuildPart): string {
  const inputs = [
    'package.json', 'package-lock.json', 'scripts', '__tests__/global-setup-dist.ts',
    ...fs.readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name)),
    part === 'engine' ? 'src' : 'ui',
  ];
  const hash = createHash('sha256');
  for (const file of inputs.flatMap(input => filesUnder(root, input)).sort()) {
    hash.update(file).update('\0').update(fs.readFileSync(path.join(root, file))).update('\0');
  }
  return hash.digest('hex');
}

function outputSnapshot(root: string, part: BuildPart): Record<string, string> {
  const directory = part === 'engine' ? 'dist' : 'dist/viewer';
  return Object.fromEntries(filesUnder(root, directory)
    .filter(file => !path.basename(file).startsWith('.test-build-'))
    .filter(file => part !== 'engine' || !file.startsWith(`dist${path.sep}viewer${path.sep}`))
    .map(file => {
      const stat = fs.statSync(path.join(root, file));
      return [file, `${stat.size}:${stat.mtimeMs}`];
    }));
}

function build(part: BuildPart, root: string): void {
  if (part === 'engine') {
    // Resolve the installed compiler directly: npx may download an unrelated
    // package named tsc when dependencies are missing.
    const compiler = require.resolve(path.join(root, 'node_modules/typescript/bin/tsc'));
    execFileSync(process.execPath, [compiler], { cwd: root, stdio: 'inherit' });
    execSync('npm run copy-assets', { cwd: root, stdio: 'inherit' });
  } else {
    execSync('npm run build:ui', { cwd: root, stdio: 'inherit' });
  }
}

/** Exported for isolated filesystem fixtures; Vitest calls the default wrapper. */
export function ensureTestDist(root: string, runBuild: BuildRunner = build): void {
  for (const part of ['engine', 'viewer'] as const) {
    const stamp = path.join(root, 'dist', `.test-build-${part}.json`);
    const inputs = inputFingerprint(root, part);
    const outputs = outputSnapshot(root, part);
    let current = false;
    try {
      const previous = JSON.parse(fs.readFileSync(stamp, 'utf8'));
      current = previous.inputs === inputs && Object.keys(outputs).length > 0
        && JSON.stringify(previous.outputs) === JSON.stringify(outputs);
    } catch { /* No valid successful-build record: rebuild. */ }
    if (current) continue;

    process.stderr.write(`[test setup] ${part} build is missing or stale; rebuilding\n`);
    // Never leave a successful stamp behind after a partially failed rebuild.
    fs.rmSync(stamp, { force: true });
    try {
      runBuild(part, root);
      const built = outputSnapshot(root, part);
      const sentinel = part === 'engine' ? 'dist/bin/codegraph.js' : 'dist/viewer/index.html';
      if (!fs.existsSync(path.join(root, sentinel))) throw new Error(`Build did not produce ${sentinel}`);
      fs.writeFileSync(stamp, JSON.stringify({ inputs, outputs: built }));
    } catch (error) {
      throw new Error(`[test setup] ${part} build failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}

export default function setup(): void {
  ensureTestDist(ROOT);
}
