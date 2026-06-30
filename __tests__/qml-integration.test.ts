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

component InlineButton : Rectangle {
  property string label: "Run"
}

Item {
  id: root
  property int count: 1
  property string label: Utils.format(root.count)
  InlineButton { id: actionButton }
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
/* component Text : Rectangle {} */
Rectangle {
  id: primaryButton
  property alias label: labelText.text
  Text { id: labelText; text: "OK" }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Text.qml'),
      `import QtQuick
Item {
  id: customText
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
    expect(components.some((n) => n.name === 'Main' && n.filePath === 'Main.qml')).toBe(true);
    expect(components.some((n) => n.name === 'InlineButton' && n.filePath === 'Main.qml')).toBe(true);
    expect(components.some((n) => n.name === 'actionButton' && n.filePath === 'Main.qml')).toBe(true);
    expect(
      components.some(
        (n) => n.name === 'PrimaryButton' && n.filePath === 'Controls/PrimaryButton.qml'
      )
    ).toBe(true);

    const inlineButton = graph.getNodesByName('InlineButton').find((n) => n.filePath === 'Main.qml');
    const actionButton = graph.getNodesByName('actionButton').find((n) => n.filePath === 'Main.qml');
    expect(inlineButton).toBeDefined();
    expect(actionButton).toBeDefined();
    expect(
      graph
        .getOutgoingEdges(actionButton!.id)
        .some((edge) => edge.kind === 'references' && edge.target === inlineButton!.id)
    ).toBe(true);

    const builtInTextUse = components.find(
      (n) => n.name.startsWith('Text@') && n.filePath === 'Controls/PrimaryButton.qml'
    );
    const customText = graph.getNodesByName('Text').find((n) => n.filePath === 'Text.qml');
    expect(builtInTextUse).toBeDefined();
    expect(customText).toBeDefined();
    expect(
      graph
        .getOutgoingEdges(builtInTextUse!.id)
        .some((edge) => edge.kind === 'references' && edge.target === customText!.id)
    ).toBe(false);

    const mainFile = graph.getNodesByKind('file').find((n) => n.filePath === 'Main.qml');
    const utilsFile = graph.getNodesByKind('file').find((n) => n.filePath === 'utils.js');
    expect(mainFile).toBeDefined();
    expect(utilsFile).toBeDefined();
    expect(
      graph
        .getOutgoingEdges(mainFile!.id)
        .some((edge) => edge.kind === 'imports' && edge.target === utilsFile!.id)
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

  it('resolves directory-local QML component instances to QML component definitions', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import "Controls"

Item {
  id: root
  Panel {
    id: panel
  }
  ActionButton {
    id: action
  }
  Text {
    id: builtInText
  }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Panel.qml'),
      `import QtQuick

Rectangle {
  id: panelRoot
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'ActionButton.qml'),
      `import QtQuick

Item {
  id: actionRoot
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Text.qml'),
      `import QtQuick

Item {
  id: customText
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const panelDefinition = graph
      .getNodesByName('Panel')
      .find((n) => n.kind === 'component' && n.filePath === 'Panel.qml');
    const panelInstance = graph
      .getNodesByName('panel')
      .find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const actionDefinition = graph
      .getNodesByName('ActionButton')
      .find((n) => n.kind === 'component' && n.filePath === 'Controls/ActionButton.qml');
    const actionInstance = graph
      .getNodesByName('action')
      .find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const customText = graph
      .getNodesByName('Text')
      .find((n) => n.kind === 'component' && n.filePath === 'Text.qml');
    const builtInText = graph
      .getNodesByName('builtInText')
      .find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(panelDefinition).toBeDefined();
    expect(panelInstance).toBeDefined();
    expect(actionDefinition).toBeDefined();
    expect(actionInstance).toBeDefined();
    expect(customText).toBeDefined();
    expect(builtInText).toBeDefined();

    expect(
      graph
        .getOutgoingEdges(panelInstance!.id)
        .some((edge) => edge.kind === 'references' && edge.target === panelDefinition!.id)
    ).toBe(true);
    expect(
      graph
        .getOutgoingEdges(actionInstance!.id)
        .some((edge) => edge.kind === 'references' && edge.target === actionDefinition!.id)
    ).toBe(true);
    expect(
      graph
        .getOutgoingEdges(builtInText!.id)
        .some((edge) => edge.kind === 'references' && edge.target === customText!.id)
    ).toBe(false);
  });

  it('resolves dynamic QML loading only for literal local component URLs', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import QtQuick as Quick

Item {
  id: root
  property string panelName: "Panel"

  Loader {
    id: literalLoader
    source: "LazyPanel.qml"
  }

  Loader {
    id: dynamicLoader
    source: "Lazy" + root.panelName + ".qml"
  }

  Image {
    id: imageSource
    source: "LazyPanel.qml"
  }

  Controls.Loader {
    id: aliasedLoader
    source: "LazyPanel.qml"
  }

  Quick.Loader {
    id: qtQuickAliasedLoader
    source: "LazyPanel.qml"
  }

  Loader {
    id: qrcLoader
    source: "qrc:/LazyPanel.qml"
  }

  Loader {
    id: httpLoader
    source: "http://example.com/LazyPanel.qml"
  }

  Loader {
    id: absoluteLoader
    source: "/absolute/LazyPanel.qml"
  }

  Loader {
    id: windowsAbsoluteLoader
    source: "C:\\\\tmp\\\\LazyPanel.qml"
  }

  Loader {
    id: relativeLoader
    source: "./LazyPanel.qml"
  }

  Loader {
    id: windowsRelativeLoader
    source: ".\\\\LazyPanel.qml"
  }

  Loader {
    id: uppercaseLoader
    source: "LazyUpper.QML"
  }

  Component.onCompleted: {
    Qt.createComponent("LazyPanel.qml")
  }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'LazyUpper.QML'), 'import QtQuick\nRectangle { id: upperRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const lazyUpper = graph.getNodesByName('LazyUpper').find((n) => n.kind === 'component' && n.filePath === 'LazyUpper.QML');
    const literalLoader = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const dynamicLoader = graph.getNodesByName('dynamicLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const imageSource = graph.getNodesByName('imageSource').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const aliasedLoader = graph.getNodesByName('aliasedLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const qtQuickAliasedLoader = graph.getNodesByName('qtQuickAliasedLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const qrcLoader = graph.getNodesByName('qrcLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const httpLoader = graph.getNodesByName('httpLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const absoluteLoader = graph.getNodesByName('absoluteLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const windowsAbsoluteLoader = graph.getNodesByName('windowsAbsoluteLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const relativeLoader = graph.getNodesByName('relativeLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const windowsRelativeLoader = graph.getNodesByName('windowsRelativeLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const uppercaseLoader = graph.getNodesByName('uppercaseLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');

    expect(lazyPanel).toBeDefined();
    expect(lazyUpper).toBeDefined();
    expect(literalLoader).toBeDefined();
    expect(dynamicLoader).toBeDefined();
    expect(imageSource).toBeDefined();
    expect(aliasedLoader).toBeDefined();
    expect(qtQuickAliasedLoader).toBeDefined();
    expect(qrcLoader).toBeDefined();
    expect(httpLoader).toBeDefined();
    expect(absoluteLoader).toBeDefined();
    expect(windowsAbsoluteLoader).toBeDefined();
    expect(relativeLoader).toBeDefined();
    expect(windowsRelativeLoader).toBeDefined();
    expect(uppercaseLoader).toBeDefined();
    expect(onCompleted).toBeDefined();

    expect(graph.getOutgoingEdges(literalLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(qtQuickAliasedLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(relativeLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(windowsRelativeLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(uppercaseLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyUpper!.id)).toBe(true);
    expect(graph.getOutgoingEdges(onCompleted!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(dynamicLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(imageSource!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(aliasedLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(qrcLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(httpLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(absoluteLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
    expect(graph.getOutgoingEdges(windowsAbsoluteLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });

  it('does not resolve dynamic QML loading for project-defined Loader components', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Loader {
    id: customLoader
    source: "LazyPanel.qml"
  }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Loader.qml'), 'import QtQuick\nItem { property string source; id: loaderRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const loaderDefinition = graph.getNodesByName('Loader').find((n) => n.kind === 'component' && n.filePath === 'Loader.qml');
    const customLoader = graph.getNodesByName('customLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(lazyPanel).toBeDefined();
    expect(loaderDefinition).toBeDefined();
    expect(customLoader).toBeDefined();
    expect(graph.getOutgoingEdges(customLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });

  it('does not resolve dynamic QML loading for qmldir-exported Loader components', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  Loader {
    id: moduleLoader
    source: "LazyPanel.qml"
  }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
Loader 1.0 Loader.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'Loader.qml'), 'import QtQuick\nItem { property string source; id: loaderRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const loaderDefinition = graph.getNodesByName('Loader').find((n) => n.kind === 'component' && n.filePath === 'Controls/Loader.qml');
    const moduleLoader = graph.getNodesByName('moduleLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(lazyPanel).toBeDefined();
    expect(loaderDefinition).toBeDefined();
    expect(moduleLoader).toBeDefined();
    expect(graph.getOutgoingEdges(moduleLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });

  it('updates literal dynamic QML loading when target files appear during sync', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Loader {
    id: literalLoader
    source: "LazyPanel.qml"
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const literalLoader = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(literalLoader).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoader!.id).some((edge) => edge.kind === 'references')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');
    await graph.sync();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const literalLoaderAfterSync = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(lazyPanel).toBeDefined();
    expect(literalLoaderAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoaderAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
  });

  it('removes literal dynamic QML loading when Loader shadow files appear during sync', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Loader {
    id: literalLoader
    source: "LazyPanel.qml"
  }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const literalLoader = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(lazyPanel).toBeDefined();
    expect(literalLoader).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(tmpDir, 'Loader.qml'), 'import QtQuick\nItem { property string source; id: loaderRoot }\n');
    await graph.sync();

    const literalLoaderAfterSync = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(literalLoaderAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoaderAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });

  it('restores literal dynamic QML loading when Loader shadow files are deleted during sync', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Loader {
    id: literalLoader
    source: "LazyPanel.qml"
  }
}
`
    );
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Loader.qml'), 'import QtQuick\nItem { property string source; id: loaderRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const literalLoader = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(lazyPanel).toBeDefined();
    expect(literalLoader).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoader!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(path.join(tmpDir, 'Loader.qml'));
    await graph.sync();

    const literalLoaderAfterSync = graph.getNodesByName('literalLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(literalLoaderAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(literalLoaderAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(true);
  });

  it('does not reindex unknown Loader aliases for literal dynamic QML target changes', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  Controls.Loader {
    id: unknownAliasLoader
    source: "LazyPanel.qml"
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const unknownAliasLoader = graph.getNodesByName('unknownAliasLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(unknownAliasLoader).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(path.join(tmpDir, 'LazyPanel.qml'), 'import QtQuick\nRectangle { id: lazyRoot }\n');
    const result = await graph.sync();

    const lazyPanel = graph.getNodesByName('LazyPanel').find((n) => n.kind === 'component' && n.filePath === 'LazyPanel.qml');
    const unknownAliasLoaderAfterSync = graph.getNodesByName('unknownAliasLoader').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(lazyPanel).toBeDefined();
    expect(unknownAliasLoaderAfterSync).toBeDefined();
    expect(result.changedFilePaths ?? []).not.toContain('Main.qml');
    expect(graph.getOutgoingEdges(unknownAliasLoaderAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === lazyPanel!.id)).toBe(false);
  });

  it('extracts QML calls from function-valued handlers and object literal callbacks', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Callbacks.qml'),
      `import QtQuick

Item {
  id: root
  signal accepted(var request)

  function openInlineConfirm(request) {
    request.accepted()
  }

  function closeInlineConfirm() {
  }

  function removeAll() {
  }

  function submit(page) {
  }

  Pager {
    onPageRequested: function(page) {
      root.submit(page)
    }
  }

  ActionButton {
    onClicked: root.openInlineConfirm({
      "accepted": function () {
        root.removeAll()
      }
    })
  }

  Confirm {
    onAccepted: root.closeInlineConfirm()
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const submit = graph
      .getNodesByName('submit')
      .find((n) => n.kind === 'function' && n.filePath === 'Callbacks.qml');
    const removeAll = graph
      .getNodesByName('removeAll')
      .find((n) => n.kind === 'function' && n.filePath === 'Callbacks.qml');
    const closeInlineConfirm = graph
      .getNodesByName('closeInlineConfirm')
      .find((n) => n.kind === 'function' && n.filePath === 'Callbacks.qml');

    expect(submit).toBeDefined();
    expect(removeAll).toBeDefined();
    expect(closeInlineConfirm).toBeDefined();

    expect(
      graph
        .getCallers(submit!.id)
        .some((caller) => caller.node.name === 'onPageRequested' && caller.edge.kind === 'calls')
    ).toBe(true);
    expect(
      graph
        .getCallers(removeAll!.id)
        .some((caller) => caller.node.name.includes('accepted') && caller.edge.kind === 'calls')
    ).toBe(true);
    expect(
      graph
        .getCallers(closeInlineConfirm!.id)
        .some((caller) => caller.node.name === 'onAccepted' && caller.edge.kind === 'calls')
    ).toBe(true);
  });

  it('extracts QML calls from multi-level member expressions in nested handlers', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'NestedMemberCalls.qml'),
      `import QtQuick

Item {
  id: root
  property var viewModel: ({})

  function goToPage(page) {
  }

  function onNodeClicked(id) {
  }

  Pager {
    onPageRequested: function(page) {
      if (root.viewModel) root.viewModel.goToPage(page)
    }
  }

  ListView {
    delegate: MouseArea {
      onClicked: root.viewModel.onNodeClicked(model.id)
    }
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const goToPage = graph
      .getNodesByName('goToPage')
      .find((n) => n.kind === 'function' && n.filePath === 'NestedMemberCalls.qml');
    const onNodeClicked = graph
      .getNodesByName('onNodeClicked')
      .find((n) => n.filePath === 'NestedMemberCalls.qml');

    expect(goToPage).toBeDefined();
    expect(onNodeClicked).toBeDefined();

    expect(
      graph
        .getCallers(goToPage!.id)
        .some((caller) => caller.node.name === 'onPageRequested' && caller.edge.kind === 'calls')
    ).toBe(true);
    expect(
      graph
        .getCallers(onNodeClicked!.id)
        .some((caller) => caller.node.name === 'onClicked' && caller.edge.kind === 'calls')
    ).toBe(true);
  });

  it('extracts QML calls from function-valued bindings and callback arguments', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'FunctionCallbacks.qml'),
      `import QtQuick

Item {
  id: root
  property var sourceItems: []
  readonly property var filteredItems: sourceItems.filter(function(item) {
    return root.isVisibleItem(item)
  })

  function displayBookmarkGroupLabel(value) {
    return value
  }

  function isVisibleItem(item) {
    return !!item
  }

  FormatterControl {
    labelFormatter: function(rawText) {
      return root.displayBookmarkGroupLabel(rawText)
    }
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const displayBookmarkGroupLabel = graph
      .getNodesByName('displayBookmarkGroupLabel')
      .find((n) => n.kind === 'function' && n.filePath === 'FunctionCallbacks.qml');
    const isVisibleItem = graph
      .getNodesByName('isVisibleItem')
      .find((n) => n.kind === 'function' && n.filePath === 'FunctionCallbacks.qml');

    expect(displayBookmarkGroupLabel).toBeDefined();
    expect(isVisibleItem).toBeDefined();

    expect(
      graph
        .getCallers(displayBookmarkGroupLabel!.id)
        .some((caller) => caller.node.name === 'labelFormatter' && caller.edge.kind === 'calls')
    ).toBe(true);
    expect(
      graph
        .getCallers(isVisibleItem!.id)
        .some((caller) => caller.node.name.includes('filter') && caller.edge.kind === 'calls')
    ).toBe(true);
  });

  it('resolves qmldir module imports without broad built-in or internal matches', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0
import My.Controls 1.0 as Controls

Item {
  FancyButton { id: plainFancy }
  Controls.FancyButton { id: aliasFancy }
  HiddenButton { id: hiddenButton }
  Text { id: builtInText }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
Text 1.0 Text.qml
internal HiddenButton HiddenButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nRectangle { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'HiddenButton.qml'), 'import QtQuick\nItem { id: hiddenRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'Text.qml'), 'import QtQuick\nItem { id: customText }\n');

    const graph = cg!;
    await graph.indexAll();

    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const plainFancy = graph.getNodesByName('plainFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const aliasFancy = graph.getNodesByName('aliasFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const hiddenDefinition = graph.getNodesByName('HiddenButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/HiddenButton.qml');
    const hiddenButton = graph.getNodesByName('hiddenButton').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const customText = graph.getNodesByName('Text').find((n) => n.kind === 'component' && n.filePath === 'Controls/Text.qml');
    const builtInText = graph.getNodesByName('builtInText').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(fancyDefinition).toBeDefined();
    expect(plainFancy).toBeDefined();
    expect(aliasFancy).toBeDefined();
    expect(hiddenDefinition).toBeDefined();
    expect(hiddenButton).toBeDefined();
    expect(customText).toBeDefined();
    expect(builtInText).toBeDefined();

    expect(graph.getOutgoingEdges(plainFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(aliasFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(hiddenButton!.id).some((edge) => edge.kind === 'references' && edge.target === hiddenDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(builtInText!.id).some((edge) => edge.kind === 'references' && edge.target === customText!.id)).toBe(false);
  });

  it('resolves and invalidates qmldir imports from uppercase QML files', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.QML'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: upperFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nItem { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'OtherButton.qml'), 'import QtQuick\nItem { id: otherRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const upperFancy = graph.getNodesByName('upperFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.QML');
    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const otherDefinition = graph.getNodesByName('OtherButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/OtherButton.qml');

    expect(upperFancy).toBeDefined();
    expect(fancyDefinition).toBeDefined();
    expect(otherDefinition).toBeDefined();
    expect(graph.getOutgoingEdges(upperFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 OtherButton.qml
`
    );
    await graph.sync();

    const upperFancyAfterSync = graph.getNodesByName('upperFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.QML');

    expect(upperFancyAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(upperFancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(upperFancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === otherDefinition!.id)).toBe(true);
  });

  it('updates qmldir importer edges when only qmldir metadata changes', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: plainFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nItem { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'OtherButton.qml'), 'import QtQuick\nItem { id: otherRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const plainFancy = graph.getNodesByName('plainFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const otherDefinition = graph.getNodesByName('OtherButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/OtherButton.qml');

    expect(plainFancy).toBeDefined();
    expect(fancyDefinition).toBeDefined();
    expect(otherDefinition).toBeDefined();
    expect(graph.getOutgoingEdges(plainFancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);

    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 OtherButton.qml
# switched target
`
    );
    await graph.sync();

    const plainFancyAfterSync = graph.getNodesByName('plainFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(plainFancyAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(plainFancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(plainFancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === otherDefinition!.id)).toBe(true);

    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
# switched back to original target
`
    );
    await graph.indexAll();

    const plainFancyAfterIndexAll = graph.getNodesByName('plainFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    expect(plainFancyAfterIndexAll).toBeDefined();
    expect(graph.getOutgoingEdges(plainFancyAfterIndexAll!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(plainFancyAfterIndexAll!.id).some((edge) => edge.kind === 'references' && edge.target === otherDefinition!.id)).toBe(false);
  });

  it('does not force-reindex unrelated qmldir module importers during sync', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'OtherControls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: fancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Other.qml'),
      `import QtQuick
import Other.Controls 1.0

Item {
  OtherButton { id: unrelatedOther }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'OtherControls', 'qmldir'),
      `module Other.Controls
OtherButton 1.0 OtherButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nItem { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButtonAlt.qml'), 'import QtQuick\nItem { id: fancyAltRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'OtherControls', 'OtherButton.qml'), 'import QtQuick\nItem { id: otherRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const fancy = graph.getNodesByName('fancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const fancyAltDefinition = graph.getNodesByName('FancyButtonAlt').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButtonAlt.qml');
    const unrelatedOtherBefore = graph.getNodesByName('unrelatedOther').find((n) => n.kind === 'component' && n.filePath === 'Other.qml');

    expect(fancy).toBeDefined();
    expect(fancyDefinition).toBeDefined();
    expect(fancyAltDefinition).toBeDefined();
    expect(unrelatedOtherBefore).toBeDefined();
    expect(graph.getOutgoingEdges(fancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButtonAlt.qml
`
    );
    await graph.sync();

    const fancyAfterSync = graph.getNodesByName('fancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const unrelatedOtherAfter = graph.getNodesByName('unrelatedOther').find((n) => n.kind === 'component' && n.filePath === 'Other.qml');

    expect(fancyAfterSync).toBeDefined();
    expect(unrelatedOtherAfter).toBeDefined();
    expect(graph.getOutgoingEdges(fancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(fancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyAltDefinition!.id)).toBe(true);
    expect(unrelatedOtherAfter!.updatedAt).toBe(unrelatedOtherBefore!.updatedAt);
  });

  it('does not force-reindex unrelated qmldir module importers when qmldir is deleted', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'OtherControls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: fancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Other.qml'),
      `import QtQuick
import Other.Controls 1.0

Item {
  OtherButton { id: unrelatedOther }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'OtherControls', 'qmldir'),
      `module Other.Controls
OtherButton 1.0 OtherButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nItem { id: fancyRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'OtherControls', 'OtherButton.qml'), 'import QtQuick\nItem { id: otherRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const fancy = graph.getNodesByName('fancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');
    const unrelatedOtherBefore = graph.getNodesByName('unrelatedOther').find((n) => n.kind === 'component' && n.filePath === 'Other.qml');

    expect(fancy).toBeDefined();
    expect(fancyDefinition).toBeDefined();
    expect(unrelatedOtherBefore).toBeDefined();
    expect(graph.getOutgoingEdges(fancy!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.rmSync(path.join(tmpDir, 'Controls', 'qmldir'));
    await graph.sync();

    const fancyAfterSync = graph.getNodesByName('fancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const unrelatedOtherAfter = graph.getNodesByName('unrelatedOther').find((n) => n.kind === 'component' && n.filePath === 'Other.qml');

    expect(fancyAfterSync).toBeDefined();
    expect(unrelatedOtherAfter).toBeDefined();
    expect(graph.getOutgoingEdges(fancyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);
    expect(unrelatedOtherAfter!.updatedAt).toBe(unrelatedOtherBefore!.updatedAt);
  });

  it('invalidates old and new importers when a qmldir module URI is renamed', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: oldImporter }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'New.qml'),
      `import QtQuick
import New.Controls 1.0

Item {
  FancyButton { id: newImporter }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton.qml'), 'import QtQuick\nItem { id: fancyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const oldImporter = graph.getNodesByName('oldImporter').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const newImporter = graph.getNodesByName('newImporter').find((n) => n.kind === 'component' && n.filePath === 'New.qml');
    const fancyDefinition = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton.qml');

    expect(oldImporter).toBeDefined();
    expect(newImporter).toBeDefined();
    expect(fancyDefinition).toBeDefined();
    expect(graph.getOutgoingEdges(oldImporter!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
    expect(graph.getOutgoingEdges(newImporter!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module New.Controls
FancyButton 1.0 FancyButton.qml
`
    );
    await graph.sync();

    const oldImporterAfterSync = graph.getNodesByName('oldImporter').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const newImporterAfterSync = graph.getNodesByName('newImporter').find((n) => n.kind === 'component' && n.filePath === 'New.qml');

    expect(oldImporterAfterSync).toBeDefined();
    expect(newImporterAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(oldImporterAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(false);
    expect(graph.getOutgoingEdges(newImporterAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === fancyDefinition!.id)).toBe(true);
  });

  it('resolves qmldir exported names that differ from target file basenames', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: exportedFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButtonImpl.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButtonImpl.qml'), 'import QtQuick\nItem { id: fancyImplRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const exportedFancy = graph.getNodesByName('exportedFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const target = graph.getNodesByName('FancyButtonImpl').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButtonImpl.qml');

    expect(exportedFancy).toBeDefined();
    expect(target).toBeDefined();
    expect(graph.getOutgoingEdges(exportedFancy!.id).some((edge) => edge.kind === 'references' && edge.target === target!.id)).toBe(true);
  });

  it('discovers qmldir modules whose component targets live in subdirectories', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls', 'impl'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.0

Item {
  FancyButton { id: nestedFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 impl/FancyButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'impl', 'FancyButton.qml'), 'import QtQuick\nItem { id: nestedFancyRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const nestedFancy = graph.getNodesByName('nestedFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const target = graph.getNodesByName('FancyButton').find((n) => n.kind === 'component' && n.filePath === 'Controls/impl/FancyButton.qml');

    expect(nestedFancy).toBeDefined();
    expect(target).toBeDefined();
    expect(graph.getOutgoingEdges(nestedFancy!.id).some((edge) => edge.kind === 'references' && edge.target === target!.id)).toBe(true);
  });

  it('uses qmldir import versions as compatible disambiguation instead of exact matches', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.2

Item {
  FancyButton { id: compatibleFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton10.qml
FancyButton 2.0 FancyButton20.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton10.qml'), 'import QtQuick\nItem { id: fancy10Root }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton20.qml'), 'import QtQuick\nItem { id: fancy20Root }\n');

    const graph = cg!;
    await graph.indexAll();

    const compatibleFancy = graph.getNodesByName('compatibleFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const compatibleTarget = graph.getNodesByName('FancyButton10').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton10.qml');
    const incompatibleTarget = graph.getNodesByName('FancyButton20').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton20.qml');

    expect(compatibleFancy).toBeDefined();
    expect(compatibleTarget).toBeDefined();
    expect(incompatibleTarget).toBeDefined();
    expect(graph.getOutgoingEdges(compatibleFancy!.id).some((edge) => edge.kind === 'references' && edge.target === compatibleTarget!.id)).toBe(true);
    expect(graph.getOutgoingEdges(compatibleFancy!.id).some((edge) => edge.kind === 'references' && edge.target === incompatibleTarget!.id)).toBe(false);
  });

  it('resolves versionless qmldir imports to the highest available version', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls

Item {
  FancyButton { id: versionlessFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 1.0 FancyButton10.qml
FancyButton 2.0 FancyButton20.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton10.qml'), 'import QtQuick\nItem { id: fancy10Root }\n');
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton20.qml'), 'import QtQuick\nItem { id: fancy20Root }\n');

    const graph = cg!;
    await graph.indexAll();

    const versionlessFancy = graph.getNodesByName('versionlessFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const olderTarget = graph.getNodesByName('FancyButton10').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton10.qml');
    const newerTarget = graph.getNodesByName('FancyButton20').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton20.qml');

    expect(versionlessFancy).toBeDefined();
    expect(olderTarget).toBeDefined();
    expect(newerTarget).toBeDefined();
    expect(graph.getOutgoingEdges(versionlessFancy!.id).some((edge) => edge.kind === 'references' && edge.target === newerTarget!.id)).toBe(true);
    expect(graph.getOutgoingEdges(versionlessFancy!.id).some((edge) => edge.kind === 'references' && edge.target === olderTarget!.id)).toBe(false);
  });

  it('does not resolve a lone qmldir candidate with an incompatible version', async () => {
    fs.mkdirSync(path.join(tmpDir, 'Controls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import My.Controls 1.2

Item {
  FancyButton { id: incompatibleFancy }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Controls', 'qmldir'),
      `module My.Controls
FancyButton 2.0 FancyButton20.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'Controls', 'FancyButton20.qml'), 'import QtQuick\nItem { id: fancy20Root }\n');

    const graph = cg!;
    await graph.indexAll();

    const incompatibleFancy = graph.getNodesByName('incompatibleFancy').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const incompatibleTarget = graph.getNodesByName('FancyButton20').find((n) => n.kind === 'component' && n.filePath === 'Controls/FancyButton20.qml');

    expect(incompatibleFancy).toBeDefined();
    expect(incompatibleTarget).toBeDefined();
    expect(graph.getOutgoingEdges(incompatibleFancy!.id).some((edge) => edge.kind === 'references' && edge.target === incompatibleTarget!.id)).toBe(false);
  });

  it('resolves components from qmldir dependency imports', async () => {
    fs.mkdirSync(path.join(tmpDir, 'AppControls'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'BaseControls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import App.Controls 1.0

Item {
  BaseButton { id: baseFromDependency }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppControls', 'qmldir'),
      `module App.Controls
import Base.Controls 1.0
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'BaseControls', 'qmldir'),
      `module Base.Controls
BaseButton 1.0 BaseButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'BaseControls', 'BaseButton.qml'), 'import QtQuick\nItem { id: baseRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const baseFromDependency = graph.getNodesByName('baseFromDependency').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const baseTarget = graph.getNodesByName('BaseButton').find((n) => n.kind === 'component' && n.filePath === 'BaseControls/BaseButton.qml');

    expect(baseFromDependency).toBeDefined();
    expect(baseTarget).toBeDefined();
    expect(graph.getOutgoingEdges(baseFromDependency!.id).some((edge) => edge.kind === 'references' && edge.target === baseTarget!.id)).toBe(true);
  });

  it('reindexes qmldir dependency importers when a dependency qmldir changes', async () => {
    fs.mkdirSync(path.join(tmpDir, 'AppControls'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'BaseControls'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import App.Controls 1.0

Item {
  BaseButton { id: baseFromDependency }
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AppControls', 'qmldir'),
      `module App.Controls
import Base.Controls 1.0
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'BaseControls', 'qmldir'),
      `module Base.Controls
BaseButton 1.0 BaseButton.qml
`
    );
    fs.writeFileSync(path.join(tmpDir, 'BaseControls', 'BaseButton.qml'), 'import QtQuick\nItem { id: baseRoot }\n');
    fs.writeFileSync(path.join(tmpDir, 'BaseControls', 'BaseButtonAlt.qml'), 'import QtQuick\nItem { id: baseAltRoot }\n');

    const graph = cg!;
    await graph.indexAll();

    const baseFromDependency = graph.getNodesByName('baseFromDependency').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const baseTarget = graph.getNodesByName('BaseButton').find((n) => n.kind === 'component' && n.filePath === 'BaseControls/BaseButton.qml');
    const baseAltTarget = graph.getNodesByName('BaseButtonAlt').find((n) => n.kind === 'component' && n.filePath === 'BaseControls/BaseButtonAlt.qml');

    expect(baseFromDependency).toBeDefined();
    expect(baseTarget).toBeDefined();
    expect(baseAltTarget).toBeDefined();
    expect(graph.getOutgoingEdges(baseFromDependency!.id).some((edge) => edge.kind === 'references' && edge.target === baseTarget!.id)).toBe(true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    fs.writeFileSync(
      path.join(tmpDir, 'BaseControls', 'qmldir'),
      `module Base.Controls
BaseButton 1.0 BaseButtonAlt.qml
`
    );
    await graph.sync();

    const baseFromDependencyAfterSync = graph.getNodesByName('baseFromDependency').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');

    expect(baseFromDependencyAfterSync).toBeDefined();
    expect(graph.getOutgoingEdges(baseFromDependencyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === baseTarget!.id)).toBe(false);
    expect(graph.getOutgoingEdges(baseFromDependencyAfterSync!.id).some((edge) => edge.kind === 'references' && edge.target === baseAltTarget!.id)).toBe(true);
  });

  it('resolves C++/QML bridge registry facts through the QML Qt framework resolver', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QtQml>

class ViewModel : public QObject {
  Q_OBJECT
  Q_PROPERTY(QString title READ title NOTIFY titleChanged)

public:
  QString title() const;
  Q_INVOKABLE void refresh();
  void hidden();

public slots:
  void save();

signals:
  void titleChanged();

private:
  QString m_title;
};

class OtherModel : public QObject {
  Q_OBJECT

public:
  Q_INVOKABLE void refresh();
  void hidden();
};

class ThemeApi : public QObject {
  Q_OBJECT

public:
  Q_INVOKABLE QString color();
};

class MyButton : public QObject {
  Q_OBJECT
};

QString ViewModel::title() const { return m_title; }
void ViewModel::refresh() {}
void ViewModel::save() {}
void ViewModel::hidden() {}
void ViewModel::titleChanged() {}
void OtherModel::refresh() {}
void OtherModel::hidden() {}
QString ThemeApi::color() { return "#123456"; }

int main(int argc, char** argv) {
  QQmlApplicationEngine engine;
  ViewModel vm;
  engine.rootContext()->setContextProperty("viewModel", &vm);
  qmlRegisterType<MyButton>("App.Controls", 1, 0, "MyButton");
  qmlRegisterUncreatableType<OtherModel>("App.Controls", 1, 0, "OtherModel", "Only context");
  qmlRegisterSingletonType<ThemeApi>("App.Controls", 1, 0, "ThemeApi", [](QQmlEngine*, QJSEngine*) -> QObject* {
    return new ThemeApi();
  });
  engine.load(QUrl(QStringLiteral("qrc:/Main.qml")));
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick
import App.Controls 1.0

Item {
  id: root
  property string shownTitle: viewModel.title
  property OtherModel selectedModel: null
  property var localTarget: ({})

  Component.onCompleted: {
    viewModel.refresh()
    viewModel.save()
    viewModel.hidden()
    ThemeApi.color()
  }

  Connections {
    Binding {
      target: localTarget
      property: "value"
      value: 1
    }

    target: viewModel
    function onTitleChanged() {
      viewModel.refresh()
    }

    Connections {
      target: localTarget
      function onTitleChanged() {
        viewModel.refresh()
      }
    }
  }

  function onTitleChanged() {
    viewModel.refresh()
  }

  Item {
    id: nestedShadowOwner
    property var viewModel: ({})
  }

  MyButton {
    id: registeredButton
  }

  OtherModel {
    id: invalidOtherModelInstance
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
    const onTitleChangedHandlers = graph.getNodesByName('onTitleChanged')
      .filter((n) => n.kind === 'method' && n.filePath === 'Main.qml')
      .sort((a, b) => a.startLine - b.startLine);
    const connectionTitleChanged = onTitleChangedHandlers[0];
    const nestedConnectionTitleChanged = onTitleChangedHandlers[1];
    const ordinaryTitleChanged = onTitleChangedHandlers[2];
    const shownTitle = graph.getNodesByName('shownTitle').find((n) => n.kind === 'property' && n.filePath === 'Main.qml');
    const selectedModel = graph.getNodesByName('selectedModel').find((n) => n.kind === 'property' && n.filePath === 'Main.qml');
    const connections = graph.getNodesByKind('component').find((n) => n.signature === 'Connections' && n.filePath === 'Main.qml');
    const registeredButton = graph.getNodesByName('registeredButton').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const invalidOtherModelInstance = graph.getNodesByName('invalidOtherModelInstance').find((n) => n.kind === 'component' && n.filePath === 'Main.qml');
    const viewModelRefresh = graph.getNodesByName('refresh').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::refresh'));
    const viewModelSave = graph.getNodesByName('save').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::save'));
    const viewModelTitle = graph.getNodesByName('title').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::title'));
    const viewModelTitleChanged = graph.getNodesByName('titleChanged').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::titleChanged'));
    const viewModelHidden = graph.getNodesByName('hidden').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::hidden'));
    const otherModelRefresh = graph.getNodesByName('refresh').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('OtherModel::refresh'));
    const themeColor = graph.getNodesByName('color').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ThemeApi::color'));
    const viewModel = graph.getNodesByName('ViewModel').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');
    const myButton = graph.getNodesByName('MyButton').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');
    const otherModel = graph.getNodesByName('OtherModel').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');

    expect(onCompleted).toBeDefined();
    expect(connectionTitleChanged).toBeDefined();
    expect(nestedConnectionTitleChanged).toBeDefined();
    expect(ordinaryTitleChanged).toBeDefined();
    expect(shownTitle).toBeDefined();
    expect(selectedModel).toBeDefined();
    expect(connections).toBeDefined();
    expect(registeredButton).toBeDefined();
    expect(invalidOtherModelInstance).toBeDefined();
    expect(viewModelRefresh).toBeDefined();
    expect(viewModelSave).toBeDefined();
    expect(viewModelTitle).toBeDefined();
    expect(viewModelTitleChanged).toBeDefined();
    expect(viewModelHidden).toBeDefined();
    expect(otherModelRefresh).toBeDefined();
    expect(themeColor).toBeDefined();
    expect(viewModel).toBeDefined();
    expect(myButton).toBeDefined();
    expect(otherModel).toBeDefined();

    const onCompletedEdges = graph.getOutgoingEdges(onCompleted!.id);
    expect(onCompletedEdges.some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(true);
    expect(onCompletedEdges.some((edge) => edge.kind === 'calls' && edge.target === viewModelSave!.id)).toBe(true);
    expect(onCompletedEdges.some((edge) => edge.kind === 'calls' && edge.target === themeColor!.id)).toBe(true);
    expect(onCompletedEdges.some((edge) => edge.kind === 'calls' && edge.target === otherModelRefresh!.id)).toBe(false);
    expect(onCompletedEdges.some((edge) => edge.kind === 'calls' && edge.target === viewModelHidden!.id)).toBe(false);
    expect(graph.getOutgoingEdges(connectionTitleChanged!.id).some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(true);
    expect(graph.getOutgoingEdges(connectionTitleChanged!.id).some((edge) => edge.kind === 'references' && edge.target === viewModelTitleChanged!.id)).toBe(true);
    expect(graph.getOutgoingEdges(nestedConnectionTitleChanged!.id).some((edge) => edge.kind === 'references' && edge.target === viewModelTitleChanged!.id)).toBe(false);
    expect(graph.getOutgoingEdges(ordinaryTitleChanged!.id).some((edge) => edge.kind === 'references' && edge.target === viewModelTitleChanged!.id)).toBe(false);
    expect(graph.getOutgoingEdges(connections!.id).some((edge) => edge.kind === 'references' && edge.target === viewModel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(shownTitle!.id).some((edge) => edge.kind === 'references' && edge.target === viewModelTitle!.id)).toBe(true);
    expect(graph.getOutgoingEdges(selectedModel!.id).some((edge) => edge.kind === 'references' && edge.target === otherModel!.id)).toBe(true);
    expect(graph.getOutgoingEdges(registeredButton!.id).some((edge) => edge.kind === 'references' && edge.target === myButton!.id)).toBe(true);
    expect(graph.getOutgoingEdges(invalidOtherModelInstance!.id).some((edge) => edge.kind === 'references' && edge.target === otherModel!.id)).toBe(false);
  });

  it('does not let C++ context properties steal shadowed QML names', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'main.cpp'),
      `#include <QObject>
#include <QQmlApplicationEngine>
#include <QQmlContext>

class ViewModel : public QObject {
  Q_OBJECT

public:
  Q_INVOKABLE void refresh();
};

void ViewModel::refresh() {}

int main() {
  QQmlApplicationEngine engine;
  ViewModel vm;
  engine.rootContext()->setContextProperty("viewModel", &vm);
  return 0;
}
`
    );
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  id: root
  property var viewModel: ({ refresh: function() {} })

  Component.onCompleted: {
    viewModel.refresh()
  }

  Connections {
    target: viewModel
    function onRefresh() {
      viewModel.refresh()
    }
  }
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    const onCompleted = graph.getNodesByName('Component.onCompleted').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
    const onRefresh = graph.getNodesByName('onRefresh').find((n) => n.kind === 'method' && n.filePath === 'Main.qml');
    const connections = graph.getNodesByKind('component').find((n) => n.signature === 'Connections' && n.filePath === 'Main.qml');
    const viewModelClass = graph.getNodesByName('ViewModel').find((n) => n.kind === 'class' && n.filePath === 'main.cpp');
    const viewModelRefresh = graph.getNodesByName('refresh').find((n) => n.kind === 'method' && n.qualifiedName.endsWith('ViewModel::refresh'));

    expect(onCompleted).toBeDefined();
    expect(onRefresh).toBeDefined();
    expect(connections).toBeDefined();
    expect(viewModelClass).toBeDefined();
    expect(viewModelRefresh).toBeDefined();

    expect(graph.getOutgoingEdges(onCompleted!.id).some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(false);
    expect(graph.getOutgoingEdges(onRefresh!.id).some((edge) => edge.kind === 'calls' && edge.target === viewModelRefresh!.id)).toBe(false);
    expect(graph.getOutgoingEdges(connections!.id).some((edge) => edge.kind === 'references' && edge.target === viewModelClass!.id)).toBe(false);
  });

  it('uses the QML Qt framework resolver for QML-specific cross-file references', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'Main.qml'),
      `import QtQuick

Item {
  id: root
}
`
    );

    const graph = cg!;
    await graph.indexAll();

    expect(graph.getDetectedFrameworks()).toContain('qt');
    expect(graph.getDetectedFrameworks()).not.toContain('qml-qt');
  });
});
