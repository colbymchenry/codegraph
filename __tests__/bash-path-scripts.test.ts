/**
 * A script that puts its own directory first on PATH lets the scripts in that
 * directory run one another by bare name — bats-core's libexec runs
 * `bats` → `bats-exec-suite` → `bats-exec-file` → `"$BATS_LIBEXEC/bats-exec-test"`.
 * Those runs are call edges to the script's file, and explore's Flow follows
 * them. Nothing else is: no PATH evidence, a builtin name, or a script outside
 * that directory links nothing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { ToolHandler } from '../src/mcp/tools';
import { flowTokens } from '../src/graph/named-symbol-flow';

let dir: string | undefined;
let cg: CodeGraph | undefined;

afterEach(() => {
  cg?.destroy();
  cg = undefined;
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

async function index(files: Record<string, string>): Promise<CodeGraph> {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-bash-path-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, { mode: 0o755 });
  }
  cg = await CodeGraph.init(dir, { index: true });
  return cg;
}

/** Every bash `calls` edge that lands on a file, as `from-file:from-name -> to-file`. */
function runs(graph: CodeGraph): string[] {
  const out: string[] = [];
  for (const file of graph.getFiles()) {
    for (const n of graph.getNodesInFile(file.path)) {
      for (const e of graph.getOutgoingEdgesFrom([n.id], ['calls'] as any)) {
        const t = graph.getNode(e.target);
        if (t?.kind === 'file') out.push(`${n.filePath}:${n.name} -> ${t.filePath}`);
      }
    }
  }
  return out.sort();
}

const SH = '#!/usr/bin/env bash\n';
// bats-core's own spelling: a newline between `cd` and `pwd`, its own readlink stand-in.
const SELF_DIR = 'TOOL_LIBEXEC="$(\n  cd "$(dirname "$(tool_readlinkf "${BASH_SOURCE[0]}")")"\n  pwd\n)"\nexport TOOL_LIBEXEC\n';

describe('scripts run through a directory on PATH', () => {
  it('links the runs between the scripts of a directory its entry script puts on PATH', async () => {
    const graph = await index({
      'libexec/tool/tool': `${SH}${SELF_DIR}export PATH="$TOOL_LIBEXEC:$PATH"\nexec tool-suite "$@"\n`,
      'libexec/tool/tool-suite': `${SH}run_all() { tool-file "$1"; }\nrun_all "$@"\n`,
      'libexec/tool/tool-file': `${SH}one() {\n  if "$TOOL_LIBEXEC/tool-test" "$1"; then :; fi\n}\none "$@"\n`,
      'libexec/tool/tool-test': `${SH}perform() { :; }\nperform\n`,
    });
    expect(runs(graph)).toEqual([
      'libexec/tool/tool-file:one -> libexec/tool/tool-test',
      'libexec/tool/tool-suite:run_all -> libexec/tool/tool-file',
      'libexec/tool/tool:tool -> libexec/tool/tool-suite',
    ]);
  });

  it('links nothing without a script putting the directory on PATH', async () => {
    const graph = await index({
      'svc/web/main': `${SH}worker\nexec worker\n`,
      'svc/web/worker': `${SH}:\n`,
    });
    expect(runs(graph)).toEqual([]);
  });

  it('never takes a builtin for a script of that name, even on PATH', async () => {
    const graph = await index({
      'bin/main': `${SH}DIR="$(cd "$(dirname "$0")" && pwd)"\nPATH="$DIR:$PATH"\nset -e\ntest -f x\nhelper\n`,
      'bin/set': `${SH}:\n`,
      'bin/test': `${SH}:\n`,
      'bin/helper': `${SH}:\n`,
    });
    expect(runs(graph)).toEqual(['bin/main:main -> bin/helper']);
  });

  it('prefers a function the shell can see over a script of the same name', async () => {
    const graph = await index({
      'bin/main': `${SH}PATH="$(dirname "\${BASH_SOURCE[0]}"):$PATH"\nhelper() { :; }\nhelper\nexec helper\n`,
      'bin/helper': `${SH}:\n`,
    });
    // `helper` runs the function; `exec helper` can only run the program.
    expect(runs(graph)).toEqual(['bin/main:main -> bin/helper']);
    const main = graph.getNodesInFile('bin/main').find((n) => n.kind === 'file')!;
    const fnCallees = graph.getCallees(main.id).filter((c) => c.node.kind === 'function').map((c) => c.node.name);
    expect(fnCallees).toEqual(['helper']);
  });

  it('only links the scripts in the directory on PATH, not callers elsewhere', async () => {
    const graph = await index({
      'libexec/tool/tool': `${SH}${SELF_DIR}export PATH="$TOOL_LIBEXEC:$PATH"\n`,
      'libexec/tool/tool-step': `${SH}:\n`,
      'scripts/other.sh': `${SH}tool-step\n`,
    });
    expect(runs(graph)).toEqual([]);
  });

  it('leaves "$VAR/x" unresolved when two scripts export VAR as different directories', async () => {
    const graph = await index({
      'a/start': `${SH}${SELF_DIR}`,
      'b/start': `${SH}${SELF_DIR}`,
      'a/step': `${SH}:\n`,
      'b/step': `${SH}:\n`,
      'c/run.sh': `${SH}"$TOOL_LIBEXEC/step"\n`,
    });
    expect(runs(graph)).toEqual([]);
  });

  it('does not take an unexported directory variable for one a child script sees', async () => {
    const graph = await index({
      'a/start': `${SH}DIR="$(cd "$(dirname "$0")" && pwd)"\n`,
      'a/step': `${SH}:\n`,
      'c/run.sh': `${SH}"$DIR/step"\n`,
    });
    expect(runs(graph)).toEqual([]);
  });
});

