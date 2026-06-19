import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

describe('QML end-to-end graph support', () => {
  let tmpDir: string;
  let cg: CodeGraph | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-qml-'));
    cg = CodeGraph.initSync(tmpDir);
  });

  afterEach(async () => {
    await cg?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('indexes QML files and traverses handler to local function relationships', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import "utils.js" as Utils

Item {
  id: root
  property int count: 1
  property string label: Utils.format(root.count)
  function submit() {
    updateState(root.count)
  }
  function updateState(value) {
    count = value
  }
  MouseArea {
    onClicked: submit()
  }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'PrimaryButton.qml'),
      `import QtQuick
Rectangle {
  id: primaryButton
  property alias label: labelText.text
  Text { id: labelText; text: "OK" }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'utils.js'),
      'export function format(value) { return String(value); }\n'
    );

    const graph = cg!;
    await graph.indexAll();

    const files = graph.getFiles();
    expect(files.some((f) => f.path === 'Main.qml' && f.language === 'qml')).toBe(true);
    expect(
      files.some((f) => f.path === 'Controls/PrimaryButton.qml' && f.language === 'qml')
    ).toBe(true);

    const components = graph.getNodesByKind('component');
    expect(components.some((n) => n.name === 'root' && n.filePath === 'Main.qml')).toBe(true);
    expect(
      components.some(
        (n) => n.name === 'primaryButton' && n.filePath === 'Controls/PrimaryButton.qml'
      )
    ).toBe(true);

    const submit = graph.getNodesByName('submit').find((n) => n.filePath === 'Main.qml');
    const updateState = graph
      .getNodesByName('updateState')
      .find((n) => n.filePath === 'Main.qml');
    expect(submit).toBeDefined();
    expect(updateState).toBeDefined();

    const callers = graph.getCallers(submit!.id);
    expect(
      callers.some(
        (c) =>
          c.node.name === 'onClicked' &&
          c.node.filePath === 'Main.qml' &&
          c.edge.kind === 'calls'
      )
    ).toBe(true);

    const onClicked = callers.find(
      (c) => c.node.name === 'onClicked' && c.node.filePath === 'Main.qml'
    )?.node;
    expect(onClicked).toBeDefined();

    const callees = graph.getCallees(onClicked!.id);
    expect(
      callees.some(
        (c) => c.node.name === 'submit' && c.node.filePath === 'Main.qml' && c.edge.kind === 'calls'
      )
    ).toBe(true);

    const submitCallees = graph.getCallees(submit!.id);
    expect(
      submitCallees.some(
        (c) =>
          c.node.name === 'updateState' &&
          c.node.filePath === 'Main.qml' &&
          c.edge.kind === 'calls'
      )
    ).toBe(true);

    const impacted = graph.getImpactRadius(updateState!.id, 2);
    expect(
      Array.from(impacted.nodes.values()).some((n) => n.name === 'submit' && n.filePath === 'Main.qml')
    ).toBe(true);
  });
});
