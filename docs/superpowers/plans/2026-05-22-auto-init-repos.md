# auto-init-repos Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `codegraph auto-init-repos [--remove]` that installs a global git template `post-checkout` hook so every new `git clone` / `git init` automatically runs `codegraph init` and `codegraph index`.

**Architecture:** Extract shared hook primitives (`stripMarkerBlock`, `isEffectivelyEmpty`, `chmodExecutable`) into `src/sync/hook-utils.ts`; refactor `src/sync/git-hooks.ts` to import them; add `src/sync/global-hooks.ts` for global template hook logic; expose the command via an extracted action handler in `src/bin/auto-init-repos-action.ts` (enables unit testing without subprocess); wire the command into `src/bin/codegraph.ts`.

**Tech Stack:** TypeScript, Node.js `fs`/`child_process`, `better-sqlite3`-free (no DB), `@clack/prompts` for output, `vitest` for tests.

**Spec:** `docs/superpowers/specs/2026-05-22-auto-init-repos-design.md`

---

## Task 1: Create `src/sync/hook-utils.ts` with tests U1–U11

**Files:**
- Create: `src/sync/hook-utils.ts`
- Create: `__tests__/hook-utils.test.ts`

- [ ] **Step 1: Write all failing tests (U1–U11)**

Create `__tests__/hook-utils.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { stripMarkerBlock, isEffectivelyEmpty, chmodExecutable } from '../src/sync/hook-utils';

const BEGIN = '# >>> codegraph test >>>';
const END   = '# <<< codegraph test <<<';

describe('stripMarkerBlock', () => {
  // U1: removes block between markers; surrounding content preserved
  it('removes block between markers and preserves surrounding content', () => {
    const content = `line before\n${BEGIN}\ninner line\n${END}\nline after`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe('line before\nline after');
  });

  // U2: no markers in content → returns unchanged
  it('returns content unchanged when no markers present', () => {
    const content = 'no markers here\njust lines';
    expect(stripMarkerBlock(content, BEGIN, END)).toBe(content);
  });

  // U3: custom begin/end markers → only those stripped, other markers untouched
  it('strips only the specified markers, leaving other marker strings untouched', () => {
    const otherBegin = '# >>> other >>>';
    const otherEnd   = '# <<< other <<<';
    const content = [
      'keep',
      BEGIN, 'codegraph block', END,
      'also keep',
      otherBegin, 'other content', otherEnd,
      'end',
    ].join('\n');
    const result = stripMarkerBlock(content, otherBegin, otherEnd);
    expect(result).toContain(BEGIN);
    expect(result).toContain('codegraph block');
    expect(result).not.toContain('other content');
    expect(result).not.toContain(otherBegin);
  });

  // U3b: begin present, end absent → strips from begin to EOF
  it('strips from begin marker to EOF when end marker is absent', () => {
    const content = `before\n${BEGIN}\ninner`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe('before');
  });

  // U3c: end present, begin absent → returns content unchanged
  it('returns content unchanged when end marker is present but begin is absent', () => {
    const content = `before\n${END}\nafter`;
    expect(stripMarkerBlock(content, BEGIN, END)).toBe(content);
  });

  // U3d: idempotent — two calls produce same result as one
  it('is idempotent: calling twice produces the same result as calling once', () => {
    const content = `a\n${BEGIN}\nb\n${END}\nc`;
    const once  = stripMarkerBlock(content, BEGIN, END);
    const twice = stripMarkerBlock(once, BEGIN, END);
    expect(twice).toBe(once);
  });
});

describe('isEffectivelyEmpty', () => {
  // U4: shebang + blank lines only → true
  it('returns true for shebang line and blank lines only', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n\n')).toBe(true);
  });

  // U5: empty string → true
  it('returns true for empty string', () => {
    expect(isEffectivelyEmpty('')).toBe(true);
  });

  // U6: real user content → false
  it('returns false when real user content is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\necho "user hook"')).toBe(false);
  });

  // U7: begin marker line present → false
  it('returns false when a begin marker line is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n# >>> codegraph auto-init hook >>>')).toBe(false);
  });

  // U8: end marker line present → false
  it('returns false when an end marker line is present', () => {
    expect(isEffectivelyEmpty('#!/bin/sh\n# <<< codegraph auto-init hook <<<')).toBe(false);
  });

  // U9: shebang + both marker lines → false
  it('returns false when shebang is present alongside marker lines', () => {
    const content = [
      '#!/bin/sh',
      '# >>> codegraph sync hook >>>',
      '# <<< codegraph sync hook <<<',
    ].join('\n');
    expect(isEffectivelyEmpty(content)).toBe(false);
  });
});

describe('chmodExecutable', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `hook-utils-chmod-${Date.now()}`);
  });

  afterEach(() => {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  // U10: sets executable bit on POSIX
  it('sets 0o755 executable bit on POSIX', () => {
    if (process.platform === 'win32') return;
    fs.writeFileSync(tmp, '#!/bin/sh\n', { mode: 0o644 });
    chmodExecutable(tmp);
    expect(fs.statSync(tmp).mode & 0o111).not.toBe(0);
  });

  // U11: no throw when file does not exist
  it('does not throw when the file does not exist', () => {
    expect(() => chmodExecutable('/nonexistent/path/file.sh')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run __tests__/hook-utils.test.ts
```

