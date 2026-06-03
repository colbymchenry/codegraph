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
    '# $3 is 1 for branch checkout, 0 for file checkout — skip file-level checkouts',
    '[ "$3" = "1" ] || exit 0',
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
 * When writeConfig is true (default) and init.templateDir is not set,
 * defaults to ~/.git-templates and writes it to git global config so
 * future git clone/git init operations pick it up.
 *
 * Creates <templateDir>/hooks/ when writeConfig is true (install path only).
 */
export function resolveTemplateDir(opts: { writeConfig?: boolean } = {}): {
  dir: string;
  configWasSet: boolean;
} {
  const writeConfig = opts.writeConfig !== false;
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

  if (writeConfig) {
    fs.mkdirSync(path.join(dir, 'hooks'), { recursive: true });
  }
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
    // Treat as empty when only a shebang remains after stripping our block
    const hasUserContent = stripped.length > 0 && !isEffectivelyEmpty(stripped);
    const newContent = hasUserContent
      ? `${stripped}\n\n${block}\n`
      : `#!/bin/sh\n${block}\n`;

    if (existing.replace(/\s*$/, '') === newContent.replace(/\s*$/, '')) {
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
