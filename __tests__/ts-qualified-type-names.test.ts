/**
 * The last name of a TypeScript type written qualified — `React.ReactNode`,
 * `TChat.ChatMessage`, `SectionKind.Legend` — is a member of what its qualifier
 * names, never a project declaration that only shares the word. Both
 * extractors record the last name alone, and name matching bound it by word:
 * outline's `React.ReactNode` annotations reached its own editor `class
 * ReactNode`, excalidraw's `TChat.ChatMessage` a `ChatMessage` component,
 * signoz's `EQueryType.CLICKHOUSE` another enum's `CLICKHOUSE`, and bbb's
 * `PluginSdk.Meeting` the app's own `Meeting` interface.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import type { Node } from '../src/types';

let root: string;
let cg: CodeGraph;

const FILES: Record<string, string> = {
  'package.json': JSON.stringify({ name: 'app', private: true, dependencies: { react: '^18.0.0', yjs: '^13.0.0' } }),
  'tsconfig.json': JSON.stringify({ compilerOptions: { jsx: 'react-jsx', strict: true } }),
  // Namesakes of the members the files below name through a qualifier.
  'src/editor/nodes/ReactNode.ts': `export default class ReactNode {
  render(): string {
    return "node";
  }
}
`,
  'src/editor/nodes/Doc.ts': `export class Doc {
  title = "";
}
`,
  'src/components/ChatMessage.tsx': `export function ChatMessage({ text }: { text: string }) {
  return <li>{text}</li>;
}
`,
  'src/explorer/views.ts': `export enum ExplorerViews {
  CLICKHOUSE = "clickhouse",
  LIST = "list",
}
`,
  'src/models/Group.ts': `export default class Group {
  name = "";
}
`,
  // What the qualifiers name.
  'src/types/dashboard.ts': `export enum EQueryType {
  CLICKHOUSE = "clickhouse",
  PROM = "promql",
}
`,
  'src/chat/types.ts': `export namespace TChat {
  export type ChatMessage = {
    id: string;
    text: string;
  };

  export type ChatHistory = {
    messages: ChatMessage[];
  };
}
`,
  'src/api/schema.ts': `export type UsersListReq = {
  limit: number;
};
`,
  'src/shared/types.ts': `export enum UnfurlResourceType {
  Group = "group",
  Document = "document",
}
`,
  'src/typings/express.d.ts': `declare global {
  namespace Express {
    interface User {
      id: string;
    }
  }
}

export {};
`,
  'src/typings/vscode.d.ts': `declare module "vscode" {
  export interface TextDocument {
    uri: string;
  }
}
`,
  'src/typings/passport.d.ts': `declare module "koa-passport" {
  namespace passport {
    interface PassportStatic {
      initialize(): void;
    }
  }

  const passport: passport.PassportStatic;
  export = passport;
}
`,
  // The repository's own package by its name, through a map this resolver doesn't read.
  'src/selfref.ts': `import * as App from "app/api/schema";

export type Query = App.UsersListReq;
`,
  // The files that write qualified types.
  'src/components/Panel.tsx': `import * as React from "react";
import * as Y from "yjs";
import type { TChat } from "../chat/types";
import { EQueryType } from "../types/dashboard";
import * as T from "../api/schema";

type Props = {
  children: React.ReactNode;
  doc: Y.Doc;
  messages: TChat.ChatMessage[];
  kind: EQueryType.CLICKHOUSE;
  query: T.UsersListReq;
};

export function Panel({ children }: Props) {
  return <section>{children}</section>;
}
`,
  'src/components/Legacy.tsx': `import React from "react";

type LegacyProps = {
  title: React.ReactNode;
};

export function Legacy({ title }: LegacyProps) {
  return <h1>{title}</h1>;
}
`,
  // React as a global (the UMD namespace @types/react declares), never imported.
  'src/components/Badge.tsx': `type BadgeProps = {
  label: React.ReactNode;
};

export function Badge({ label }: BadgeProps) {
  return <span>{label}</span>;
}
`,
  'src/unfurl.ts': `import Group from "./models/Group";
import { UnfurlResourceType } from "./shared/types";

export type GroupUnfurl = {
  type: UnfurlResourceType.Group;
  group: Group;
};
`,
  'src/kinds.ts': `enum Kind {
  Line = "line",
  Bar = "bar",
}

namespace Shapes {
  export interface Circle {
    radius: number;
  }
}

export type LineKind = Kind.Line;
export type Round = Shapes.Circle;
`,
  'src/auth.ts': `export function currentUser(user: Express.User): string {
  return user.id;
}
`,
  'src/extension.ts': `import * as vscode from "vscode";

export function uriOf(doc: vscode.TextDocument): string {
  return doc.uri;
}
`,
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ts-qualified-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

function node(file: string, name: string, kind?: string): Node {
  const found = cg.getNodesInFile(file).filter((n) => n.name === name && (!kind || n.kind === kind));
  expect(found, `${kind ?? 'node'} ${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** Where a node's `references` edges named `name` go: `kind:qualifiedName@file`. */