Expected: all tests **FAIL** with `Cannot find module '../src/sync/hook-utils'`.

- [ ] **Step 3: Implement `src/sync/hook-utils.ts`**

Create `src/sync/hook-utils.ts`:

```typescript
import * as fs from 'fs';

/**
 * Remove the block delimited by `begin` and `end` (inclusive) from `content`.
 * Idempotent. When `begin` is present but `end` is absent, strips from `begin`
 * to end-of-string (preserves compatibility with legacy partial writes).
 * When `end` is present but `begin` is absent, returns content unchanged.
 */
export function stripMarkerBlock(content: string, begin: string, end: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let inBlock = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === begin) { inBlock = true; continue; }
    if (trimmed === end)   { inBlock = false; continue; }
    if (!inBlock) kept.push(line);
  }
  return kept.join('\n');
}

/**
 * Returns true iff every line in `content` is blank or a shebang (`#!` prefix).
 * Call AFTER stripMarkerBlock — marker lines are not "empty" and return false,
 * guarding against incorrect file deletion when a strip was skipped.
 */
export function isEffectivelyEmpty(content: string): boolean {
  return content
    .split('\n')
    .map((l) => l.trim())
    .every((l) => l.length === 0 || l.startsWith('#!'));
}

/** Sets the executable bit (0o755) on `file`. No-op when chmod is unsupported. */
export function chmodExecutable(file: string): void {
  try {
    fs.chmodSync(file, 0o755);
  } catch {
    /* no-op on Windows or when file does not exist */
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/hook-utils.test.ts
```

Expected: **11 tests pass**, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/sync/hook-utils.ts __tests__/hook-utils.test.ts
git commit -m "$(cat <<'EOF'
feat(hook-utils): extract shared hook primitive functions

stripMarkerBlock, isEffectivelyEmpty, and chmodExecutable were
duplicated in git-hooks.ts. Extracting them here lets global-hooks.ts
reuse the same logic without copy-pasting, and pins their contracts
with 11 explicit unit tests.
EOF
)"
```

---

## Task 2: Refactor `src/sync/git-hooks.ts` to import from hook-utils

**Files:**
- Modify: `src/sync/git-hooks.ts`

- [ ] **Step 1: Replace local function definitions with imports**

Open `src/sync/git-hooks.ts`. Make the following changes:

**Add import** at the top (after the existing `import { execFileSync }` line):

```typescript
import { stripMarkerBlock, isEffectivelyEmpty, chmodExecutable } from './hook-utils';
```

**Remove** these three function definitions entirely (lines ~86–114):

```typescript
/** Remove our marker block (and the marker lines) from hook content. */
function stripMarkerBlock(content: string): string {
  const lines = content.split('\n');
  ...
}

/** Whether a hook body is just a shebang / blank lines (i.e. only ever ours). */
function isEffectivelyEmpty(content: string): boolean {
  ...
}

function chmodExecutable(file: string): void {
  ...
}
```

**Update the two call sites** that pass no marker args (the new signature requires them):

In `installGitSyncHook` (~line 145):
```typescript
// Before:
const base = stripMarkerBlock(fs.readFileSync(file, 'utf8')).replace(/\s*$/, '');
// After:
const base = stripMarkerBlock(fs.readFileSync(file, 'utf8'), MARKER_BEGIN, MARKER_END).replace(/\s*$/, '');
```

In `removeGitSyncHook` (~line 184):
```typescript
// Before:
const stripped = stripMarkerBlock(original);
// After:
const stripped = stripMarkerBlock(original, MARKER_BEGIN, MARKER_END);
```

- [ ] **Step 2: Run existing git-hooks tests — verify all 7 still pass**

```bash
npx vitest run __tests__/git-hooks.test.ts
```

Expected: **7 tests pass**, 0 failures. Any failure means an import or call-site was missed.

- [ ] **Step 3: Commit**

```bash
git add src/sync/git-hooks.ts
git commit -m "refactor(sync): import hook-utils in git-hooks"
```

---

## Task 3: Create `src/sync/global-hooks.ts` with tests G1–G20

**Files:**
- Create: `src/sync/global-hooks.ts`
- Create: `__tests__/global-hooks.test.ts`

- [ ] **Step 1: Write all failing tests (G1–G20)**

Create `__tests__/global-hooks.test.ts`:

```typescript
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

// Each test gets an isolated temp dir and a temp gitconfig so we never
// touch the real ~/.gitconfig.
let tempDir: string;
let templateDir: string;
let origGitConfigGlobal: string | undefined;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-global-hooks-'));
  templateDir = path.join(tempDir, 'templates');
  fs.mkdirSync(path.join(templateDir, 'hooks'), { recursive: true });

  origGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = path.join(tempDir, '.gitconfig');

  // Pre-configure init.templateDir so tests control the target path.
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
  // G1: init.templateDir already set → return it, do not overwrite
  it('G1: returns configured templateDir and does not overwrite git config', () => {
    const result = resolveTemplateDir();
    expect(result.dir).toBe(templateDir);
    expect(result.configWasSet).toBe(false);
    // Config still equals templateDir
    const after = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    expect(after).toBe(templateDir);
  });

  // G2: not set → returns ~/.git-templates, sets git config
  it('G2: defaults to ~/.git-templates and writes git config when not set', () => {
    // Use a fresh gitconfig with no init.templateDir and a temp HOME
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
  // G3: fresh install — creates file with shebang + block, executable
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

  // G4: hook contains command -v guard
  it('G4: hook script is guarded by command -v codegraph check', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      'if command -v codegraph >/dev/null 2>&1'
    );
  });

  // G5: hook contains [ ! -d .codegraph ] branch
  it('G5: hook script checks for absence of .codegraph directory', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain('[ ! -d .codegraph ]');
  });

  // G6: init branch contains codegraph init . and codegraph index
  it('G6: init branch runs codegraph init . and codegraph index', () => {
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('codegraph init . >/dev/null 2>&1');
    expect(body).toContain('codegraph index >/dev/null 2>&1');
  });

  // G7: init branch appends .codegraph/ to .gitignore idempotently
  it('G7: init branch appends .codegraph/ to .gitignore using grep -qxF guard', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      "grep -qxF '.codegraph/' .gitignore 2>/dev/null || echo '.codegraph/' >> .gitignore"
    );
  });

  // G8: sync branch runs codegraph sync in background
  it('G8: sync branch runs codegraph sync in background and suppresses output', () => {
    installGlobalAutoInitHook();
    expect(fs.readFileSync(hookFile(), 'utf8')).toContain(
      '( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1'
    );
  });

  // G9: idempotent — re-run produces exactly one marker block
  it('G9: re-running install does not duplicate the marker block', () => {
    installGlobalAutoInitHook();
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    const count = body.split('# >>> codegraph auto-init hook >>>').length - 1;
    expect(count).toBe(1);
  });

  // G10: preserves pre-existing user hook content
  it('G10: appends block after existing user hook content', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "my custom hook"\n', { mode: 0o755 });
    installGlobalAutoInitHook();
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('echo "my custom hook"');
    expect(body).toContain('# >>> codegraph auto-init hook >>>');
  });

  // G11: returns status 'installed' and correct templateDir
  it('G11: returns status installed and the resolved templateDir', () => {
    const result = installGlobalAutoInitHook();
    expect(result.status).toBe('installed');
    expect(result.templateDir).toBe(templateDir);
  });

  // G12: already installed with byte-identical block → status unchanged, no write
  it('G12: returns unchanged and does not rewrite file when block is already current', () => {
    installGlobalAutoInitHook();
    const mtimeBefore = fs.statSync(hookFile()).mtimeMs;
    // Small delay to ensure mtime would differ if file were rewritten
    const result = installGlobalAutoInitHook();
    expect(result.status).toBe('unchanged');
    expect(fs.statSync(hookFile()).mtimeMs).toBe(mtimeBefore);
  });

  // G19: creates <templateDir>/hooks/ when it does not exist
  it('G19: creates hooks directory if it does not exist', () => {
    const freshTemplateDir = path.join(tempDir, 'fresh-templates');
    execFileSync('git', ['config', '--global', 'init.templateDir', freshTemplateDir], {
      stdio: 'ignore',
    });
    expect(fs.existsSync(path.join(freshTemplateDir, 'hooks'))).toBe(false);
    installGlobalAutoInitHook();
    expect(fs.existsSync(path.join(freshTemplateDir, 'hooks', 'post-checkout'))).toBe(true);
  });

  // G20: uses existing init.templateDir without changing config
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
  // G13: strips block, deletes file when only ours
  it('G13: deletes the hook file when our block was the only content', () => {
    installGlobalAutoInitHook();
    const result = removeGlobalAutoInitHook();
    expect(result.status).toBe('removed');
    expect(fs.existsSync(hookFile())).toBe(false);
  });

  // G14: keeps user content when hook is shared
  it('G14: preserves user content and rewrites file without our block', () => {
    fs.writeFileSync(hookFile(), '#!/bin/sh\necho "keep me"\n', { mode: 0o755 });
    installGlobalAutoInitHook();
    removeGlobalAutoInitHook();
    expect(fs.existsSync(hookFile())).toBe(true);
    const body = fs.readFileSync(hookFile(), 'utf8');
    expect(body).toContain('echo "keep me"');
    expect(body).not.toContain('# >>> codegraph auto-init hook >>>');
  });

  // G15: not installed → status skipped
  it('G15: returns skipped when no block is present', () => {
    const result = removeGlobalAutoInitHook();
    expect(result.status).toBe('skipped');
    expect(result.reason).toBeDefined();
  });

  // G16: never modifies git config init.templateDir
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
  // G17: returns true when installed
  it('G17: returns true after install', () => {
    installGlobalAutoInitHook();
    expect(isGlobalAutoInitHookInstalled()).toBe(true);
  });

  // G18: returns false when not installed
  it('G18: returns false when hook file does not contain our block', () => {
    expect(isGlobalAutoInitHookInstalled()).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run __tests__/global-hooks.test.ts
```

Expected: all tests **FAIL** with `Cannot find module '../src/sync/global-hooks'`.

- [ ] **Step 3: Implement `src/sync/global-hooks.ts`**

Create `src/sync/global-hooks.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { stripMarkerBlock, isEffectivelyEmpty, chmodExecutable } from './hook-utils';

const MARKER_BEGIN = '# >>> codegraph auto-init hook >>>';
const MARKER_END   = '# <<< codegraph auto-init hook <<<';

export interface GlobalHookResult {
  templateDir: string;
  status: 'installed' | 'removed' | 'unchanged' | 'skipped';
  /** True when this call wrote git config init.templateDir for the first time. */
  configWasSet: boolean;
  reason?: string;
}

/** The shell snippet injected between markers into the template post-checkout hook. */
function autoInitBlock(): string {
  return [
    MARKER_BEGIN,
    '# Auto-initializes CodeGraph in newly cloned repos.',
    '# Managed by codegraph; remove with: codegraph auto-init-repos --remove',
    'if command -v codegraph >/dev/null 2>&1; then',
    '  if [ ! -d .codegraph ]; then',
    '    codegraph init . >/dev/null 2>&1',
    '    codegraph index >/dev/null 2>&1',
    "    grep -qxF '.codegraph/' .gitignore 2>/dev/null || echo '.codegraph/' >> .gitignore",
    '  else',
    '    ( codegraph sync >/dev/null 2>&1 & ) >/dev/null 2>&1',
    '  fi',
    'fi',
    MARKER_END,
  ].join('\n');
}

/**
 * Resolve (and optionally write) the git template directory.
 *
 * When `writeConfig` is true (default) and `init.templateDir` is not set,
 * defaults to `~/.git-templates` and writes it to git global config so
 * future `git clone`/`git init` operations pick it up.
 *
 * Always creates `<templateDir>/hooks/` if it does not exist.
 */
export function resolveTemplateDir(opts: { writeConfig?: boolean } = {}): {
  dir: string;
  configWasSet: boolean;
} {
  const writeConfig = opts.writeConfig !== false; // default true
  let dir: string;
  let configWasSet = false;

  try {
    const raw = execFileSync('git', ['config', '--global', 'init.templateDir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    dir = raw.replace(/^~/, os.homedir());
  } catch {
    dir = path.join(os.homedir(), '.git-templates');
    if (writeConfig) {
      execFileSync('git', ['config', '--global', 'init.templateDir', dir], {
        stdio: 'ignore',
      });
      configWasSet = true;
    }
  }

  fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  return { dir, configWasSet };
}

/**
 * Install (or update) the CodeGraph auto-init hook in the git template directory.
 * Idempotent: re-running replaces our block rather than duplicating it.
 * Pre-existing user hook content is preserved.
 */
export function installGlobalAutoInitHook(): GlobalHookResult {
  const { dir: templateDir, configWasSet } = resolveTemplateDir();
  const hookPath = path.join(templateDir, 'hooks', 'post-checkout');
  const block = autoInitBlock();

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    const stripped = stripMarkerBlock(existing, MARKER_BEGIN, MARKER_END).replace(/\s*$/, '');
    const newContent = stripped.length > 0
      ? `${stripped}\n\n${block}\n`
      : `#!/bin/sh\n${block}\n`;

    if (existing === newContent) {
      return { templateDir, status: 'unchanged', configWasSet };
    }

    fs.writeFileSync(hookPath, newContent);
    chmodExecutable(hookPath);
    return { templateDir, status: 'installed', configWasSet };
  }

  fs.writeFileSync(hookPath, `#!/bin/sh\n${block}\n`);
  chmodExecutable(hookPath);
  return { templateDir, status: 'installed', configWasSet };
}

