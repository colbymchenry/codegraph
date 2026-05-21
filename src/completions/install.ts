/**
 * Detects the best install location for each shell, given the running
 * environment, and writes the generated script there. The detection
 * priorities are deliberate — the goal is "Tab works after install,
 * with zero follow-up config" wherever possible.
 *
 * Why per-shell tiers (not a single fixed path):
 *   - On zsh, ~/.zsh/completions isn't on $fpath by default, so the
 *     naive "drop a file there" install requires the user to edit
 *     ~/.zshrc. We can avoid that entirely by detecting oh-my-zsh
 *     (always on $fpath via $ZSH/completions) or Homebrew zsh (on
 *     $fpath via `brew shellenv`) and using those when present.
 *   - On bash, Homebrew bash-completion@2 lives at a different path
 *     than the Linux XDG convention.
 *   - On PowerShell, there is no completions directory at all — only
 *     $PROFILE dot-sourcing works. The install writes a standalone
 *     .ps1 next to $PROFILE and idempotently appends a dot-source line.
 *
 * Detection is best-effort and conservative: every tier checks that
 * its target is writable before committing. The final fallback always
 * returns *something* on a recognized platform; only obscure setups
 * (e.g., codegraph on Windows targeting bash) return null.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Shell } from './index';

export interface InstallTarget {
  /** Absolute path the script will be written to. */
  path: string;
  /** Which detection rule picked this path (used in messages). */
  source:
    | 'oh-my-zsh'
    | 'zsh-site-functions'
    | 'homebrew-bash-completion'
    | 'xdg-bash-completion'
    | 'fish-config'
    | 'pwsh-profile-dir'
    | 'zsh-fallback';
  /** Human-readable explanation of how to make the install effective if needed. */
  postInstallHint?: string;
  /**
   * For PowerShell: append this line to $PROFILE to load the script.
   * The installer handles the append idempotently; this is also surfaced
   * in messages for transparency.
   */
  profileLine?: string;
  /**
   * Path to the PowerShell $PROFILE file that needs the dot-source line.
   * Null if we couldn't determine it (e.g., pwsh not in PATH on this OS).
   */
  profilePath?: string;
}

export interface InstallResult {
  target: InstallTarget;
  /** True if we appended to $PROFILE; false if it was already wired up. */
  profileUpdated?: boolean;
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

const isWritableDir = (dir: string): boolean => {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    const st = fs.statSync(dir);
    return st.isDirectory();
  } catch {
    return false;
  }
};

const canCreateIn = (dir: string): boolean => {
  // Walk up to the first existing ancestor; if it's writable, we can
  // mkdir -p. Returns false if no ancestor is writable.
  let cur = dir;
  while (cur && cur !== path.dirname(cur)) {
    if (fs.existsSync(cur)) return isWritableDir(cur);
    cur = path.dirname(cur);
  }
  return false;
};

// ─────────────────────────────────────────────────────────────────────
// Per-shell detection
// ─────────────────────────────────────────────────────────────────────

const detectZsh = (env: NodeJS.ProcessEnv, home: string): InstallTarget => {
  // Tier 1: oh-my-zsh. $ZSH points at the oh-my-zsh install dir and
  // $ZSH/completions is always on $fpath via oh-my-zsh's bootstrap.
  // No .zshrc edit needed — true zero-config install.
  const zshDir = env.ZSH;
  if (zshDir && fs.existsSync(zshDir) && isWritableDir(zshDir)) {
    const target = path.join(zshDir, 'completions', '_codegraph');
    if (canCreateIn(path.dirname(target))) {
      return { path: target, source: 'oh-my-zsh' };
    }
  }

  // Tier 2: `<prefix>/share/zsh/site-functions`. Apple Silicon Homebrew
  // is /opt/homebrew, Intel Homebrew + most Linux distros use /usr/local.
  // Homebrew puts this on $fpath via `brew shellenv`; zsh adds /usr/local
  // to its default $fpath at compile time on most Linux builds. If the
  // dir exists and is writable, the install is zero-config.
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    const dir = path.join(prefix, 'share', 'zsh', 'site-functions');
    if (isWritableDir(dir)) {
      return { path: path.join(dir, '_codegraph'), source: 'zsh-site-functions' };
    }
  }

  // Tier 3: ~/.zsh/completions fallback. Not on default $fpath; print
  // the .zshrc snippet so users can wire it up.
  return {
    path: path.join(home, '.zsh', 'completions', '_codegraph'),
    source: 'zsh-fallback',
    postInstallHint:
      '~/.zsh/completions is not on your $fpath by default.\n' +
      'Add to ~/.zshrc (before `compinit`):\n' +
      '  fpath=(~/.zsh/completions $fpath)\n' +
      '  autoload -Uz compinit && compinit',
  };
};

