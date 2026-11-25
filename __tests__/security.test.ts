/**
 * Security Tests
 *
 * Tests for P0/P1 security fixes:
 * - FileLock (cross-process locking)
 * - Path traversal prevention
 * - MCP input validation
 * - Atomic writes
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { once } from 'events';
import { pathToFileURL } from 'url';
import { WASM_RUNTIME_FLAGS } from '../src/extraction/wasm-runtime-flags';
import { FileLock, validateProjectPath, validatePathWithinRoot, lexicalPathWithinRoot } from '../src/utils';
import CodeGraph from '../src/index';
import { resolveServerRoot } from '../src/directory';
import { ToolHandler, tools, __setLoadCodeGraphForTests } from '../src/mcp/tools';
import { scanDirectory, isSourceFile } from '../src/extraction';
import { DatabaseConnection, getDatabasePath } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-security-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('FileLock', () => {
  let tempDir: string;
  let lockPath: string;

  beforeEach(() => {
    tempDir = createTempDir();
    lockPath = path.join(tempDir, 'test.lock');
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should acquire and release a lock', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();

    expect(fs.existsSync(lockPath)).toBe(true);
    const content = fs.readFileSync(lockPath, 'utf-8').trim();
    expect(parseInt(content, 10)).toBe(process.pid);

    lock.release();
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should prevent double acquisition within same process', () => {
    const lock1 = new FileLock(lockPath);
    const lock2 = new FileLock(lockPath);

    lock1.acquire();

    // Second lock should fail because our PID is alive
    expect(() => lock2.acquire()).toThrow(/locked by another process/);

    lock1.release();
  });

  it('keeps a live holder protected after its lock file is older than two minutes (#1959)', () => {
    const holder = new FileLock(lockPath);
    const contender = new FileLock(lockPath);
    holder.acquire();
    const old = new Date(Date.now() - 3 * 60_000);
    fs.utimesSync(lockPath, old, old);

    try {
      expect(() => contender.acquire()).toThrow(/locked by another process/);
      expect(fs.readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    } finally {
      holder.release();
      contender.release();
    }
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should detect and remove stale locks from dead processes', () => {
    // Write a lock file with a PID that doesn't exist
    // PID 99999999 is extremely unlikely to be a real process
    fs.writeFileSync(lockPath, '99999999');

    const lock = new FileLock(lockPath);
    // Should succeed because the PID is dead
    expect(() => lock.acquire()).not.toThrow();

    lock.release();
  });

  it('should execute function with withLock', () => {
    const lock = new FileLock(lockPath);

    const result = lock.withLock(() => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if function throws', () => {
    const lock = new FileLock(lockPath);

    expect(() => {
      lock.withLock(() => {
        throw new Error('test error');
      });
    }).toThrow('test error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should execute async function with withLockAsync', async () => {
    const lock = new FileLock(lockPath);

    const result = await lock.withLockAsync(async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 'async-result';
    });

    expect(result).toBe('async-result');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('should release lock even if async function throws', async () => {
    const lock = new FileLock(lockPath);

    await expect(
      lock.withLockAsync(async () => {
        throw new Error('async error');
      })
    ).rejects.toThrow('async error');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('release should be idempotent', () => {
    const lock = new FileLock(lockPath);
    lock.acquire();
    lock.release();
    // Second release should not throw
    expect(() => lock.release()).not.toThrow();
  });
});

describe('Path Traversal Prevention', () => {
  let testDir: string;
  let cg: CodeGraph;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'hello.ts'),
      `export function hello(): string { return "hi"; }\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should read code for valid nodes within project', async () => {
    const nodes = cg.getNodesByKind('function');
    const hello = nodes.find((n) => n.name === 'hello');
    expect(hello).toBeDefined();

    const code = await cg.getCode(hello!.id);
    expect(code).toContain('hello');
  });

  it('should return null for non-existent node', async () => {
    const code = await cg.getCode('does-not-exist');
    expect(code).toBeNull();
  });
});

// #415: a root that already ends with its separator (a Windows drive root such
// as a `Z:\` network drive or a `subst` drive, a UNC share root, POSIX `/`) got
// a second one appended, so no path under it counted as inside it, and a
// project there indexed no files. Path math, plus read-only realpaths of `C:\`.
describe('Path containment at a filesystem root (#415)', () => {
  it('counts a file under the filesystem root as inside it', () => {
    const root = path.parse(process.cwd()).root; // `/`, or this drive's root on Windows
    expect(lexicalPathWithinRoot(root, 'a.ts')).toBe(path.join(root, 'a.ts'));
    expect(lexicalPathWithinRoot(root, path.join('src', 'b.ts'))).toBe(path.join(root, 'src', 'b.ts'));
  });

  it.runIf(process.platform === 'win32')('counts a file under a drive root or a share root as inside it', () => {
    // Neither the drive nor the share has to exist: this is path math only.
    expect(lexicalPathWithinRoot('Q:\\', 'a.ts')).toBe('Q:\\a.ts');
    expect(lexicalPathWithinRoot('q:\\', 'src\\b.ts')).toBe('q:\\src\\b.ts');
    expect(lexicalPathWithinRoot('\\\\server\\share\\', 'a.ts')).toBe('\\\\server\\share\\a.ts');
    // Another drive or another share is still outside.
    expect(lexicalPathWithinRoot('Q:\\', 'C:\\Windows\\win.ini')).toBeNull();
    expect(lexicalPathWithinRoot('\\\\server\\share\\', '\\\\server\\other\\a.ts')).toBeNull();
  });

  it.runIf(process.platform === 'win32' && fs.existsSync('C:\\Windows'))(
    'lets the realpath check through for a folder under a drive root',
    () => {
      expect(validatePathWithinRoot('C:\\', 'Windows')?.toLowerCase()).toBe('c:\\windows');
      // A path that doesn't exist yet is judged by its nearest existing
      // ancestor, which here is the drive root itself.
      expect(validatePathWithinRoot('C:\\', 'codegraph-no-such-dir-415\\a.ts')).toBe(
        'C:\\codegraph-no-such-dir-415\\a.ts'
      );
    }
  );
});

describe('Symlink escape prevention (#527)', () => {
  // An in-repo symlink whose logical path is inside the project root but whose
  // REAL target escapes the root must never be served. validatePathWithinRoot
  // is the chokepoint both content-serving read sinks go through (codegraph_node
  // includeCode + codegraph_explore source rendering), so it must resolve
  // symlinks, not just compare strings. realpathSync the roots so the test's own
  // expectations don't trip over /tmp -> /private/tmp on macOS.
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-root-')));
    outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-outside-')));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'src', 'in.ts'), 'export const x = 1;\n');
    fs.mkdirSync(path.join(outside, 'pkg'));
    fs.writeFileSync(path.join(outside, 'pkg', 'secret.txt'), 'TOP-SECRET\n');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  // Symlink creation needs privileges on Windows; skip gracefully if it fails.
  const link = (linkPath: string, target: string): boolean => {
    try { fs.symlinkSync(target, linkPath); return true; } catch { return false; }
  };

  it('allows a real file inside the root (and realpaths consistently)', () => {
    expect(validatePathWithinRoot(root, 'src/in.ts')).not.toBeNull();
  });

  it('allows a not-yet-existing path inside the root (ENOENT — files about to be written)', () => {
    expect(validatePathWithinRoot(root, 'src/will-write.ts')).not.toBeNull();
  });

  it('rejects a lexical ../ traversal out of the root', () => {
    expect(validatePathWithinRoot(root, `../${path.basename(outside)}/pkg/secret.txt`)).toBeNull();
  });

  it('rejects an in-repo symlink to an out-of-root FILE', () => {
    if (!link(path.join(root, 'escape'), path.join(outside, 'pkg', 'secret.txt'))) return;
    expect(validatePathWithinRoot(root, 'escape')).toBeNull();
  });

  it('rejects a path that escapes through an in-repo symlink to an out-of-root DIR', () => {
    if (!link(path.join(root, 'escapedir'), path.join(outside, 'pkg'))) return;
    expect(validatePathWithinRoot(root, 'escapedir/secret.txt')).toBeNull();
  });

  it('rejects a missing leaf below an out-of-root directory symlink', () => {
    if (!link(path.join(root, 'escapedir'), path.join(outside, 'pkg'))) return;
    expect(validatePathWithinRoot(root, 'escapedir/not-created-yet/file.txt')).toBeNull();
  });

  // A directory link that needs no privilege on Windows (a junction), so the
  // cases below run there without Developer Mode; a symlink elsewhere. Each
  // test removes its own link, so nothing recursive ever walks through one.
  const dirLink = (linkPath: string, target: string): void =>
    fs.symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

  it.runIf(process.platform === 'win32')('rejects a missing leaf below an out-of-root directory junction', () => {
    const junction = path.join(root, 'escapejunction');
    dirLink(junction, path.join(outside, 'pkg'));
    try {
      expect(validatePathWithinRoot(root, 'escapejunction/not-created-yet/file.txt')).toBeNull();
    } finally {
      fs.unlinkSync(junction);
    }
  });

  it('still allows a missing leaf below a directory link that stays WITHIN the root', () => {
    fs.mkdirSync(path.join(root, 'src', 'realdir'));
    const inLink = path.join(root, 'src', 'linkdir');
    dirLink(inLink, path.join(root, 'src', 'realdir'));
    try {
      expect(validatePathWithinRoot(root, 'src/linkdir/new/file.ts')).toBe(
        path.join(root, 'src', 'linkdir', 'new', 'file.ts')
      );
    } finally {
      fs.unlinkSync(inLink);
    }
  });

  // POSIX reports ENOTDIR, not ENOENT, for a path under a FILE (a folder git
  // still lists that is now a file, #2904). It is a missing leaf like any other:
  // allowed inside the root, still refused below a link out of it.
  it('judges a path under an existing file like any missing leaf', () => {
    expect(validatePathWithinRoot(root, 'src/in.ts/child.ts')).toBe(path.join(root, 'src', 'in.ts', 'child.ts'));
    expect(validatePathWithinRoot(root, 'src/in.ts/child.ts', { allowSymlinkEscape: true })).not.toBeNull();
  });

  it('rejects a path under an in-repo symlink to an out-of-root FILE', () => {
    if (!link(path.join(root, 'escape'), path.join(outside, 'pkg', 'secret.txt'))) return;
    expect(validatePathWithinRoot(root, 'escape/child.txt')).toBeNull();
  });

  it('rejects every path under a root that does not exist', () => {
    expect(validatePathWithinRoot(path.join(root, 'gone'), 'src/in.ts')).toBeNull();
  });

  it('still allows an in-repo symlink that stays WITHIN the root (no over-blocking)', () => {
    if (!link(path.join(root, 'src', 'inlink.ts'), path.join(root, 'src', 'in.ts'))) return;
    expect(validatePathWithinRoot(root, 'src/inlink.ts')).not.toBeNull();
  });

  // The INDEXING read path opts into following in-root symlinks the directory
  // walk already descended into — discovery and the reader must agree, or files
  // reached via an in-root symlink-to-outside fail to index (#935). The lexical
  // `../` guard is NOT waived, and content-serving sinks never pass the flag.
  it('allowSymlinkEscape follows an in-repo symlink to an out-of-root FILE (indexing read)', () => {
    if (!link(path.join(root, 'escape'), path.join(outside, 'pkg', 'secret.txt'))) return;
    expect(validatePathWithinRoot(root, 'escape', { allowSymlinkEscape: true })).not.toBeNull();
  });

  it('allowSymlinkEscape follows a path through an in-repo out-of-root DIR symlink (indexing read)', () => {
    if (!link(path.join(root, 'escapedir'), path.join(outside, 'pkg'))) return;
    expect(validatePathWithinRoot(root, 'escapedir/secret.txt', { allowSymlinkEscape: true })).not.toBeNull();
  });

  it('allowSymlinkEscape still allows a missing leaf through an out-of-root DIR link (indexing read)', () => {
    const escapeLink = path.join(root, 'escapedir');
    dirLink(escapeLink, path.join(outside, 'pkg'));
    try {
      expect(
        validatePathWithinRoot(root, 'escapedir/not-created-yet/file.txt', { allowSymlinkEscape: true })
      ).not.toBeNull();
    } finally {
      fs.unlinkSync(escapeLink);
    }
  });

  it('allowSymlinkEscape STILL rejects a lexical ../ traversal (guard not waived)', () => {
    expect(
      validatePathWithinRoot(root, `../${path.basename(outside)}/pkg/secret.txt`, { allowSymlinkEscape: true })
    ).toBeNull();
  });

  it('end-to-end: getCode never serves an out-of-root file reached via a dir symlink', async () => {
    fs.writeFileSync(path.join(outside, 'pkg', 'leak.ts'),
      'export function leaked() { return "LEAKED-ZZZ-9"; }\n');
    if (!link(path.join(root, 'vendored'), path.join(outside, 'pkg'))) return;

    const cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await cg.indexAll();
      // Whether or not extraction followed the dir symlink, NO node may ever
      // yield the out-of-root content through getCode.
      for (const n of cg.getNodesByKind('function')) {
        const code = await cg.getCode(n.id);
        expect(code ?? '').not.toContain('LEAKED-ZZZ-9');
      }
    } finally {
      cg.close();
    }
  });

  it('end-to-end (#935): indexes source reached through an in-root dir symlink to outside', async () => {
    // The Dota custom-game layout symlinks `game/` and `content/` into an SDK
    // tree outside the repo. Before #935 the batch reader's strict symlink-escape
    // guard blocked every file under them, so nothing indexed — even though the
    // directory walk deliberately followed the symlink to enumerate them. The
    // reader now agrees with discovery: the file indexes.
    fs.writeFileSync(path.join(outside, 'pkg', 'vendored.ts'),
      'export function vendoredHelper() { return "LEAKED-ZZZ-9"; }\n');
    if (!link(path.join(root, 'game'), path.join(outside, 'pkg'))) return;

    const cg = CodeGraph.initSync(root, { config: { include: ['**/*.ts'], exclude: [] } });
    try {
      await cg.indexAll();
      // The symlinked-in file is now part of the graph...
      const names = cg.getNodesByKind('function').map((n) => n.name);
      expect(names).toContain('vendoredHelper');
      // ...but its out-of-root contents are STILL never served (the #527 sink
      // stays strict — indexing relaxes only the read path, not getCode).
      for (const n of cg.getNodesByKind('function')) {
        expect((await cg.getCode(n.id)) ?? '').not.toContain('LEAKED-ZZZ-9');
      }
    } finally {
      cg.close();
    }
  });
});