function targets(from: Node, name: string): string[] {
  return cg.getOutgoingEdges(from.id)
    .filter((e) => e.kind === 'references' && e.metadata?.refName === name)
    .map((e) => {
      const target = cg.getNode(e.target)!;
      return `${target.kind}:${target.qualifiedName}@${target.filePath}`;
    })
    .sort();
}

describe('the last name of a qualified type', () => {
  it('is nothing of the project for a member of a package', () => {
    const props = node('src/components/Panel.tsx', 'Props', 'type_alias');
    expect(targets(props, 'ReactNode')).toEqual([]);
    expect(targets(props, 'Doc')).toEqual([]);
    const legacy = node('src/components/Legacy.tsx', 'LegacyProps', 'type_alias');
    expect(targets(legacy, 'ReactNode')).toEqual([]);
  });

  it('is nothing of the project for a member of a global namespace the project does not declare', () => {
    const badge = node('src/components/Badge.tsx', 'BadgeProps', 'type_alias');
    expect(targets(badge, 'ReactNode')).toEqual([]);
  });

  it("is the imported namespace's member, not a component of its name", () => {
    const props = node('src/components/Panel.tsx', 'Props', 'type_alias');
    expect(targets(props, 'ChatMessage')).toEqual(['type_alias:ChatMessage@src/chat/types.ts']);
  });

  it("is the imported enum's member, not another enum's", () => {
    const props = node('src/components/Panel.tsx', 'Props', 'type_alias');
    expect(targets(props, 'CLICKHOUSE')).toEqual(['enum_member:EQueryType::CLICKHOUSE@src/types/dashboard.ts']);
  });

  it("is the export of the module a namespace import names", () => {
    const props = node('src/components/Panel.tsx', 'Props', 'type_alias');
    expect(targets(props, 'UsersListReq')).toEqual(['type_alias:UsersListReq@src/api/schema.ts']);
  });

  it("is the qualifier's member even when the file imports the last name too", () => {
    const unfurl = node('src/unfurl.ts', 'GroupUnfurl', 'type_alias');
    expect(targets(unfurl, 'Group')).toEqual([
      'class:Group@src/models/Group.ts',
      'enum_member:UnfurlResourceType::Group@src/shared/types.ts',
    ]);
  });

  it("is the member of an enum or a namespace the file declares", () => {
    expect(targets(node('src/kinds.ts', 'LineKind', 'type_alias'), 'Line')).toEqual(['enum_member:Kind::Line@src/kinds.ts']);
    expect(targets(node('src/kinds.ts', 'Round', 'type_alias'), 'Circle')).toEqual(['interface:Circle@src/kinds.ts']);
  });

  it('is the member of a global namespace the project declares', () => {
    expect(targets(node('src/auth.ts', 'currentUser'), 'User')).toEqual(['interface:User@src/typings/express.d.ts']);
  });

  it('is the member of a package module the project declares', () => {
    expect(targets(node('src/extension.ts', 'uriOf'), 'TextDocument')).toEqual(['interface:TextDocument@src/typings/vscode.d.ts']);
  });

  it("is the member of a namespace a declared module's body declares, for the module's own declarations", () => {
    expect(targets(node('src/typings/passport.d.ts', 'passport'), 'PassportStatic')).toEqual(['interface:PassportStatic@src/typings/passport.d.ts']);
  });

  it("is left to the name strategies through the repository's own package, which no manifest declares", () => {
    expect(targets(node('src/selfref.ts', 'Query', 'type_alias'), 'UsersListReq')).toEqual(['type_alias:UsersListReq@src/api/schema.ts']);
  });
});