/**
 * Remove the CodeGraph auto-init block from the template post-checkout hook.
 * Strips only our marker block; deletes the file if nothing meaningful remains.
 * Never modifies git config.
 */
export function removeGlobalAutoInitHook(): GlobalHookResult {
  const { dir: templateDir } = resolveTemplateDir({ writeConfig: false });
  const hookPath = path.join(templateDir, 'hooks', 'post-checkout');

  if (!fs.existsSync(hookPath)) {
    return {
      templateDir,
      status: 'skipped',
      configWasSet: false,
      reason: 'hook file does not exist',
    };
  }

  const original = fs.readFileSync(hookPath, 'utf8');
  if (!original.includes(MARKER_BEGIN)) {
    return {
      templateDir,
      status: 'skipped',
      configWasSet: false,
      reason: 'no codegraph auto-init block found',
    };
  }

  const stripped = stripMarkerBlock(original, MARKER_BEGIN, MARKER_END);
  if (isEffectivelyEmpty(stripped)) {
    fs.unlinkSync(hookPath);
  } else {
    fs.writeFileSync(hookPath, `${stripped.replace(/\s*$/, '')}\n`);
    chmodExecutable(hookPath);
  }

  return { templateDir, status: 'removed', configWasSet: false };
}

/** Returns true when the template post-checkout hook contains our auto-init block. */
export function isGlobalAutoInitHookInstalled(): boolean {
  try {
    const { dir } = resolveTemplateDir({ writeConfig: false });
    const hookPath = path.join(dir, 'hooks', 'post-checkout');
    return fs.existsSync(hookPath) && fs.readFileSync(hookPath, 'utf8').includes(MARKER_BEGIN);
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/global-hooks.test.ts
```

Expected: **20 tests pass**, 0 failures.

- [ ] **Step 5: Run full test suite — verify nothing regressed**

```bash
npm test
```

Expected: all existing tests still pass.

- [ ] **Step 6: Commit**

```bash
git add src/sync/global-hooks.ts __tests__/global-hooks.test.ts
git commit -m "$(cat <<'EOF'
feat(global-hooks): add auto-init template hook install/remove

Installs a post-checkout snippet into the git template directory so
every new git clone automatically runs codegraph init + index. Uses
the same marker-block pattern as the per-repo sync hooks, with full
idempotency and surgical remove that preserves user hook content.
EOF
)"
```

---

## Task 4: Create `src/bin/auto-init-repos-action.ts` with CLI tests C1–C12

**Files:**
- Create: `src/bin/auto-init-repos-action.ts`
- Create: `__tests__/auto-init-repos-cli.test.ts`

- [ ] **Step 1: Write all failing tests (C1–C12)**

Create `__tests__/auto-init-repos-cli.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock global-hooks before importing the action so vi.mock hoists correctly.
vi.mock('../src/sync/global-hooks', () => ({
  installGlobalAutoInitHook: vi.fn(),
  removeGlobalAutoInitHook: vi.fn(),
}));

import { autoInitReposAction } from '../src/bin/auto-init-repos-action';
import {
  installGlobalAutoInitHook,
  removeGlobalAutoInitHook,
} from '../src/sync/global-hooks';

const mockInstall = vi.mocked(installGlobalAutoInitHook);
const mockRemove  = vi.mocked(removeGlobalAutoInitHook);

// Capture clack output via the injected mock.
function makeClack() {
  const calls: string[] = [];
  return {
    intro:  vi.fn(),
    outro:  vi.fn(),
    log: {
      success: vi.fn((msg: string) => calls.push(msg)),
      info:    vi.fn((msg: string) => calls.push(msg)),
      warn:    vi.fn((msg: string) => calls.push(msg)),
      error:   vi.fn((msg: string) => calls.push(msg)),
    },
    _calls: calls,
  };
}

type MockClack = ReturnType<typeof makeClack>;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // Restore process.exitCode after each test
  process.exitCode = undefined;
});