describe('explore across scripts run through PATH', () => {
  it('reads hyphenated names as flow tokens', () => {
    expect(flowTokens('cmd-git-hook git_receive_app bats-exec-file')).toEqual(['cmd-git-hook', 'git_receive_app', 'bats-exec-file']);
  });

  it('shows the Flow from the entry script through each script it runs', async () => {
    const graph = await index({
      'libexec/tool/tool': `${SH}${SELF_DIR}export PATH="$TOOL_LIBEXEC:$PATH"\nexec tool-suite "$@"\n`,
      'libexec/tool/tool-suite': `${SH}run_all() { tool-file "$1"; }\nrun_all "$@"\n`,
      'libexec/tool/tool-file': `${SH}one() {\n  if "$TOOL_LIBEXEC/tool-test" "$1"; then :; fi\n}\none "$@"\n`,
      'libexec/tool/tool-test': `${SH}perform_test() { :; }\nperform_test\n`,
    });
    const handler = new ToolHandler(graph);
    const result = await handler.execute('codegraph_explore', { query: 'tool tool-suite tool-file tool-test perform_test' });
    const text = result.content[0]!.text as string;
    const flow = text.slice(text.indexOf('**Flow'), text.indexOf('> Full source'));
    expect(flow).toMatch(/1\. tool \(libexec\/tool\/tool:1\)[\s\S]*tool-suite[\s\S]*tool-file[\s\S]*tool-test[\s\S]*perform_test/);
  });

  it('renders the line where each script on the Flow starts the next one, however far down', async () => {
    // A long entry script whose hop is its last line, and a suite nothing but the
    // Flow reaches (the query does not name it): both must show their call line.
    const filler = Array.from({ length: 400 }, (_, i) => `opt_${i}="\${OPT_${i}:-}"`).join('\n');
    const graph = await index({
      'libexec/tool/tool': `${SH}${SELF_DIR}export PATH="$TOOL_LIBEXEC:$PATH"\n${filler}\nexec tool-suite "$@"\n`,
      'libexec/tool/tool-suite': `${SH}${filler}\ntool-file "$1"\n`,
      'libexec/tool/tool-file': `${SH}perform_file() { :; }\nperform_file\n`,
    });
    const handler = new ToolHandler(graph);
    const result = await handler.execute('codegraph_explore', { query: 'tool tool-file perform_file' });
    const text = result.content[0]!.text as string;
    expect(text).toContain('exec tool-suite "$@"');
    expect(text).toContain('tool-file "$1"');
  });
});
