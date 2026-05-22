import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import {
  resolveTemplateDir,
  installGlobalAutoInitHook,
  removeGlobalAutoInitHook,
  isGlobalAutoInitHookInstalled,
} from '../src/sync/global-hooks';

let tempDir: string;
let templateDir: string;
let origGitConfigGlobal: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-global-hooks-'));
  templateDir = path.join(tempDir, 'templates');
  fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true });

  origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, '.gitconfig');

  execFileSync('git', ['config', '--global', 'init.templateDir', templateDir], {
    stdio: 'ignore',
  });
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  if (origGitConfigGlobal === undefined) {
    delete process.env.GIT_CONFIG_GLOBAL;
  } else {
    process.env.GIT_CONFIG_GLOBAL = origGitConfigGlobal;
  }
});

function hookFile(): string {
  return path.join(templateDir, 'hooks', 'post-checkout');
}

function isExecutable(file: string): boolean {
  if (process.platform === 'win32') return true;
  return (fs.statSync(file).mode & 0o111) !== 0;
}

describe('resolveTemplateDir', () => {
  it('G1: returns configured templateDir and does not overwrite git config', () => {
    const result = resolveTemplateDir();
    expect(result.dir).toBe(templateDir);
    expect(result.configWasSet).toBe(false);
    const after = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    expect(after).toBe(templateDir);
  });

  it('G2: defaults to ~/.git-templates and writes git config when not set', () => {
    const freshConfig = path.join(tempDir, '.fresh-gitconfig');
    process.env.GIT_CONFIG_GLOBAL = freshConfig;
    const origHome = process.env.HOME;
    const fakeHome = path.join(tempDir, 'fakehome');
    fs.mkdirSync(fakeHome, { recursive: true });
    process.env.HOME = fakeHome;

    try {
      const result = resolveTemplateDir();
      const expected = path.join(fakeHome, '.git-templates');
      expect(result.dir).toBe(expected);
      expect(result.configWasSet).toBe(true);

      const written = execFileSync('git', ['config', '--global', 'init.templateDir'], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      expect(written).toBe(expected);
    } finally {
      if (origHome === undefined) delete process.env.HOME;
      else process.env.HOME = origHome;
    }
  });
});

describe('installGlobalAutoInitHook', () => {
  it('G3: creates post-checkout file with shebang, block, and executable bit', () => {
    const result = installGlobalAutoInitHook();
    expect(result.status).toBe('installed');
    expect(result.templateDir).toBe(templateDir);
    expect(fs.existsSync(hookFile())).toBe(true);
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toMatch(/^#!\/bin\/sh/);
    expect(body).toContain('# >>> codegraph auto-init hook >>>');
    expect(isExecutable(hookFile())).toBe(true);
  });

  it('G4: hook script is guarded by command -v codegraph check', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      'if command -v codegraph >/dev/null 2>&1'
    );
  });

  it('G5: hook script checks for absence of .codegraph directory', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain('[ ! -d .codegraph ]');
  });

  it('G6: init branch runs codegraph init . and codegraph index', () => {
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('codegraph init . >/dev/null 2>&1');
    expect(body).toContain('codegraph index >/dev/null 2>&1');
  });

  it('G7: init branch appends .codegraph/ to .gitignore using grep -qxF guard', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      "grep -qxF '.codegraph/' .gitignore 2>/dev/null || echo '.codegraph/' >> .gitignore"
    );
  });

  it('G8: sync branch runs codegraph sync in background and suppresses output', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      '( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1'
    );
  });

  it('G9: re-running install does not duplicate the marker block', () => {
    installGlobalAutoInitHook();
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    const count = body.split('# >>> codegraph auto-init hook >>>').length - 1;
    expect(count).toBe(1);
  });

  it('G10: appends block after existing user hook content', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "my custom hook"\n', { mode: 0o755 });
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('echo "my custom hook"');
    expect(body).toContain('# >>> codegraph auto-init hook >>>');
  });

  it('G11: returns status installed and the resolved templateDir', () => {
    const result = installGlobalAutoInitHook();
    expect(result.status).toBe('installed');
    expect(result.templateDir).toBe(templateDir);
  });

  it('G12: returns unchanged and does not rewrite file when block is already current', () => {
    installGlobalAutoInitHook();
    const mtimeBefore = fs.statSync(hookFile()).mtimeMs;
    const result = installGlobalAutoInitHook();
    expect(result.status).toBe('unchanged');
    expect(fs.statSync(hookFile()).mtimeMs).toBe(mtimeBefore);
  });

  it('G19: creates hooks directory if it does not exist', () => {
    const freshTemplateDir = path.join(tempDir, 'fresh-templates');
    execFileSync('git', ['config', '--global', 'init.templateDir', freshTemplateDir], {
      stdio: 'ignore',
    });
    expect(fs.existsSync(path.join(freshTemplateDir, 'hooks'))).toBe(false);
    installGlobalAutoInitHook();
    expect(fs.existsSync(path.join(freshTemplateDir, 'hooks', 'post-checkout'))).toBe(true);
  });

  it('G20: uses existing git config value and does not overwrite it', () => {
    const before = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    installGlobalAutoInitHook();
    const after = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    expect(after).toBe(before);
  });
});

describe('removeGlobalAutoInitHook', () => {
  it('G13: deletes the hook file when our block was the only content', () => {
    installGlobalAutoInitHook();
    const result = removeGlobalAutoInitHook();
    expect(result.status).toBe('removed');
    expect(fs.existsSync(hookFile())).toBe(false);
  });

  it('G14: preserves user content and rewrites file without our block', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "keep me"\n', { mode: 0o755 });
    installGlobalAutoInitHook();
    removeGlobalAutoInitHook();
    expect(fs.existsSync(hookFile())).toBe(true);
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('echo "keep me"');
    expect(body).not.toContain('# >>> codegraph auto-init hook >>>');
  });

  it('G15: returns skipped when no block is present', () => {
    const result = removeGlobalAutoInitHook();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeDefined();
  });

  it('G15b: returns skipped when hook file exists but contains no codegraph block', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "user hook"\n', { mode: 0o755 });
    const result = removeGlobalAutoInitHook();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeDefined();
    // File must be preserved untouched
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain('echo "user hook"');
  });

  it('G16: does not modify git config init.templateDir during remove', () => {
    installGlobalAutoInitHook();
    const before = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    removeGlobalAutoInitHook();
    const after = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    expect(after).toBe(before);
  });
});

describe('isGlobalAutoInitHookInstalled', () => {
  it('G17: returns true after install', () => {
    installGlobalAutoInitHook();
    expect(isGlobalAutoInitHookInstalled()).toBe(true);
  });

  it('G18: returns false when hook file does not contain our block', () => {
    expect(isGlobalAutoInitHookInstalled()).toBe(false);
  });
});