describe('autoInitReposAction — install path', () => {
  // C1: no --remove → calls installGlobalAutoInitHook
  it('C1: calls installGlobalAutoInitHook when remove is not set', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(mockInstall).toHaveBeenCalledOnce();
    expect(mockRemove).not.toHaveBeenCalled();
  });

  // C3: install success → output contains templateDir
  it('C3: logs the resolved templateDir on successful install', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toContain('/tmp/t');
  });

  // C4: configWasSet true → output contains 'init.templateDir set'
  it('C4: logs that init.templateDir was set when configWasSet is true', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: true });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/init\.templateDir set/i);
  });

  // C5: configWasSet false → output contains 'already set' or 'already configured'
  it('C5: logs that init.templateDir was already configured when configWasSet is false', async () => {
    mockInstall.mockReturnValue({ status: 'installed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/already (set|configured)/i);
  });

  // C6: status unchanged → output contains 'Already installed' and templateDir
  it('C6: logs Already installed with templateDir when status is unchanged', async () => {
    mockInstall.mockReturnValue({ status: 'unchanged', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({}, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/already installed/i);
    expect(allOutput).toContain('/tmp/t');
  });

  // C7: status unchanged → exits 0 (no process.exit(1))
  it('C7: does not set exit code to 1 when status is unchanged', async () => {
    mockInstall.mockReturnValue({ status: 'unchanged', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await autoInitReposAction({}, clack as unknown as MockClack);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('autoInitReposAction — remove path', () => {
  // C2: --remove → calls removeGlobalAutoInitHook, not install
  it('C2: calls removeGlobalAutoInitHook when remove is true', async () => {
    mockRemove.mockReturnValue({ status: 'removed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    expect(mockRemove).toHaveBeenCalledOnce();
    expect(mockInstall).not.toHaveBeenCalled();
  });

  // C8: remove success → output contains templateDir and note about init.templateDir
  it('C8: logs templateDir and git config note on successful remove', async () => {
    mockRemove.mockReturnValue({ status: 'removed', templateDir: '/tmp/t', configWasSet: false });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toContain('/tmp/t');
    expect(allOutput).toMatch(/init\.templateDir was not modified/i);
  });

  // C9: status skipped → output contains 'No codegraph auto-init hook found' and templateDir
  it('C9: logs hook-not-found message with templateDir when status is skipped', async () => {
    mockRemove.mockReturnValue({
      status: 'skipped',
      templateDir: '/tmp/t',
      configWasSet: false,
      reason: 'no block found',
    });
    const clack = makeClack();
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    const allOutput = clack._calls.join(' ');
    expect(allOutput).toMatch(/no codegraph auto-init hook found/i);
    expect(allOutput).toContain('/tmp/t');
  });

  // C10: status skipped → exits 0
  it('C10: does not set exit code to 1 when status is skipped', async () => {
    mockRemove.mockReturnValue({
      status: 'skipped', templateDir: '/tmp/t', configWasSet: false,
    });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await autoInitReposAction({ remove: true }, clack as unknown as MockClack);
    expect(exitSpy).not.toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});

describe('autoInitReposAction — error handling', () => {
  // C11: install throws → process.exit(1) called
  it('C11: calls process.exit(1) when installGlobalAutoInitHook throws', async () => {
    mockInstall.mockImplementation(() => { throw new Error('write failed'); });
    const clack = makeClack();
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(autoInitReposAction({}, clack as unknown as MockClack)).rejects.toThrow('exit');
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  // C12: install throws → clack.log.error called with error message
  it('C12: logs error message via clack.log.error when installGlobalAutoInitHook throws', async () => {
    mockInstall.mockImplementation(() => { throw new Error('write failed'); });
    const clack = makeClack();
    vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    await expect(autoInitReposAction({}, clack as unknown as MockClack)).rejects.toThrow('exit');
    expect(clack.log.error).toHaveBeenCalledWith(expect.stringContaining('write failed'));
    vi.restoreAllMocks();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

```bash
npx vitest run __tests__/auto-init-repos-cli.test.ts
```

Expected: all tests **FAIL** with `Cannot find module '../src/bin/auto-init-repos-action'`.

- [ ] **Step 3: Implement `src/bin/auto-init-repos-action.ts`**

Create `src/bin/auto-init-repos-action.ts`:

```typescript
import {
  installGlobalAutoInitHook,
  removeGlobalAutoInitHook,
} from '../sync/global-hooks';

// Clack is injected so the handler is testable without ESM dynamic import
// complexity. codegraph.ts loads clack once and passes it through.
type ClackModule = typeof import('@clack/prompts');

export async function autoInitReposAction(
  options: { remove?: boolean },
  clack: ClackModule,
): Promise<void> {
  clack.intro('CodeGraph auto-init');

  try {
    if (options.remove) {
      const result = removeGlobalAutoInitHook();

      if (result.status === 'skipped') {
        clack.log.info(
          `No codegraph auto-init hook found in ${result.templateDir}`
        );
      } else {
        clack.log.success(
          `Removed auto-init hook from ${result.templateDir}/hooks/post-checkout`
        );
        clack.log.info('Note: git config init.templateDir was not modified.');
      }
    } else {
      const result = installGlobalAutoInitHook();

      if (result.status === 'unchanged') {
        clack.log.success(`Already installed in ${result.templateDir}`);
      } else {
        clack.log.success(`Template dir: ${result.templateDir}`);

        if (result.configWasSet) {
          clack.log.success('git config init.templateDir set');
        } else {
          clack.log.info(
            `git config init.templateDir already configured — using ${result.templateDir}`
          );
        }

        clack.log.success('post-checkout hook installed');
        clack.outro(
          'Every new git clone will auto-initialize and index CodeGraph.\n' +
          '   Run `codegraph auto-init-repos --remove` to undo.'
        );
        return;
      }
    }
  } catch (err) {
    clack.log.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
    return;
  }

  clack.outro('');
}
```

- [ ] **Step 4: Run tests — verify they pass**

```bash
npx vitest run __tests__/auto-init-repos-cli.test.ts
```

Expected: **12 tests pass**, 0 failures.

- [ ] **Step 5: Commit**

```bash
git add src/bin/auto-init-repos-action.ts __tests__/auto-init-repos-cli.test.ts
git commit -m "$(cat <<'EOF'
feat(auto-init): add action handler and CLI unit tests

Extracts the auto-init-repos command handler into its own module so
tests can import it directly and mock global-hooks without spawning a
subprocess. Clack is injected via parameter to avoid ESM dynamic
import issues in the test environment.
EOF
)"
```

---

## Task 5: Wire the CLI command into `src/bin/codegraph.ts`

**Files:**
- Modify: `src/bin/codegraph.ts`

- [ ] **Step 1: Add the `auto-init-repos` command**

In `src/bin/codegraph.ts`, locate the line `program.parse();` at the bottom (line ~1402).
Add the following block **immediately before** `program.parse();`:

```typescript
/**
 * codegraph auto-init-repos [--remove]
 */
program
  .command('auto-init-repos')
  .description('Install (or remove) a global git template hook that auto-initializes CodeGraph in every new git clone')
  .option('--remove', 'Remove the auto-init hook from the git template directory')
  .action(async (opts: { remove?: boolean }) => {
    const clack = await importESM('@clack/prompts');
    const { autoInitReposAction } = await import('./auto-init-repos-action');
    await autoInitReposAction(opts, clack);
  });
```

- [ ] **Step 2: Build the project**

```bash
npm run build
```

Expected: **build succeeds** with no TypeScript errors.

- [ ] **Step 3: Smoke test — install**

```bash
node dist/bin/codegraph.js auto-init-repos
```

Expected output (approximate):
```
◆  CodeGraph auto-init
✔  Template dir: ~/.git-templates  (created or already existed)
✔  git config init.templateDir set  (or: already configured)
✔  post-checkout hook installed
◇  Every new git clone will auto-initialize and index CodeGraph.
   Run `codegraph auto-init-repos --remove` to undo.
```

- [ ] **Step 4: Smoke test — idempotent re-run**

```bash
node dist/bin/codegraph.js auto-init-repos
```

Expected output:
```
◆  CodeGraph auto-init
✔  Already installed in <templateDir>
```

- [ ] **Step 5: Smoke test — remove**

```bash
node dist/bin/codegraph.js auto-init-repos --remove
```

Expected output:
```
◆  CodeGraph auto-init
✔  Removed auto-init hook from <templateDir>/hooks/post-checkout
ℹ  Note: git config init.templateDir was not modified.
```

- [ ] **Step 6: Run full test suite — all 53 tests pass**

```bash
npm test
```

Expected: **53 tests pass** (14 hook-utils + 7 git-hooks + 20 global-hooks + 12 CLI), 0 failures.

- [ ] **Step 7: Commit**

```bash
git add src/bin/codegraph.ts
git commit -m "feat(cli): register auto-init-repos command"
```

---

## Self-Review

**Spec coverage check:**

| Spec section | Task covering it |
|---|---|
| REQ-HU-01–13 (hook-utils) | Task 1 |
| REQ-GH-01–02 (git-hooks refactor) | Task 2 |
| REQ-GL-01–26 (global-hooks) | Task 3 |
| REQ-CLI-00–10 (action handler) | Task 4 |
| CLI registration, build, smoke test | Task 5 |

All 53 test IDs (U1–U11, G1–G20, C1–C12, 7 existing git-hooks) covered. No gaps.

**Placeholder scan:** No TBDs, no "implement later", all steps contain actual code.

**Type consistency check:**
- `GlobalHookResult.configWasSet: boolean` — defined in Task 3 `src/sync/global-hooks.ts`, used in Task 4 tests (`configWasSet: true/false` in mock return values). ✓
- `resolveTemplateDir(opts?)` — defined in Task 3, called with `{ writeConfig: false }` inside `removeGlobalAutoInitHook` and `isGlobalAutoInitHookInstalled`. ✓
- `autoInitReposAction(options, clack)` — defined in Task 4, called in Task 5 with `(opts, clack)`. ✓
- `stripMarkerBlock(content, begin, end)` — defined in Task 1, call sites in Task 2 updated to pass `MARKER_BEGIN, MARKER_END`. ✓
