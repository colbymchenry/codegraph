/**
 * A type annotation in a .tsx file names a type, never a component elsewhere,
 * and a type alias or interface the file declares beside a component or value
 * of the same name is what its annotations name. The React resolver's
 * component lookup ran before name matching, so annotations went to
 * components: outline's InputSelect.tsx declares `type Option` and its
 * annotations linked to the `Option` component of Export/ExportDialog.tsx;
 * bigbluebutton's modalController.tsx declares `type ModalRegistration` beside
 * a `ModalRegistration` component and its annotations linked to the component;
 * mastodon's `<Item>` type parameters linked to an `Item` class.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

const roots: string[] = [];
const graphs: CodeGraph[] = [];

async function index(files: Record<string, string>): Promise<CodeGraph> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-react-own-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  const cg = await CodeGraph.init(root, { index: true });
  graphs.push(cg);
  return cg;
}

const PACKAGE = JSON.stringify({ name: 'app', private: true, dependencies: { react: '^18.0.0', 'styled-components': '^6.0.0' } });

/** The components folder's namesakes of the names the files below declare themselves. */
const NAMESAKES: Record<string, string> = {
  'app/components/Emoji.tsx': `import styled from "styled-components";

type Props = { size?: number };

export const Emoji = styled.span<Props>\`
  font-size: \${({ size }) => size ?? 16}px;
\`;
`,
  'app/components/Export/ExportDialog.tsx': `export function Option({ label }: { label: string }) {
  return <li>{label}</li>;
}
`,
  'app/features/explore/components/Story.tsx': `export function Story({ title }: { title: string }) {
  return <article>{title}</article>;
}
`,
  'app/components/Mode.tsx': `export function Mode({ label }: { label: string }) {
  return <span>{label}</span>;
}
`,
  'app/pages/profile.tsx': `export function Entry({ label }: { label: string }) {
  return <dt>{label}</dt>;
}
`,
};

const FILES: Record<string, string> = {
  'package.json': PACKAGE,
  'app/editor/components/SuggestionsMenu.tsx': `export type Props<T> = {
  items: T[];
  renderMenuItem: (item: T) => unknown;
  search?: string;
};

export default function SuggestionsMenu<T>(props: Props<T>) {
  return <ul>{props.items.length}</ul>;
}
`,
  'app/editor/components/EmojiMenu.tsx': `import type { Props as SuggestionsMenuProps } from "./SuggestionsMenu";

type Emoji = {
  name: string;
  emoji: string;
};

type Props = Omit<
  SuggestionsMenuProps<Emoji>,
  "renderMenuItem" | "items"
>;

export default function EmojiMenu(props: Props) {
  return <div>{props.search}</div>;
}
`,
  'app/components/primitives/SplitButton.tsx': `interface Option {
  label: string;
  onClick: () => void;
}

type Props = {
  options: Option[];
};

export function SplitButton({ options }: Props) {
  return <div>{options.length}</div>;
}
`,
  'app/components/button/button.stories.tsx': `import type { Meta, StoryObj } from "@storybook/react";

const meta = {
  title: "Button",
} satisfies Meta;

export default meta;

type Story = StoryObj<typeof meta>;

export const Primary: Story = {
  args: { label: "Save" },
};
`,
  // A type and a component of the same name: bigbluebutton's modalController.tsx.
  'app/core/singletons/modalController.tsx': `type ModalRegistration = {
  id: string;
  priority: number;
};

type ModalState = {
  byKey: Record<string, ModalRegistration>;
};

export const state: ModalState = { byKey: {} };

export function register(reg: ModalRegistration) {
  state.byKey[reg.id] = reg;
}

export const ModalRegistration = ({ id }: { id: string }) => {
  register({ id, priority: 0 });
  return null;
};

export function Host() {
  return ModalRegistration({ id: "host" });
}
`,
  // A type and a value of the same name, the value wrapping a component.
  'app/scenes/Toolbar.tsx': `import { observer } from "mobx-react";

type Toolbar = {
  items: string[];
};

type Props = {
  toolbar: Toolbar;
};

function ToolbarView({ toolbar }: Props) {
  return <div>{toolbar.items.length}</div>;
}

const Toolbar = observer(ToolbarView);

export default Toolbar;
`,
  // A component's own type parameter, named like a component elsewhere.
  'app/components/ui/table/table.tsx': `type TableProps<Entry> = {
  data: Entry[];
};

export const Table = <Entry extends { id: string }>({ data }: TableProps<Entry>) => {
  return <table>{data.length}</table>;
};
`,
  'app/editor/components/ModeToggle.tsx': `enum Mode {
  Edit = "edit",
  Read = "read",
}

type Props = {
  mode: Mode;
};

export default function ModeToggle({ mode }: Props) {
  return <button>{mode === Mode.Edit ? "Read" : "Edit"}</button>;
}
`,
  ...NAMESAKES,
};

let cg: CodeGraph;
let bare: CodeGraph;

beforeAll(async () => {
  cg = await index(FILES);
  // The same project without the components folder's namesakes.
  bare = await index(Object.fromEntries(Object.entries(FILES).filter(([rel]) => !(rel in NAMESAKES))));
}, 120_000);

