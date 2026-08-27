import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

/**
 * Bash script-path relations. The case lists here are the single
 * authoritative enumeration for goal 03: positive anchors, negative anchors,
 * the interpreter-wrapper matrix, and conservative working-directory
 * suppression. Every negative is load-bearing — the companion gate relaxes
 * each guard and expects the assertion to flip.
 */
describe('bash script path relations', () => {
  let root: string;
  let cg: CodeGraph;
  let files: Map<string, Node>;

  const write = (rel: string, content: string): void => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();

    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-resolution-'));
    write('lib/lib.sh', 'greet() { echo hi; }\n');
    write('tools/sib.sh', 'echo sib\n');
    write('tools/t.py', 'print("python")\n');
    write('tools/t.js', 'console.log("node")\n');
    write('tools/t.php', '<?php echo "php";\n');
    write('env.sh', 'export FROM_ENV=1\n');
    write('shared/common.sh', 'shared_fn() { :; }\n');
    write('newroot/run.sh', 'echo rooted\n');
    write('run.sh', 'echo host\n');
    write('scripts/x.sh', 'echo stdin\n');
    write('bin/bin/mytool', '#!/usr/bin/env bash\necho tool\n');
    write('bin/src/build.sh', 'echo build\n');

    // POSITIVE anchor cases.
    const positives: Array<[string, string]> = [
      ['var-anchor', 'D="$(dirname "$0")"\nsource "$D/../lib/lib.sh"\n'],
      ['inline-dirname', 'source "$(dirname "$0")/../lib/lib.sh"\n'],
      ['cdprint-var', 'L=$(cd "$(dirname "$0")/../lib" && pwd)\nsource "$L/lib.sh"\n'],
      ['cdprint-suffix', 'L=$(cd "$(dirname "$0")" && pwd)/../lib\nsource "$L/lib.sh"\n'],
      ['bashsource-array', 'source "${BASH_SOURCE[0]%/*}/../lib/lib.sh"\n'],
      ['zero-removal', 'source "${0%/*}/../lib/lib.sh"\n'],
      ['literal-rel', 'source ../lib/lib.sh\n'],
      ['agree-chain', 'D="$(dirname "$0")/.."\nD="$D/lib"\nsource "$D/lib.sh"\n'],
      ['exec-anchor', '"$(dirname "$0")/../tools/sib.sh"\n'],
      ['exec-compose', 'H="$(dirname "$0")"\n"$H/../tools/sib.sh"\n'],
      ['repo-root-anchor', 'source "$REPO_ROOT/lib/lib.sh"\n'],
      ['bash-env-startup', 'BASH_ENV=../env.sh bash ../tools/sib.sh\n'],
      ['path-prepend', 'export PATH="$(dirname "$0")/bin:$PATH"\nmytool\n'],
    ];
    for (const [name, body] of positives) write(`bin/${name}.sh`, `#!/usr/bin/env bash\n${body}`);

    // NEGATIVE anchor cases — each must yield no relation at all.
    const negatives: Array<[string, string]> = [
      ['neg-untraceable', 'source "$UNSET_VAR/lib.sh"\n'],
      ['neg-param-default', 'source "${D:-/tmp}/lib.sh"\n'],
      ['neg-conditional', 'if true; then D="$(dirname "$0")"; fi\nsource "$D/lib.sh"\n'],
      ['neg-fn-body', 'f() { D="$(dirname "$0")"; }\nsource "$D/lib.sh"\n'],
      ['neg-disagree', 'D="$(dirname "$0")"\nD="../elsewhere"\nsource "$D/lib.sh"\n'],
      ['neg-self-ref', 'D="$D/x"\nsource "$D/lib.sh"\n'],
      ['neg-depth-chain', 'A="$B/x"\nB="$C/y"\nC="$A/z"\nD="$(dirname "$0")"\nE="$D/1"\nF="$E/2"\nG="$F/3"\nH="$G/4"\nI="$H/5"\nsource "$I/lib.sh"\n'],
      ['neg-unknown-subst', 'source "$(somecmd)/lib.sh"\n'],
      ['neg-default-sep', 'source "${D:-a/b}/lib.sh"\n'],
      ['neg-slashless', 'source lib.sh\n'],
      ['neg-no-filename', 'D="$(dirname "$0")"\nsource "$D"\n'],
      ['neg-dynamic-tail', 'W="x"\nD="$(dirname "$0")"\nsource "$D/$W/lib.sh"\n'],
      ['neg-source-foreign', 'source ./tools/t.php\n'],
      ['neg-env-startup', 'ENV=./env.sh bash ./tools/sib.sh\n'],
    ];
    for (const [name, body] of negatives) write(`bin/${name}.sh`, `#!/usr/bin/env bash\n${body}`);

    // INTERPRETER-WRAPPER matrix — every form resolves to the executed script.
    const wrappers: Array<[string, string]> = [
      ['wrap-env-assigns', 'FOO=1 env ../tools/sib.sh\n'],
      ['wrap-command', 'command ../tools/sib.sh\n'],
      ['wrap-builtin-stack', 'builtin command ../tools/sib.sh\n'],
      ['wrap-sudo-user', 'sudo -u alice ../tools/sib.sh\n'],
      ['wrap-nohup', 'nohup ../tools/sib.sh\n'],
      ['wrap-timeout-duration', 'timeout 30 ../tools/sib.sh\n'],
      ['wrap-nice-adjust', 'nice -n 5 ../tools/sib.sh\n'],
      ['wrap-stdbuf-mode', 'stdbuf -o 64K ../tools/sib.sh\n'],
      ['wrap-exec-name', 'exec -a renamed ../tools/sib.sh\n'],
      ['wrap-zsh', 'zsh ../tools/sib.sh\n'],
      ['wrap-shell-variable', 'RUN=zsh\n$RUN ../tools/sib.sh\n'],
      ['wrap-interpreter-opts', 'bash -l ../tools/sib.sh\n'],
      // An interpreter's script argument must go through the same anchor
      // tracing `source` uses. These arrive as wordsOfCommand's '\0' sentinel
      // because they are quoted, and were previously discarded outright.
      ['wrap-interp-var-anchor', 'H="$(dirname "$0")"\nbash "$H/../tools/sib.sh"\n'],
      ['wrap-interp-var-split', 'H="$(dirname "$0")"\nbash "$H"/../tools/sib.sh\n'],
      ['wrap-interp-flag-then-var', 'H="$(dirname "$0")"\nbash -x "$H/../tools/sib.sh"\n'],
      ['wrap-interp-ddash', 'H="$(dirname "$0")"\nbash -- "$H/../tools/sib.sh"\n'],
      ['wrap-interp-stdin', 'H="$(dirname "$0")"\nbash -s < "$H/../tools/sib.sh"\n'],
      ['foreign-python', 'python3 ../tools/t.py\n'],
      ['foreign-node', 'node ../tools/t.js\n'],
      ['foreign-php', 'php ../tools/t.php\n'],
      ['foreign-absolute-php', '/usr/bin/php ../tools/t.php\n'],
    ];
    for (const [name, body] of wrappers) write(`bin/${name}.sh`, `#!/usr/bin/env bash\n${body}`);

    // Wrapper shapes that must return null rather than guess.
    const wrapperNegatives: Array<[string, string]> = [
      ['wrapneg-bare-env', 'env\n'],
      ['wrapneg-unenum-opt', 'sudo --frobnicate ../tools/sib.sh\n'],
      // `-c` takes a COMMAND STRING and `-s` reads from stdin: neither has a
      // script-path argument, so a path-looking string inside them must not
      // become a relation. Short options bundle, hence `-ec`.
      ['wrapneg-interp-c-string', 'bash -c "cd /tmp && ../tools/sib.sh"\n'],
      ['wrapneg-interp-bundled-c', 'bash -ec "../tools/sib.sh"\n'],
      // A bare name is resolved by bash against the runtime cwd/PATH, not the
      // script's directory, so it stays unresolved on purpose.
      ['wrapneg-interp-bare-name', 'bash sib.sh\n'],
      ['wrapneg-python-c-string', 'python3 -c "print(1)"\n'],
    ];
    for (const [name, body] of wrapperNegatives)
      write(`bin/${name}.sh`, `#!/usr/bin/env bash\n${body}`);

    const startupNegatives: Array<[string, string]> = [
      ['startup-rcfile', 'bash --rcfile ../env.sh ../tools/sib.sh\n'],
      ['startup-initfile', 'bash --init-file ../env.sh ../tools/sib.sh\n'],
      ['startup-env', 'ENV=../env.sh sh ../tools/sib.sh\n'],
      ['startup-unresolved', 'BASH_ENV="$UNKNOWN_ENV" bash ./tools/sib.sh\n'],
    ];
    for (const [name, body] of startupNegatives)
      write(`bin/${name}.sh`, `#!/usr/bin/env bash\n${body}`);

    // WORKING-DIRECTORY suppression set.
    write('bin/wd-suppressed.sh', '#!/usr/bin/env bash\ncd ..\nsource lib/lib.sh\n');
    write(
      'bin/wd-anchored-after-cd.sh',
      '#!/usr/bin/env bash\ncd ..\nsource "$(dirname "$0")/../lib/lib.sh"\n'
    );
    write(
      'bin/wd-cd-inside-subst.sh',
      '#!/usr/bin/env bash\nB=$(cd "$(dirname "$0")/.." && pwd)\nsource "$B/lib/lib.sh"\n'
    );
    write('bin/chroot-run.sh', '#!/usr/bin/env bash\nchroot ../newroot /run.sh\n');
    write('bin/nsenter-run.sh', '#!/usr/bin/env bash\nnsenter -t 123 /run.sh\n');
    write('bin/bwrap-run.sh', '#!/usr/bin/env bash\nbwrap --bind ./src /app -- /app/build.sh\n');
    write('bin/local-stdin.sh', '#!/usr/bin/env bash\nbash < ../scripts/x.sh\n');
    write('bin/ssh-stdin.sh', '#!/usr/bin/env bash\nssh host \'bash -s\' < ../scripts/x.sh\n');
    write('bin/docker-stdin.sh', '#!/usr/bin/env bash\ndocker run -i image bash -s < ../scripts/x.sh\n');
    write('bin/ssh-subst.sh', '#!/usr/bin/env bash\nssh host "$(cat ../scripts/x.sh)"\n');
    write('bin/ssh-remote-path.sh', '#!/usr/bin/env bash\nssh host ../scripts/x.sh\n');
    write('bin/docker-remote-path.sh', '#!/usr/bin/env bash\ndocker run image ../scripts/x.sh\n');

    cg = CodeGraph.initSync(root);
    await cg.indexAll();

    files = new Map(cg.getNodesByKind('file').map((n) => [n.filePath, n]));
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const hasRelation = (fromRel: string, kind: 'imports' | 'references', toRel: string): boolean => {
    const from = files.get(fromRel);
    const to = files.get(toRel);
    if (!from || !to) return false;
    return cg
      .getOutgoingEdges(from.id)
      .some((e) => e.kind === kind && e.target === to.id);
  };

  it('resolves every positive sourcing anchor to lib/lib.sh', () => {
    for (const name of [
      'bin/var-anchor.sh',
      'bin/inline-dirname.sh',
      'bin/cdprint-var.sh',
      'bin/cdprint-suffix.sh',
      'bin/bashsource-array.sh',
      'bin/zero-removal.sh',
      'bin/literal-rel.sh',
      'bin/agree-chain.sh',
      'bin/repo-root-anchor.sh',
    ]) {
      expect(hasRelation(name, 'imports', 'lib/lib.sh'), `${name} -> lib/lib.sh`).toBe(true);
    }
  });

  it('records executions as references-kind relations to the executed script', () => {
    for (const name of ['bin/exec-anchor.sh', 'bin/exec-compose.sh']) {
      expect(hasRelation(name, 'references', 'tools/sib.sh'), `${name} -> tools/sib.sh`).toBe(true);
    }
  });

  it('resolves a bare command only through a script-prepended PATH directory', () => {
    expect(hasRelation('bin/path-prepend.sh', 'references', 'bin/bin/mytool')).toBe(true);
  });

  it('imports BASH_ENV and keeps the interpreter target as an execution reference', () => {
    expect(hasRelation('bin/bash-env-startup.sh', 'imports', 'env.sh')).toBe(true);
    expect(hasRelation('bin/bash-env-startup.sh', 'references', 'tools/sib.sh')).toBe(true);
  });

  it('does not mistake interactive-only or unresolved startup options for imports', () => {
    for (const name of ['bin/startup-rcfile.sh', 'bin/startup-initfile.sh', 'bin/startup-env.sh', 'bin/startup-unresolved.sh']) {
      const from = files.get(name)!;
      expect(cg.getOutgoingEdges(from.id).filter((e) => e.kind === 'imports')).toEqual([]);
    }
  });

  it('yields no edge for any negative anchor case', () => {
    const negativeNames = [
      'bin/neg-untraceable.sh',
      'bin/neg-param-default.sh',
      'bin/neg-conditional.sh',
      'bin/neg-fn-body.sh',
      'bin/neg-disagree.sh',
      'bin/neg-self-ref.sh',
      'bin/neg-depth-chain.sh',
      'bin/neg-unknown-subst.sh',
      'bin/neg-default-sep.sh',
      'bin/neg-slashless.sh',
      'bin/neg-no-filename.sh',
      'bin/neg-dynamic-tail.sh',
      'bin/neg-source-foreign.sh',
      'bin/neg-env-startup.sh',
    ];
    for (const name of negativeNames) {
      const from = files.get(name);
      expect(from, name).toBeDefined();
      const rels = cg
        .getOutgoingEdges(from!.id)
        .filter((e) => e.kind === 'imports' || e.kind === 'references');
      expect(rels, `${name} must emit no script relation`).toEqual([]);
    }
  });

  it('sees through every enumerated wrapper form to the executed script', () => {
    for (const name of [
      'bin/wrap-env-assigns.sh',
      'bin/wrap-command.sh',
      'bin/wrap-builtin-stack.sh',
      'bin/wrap-sudo-user.sh',
      'bin/wrap-nohup.sh',
      'bin/wrap-timeout-duration.sh',
      'bin/wrap-nice-adjust.sh',
      'bin/wrap-stdbuf-mode.sh',
      'bin/wrap-exec-name.sh',
      'bin/wrap-zsh.sh',
      'bin/wrap-shell-variable.sh',
      'bin/wrap-interpreter-opts.sh',
      'bin/wrap-interp-var-anchor.sh',
      'bin/wrap-interp-var-split.sh',
      'bin/wrap-interp-flag-then-var.sh',
      'bin/wrap-interp-ddash.sh',
      'bin/wrap-interp-stdin.sh',
    ]) {
      expect(hasRelation(name, 'references', 'tools/sib.sh'), `${name} -> tools/sib.sh`).toBe(true);
    }
  });

  it('returns null rather than guessing on unenumerated wrapper shapes', () => {
    for (const name of [
      'bin/wrapneg-bare-env.sh',
      'bin/wrapneg-unenum-opt.sh',
      'bin/wrapneg-interp-c-string.sh',
      'bin/wrapneg-interp-bundled-c.sh',
      'bin/wrapneg-interp-bare-name.sh',
      'bin/wrapneg-python-c-string.sh',
    ]) {
      const from = files.get(name)!;
      const rels = cg
        .getOutgoingEdges(from.id)
        .filter((e) => e.kind === 'imports' || e.kind === 'references');
      expect(rels, `${name}`).toEqual([]);
    }
  });

  it('resolves foreign interpreter launches to their indexed target files', () => {
    expect(hasRelation('bin/foreign-python.sh', 'references', 'tools/t.py')).toBe(true);
    expect(hasRelation('bin/foreign-node.sh', 'references', 'tools/t.js')).toBe(true);
    expect(hasRelation('bin/foreign-php.sh', 'references', 'tools/t.php')).toBe(true);
    expect(hasRelation('bin/foreign-absolute-php.sh', 'references', 'tools/t.php')).toBe(true);
  });

  it('suppresses cwd-dependent paths after a cd outside own-process constructs, but keeps anchored ones', () => {
    expect(hasRelation('bin/wd-suppressed.sh', 'imports', 'lib/lib.sh')).toBe(false);
    expect(hasRelation('bin/wd-anchored-after-cd.sh', 'imports', 'lib/lib.sh')).toBe(true);
    expect(hasRelation('bin/wd-cd-inside-subst.sh', 'imports', 'lib/lib.sh')).toBe(true);
  });

  it('applies chroot remapping and refuses runtime-dependent nsenter roots', () => {
    expect(hasRelation('bin/chroot-run.sh', 'references', 'newroot/run.sh')).toBe(true);
    expect(hasRelation('bin/chroot-run.sh', 'references', 'run.sh')).toBe(false);
    const nsenter = files.get('bin/nsenter-run.sh')!;
    expect(cg.getOutgoingEdges(nsenter.id).filter((e) => e.kind === 'imports' || e.kind === 'references')).toEqual([]);
    expect(hasRelation('bin/bwrap-run.sh', 'references', 'bin/src/build.sh')).toBe(true);
  });

  it('keeps local stdin redirections while refusing remote command operands', () => {
    for (const name of ['bin/local-stdin.sh', 'bin/ssh-stdin.sh', 'bin/docker-stdin.sh', 'bin/ssh-subst.sh']) {
      expect(hasRelation(name, 'references', 'scripts/x.sh')).toBe(true);
    }
    for (const name of ['bin/ssh-remote-path.sh', 'bin/docker-remote-path.sh']) {
      expect(hasRelation(name, 'references', 'scripts/x.sh')).toBe(false);
    }
  });

  it('keeps every enumerated case in exactly one set', () => {
    const scripts = fs.readdirSync(path.join(root, 'bin'));
    expect(scripts.length).toBe(17 + 16 + 21 + 8 + 10);
  });
});
