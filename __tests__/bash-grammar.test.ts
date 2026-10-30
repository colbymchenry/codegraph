/**
 * Bash grammar regressions (#1203, #1217): the vendored tree-sitter-bash 0.25.1
 * plus docs/grammars/tree-sitter-bash.patch. Each case is valid Bash that the
 * grammar CodeGraph used to load either failed on or read with the wrong
 * function boundaries — checked through extraction, since function extents and
 * which function a call belongs to are what the graph keeps.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { getParser, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['bash']);
});

/** Whether the grammar reads `source` with no ERROR or MISSING node. */
function parsesCleanly(source: string): boolean {
  const tree = getParser('bash')!.parse(source)!;
  try {
    return !tree.rootNode.hasError;
  } finally {
    tree.delete();
  }
}

function functions(source: string, file = 'script.sh') {
  const result = extractFromSource(file, source);
  return {
    clean: parsesCleanly(source),
    result,
    fns: result.nodes.filter((n) => n.kind === 'function').map((n) => [n.name, n.startLine, n.endLine]),
    callsFrom: (name: string) => {
      const fn = result.nodes.find((n) => n.kind === 'function' && n.name === name)!;
      return result.unresolvedReferences
        .filter((r) => r.referenceKind === 'calls' && r.fromNodeId === fn.id)
        .map((r) => r.referenceName);
    },
  };
}

describe('Bash grammar', () => {
  it('parses case dispatch (the tree-sitter-wasms 0.20.5 scanner failed on it)', () => {
    const { clean, fns, callsFrom } = functions([
      'dispatch() {',
      '  case "$1" in',
      '    build) run_build ;;',
      '    *) usage ;;',
      '  esac',
      '}',
      '',
    ].join('\n'));
    expect(clean).toBe(true);
    expect(fns).toEqual([['dispatch', 1, 6]]);
    expect(callsFrom('dispatch')).toEqual(expect.arrayContaining(['run_build', 'usage']));
  });

  it.each(['coproc HELD { inside; }', 'coproc { inside; }', 'coproc HELD ( inside )', 'coproc ( inside )', 'coproc inside', 'coproc inside argument'])
    ('keeps the enclosing function whole around `%s`', (command) => {
      const { clean, fns, callsFrom } = functions(['outer() {', `  ${command}`, '  following', '}', 'sibling() { :; }', ''].join('\n'));
      expect(clean).toBe(true);
      expect(fns).toEqual([['outer', 1, 4], ['sibling', 5, 5]]);
      expect(callsFrom('outer')).toEqual(expect.arrayContaining(['inside', 'following']));
    });

  it('keeps a multi-line coproc body inside its function', () => {
    const { fns, callsFrom } = functions([
      'hold() {', '  coproc HELD {', '    policy run', '  }', '  after_hold', '}', 'after() { :; }', '',
    ].join('\n'));
    expect(fns).toEqual([['hold', 1, 6], ['after', 7, 7]]);
    expect(callsFrom('hold')).toEqual(expect.arrayContaining(['policy', 'after_hold']));
  });

  it('parses a negated case condition', () => {
    const { clean, callsFrom } = functions([
      'gate() {',
      '  if [ -n "$1" ]; then',
      '    admit ok',
      '  elif ! case "$1" in',
      "    ''|*[!0-9]*|0*) refuse;;",
      '    *) accept;;',
      '  esac; then',
      '    refuse',
      '  fi',
      '}',
      '',
    ].join('\n'));
    expect(clean).toBe(true);
    expect(callsFrom('gate')).toEqual(expect.arrayContaining(['admit', 'refuse', 'accept']));
  });

  it.each(['exec {FD}<>"$fifo"', 'exec 3<>"$fifo"'])('parses the read/write redirect in `%s`', (command) => {
    const { clean, fns } = functions(`open_slot() { ${command}; }\nnext_fn() { :; }\n`);
    expect(clean).toBe(true);
    expect(fns).toEqual([['open_slot', 1, 1], ['next_fn', 2, 2]]);
  });

  it.each([
    ['a blank line', ''],
    ['a line of spaces', '   '],
    ['a line of tabs', '\t'],
  ])('ends an expanding heredoc after %s that follows an expansion', (_label, blank) => {
    const { clean, fns } = functions([
      'usage() {', '  cat <<EOF', 'Usage: ${cmd} [options]', blank, 'EOF', '}', 'main() { usage; }', '',
    ].join('\n'));
    expect(clean).toBe(true);
    expect(fns).toEqual([['usage', 1, 6], ['main', 7, 7]]);
  });

  it('reads a CRLF script the way it reads the LF one', () => {
    const lf = [
      'usage() {',
      '  local cmd="${0##*/}"',
      '  cat <<HELP',
      'Usage: ${cmd} [OPTIONS]',
      '',
      'HELP',
      '  cat <<\'BODY\'',
      '  more text',
      'BODY',
      '}',
      'main() {',
      '  usage',
      '}',
      '',
    ].join('\n');
    const crlf = lf.replace(/\n/g, '\r\n');
    const a = functions(lf);
    const b = functions(crlf);
    expect(b.clean).toBe(true);
    expect(b.fns).toEqual(a.fns);
    expect(b.fns).toEqual([['usage', 1, 10], ['main', 11, 13]]);
    expect(b.callsFrom('main')).toEqual(['usage']);
  });

  it('keeps a quoted heredoc body out of the graph', () => {
    const { fns, result } = functions([
      "write_text() { cat <<'TEXT'",
      'fake_inside() { phantom_call; }',
      'TEXT',
      '}',
      '',
    ].join('\n'));
    expect(fns.map((f) => f[0])).toEqual(['write_text']);
    expect(result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName)).toEqual(['cat']);
  });
});