const detectBash = (home: string): InstallTarget | null => {
  // macOS Homebrew bash-completion@2 lives at $(brew --prefix)/etc/
  // bash_completion.d/. If that dir exists and is writable, use it —
  // bash-completion auto-loads from there with no further config.
  for (const prefix of ['/opt/homebrew', '/usr/local']) {
    const dir = path.join(prefix, 'etc', 'bash_completion.d');
    if (isWritableDir(dir)) {
      return { path: path.join(dir, 'codegraph'), source: 'homebrew-bash-completion' };
    }
  }

  // XDG user-local path that bash-completion v2 auto-loads. Works on
  // Linux + macOS-without-Homebrew, provided bash-completion is
  // installed (we can't check this from Node, so just print a hint).
  const xdg =
    process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share');
  const target = path.join(xdg, 'bash-completion', 'completions', 'codegraph');
  // canCreateIn lets us return this path even if the directory doesn't
  // yet exist — mkdir -p handles creation. The check guards against
  // permission failures (e.g., XDG_DATA_HOME pointing at a read-only path).
  if (canCreateIn(path.dirname(target))) {
    return {
      path: target,
      source: 'xdg-bash-completion',
      postInstallHint:
        'Requires the `bash-completion` package. On macOS install via\n' +
        '  brew install bash-completion@2\n' +
        'and follow the post-install steps to source it from your bashrc.',
    };
  }
  return null;
};

const detectFish = (home: string): InstallTarget => ({
  path: path.join(home, '.config', 'fish', 'completions', 'codegraph.fish'),
  source: 'fish-config',
});

const detectPowershell = (env: NodeJS.ProcessEnv, home: string): InstallTarget | null => {
  // PowerShell has no completions directory. The convention is to keep
  // a standalone .ps1 and dot-source it from $PROFILE.
  //
  // We can't run pwsh to read $PROFILE (it may not be on PATH); use the
  // documented per-OS default that pwsh itself uses on first launch.
  //
  // Windows pwsh 7: ~/Documents/PowerShell/Microsoft.PowerShell_profile.ps1
  // Windows PS 5.1: ~/Documents/WindowsPowerShell/...
  // macOS/Linux pwsh: ~/.config/powershell/Microsoft.PowerShell_profile.ps1
  let profileDir: string;
  if (process.platform === 'win32') {
    // Prefer pwsh 7 path. PS 5.1 users have to install manually — they
    // can still source the .ps1 by hand if our chosen profile path
    // doesn't match.
    profileDir = path.join(home, 'Documents', 'PowerShell');
  } else {
    profileDir = path.join(home, '.config', 'powershell');
  }
  // We need at least to be able to create the dir — pwsh creates it
  // on first run, but if we're installing without pwsh ever having run,
  // the parent of profileDir must exist and be writable.
  if (!canCreateIn(profileDir)) return null;

  const scriptPath = path.join(profileDir, 'codegraph.ps1');
  const profilePath = path.join(profileDir, 'Microsoft.PowerShell_profile.ps1');
  // The exact line we append to $PROFILE. The leading marker comment
  // is used by the installer to detect "already wired up" and skip
  // re-appending on repeat runs.
  const profileLine = `. '${scriptPath}'  # codegraph completions`;
  void env;
  return {
    path: scriptPath,
    source: 'pwsh-profile-dir',
    profilePath,
    profileLine,
    postInstallHint:
      `Dot-sourced from $PROFILE on next pwsh launch.\n` +
      `If your $PROFILE is somewhere else, add manually:\n  ${profileLine}`,
  };
};

// ─────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────

export const detectInstallTarget = (
  shell: Shell,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): InstallTarget | null => {
  switch (shell) {
    case 'zsh':
      return detectZsh(env, home);
    case 'bash':
      return detectBash(home);
    case 'fish':
      return detectFish(home);
    case 'powershell':
      return detectPowershell(env, home);
  }
};

export const installCompletions = (shell: Shell, script: string): InstallResult | null => {
  const target = detectInstallTarget(shell);
  if (!target) return null;

  fs.mkdirSync(path.dirname(target.path), { recursive: true });
  fs.writeFileSync(target.path, script, 'utf8');

  // PowerShell: idempotently append a dot-source line to $PROFILE so
  // the registration actually fires in new pwsh sessions. If the line
  // is already there (substring match on the marker comment), skip.
  let profileUpdated: boolean | undefined;
  if (shell === 'powershell' && target.profilePath && target.profileLine) {
    const marker = '# codegraph completions';
    const existing = fs.existsSync(target.profilePath)
      ? fs.readFileSync(target.profilePath, 'utf8')
      : '';
    if (existing.includes(marker)) {
      profileUpdated = false;
    } else {
      fs.mkdirSync(path.dirname(target.profilePath), { recursive: true });
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(target.profilePath, `${prefix}${target.profileLine}\n`);
      profileUpdated = true;
    }
  }

  return { target, profileUpdated };
};
