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
});