afterAll(() => {
  for (const g of graphs) g.close();
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function node(g: CodeGraph, file: string, name: string, kind?: string): Node {
  const found = g.getNodesInFile(file).filter((n) => n.name === name && (!kind || n.kind === kind));
  expect(found, `${kind ?? 'node'} ${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** Where a node's references named `name` go, `kind:name@file`, and which strategy resolved each. */
function referencesFrom(g: CodeGraph, from: Node, name: string, edgeKind = 'references') {
  return g.getOutgoingEdges(from.id)
    .filter((e) => e.kind === edgeKind && e.metadata?.refName === name)
    .map((e) => {
      const target = g.getNode(e.target)!;
      return { to: `${target.kind}:${target.name}@${target.filePath}`, resolvedBy: e.metadata?.resolvedBy };
    });
}

describe('a name a .tsx file declares itself', () => {
  it('has the namesake components the cases below need', () => {
    expect(node(cg, 'app/components/Emoji.tsx', 'Emoji').kind).toBe('component');
    expect(node(cg, 'app/components/Export/ExportDialog.tsx', 'Option').kind).toBe('function');
    expect(node(cg, 'app/features/explore/components/Story.tsx', 'Story').kind).toBe('function');
    expect(node(cg, 'app/components/Mode.tsx', 'Mode').kind).toBe('function');
    expect(node(cg, 'app/pages/profile.tsx', 'Entry').kind).toBe('function');
  });

  it('is the type alias a type annotation names, not a styled component of that name', () => {
    const props = node(cg, 'app/editor/components/EmojiMenu.tsx', 'Props', 'type_alias');
    expect(referencesFrom(cg, props, 'Emoji').map((r) => r.to)).toEqual(['type_alias:Emoji@app/editor/components/EmojiMenu.tsx']);
  });

  it('is the interface a type annotation names', () => {
    const props = node(cg, 'app/components/primitives/SplitButton.tsx', 'Props', 'type_alias');
    expect(referencesFrom(cg, props, 'Option').map((r) => r.to)).toEqual(['interface:Option@app/components/primitives/SplitButton.tsx']);
  });

  it("is a story file's own Story type", () => {
    const primary = node(cg, 'app/components/button/button.stories.tsx', 'Primary');
    expect(referencesFrom(cg, primary, 'Story').map((r) => r.to)).toEqual(['type_alias:Story@app/components/button/button.stories.tsx']);
  });

  it('is the enum a type annotation names', () => {
    const props = node(cg, 'app/editor/components/ModeToggle.tsx', 'Props', 'type_alias');
    expect(referencesFrom(cg, props, 'Mode').map((r) => r.to)).toEqual(['enum:Mode@app/editor/components/ModeToggle.tsx']);
  });

  it("is a type parameter, never another file's component", () => {
    const file = 'app/components/ui/table/table.tsx';
    expect(referencesFrom(cg, node(cg, file, 'Table'), 'Entry')).toEqual([]);
    expect(referencesFrom(cg, node(cg, file, 'TableProps'), 'Entry')).toEqual([]);
  });

  // (Name matching's confidence still counts the namesake as a candidate.)
  it('resolves as it does with no namesake component in the project', () => {
    const cases: Array<[string, string, string]> = [
      ['app/editor/components/EmojiMenu.tsx', 'Props', 'Emoji'],
      ['app/components/primitives/SplitButton.tsx', 'Props', 'Option'],
      ['app/components/button/button.stories.tsx', 'Primary', 'Story'],
      ['app/editor/components/ModeToggle.tsx', 'Props', 'Mode'],
      ['app/components/ui/table/table.tsx', 'Table', 'Entry'],
    ];
    for (const [file, from, name] of cases) {
      expect(referencesFrom(cg, node(cg, file, from), name), `${from} -> ${name}`)
        .toEqual(referencesFrom(bare, node(bare, file, from), name));
    }
  });

  it('is the type, in a type annotation, when the file also declares a component of that name', () => {
    const file = 'app/core/singletons/modalController.tsx';
    const type = 'type_alias:ModalRegistration@app/core/singletons/modalController.tsx';
    expect(referencesFrom(cg, node(cg, file, 'ModalState'), 'ModalRegistration').map((r) => r.to)).toEqual([type]);
    expect(referencesFrom(cg, node(cg, file, 'register'), 'ModalRegistration').map((r) => r.to)).toEqual([type]);
  });

  it('is the type, in a type annotation, when the file also declares a value of that name', () => {
    const file = 'app/scenes/Toolbar.tsx';
    expect(referencesFrom(cg, node(cg, file, 'Props', 'type_alias'), 'Toolbar').map((r) => r.to))
      .toEqual(['type_alias:Toolbar@app/scenes/Toolbar.tsx']);
  });

  it('is the component, where code calls it', () => {
    const file = 'app/core/singletons/modalController.tsx';
    expect(referencesFrom(cg, node(cg, file, 'Host'), 'ModalRegistration', 'calls').map((r) => r.to))
      .toEqual(['function:ModalRegistration@app/core/singletons/modalController.tsx']);
  });
});
