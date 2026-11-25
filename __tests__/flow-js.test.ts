/**
 * A Flow-typed `.js` file (`// @flow` in its leading comments) is read with the
 * TSX grammar: the JavaScript grammar can't parse its annotations, and a
 * `render(): React.Node` cut the class around it short — segmented-control's
 * component came out with no methods. Flow's own syntax (`{| |}`, `?T`, an
 * inexact object's `...`, `import typeof`, `opaque type`) is blanked first.
 * A `.js` without the pragma is untouched.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { detectLanguage } from '../src/extraction/grammars';
import { blankFlowSyntax } from '../src/extraction/languages/typescript';

let root = '';
let cg: CodeGraph;

const FLOW = `/**
 * @flow strict-local
 * @format
 */
import typeof * as React from 'react';
import * as React from 'react';

type Props = $ReadOnly<{|
  values: ?Array<string>,
  onChange?: ?(event: {nativeEvent: {value: string}, ...}) => mixed,
|}>;

opaque type Token = string;

class SegmentedControl extends React.Component<Props> {
  render(): React.Node {
    return this._renderItems();
  }

  _renderItems(): React.Node {
    return null;
  }
}

module.exports = SegmentedControl;
`;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-flow-'));
  fs.mkdirSync(path.join(root, 'js'), { recursive: true });
  fs.writeFileSync(path.join(root, 'js/SegmentedControl.js'), FLOW);
  fs.writeFileSync(path.join(root, 'js/plain.js'), `function plain() { return 1; }\nmodule.exports = plain;\n`);
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('Flow-typed JavaScript', () => {
  it('is detected by its pragma, and only then', () => {
    expect(detectLanguage('js/SegmentedControl.js', FLOW)).toBe('tsx');
    expect(detectLanguage('js/plain.js', 'function plain() {}')).toBe('javascript');
    expect(detectLanguage('js/x.js', '// @noflow\nconst a = 1;')).toBe('javascript');
  });

  it('keeps its class and methods', () => {
    const nodes = cg.getNodesInFile('js/SegmentedControl.js');
    const methods = nodes.filter((n) => n.kind === 'method').map((n) => n.name).sort();
    expect(methods).toEqual(['_renderItems', 'render']);
    const render = nodes.find((n) => n.name === 'render')!;
    const calls = cg.getOutgoingEdges(render.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.name);
    expect(calls).toContain('_renderItems');
  });

  it('blanks Flow-only syntax to spaces, keeping every offset', () => {
    const out = blankFlowSyntax(FLOW, 'js/SegmentedControl.js');
    expect(out.length).toBe(FLOW.length);
    expect(out).not.toMatch(/\{\||\|\}|import\s+typeof|opaque\s+type|:\s*\?Array/);
    expect(blankFlowSyntax('const a = {| b |};', 'plain.js')).toBe('const a = {| b |};');
  });
});