describe('validateProjectPath — sensitive directory blocking', () => {
  // POSIX-only: on Windows '/etc' resolves to C:\etc (non-existent), not a
  // sensitive dir — the Windows case is covered by the win32-gated test below.
  it.runIf(process.platform !== 'win32')('blocks POSIX system directories (exact match)', () => {
    expect(validateProjectPath('/')).toMatch(/sensitive system directory/i);
    expect(validateProjectPath('/etc')).toMatch(/sensitive system directory/i);
  });

  it('allows a normal, existing directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-validate-'));
    try {
      expect(validateProjectPath(dir)).toBeNull();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // SENSITIVE_PATHS stores the Windows entries lowercase and validateProjectPath
  // matches via resolved.toLowerCase(), so 'C:\\Windows' and 'c:\\windows' are
  // both blocked. path.resolve is platform-specific, so this only runs on Windows.
  it.runIf(process.platform === 'win32')(
    'blocks Windows system directories regardless of case',
    () => {
      expect(validateProjectPath('C:\\Windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('c:\\windows')).toMatch(/sensitive system directory/i);
      expect(validateProjectPath('C:\\WINDOWS\\System32')).toMatch(/sensitive system directory/i);
    }
  );
});

/**
 * A directory link any user can make: a junction on Windows (no privilege or
 * Developer Mode needed), a symlink elsewhere.
 */
function linkDir(target: string, link: string): void {
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
}

/** Point `os.homedir()` at `home`: it reads USERPROFILE on Windows, HOME elsewhere. */
function setHome(home: string | undefined, profile: string | undefined = home): void {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  if (profile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = profile;
}

/**
 * A temp folder holding a private home with its own `.ssh` and `.config`, and
 * the links a case makes. Links are removed before the tree, so the cleanup
 * can never walk into a link's target.
 */
function sensitiveFixture() {
  const state = {
    tmp: '',
    home: '',
    links: [] as string[],
    savedHome: undefined as string | undefined,
    savedProfile: undefined as string | undefined,
  };
  beforeEach(() => {
    state.tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-sensitive-')));
    state.home = path.join(state.tmp, 'home');
    fs.mkdirSync(path.join(state.home, '.ssh'), { recursive: true });
    fs.mkdirSync(path.join(state.home, '.config', 'nvim'), { recursive: true });
    fs.mkdirSync(path.join(state.tmp, 'project'));
    fs.mkdirSync(path.join(state.tmp, 'elsewhere'));
    state.links = [];
    state.savedHome = process.env.HOME;
    state.savedProfile = process.env.USERPROFILE;
    setHome(state.home);
  });
  afterEach(() => {
    setHome(state.savedHome, state.savedProfile);
    for (const link of state.links.reverse()) fs.unlinkSync(link);
    fs.rmSync(state.tmp, { recursive: true, force: true });
  });
  const link = (target: string, at: string): string => {
    linkDir(target, at);
    state.links.push(at);
    return at;
  };
  return { state, link };
}

// #1930: the guard compared the path as typed, so a link to a sensitive folder,
// a case variant of one (Windows, macOS) or a `\\?\` spelling (Windows) passed.
describe('validateProjectPath — the folder a path really names (#1930)', () => {
  const { state, link } = sensitiveFixture();

  it('refuses a link to a sensitive home folder, and the folders under it', () => {
    const elsewhere = path.join(state.tmp, 'elsewhere');
    const ssh = link(path.join(state.home, '.ssh'), path.join(elsewhere, 'ssh'));
    const config = link(path.join(state.home, '.config'), path.join(elsewhere, 'config'));

    expect(validateProjectPath(ssh)).toMatch(/sensitive directory/i);
    expect(validateProjectPath(config)).toMatch(/sensitive directory/i);
    expect(validateProjectPath(path.join(config, 'nvim'))).toMatch(/sensitive directory/i);
    // The refusal names the folder the link leads to.
    expect(validateProjectPath(ssh)).toContain(path.join(state.home, '.ssh'));
    // A link to an ordinary folder is still a fine project root.
    const project = link(path.join(state.tmp, 'project'), path.join(elsewhere, 'project'));
    expect(validateProjectPath(project)).toBeNull();
  });

  it('refuses a sensitive home folder that is itself a link, and links to it', () => {
    // ~/.ssh kept in a dotfiles checkout and linked into the home.
    const dotfiles = path.join(state.tmp, 'dotfiles', 'ssh');
    fs.mkdirSync(dotfiles, { recursive: true });
    fs.rmdirSync(path.join(state.home, '.ssh'));
    link(dotfiles, path.join(state.home, '.ssh'));

    expect(validateProjectPath(dotfiles)).toMatch(/sensitive directory/i);
    const viaLink = link(path.join(state.home, '.ssh'), path.join(state.tmp, 'elsewhere', 'ssh'));
    expect(validateProjectPath(viaLink)).toMatch(/sensitive directory/i);
  });

  it("refuses a linked home's sensitive folders by their real path", () => {
    const realHome = path.join(state.tmp, 'real-home');
    fs.mkdirSync(path.join(realHome, '.aws'), { recursive: true });
    const linkedHome = link(realHome, path.join(state.tmp, 'linked-home'));
    setHome(linkedHome);

    expect(validateProjectPath(path.join(realHome, '.aws'))).toMatch(/sensitive directory/i);
    expect(validateProjectPath(path.join(linkedHome, '.aws'))).toMatch(/sensitive directory/i);
  });

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    'refuses a case variant of a sensitive home folder (case-insensitive file systems)',
    () => {
      expect(validateProjectPath(path.join(state.home, '.SSH'))).toMatch(/sensitive directory/i);
      expect(validateProjectPath(path.join(state.home, '.Config', 'nvim'))).toMatch(/sensitive directory/i);
      expect(validateProjectPath(path.join(state.home.toUpperCase(), '.config'))).toMatch(
        /sensitive directory/i
      );
    }
  );

  it.runIf(process.platform === 'win32')('refuses \\\\?\\ and \\\\.\\ spellings of a sensitive folder', () => {
    for (const spelled of [
      `\\\\?\\${path.join(state.home, '.ssh')}`,
      `\\\\.\\${path.join(state.home, '.config')}`,
      `//?/${path.join(state.home, '.ssh').replace(/\\/g, '/')}`,
    ]) {
      expect(validateProjectPath(spelled), spelled).toMatch(/sensitive directory/i);
    }
    for (const spelled of ['\\\\?\\C:\\Windows', '\\\\.\\C:\\Windows', '\\\\?\\c:\\windows\\system32', '\\\\?\\C:\\']) {
      expect(validateProjectPath(spelled), spelled).toMatch(/sensitive system directory/i);
    }
    // The prefix on an ordinary folder changes nothing.
    expect(validateProjectPath(`\\\\?\\${path.join(state.tmp, 'project')}`)).toBeNull();
  });

  it.runIf(process.platform === 'win32' && fs.existsSync('C:\\Windows'))(
    'refuses a junction to a Windows system folder',
    () => {
      const windows = link('C:\\Windows', path.join(state.tmp, 'elsewhere', 'windows'));
      expect(validateProjectPath(windows)).toMatch(/sensitive system directory/i);
    }
  );

  // On macOS `/etc` is itself a link to `/private/etc`, so this also checks that
  // the system folders are compared by their own real paths.
  it.runIf(process.platform !== 'win32')('refuses a symlink to a system folder', () => {
    const etc = link('/etc', path.join(state.tmp, 'elsewhere', 'etc'));
    expect(validateProjectPath(etc)).toMatch(/sensitive system directory/i);
  });

  it.runIf(process.platform === 'darwin')('refuses /private/etc, the folder /etc names on macOS', () => {
    expect(validateProjectPath('/private/etc')).toMatch(/sensitive system directory/i);
  });
});

// #1930 through the MCP entry point, against a real index of the folder.
describe('MCP projectPath into a sensitive folder (#1930)', () => {
  const { state, link } = sensitiveFixture();
  let handler: ToolHandler;

  beforeEach(async () => {
    const config = path.join(state.home, '.config');
    fs.mkdirSync(path.join(config, 'tool'));
    fs.writeFileSync(
      path.join(config, 'tool', 'secrets.ts'),
      "export function readToken(): string { return 'FAKE-TOKEN-1930'; }\n"
    );
    const indexed = await CodeGraph.init(config, { index: true });
    indexed.close();
    // Without the seam an unrefused path fails to load the engine here instead
    // of opening the folder's index, which would hide a leak.
    __setLoadCodeGraphForTests(CodeGraph);
    handler = new ToolHandler(null);
  });

  afterEach(async () => {
    await handler.closeAll();
    __setLoadCodeGraphForTests(null);
  });

  it('refuses a link to the folder, and a missing folder under it', async () => {
    const config = path.join(state.home, '.config');
    const viaLink = link(config, path.join(state.tmp, 'elsewhere', 'config'));
    // A path that doesn't exist skips the up-front check and walks up to the
    // folder's own index, so the root the walk lands on is checked too.
    for (const projectPath of [viaLink, path.join(config, 'no-such-dir'), path.join(viaLink, 'no-such-dir')]) {
      const result = await handler.execute('codegraph_node', {
        symbol: 'readToken',
        includeCode: true,
        projectPath,
      });
      const text = result.content.map((c) => c.text).join('\n');
      expect(result.isError, projectPath).toBe(true);
      expect(text, projectPath).toMatch(/sensitive directory/i);
      expect(text, projectPath).not.toContain('FAKE-TOKEN-1930');
    }
  });
});

// The MCP server's default project comes from the client (initialize's rootUri
// or workspaceFolders, or roots/list), the launch cwd, or --path. It gets the
// refusal an agent's projectPath gets: a sensitive folder is not opened,
// watched or synced, and the session runs with no default project.
describe('MCP default project in a sensitive folder', () => {
  const { state, link } = sensitiveFixture();
  // The built engine and session. Under vitest the src engine can't load the
  // CodeGraph chain it opens a default project with, so it would open none at
  // all and pass these tests with the guard missing.
  const DIST = path.resolve(__dirname, '../dist');
  const { MCPEngine } = require(path.join(DIST, 'mcp', 'engine.js')) as typeof import('../src/mcp/engine');
  const { MCPSession } = require(path.join(DIST, 'mcp', 'session.js')) as typeof import('../src/mcp/session');
  const TOKEN = 'FAKE-TOKEN-DEFAULT-ROOT';
  const NO_DEFAULT_INSTRUCTIONS = 'per-project; pass projectPath';
  type Engine = InstanceType<typeof MCPEngine>;
  type Reply = { isError?: boolean; content: Array<{ text: string }>; instructions?: string };
  const engines: Engine[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  let config: string;
  let project: string;
  let stderr: string;

  const text = (reply: Reply): string => reply.content.map((c) => c.text).join('\n');

  beforeEach(async () => {
    config = path.join(state.home, '.config');
    fs.mkdirSync(path.join(config, 'tool'));
    fs.writeFileSync(
      path.join(config, 'tool', 'secrets.ts'),
      `export function readToken(): string { return '${TOKEN}'; }\n`
    );
    (await CodeGraph.init(config, { index: true })).close();
    project = path.join(state.tmp, 'project');
    fs.writeFileSync(path.join(project, 'app.ts'), 'export function serveApp(): number { return 1; }\n');
    (await CodeGraph.init(project, { index: true })).close();
    stderr = '';
    vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
      stderr += String(chunk);
      return true;
    }) as typeof process.stderr.write);
  }, 60_000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(engines.splice(0).map((engine) => engine.stop()));
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
    // A daemon a launcher started for the folder holds it open (only ever
    // without the guard): stop it before the folder is removed.
    let daemonPid = 0;
    try {
      daemonPid = JSON.parse(fs.readFileSync(path.join(config, '.codegraph', 'daemon.pid'), 'utf8')).pid;
    } catch { /* no daemon */ }
    if (daemonPid > 0) {
      try { process.kill(daemonPid, 'SIGKILL'); } catch { /* already gone */ }
      for (let i = 0; i < 200; i++) {
        try { process.kill(daemonPid, 0); } catch { break; }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }, 60_000);

  /** An MCP client in this process, on a new session of `engine`; roots/list answers `roots`. */
  function connect(engine: Engine, roots: string[] = []) {
    let deliver: ((message: object) => Promise<void>) | null = null;
    const replies = new Map<number, Reply>();
    const asked: string[] = [];
    const transport = {
      start: (handler: (message: object) => Promise<void>) => { deliver = handler; },
      stop: () => {},
      send: () => {},
      notify: () => {},
      request: async (method: string) => {
        asked.push(method);
        return method === 'roots/list'
          ? { roots: roots.map((root) => ({ uri: pathToFileURL(root).href, name: path.basename(root) })) }
          : {};
      },
      sendResult: (id: number, result: Reply) => { replies.set(id, result); },
      sendError: (id: number, _code: number, message: string) => {
        replies.set(id, { isError: true, content: [{ text: message }] });
      },
    };
    new MCPSession(transport as never, engine).start();
    let nextId = 0;
    const call = async (method: string, params: object): Promise<Reply> => {
      const id = nextId++;
      await deliver!({ jsonrpc: '2.0', id, method, params });
      return replies.get(id)!;
    };
    const initialize = (params: object = {}) =>
      call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' }, ...params });
    const node = (symbol: string) =>
      call('tools/call', { name: 'codegraph_node', arguments: { symbol, includeCode: true } });
    return { call, initialize, node, asked };
  }

  it('does not open, watch or sync a sensitive folder as the default project', async () => {
    const viaLink = link(config, path.join(state.tmp, 'elsewhere', 'config'));
    // The folder, one inside it, a missing one under it (the up-walk lands on
    // the folder's index), and a link to it.
    for (const searchFrom of [config, path.join(config, 'tool'), path.join(config, 'no-such-dir'), viaLink]) {
      const engine = new MCPEngine({ watch: true });
      engines.push(engine);
      await engine.ensureInitialized(searchFrom);
      engine.retryInitializeSync(searchFrom); // what each tool call retries
      expect(engine.hasDefaultCodeGraph(), searchFrom).toBe(false);

      // The no-default-project guidance: success-shaped, never isError.
      const bare = await engine.getToolHandler().execute('codegraph_node', { symbol: 'readToken', includeCode: true });
      expect(bare.isError, searchFrom).toBeFalsy();
      expect(text(bare), searchFrom).toContain('No CodeGraph project is loaded');
      expect(text(bare), searchFrom).toMatch(/sensitive directory/i);
      expect(text(bare), searchFrom).toContain('projectPath');
      expect(text(bare), searchFrom).not.toContain(TOKEN);

      // Naming the folder is refused as before.
      const named = await engine.getToolHandler().execute('codegraph_node', {
        symbol: 'readToken',
        includeCode: true,
        projectPath: config,
      });
      expect(named.isError, searchFrom).toBe(true);
      expect(text(named), searchFrom).toMatch(/sensitive directory/i);
      expect(text(named), searchFrom).not.toContain(TOKEN);
    }
    // Nothing took the folder's writer slot or watched it, and the log says why.
    expect(fs.existsSync(path.join(config, '.codegraph', 'writer.pid'))).toBe(false);
    expect(stderr).not.toContain('File watcher active');
    expect(stderr).toMatch(/sensitive directory.*no default project/i);
  }, 60_000);

  it('still opens, watches and syncs an ordinary project as the default project', async () => {
    const engine = new MCPEngine({ watch: true });
    engines.push(engine);
    await engine.ensureInitialized(project);
    expect(engine.hasDefaultCodeGraph()).toBe(true);
    const result = await engine.getToolHandler().execute('codegraph_node', { symbol: 'serveApp', includeCode: true });
    expect(result.isError).toBeFalsy();
    expect(text(result)).toContain('serveApp');
    // The lifecycle the refused folder skips: this engine took the writer slot.
    expect(fs.existsSync(path.join(project, '.codegraph', 'writer.pid'))).toBe(true);
  }, 60_000);

  it('sends the no-default-project instructions for a sensitive rootUri, workspaceFolders or cwd', async () => {
    const uri = pathToFileURL(config).href;
    const cases: Array<[string, object, string]> = [
      ['rootUri', { rootUri: uri }, path.join(state.tmp, 'elsewhere')],
      ['workspaceFolders', { workspaceFolders: [{ uri, name: 'config' }] }, path.join(state.tmp, 'elsewhere')],
      ['cwd', {}, config],
    ];
    for (const [source, params, cwd] of cases) {
      const restoreCwd = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
      try {
        const engine = new MCPEngine({ watch: true });
        engines.push(engine);
        const client = connect(engine);
        const init = await client.initialize(params);
        expect(init.instructions, source).toContain(NO_DEFAULT_INSTRUCTIONS);
        const result = await client.node('readToken');
        expect(result.isError, source).toBeFalsy();
        expect(text(result), source).toContain('No CodeGraph project is loaded');
        expect(text(result), source).not.toContain(TOKEN);
        expect(engine.hasDefaultCodeGraph(), source).toBe(false);
      } finally {
        restoreCwd.mockRestore();
      }
    }
    // A client naming an ordinary project still gets it as the default.
    const engine = new MCPEngine({ watch: true });
    engines.push(engine);
    const client = connect(engine);
    const init = await client.initialize({ rootUri: pathToFileURL(project).href });
    expect(init.instructions).not.toContain(NO_DEFAULT_INSTRUCTIONS);
    expect(text(await client.node('serveApp'))).toContain('serveApp');
  }, 60_000);

  it('does not adopt a sensitive folder that roots/list names', async () => {
    // The fallback after roots/list is the cwd: keep it off any real index.
    const restoreCwd = vi.spyOn(process, 'cwd').mockReturnValue(path.join(state.tmp, 'elsewhere'));
    try {
      const engine = new MCPEngine({ watch: true });
      engines.push(engine);
      const client = connect(engine, [config]);
      await client.initialize({ capabilities: { roots: {} } });
      const result = await client.node('readToken');
      expect(client.asked).toContain('roots/list');
      expect(result.isError).toBeFalsy();
      expect(text(result)).toContain('No CodeGraph project is loaded');
      expect(text(result)).not.toContain(TOKEN);
      expect(engine.hasDefaultCodeGraph()).toBe(false);

      // roots/list naming an ordinary project still makes it the default.
      const ordinary = new MCPEngine({ watch: true });
      engines.push(ordinary);
      const other = connect(ordinary, [project]);
      await other.initialize({ capabilities: { roots: {} } });
      expect(text(await other.node('serveApp'))).toContain('serveApp');
      expect(ordinary.hasDefaultCodeGraph()).toBe(true);
    } finally {
      restoreCwd.mockRestore();
    }
  }, 60_000);

  it('neither adopts nor lists the indexed sub-projects of a sensitive folder', async () => {
    /** A workspace (it has a .git) whose indexes live in its sub-folders. */
    const workspace = async (base: string, children: string[]): Promise<string> => {
      fs.mkdirSync(path.join(base, '.git'), { recursive: true });
      for (const child of children) {
        fs.mkdirSync(path.join(base, child));
        fs.writeFileSync(path.join(base, child, 'a.ts'), 'export const a = 1;\n');
        (await CodeGraph.init(path.join(base, child))).close();
      }
      return base;
    };
    // Nothing indexed at or above these, so the down-scan below them decides.
    const one = await workspace(path.join(state.home, '.aws', 'one'), ['only']);
    const two = await workspace(path.join(state.home, '.aws', 'two'), ['a', 'b']);
    expect(resolveServerRoot(one)).toMatchObject({ root: null, candidates: [], refusal: expect.stringMatching(/sensitive directory/i) });
    expect(resolveServerRoot(two)).toMatchObject({ root: null, candidates: [] });

    // The same workspaces elsewhere: the single sub-project is adopted, two are listed.
    const okOne = await workspace(path.join(state.tmp, 'elsewhere', 'one'), ['only']);
    const okTwo = await workspace(path.join(state.tmp, 'elsewhere', 'two'), ['a', 'b']);
    expect(resolveServerRoot(okOne)).toMatchObject({ root: path.join(okOne, 'only'), viaSubScan: true, refusal: null });
    expect(resolveServerRoot(okTwo).candidates).toHaveLength(2);
  }, 60_000);

  // The launcher keys its shared daemon on the root it resolves from the cwd or
  // --path, so this runs the real `serve --mcp` with daemon sharing on.
  it('starts no daemon for a launch from a sensitive cwd or --path, and serves no default project', async () => {
    const elsewhere = path.join(state.tmp, 'elsewhere');
    const launches: Array<[string, string, string[]]> = [
      ['cwd', config, []],
      ['--path', elsewhere, ['--path', config]],
    ];
    for (const [source, cwd, args] of launches) {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CODEGRAPH_WASM_RELAUNCHED: '1',
        CODEGRAPH_NO_UPDATE_CHECK: '1',
        // Should a daemon start anyway, it leaves soon after its client does.
        CODEGRAPH_DAEMON_IDLE_TIMEOUT_MS: '1000',
      };
      delete env.CODEGRAPH_NO_DAEMON;
      delete env.CODEGRAPH_DAEMON_INTERNAL;
      const child = spawn(
        process.execPath,
        [...WASM_RUNTIME_FLAGS, path.join(DIST, 'bin', 'codegraph.js'), 'serve', '--mcp', ...args],
        { cwd, stdio: ['pipe', 'pipe', 'pipe'], env }
      ) as ChildProcessWithoutNullStreams;
      children.push(child);
      const messages: Array<{ id?: number; result?: Reply }> = [];
      let out = '';
      let err = '';
      child.stdout.on('data', (chunk) => {
        out += chunk.toString('utf8');
        let newline: number;
        while ((newline = out.indexOf('\n')) !== -1) {
          const line = out.slice(0, newline).trim();
          out = out.slice(newline + 1);
          try { if (line) messages.push(JSON.parse(line)); } catch { /* not JSON-RPC */ }
        }
      });
      child.stderr.on('data', (chunk) => { err += chunk.toString('utf8'); });
      const send = (message: object): void => { child.stdin.write(JSON.stringify(message) + '\n'); };
      const reply = async (id: number): Promise<Reply> => {
        const deadline = Date.now() + 30_000;
        for (;;) {
          const hit = messages.find((m) => m.id === id && m.result);
          if (hit) return hit.result!;
          if (Date.now() > deadline) throw new Error(`${source}: no reply ${id}; stderr: ${err}`);
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };

      send({
        jsonrpc: '2.0', id: 0, method: 'initialize',
        params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      });
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'codegraph_node', arguments: { symbol: 'readToken', includeCode: true } },
      });
      const init = await reply(0);
      const result = await reply(1);

      expect(init.instructions, source).toContain(NO_DEFAULT_INSTRUCTIONS);
      expect(result.isError, source).toBeFalsy();
      expect(text(result), source).toContain('No CodeGraph project is loaded');
      expect(text(result), source).not.toContain(TOKEN);
      // No daemon lock, no writer slot: nothing was set up in the folder.
      expect(fs.existsSync(path.join(config, '.codegraph', 'daemon.pid')), source).toBe(false);
      expect(fs.existsSync(path.join(config, '.codegraph', 'writer.pid')), source).toBe(false);
      expect(err, source).toMatch(/sensitive directory/i);

      const closed = once(child, 'close');
      child.kill('SIGKILL');
      await closed;
    }
  }, 120_000);
});

