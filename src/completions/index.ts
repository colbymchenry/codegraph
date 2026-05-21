/**
 * Shell-completion script generator. Walks a commander `Command` tree
 * and emits a shell-native completion script. Each shell gets its own
 * emitter because the formats diverge sharply.
 *
 * Pattern mirrors hand-written generators in other CLIs (sema, fedit):
 * we generate a static script the user installs once, rather than
 * hooking completion through a runtime callback. Static scripts work
 * without `codegraph` having to spawn a Node process on every Tab,
 * and they survive when the binary is uninstalled mid-shell-session.
 */

import type { Command } from 'commander';
import { emitZsh } from './zsh';
import { emitBash } from './bash';
import { emitFish } from './fish';
import { emitPowershell } from './powershell';

export type Shell = 'zsh' | 'bash' | 'fish' | 'powershell';

export const SUPPORTED_SHELLS: readonly Shell[] = ['zsh', 'bash', 'fish', 'powershell'] as const;

// Accept common spellings (`pwsh`, `ps`) — easier than asking users to remember.
const SHELL_ALIASES: Record<string, Shell> = {
  pwsh: 'powershell',
  ps: 'powershell',
  ps1: 'powershell',
};

export const parseShell = (s: string): Shell | null => {
  const lower = s.toLowerCase();
  if ((SUPPORTED_SHELLS as readonly string[]).includes(lower)) return lower as Shell;
  return SHELL_ALIASES[lower] ?? null;
};

export const emit = (program: Command, shell: Shell): string => {
  switch (shell) {
    case 'zsh':
      return emitZsh(program);
    case 'bash':
      return emitBash(program);
    case 'fish':
      return emitFish(program);
    case 'powershell':
      return emitPowershell(program);
  }
};

export { installCompletions, detectInstallTarget } from './install';
export type { InstallTarget, InstallResult } from './install';
