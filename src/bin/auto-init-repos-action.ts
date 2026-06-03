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
  }

  clack.outro('');
}