describe('MCP Input Validation', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = createTempDir();

    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'example.ts'),
      `export function exampleFunc(): void {}\nexport class ExampleClass {}\n`
    );

    cg = CodeGraph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.close();
    cleanupTempDir(testDir);
  });

  it('should reject non-string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: null });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject empty string query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: '' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should accept valid query in codegraph_search', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example' });
    expect(result.isError).toBeFalsy();
  });

  it('should clamp limit to valid range in codegraph_search', async () => {
    // Extremely large limit should still work (clamped to 100)
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 999999 });
    expect(result.isError).toBeFalsy();
  });

  it('should reject non-string symbol in codegraph_callers', async () => {
    const result = await handler.execute('codegraph_callers', { symbol: 123 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should reject non-string query in codegraph_explore', async () => {
    const result = await handler.execute('codegraph_explore', { query: undefined });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('non-empty string');
  });

  it('should truncate oversized tool output', async () => {
    // Force a huge result set through codegraph_search; the response must be
    // truncated with the sentinel rather than flooding the agent's context.
    const many = Array.from({ length: 3000 }, (_, i) => ({
      node: {
        id: `n${i}`,
        name: `symbol_${i}_${'x'.repeat(40)}`,
        kind: 'function',
        filePath: `src/very/deep/path/file_${i}.ts`,
        startLine: 1,
        endLine: 2,
        language: 'typescript',
      },
      score: 1,
    }));
    const fakeCg = {
      searchNodes: () => many,
      getFile: () => undefined,
      // Search down-ranks generated files, and since #1500 that verdict comes
      // from the index (path convention ∪ content banner) rather than the
      // filename alone. No database here — none of these paths is generated.
      generatedFilePredicate: () => () => false,
    };
    const fakeHandler = new ToolHandler(fakeCg as unknown as CodeGraph);

    const result = await fakeHandler.execute('codegraph_search', { query: 'x' });

    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain('... (output truncated)');
  });

  it('should reject non-string symbol in codegraph_impact', async () => {
    const result = await handler.execute('codegraph_impact', { symbol: [] });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_node', async () => {
    const result = await handler.execute('codegraph_node', { symbol: false });
    expect(result.isError).toBe(true);
  });

  it('should reject non-string symbol in codegraph_callees', async () => {
    const result = await handler.execute('codegraph_callees', { symbol: {} });
    expect(result.isError).toBe(true);
  });

  it('should handle NaN limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: 'abc' });
    expect(result.isError).toBeFalsy();
  });

  it('should handle negative limit gracefully', async () => {
    const result = await handler.execute('codegraph_search', { query: 'example', limit: -5 });
    expect(result.isError).toBeFalsy();
  });

  // #230: getCodeGraph must reject a sensitive system directory passed as
  // projectPath before opening it. The error surfaces through execute()'s
  // catch as an isError result. /etc is sensitive on POSIX; C:\Windows on
  // Windows (path.resolve is platform-specific, so each case is gated).
  it.runIf(process.platform !== 'win32')(
    'rejects a sensitive POSIX projectPath (/etc) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: '/etc',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );

  it.runIf(process.platform === 'win32')(
    'rejects a sensitive Windows projectPath (C:\\Windows) via the MCP handler',
    async () => {
      const result = await handler.execute('codegraph_search', {
        query: 'example',
        projectPath: 'C:\\Windows',
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/sensitive system directory/i);
    }
  );
});

describe('Atomic Writes', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not leave temp files on success', () => {
    // We test this indirectly through the config-writer module
    // by checking that no .tmp files remain after writing
    const configDir = path.join(tempDir, '.claude');
    fs.mkdirSync(configDir, { recursive: true });

    const testFile = path.join(configDir, 'test.json');
    // Simulate what atomicWriteFileSync does
    const tmpPath = testFile + '.tmp.' + process.pid;
    fs.writeFileSync(tmpPath, '{"test": true}');
    fs.renameSync(tmpPath, testFile);

    expect(fs.existsSync(testFile)).toBe(true);
    expect(fs.existsSync(tmpPath)).toBe(false);

    const content = JSON.parse(fs.readFileSync(testFile, 'utf-8'));
    expect(content.test).toBe(true);
  });
});

