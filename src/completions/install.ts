/**
 * Writes a generated completion script to the standard per-shell
 * location. Paths match what sema-lisp and fedit use so users with
 * existing fpath/bash-completion config don't need new configuration.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Shell } from './index';

export const installPathFor = (shell: Shell): string => {
  const home = os.homedir();
  switch (shell) {
    case 'zsh':
      return path.join(home, '.zsh', 'completions', '_codegraph');
    case 'bash':
      return path.join(home, '.local', 'share', 'bash-completion', 'completions', 'codegraph');
    case 'fish':
      return path.join(home, '.config', 'fish', 'completions', 'codegraph.fish');
  }
};

export interface InstallResult {
  path: string;
  postInstallHint?: string;
}

export const installCompletions = (shell: Shell, script: string): InstallResult => {
  const target = installPathFor(shell);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, script, 'utf8');

  let postInstallHint: string | undefined;
  if (shell === 'zsh') {
    // ~/.zsh/completions isn't on `$fpath` by default, so first-time
    // users would install the script and see no completions. Tell them.
    postInstallHint =
      'Add to ~/.zshrc (before `compinit`):\n' +
      '  fpath=(~/.zsh/completions $fpath)\n' +
      '  autoload -Uz compinit && compinit';
  }
  return { path: target, postInstallHint };
};