describe('Source file detection (isSourceFile)', () => {
  it('selects files by supported extension', () => {
    expect(isSourceFile('src/index.ts')).toBe(true);
    expect(isSourceFile('src/deep/nested/file.ts')).toBe(true);
    expect(isSourceFile('src/component.tsx')).toBe(true);
    expect(isSourceFile('lib/util.js')).toBe(true);
    expect(isSourceFile('src/main.py')).toBe(true);
  });

  it('rejects unsupported extensions and extensionless files', () => {
    expect(isSourceFile('src/component.css')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
    expect(isSourceFile('Makefile')).toBe(false);
    expect(isSourceFile('.gitignore')).toBe(false);
  });

  it('matches regardless of leading dot directories', () => {
    expect(isSourceFile('.hidden/index.ts')).toBe(true);
  });
});

describe('JSON.parse Error Boundaries in DB', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should not crash when node has malformed JSON in decorators column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a node with malformed JSON in the decorators column
    db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, decorators, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      'test-node-1', 'function', 'myFunc', 'myFunc', 'test.ts', 'typescript',
      1, 5, 0, 0,
      '{not valid json!!!}',  // malformed decorators
      0, 0, 0, 0, Date.now()
    );

    // Should not throw - should return node with undefined decorators
    const node = queries.getNodeById('test-node-1');
    expect(node).not.toBeNull();
    expect(node!.name).toBe('myFunc');
    expect(node!.decorators).toBeUndefined();

    db.close();
  });

  it('should not crash when edge has malformed JSON in metadata column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert two nodes first
    const insertNode = db.getDb().prepare(`
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column, end_column, is_exported, is_async, is_static, is_abstract, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insertNode.run('node-a', 'function', 'funcA', 'funcA', 'a.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());
    insertNode.run('node-b', 'function', 'funcB', 'funcB', 'b.ts', 'typescript', 1, 5, 0, 0, 0, 0, 0, 0, Date.now());

    // Insert edge with malformed metadata
    db.getDb().prepare(`
      INSERT INTO edges (source, target, kind, metadata)
      VALUES (?, ?, ?, ?)
    `).run('node-a', 'node-b', 'calls', 'broken json {{{');

    // Should not throw - should return edge with undefined metadata
    const edges = queries.getOutgoingEdges('node-a');
    expect(edges.length).toBe(1);
    expect(edges[0].source).toBe('node-a');
    expect(edges[0].target).toBe('node-b');
    expect(edges[0].metadata).toBeUndefined();

    db.close();
  });

  it('should not crash when file record has malformed JSON in errors column', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);
    const queries = new QueryBuilder(db.getDb());

    // Insert a file with malformed errors JSON
    db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, node_count, errors)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run('test.ts', 'abc123', 'typescript', 100, Date.now(), Date.now(), 5, 'not-an-array');

    // Should not throw - should return file with undefined errors
    const file = queries.getFileByPath('test.ts');
    expect(file).not.toBeNull();
    expect(file!.path).toBe('test.ts');
    expect(file!.errors).toBeUndefined();

    db.close();
  });
});

describe('Symlink Cycle Detection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should handle symlink cycle without infinite loop', () => {
    // Create directory structure with a symlink cycle
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'index.ts'), 'export const x = 1;\n');

    // Create a symlink from src/loop -> tempDir (parent directory)
    try {
      fs.symlinkSync(tempDir, path.join(srcDir, 'loop'), 'dir');
    } catch {
      // Skip test if symlinks not supported (e.g., Windows without admin)
      return;
    }


    // This should complete without hanging
    const files = scanDirectory(tempDir);

    // Should find the real file but not loop infinitely
    expect(files).toContain('src/index.ts');
    // Should not find duplicates via the symlink path
    const indexFiles = files.filter(f => f.endsWith('index.ts'));
    expect(indexFiles.length).toBe(1);
  });

  it('should follow valid symlinks to directories', () => {
    // Create source directory with a file
    const realDir = path.join(tempDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'hello.ts'), 'export function hello() {}\n');

    // Create a symlink to realDir
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    try {
      fs.symlinkSync(realDir, path.join(srcDir, 'linked'), 'dir');
    } catch {
      return;
    }


    const files = scanDirectory(tempDir);

    // Should find files from both the real dir and via the symlink
    // But deduplicate since they resolve to the same real path
    expect(files.some(f => f.includes('hello.ts'))).toBe(true);
  });

  it('should skip broken symlinks gracefully', () => {
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'valid.ts'), 'export const y = 2;\n');

    try {
      fs.symlinkSync('/nonexistent/path', path.join(srcDir, 'broken'), 'dir');
    } catch {
      return;
    }


    // Should not throw
    const files = scanDirectory(tempDir);
    expect(files).toContain('src/valid.ts');
  });
});
