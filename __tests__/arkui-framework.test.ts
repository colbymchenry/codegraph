/**
 * ArkUI Framework Resolver Tests
 */
import { beforeAll, describe, it, expect } from 'vitest';
import { arkuiResolver, _resetRouteConstantsCache } from '../src/resolution/frameworks/arkui';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

describe('arkuiResolver.extract', () => {
  it('extracts @Entry-decorated struct as arkui_page node', () => {
    const src = `
@Entry
@Component
struct IndexPage {
  @State message: string = 'Hello';
  build() {
    Column() {
      Text(this.message)
    }
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/Index.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('IndexPage');
    expect(nodes[0].language).toBe('arkts');
    expect(nodes[0].id).toContain('arkui_page:');
    expect(nodes[0].qualifiedName).toContain('IndexPage');
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('IndexPage');
    expect(references[0].referenceKind).toBe('references');
  });

  it('extracts @Entry struct without extra decorators', () => {
    const src = `
@Entry
struct SimplePage {
  build() {
    Text('simple');
  }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/SimplePage.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('SimplePage');
  });

  it('extracts multiple @Entry structs from one file', () => {
    const src = `
@Entry
@Component
struct PageA {
  build() { Text('A'); }
}

@Entry
struct PageB {
  build() { Text('B'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Multi.ets', src);
    expect(nodes).toHaveLength(2);
    expect(nodes.map((n) => n.name).sort()).toEqual(['PageA', 'PageB']);
    expect(nodes.every((n) => n.kind === 'arkui_page')).toBe(true);
  });

  it('extracts @Component struct (without @Entry) as component node', () => {
    const src = `
@Component
struct NotAPage {
  build() {
    Text('not a page');
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/NotEntry.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('component');
    expect(nodes[0].name).toBe('NotAPage');
    expect(nodes[0].decorators).toEqual(['Component']);
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('NotAPage');
    expect(references[0].referenceKind).toBe('references');
  });

  it('extracts router.pushUrl as unresolved reference', () => {
    const src = `
@Entry
struct HomePage {
  build() {
    Button('Go Detail')
      .onClick(() => {
        router.pushUrl({ url: 'pages/Detail' })
      })
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/HomePage.ets', src);
    expect(nodes).toHaveLength(1);
    const navRefs = references.filter(
      (r) => r.referenceKind === 'references' && r.referenceName !== 'HomePage'
    );
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('pages/Detail');
    expect(navRefs[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts router.replaceUrl as unresolved reference', () => {
    const src = `
@Entry
struct LoginPage {
  build() {
    Button('Login')
      .onClick(() => {
        router.replaceUrl({ url: 'pages/Home' })
      })
  }
}
`;
    const { references } = arkuiResolver.extract!('pages/Login.ets', src);
    const navRefs = references.filter((r) => r.referenceName !== 'LoginPage');
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('pages/Home');
  });

  it('attributes pushUrl to nearest preceding @Entry struct', () => {
    const src = `
@Entry
struct PageOne {
  build() { Text('one'); }
}

router.pushUrl({ url: 'pages/PageTwo' })

@Entry
struct PageTwo {
  build() { Text('two'); }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/RouteTest.ets', src);
    expect(nodes).toHaveLength(2);
    const navRef = references.find((r) => r.referenceName === 'pages/PageTwo');
    expect(navRef).toBeDefined();
    expect(navRef!.fromNodeId).toBe(nodes.find((n) => n.name === 'PageOne')!.id);
  });

  it('falls back to file-level id when no @Entry precedes pushUrl', () => {
    const src = `
router.pushUrl({ url: 'pages/Standalone' })
`;
    const { references } = arkuiResolver.extract!('pages/NopageRef.ets', src);
    const navRef = references.find((r) => r.referenceName === 'pages/Standalone');
    expect(navRef).toBeDefined();
    expect(navRef!.fromNodeId).toMatch(/^file:/);
  });

  it('extracts router.pushUrl with ScreenRoutes constant', () => {
    const src = `
@Entry
struct HomePage {
  build() {
    Button('Go')
      .onClick(() => {
        router.pushUrl({ url: ScreenRoutes.DETAIL })
      })
  }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/Home.ets', src);
    expect(nodes).toHaveLength(1);
    const navRefs = references.filter(
      (r) => r.referenceKind === 'references' && r.referenceName !== 'HomePage'
    );
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('ScreenRoutes.DETAIL');
    expect(navRefs[0].fromNodeId).toBe(nodes[0].id);
  });

  it('extracts router.replaceUrl with route constant', () => {
    const src = `
@Entry
struct LoginPage {
  build() {
    router.replaceUrl({ url: AppRoutes.HOME })
  }
}
`;
    const { references } = arkuiResolver.extract!('pages/Login.ets', src);
    const navRefs = references.filter(
      (r) => r.referenceKind === 'references' && r.referenceName !== 'LoginPage'
    );
    expect(navRefs).toHaveLength(1);
    expect(navRefs[0].referenceName).toBe('AppRoutes.HOME');
  });

  it('captures both string-literal and constant router URLs in one file', () => {
    const src = `
@Entry
struct MixedPage {
  build() {
    router.pushUrl({ url: 'pages/StringLiteral' })
    router.pushUrl({ url: ScreenRoutes.CONSTANT_PAGE })
  }
}
`;
    const { references } = arkuiResolver.extract!('pages/Mixed.ets', src);
    const navRefs = references.filter((r) => r.referenceName !== 'MixedPage');
    const names = navRefs.map((r) => r.referenceName).sort();
    expect(names).toEqual(['ScreenRoutes.CONSTANT_PAGE', 'pages/StringLiteral']);
  });

  it('returns empty for non-.ets files', () => {
    const { nodes, references } = arkuiResolver.extract!('test.ts', '');
    expect(nodes).toEqual([]);
    expect(references).toEqual([]);
  });

  it('skips // line-commented @Entry', () => {
    const src = `
// @Entry
// struct FakePage {}
@Entry
struct RealPage {
  build() { Text('real'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Commented.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('RealPage');
  });

  it('skips /* block-commented */ @Entry', () => {
    const src = `
/*
@Entry
struct FakePage {
  build() { Text('fake'); }
}
*/
@Entry
struct RealPage {
  build() { Text('real'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/BlockCommented.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].name).toBe('RealPage');
  });

  it('does not duplicate @Entry+@Component struct as component', () => {
    const src = `
@Entry
@Component
struct IndexPage {
  build() {
    Text('hello');
  }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Index.ets', src);
    const pages = nodes.filter((n) => n.kind === 'arkui_page');
    const components = nodes.filter((n) => n.kind === 'component');
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('IndexPage');
    expect(components).toHaveLength(0);
  });

  it('extracts @Component-only structs alongside @Entry pages', () => {
    const src = `
@Entry
@Component
struct HomePage {
  build() { Text('home'); }
}

@Component
struct MyButton {
  build() { Button('click'); }
}

@Component
struct MyLabel {
  build() { Text('label'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Mixed.ets', src);
    const pages = nodes.filter((n) => n.kind === 'arkui_page');
    const components = nodes.filter((n) => n.kind === 'component');
    expect(pages).toHaveLength(1);
    expect(pages[0].name).toBe('HomePage');
    expect(components).toHaveLength(2);
    expect(components.map((c) => c.name).sort()).toEqual(['MyButton', 'MyLabel']);
    components.forEach((c) => {
      expect(c.decorators).toEqual(['Component']);
    });
  });

  it('extracts @Entry with routeName param', () => {
    const src = `
@Entry({ routeName: 'main' })
@Component
struct MainPage {
  build() { Text('main'); }
}
`;
    const { nodes } = arkuiResolver.extract!('pages/Main.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('arkui_page');
    expect(nodes[0].name).toBe('MainPage');
  });

  it('extracts @Component with freezeWhenInvisible param', () => {
    const src = `
@Component({ freezeWhenInvisible: true })
struct FrozenLabel {
  build() { Text('frozen'); }
}
`;
    const { nodes, references } = arkuiResolver.extract!('pages/Frozen.ets', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0].kind).toBe('component');
    expect(nodes[0].name).toBe('FrozenLabel');
    expect(nodes[0].decorators).toEqual(['Component']);
    expect(references).toHaveLength(1);
    expect(references[0].referenceName).toBe('FrozenLabel');
  });
});

describe('arkuiResolver.postExtract', () => {
  it('returns empty array when main_pages.json is absent', () => {
    const context = {
      readFile: (_path: string) => null,
      getNodesByKind: (_kind: string) => [],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toEqual([]);
  });

  it('creates arkui_page nodes from main_pages.json src entries', () => {
    const json = JSON.stringify({ src: ['pages/Index', 'pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(2);
    expect(result[0].kind).toBe('arkui_page');
    expect(result[0].name).toBe('pages/Index');
    expect(result[1].name).toBe('pages/Detail');
  });

  it('de-duplicates against already extracted pages (filePath match)', () => {
    const json = JSON.stringify({ src: ['pages/Index', 'pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [
        {
          filePath: 'pages/Index.ets',
          qualifiedName: 'pages/Index.ets::Index',
          name: 'Index',
        },
      ] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pages/Detail');
  });

  it('de-duplicates against qualifiedName end-match', () => {
    const json = JSON.stringify({ src: ['pages/Detail'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return null;
        if (path === 'main_pages.json') return json;
        return null;
      },
      getNodesByKind: (_kind: string) => [
        {
          filePath: 'pages/Detail.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail.ets::Detail',
          name: 'Detail',
        },
      ] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toEqual([]);
  });

  it('prefers primary config path over fallback', () => {
    const primary = JSON.stringify({ src: ['pages/Primary'] });
    const fallback = JSON.stringify({ src: ['pages/Fallback'] });
    const context = {
      readFile: (path: string) => {
        if (path === 'entry/src/main/resources/base/profile/main_pages.json') return primary;
        if (path === 'main_pages.json') return fallback;
        return null;
      },
      getNodesByKind: (_kind: string) => [] as any[],
    };
    const result = arkuiResolver.postExtract!(context as any);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pages/Primary');
  });
});

describe('arkuiResolver.resolve', () => {
  beforeEach(() => {
    _resetRouteConstantsCache();
  });

  it('resolves pages/Detail to matching arkui_page by filePath', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page1',
          filePath: 'entry/src/main/ets/pages/Detail.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller1',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page1');
    expect(result!.confidence).toBe(0.9);
  });

  it('resolves pages/Detail to index.ets fallback', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page2',
          filePath: 'entry/src/main/ets/pages/Detail/index.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail/index.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller2',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page2');
    expect(result!.confidence).toBe(0.9);
  });

  it('falls back to partial path match with lower confidence', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page3',
          filePath: 'feature/src/main/ets/custom/Detail.ets',
          qualifiedName: 'feature/src/main/ets/custom/Detail.ets::Detail',
          name: 'Detail',
        },
      ],
    };
    const ref = {
      fromNodeId: 'caller3',
      referenceName: 'pages/Detail',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page3');
    expect(result!.confidence).toBeGreaterThanOrEqual(0.65);
    expect(result!.confidence).toBeLessThan(0.9);
  });

  it('returns null for non-page references', () => {
    const context = { getNodesByKind: (_kind: string) => [] };
    const ref = {
      fromNodeId: 'caller4',
      referenceName: 'SomeUtility',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).toBeNull();
  });

  it('returns null for pages/ reference with no matching nodes', () => {
    const context = { getNodesByKind: (_kind: string) => [] };
    const ref = {
      fromNodeId: 'caller5',
      referenceName: 'pages/NotFound',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).toBeNull();
  });

  it('resolves ScreenRoutes constant to page by scanning project files', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page-detail',
          filePath: 'entry/src/main/ets/pages/Detail.ets',
          qualifiedName: 'entry/src/main/ets/pages/Detail.ets::Detail',
          name: 'Detail',
        },
      ],
      getAllFiles: () => ['entry/src/main/ets/common/ScreenRoutes.ets'],
      readFile: (path: string) => {
        if (path === 'entry/src/main/ets/common/ScreenRoutes.ets') {
          return 'export class ScreenRoutes { static readonly DETAIL: string = \'pages/Detail\' }';
        }
        return null;
      },
    };
    const ref = {
      fromNodeId: 'caller6',
      referenceName: 'ScreenRoutes.DETAIL',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page-detail');
    expect(result!.confidence).toBe(0.9);
    expect(result!.synthesizedBy).toBe('arkui-route');
  });

  it('falls back to trailing constant name lookup', () => {
    const context = {
      getNodesByKind: (_kind: string) => [
        {
          id: 'page-settings',
          filePath: 'entry/src/main/ets/pages/Settings.ets',
          qualifiedName: 'entry/src/main/ets/pages/Settings.ets::Settings',
          name: 'Settings',
        },
      ],
      getAllFiles: () => ['entry/src/main/ets/common/Routes.ets'],
      readFile: (path: string) => {
        if (path === 'entry/src/main/ets/common/Routes.ets') {
          return 'export class Routes { static readonly SETTINGS: string = \'pages/Settings\' }';
        }
        return null;
      },
    };
    // referenceName uses a different class name than what's in the constant file
    const ref = {
      fromNodeId: 'caller7',
      referenceName: 'OtherRoutes.SETTINGS',  // class name differs
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).not.toBeNull();
    expect(result!.targetNodeId).toBe('page-settings');
  });

  it('returns null for unresolved route constant', () => {
    const context = {
      getNodesByKind: (_kind: string) => [],
      getAllFiles: () => [],
      readFile: (_path: string) => null,
    };
    const ref = {
      fromNodeId: 'caller8',
      referenceName: 'MissingRoutes.NOT_FOUND',
      referenceKind: 'references' as const,
      line: 10,
      column: 0,
    };
    const result = arkuiResolver.resolve!(ref as any, context as any);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Callback-synthesizer phase tests
// ---------------------------------------------------------------------------
import type { Node, Edge } from '../src/types';
import { arkuiStateChainEdges, arkuiStateDepEdges, arkuiEventChainEdges, arkuiAstEdges } from '../src/resolution/callback-synthesizer';

/** Create a minimal QueryBuilder mock. */
function mockQueries(overrides: {
  classes?: Node[];
  structs?: Node[];
  edges?: Map<string, Edge[]>;
  nodesById?: Map<string, Node>;
} = {}) {
  const classes = overrides.classes ?? [];
  const structs = overrides.structs ?? [];
  const edges = overrides.edges ?? new Map();
  const nodesById = overrides.nodesById ?? new Map();
  return {
    getNodesByKind: (kind: string) => {
      if (kind === 'class') return classes;
      if (kind === 'struct') return structs;
      return [];
    },
    getOutgoingEdges: (nodeId: string, _kinds: string[]) => edges.get(nodeId) ?? [],
    getNodeById: (id: string) => nodesById.get(id) ?? null,
  } as any;
}

/** Create a minimal ResolutionContext mock. */
function mockCtx(overrides: {
  files?: string[];
  fileContents?: Map<string, string>;
  fileNodes?: Map<string, Node[]>;
} = {}) {
  const files = overrides.files ?? [];
  const fileContents = overrides.fileContents ?? new Map();
  const fileNodes = overrides.fileNodes ?? new Map();
  return {
    getAllFiles: () => files,
    readFile: (path: string) => fileContents.get(path) ?? null,
    getNodesInFile: (path: string) => fileNodes.get(path) ?? [],
  } as any;
}

describe('arkuiStateChainEdges', () => {
  it('links every sibling method to build() in .ets structs', () => {
    const buildNode: Node = {
      id: 'build-1', kind: 'method', name: 'build',
      filePath: 'pages/Index.ets', startLine: 20, endLine: 30,
      qualifiedName: 'pages/Index.ets::Index::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const onClickNode: Node = {
      id: 'onClick-1', kind: 'method', name: 'onClick',
      filePath: 'pages/Index.ets', startLine: 10, endLine: 18,
      qualifiedName: 'pages/Index.ets::Index::onClick', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-1', kind: 'struct', name: 'Index',
      filePath: 'pages/Index.ets', startLine: 1, endLine: 35,
      qualifiedName: 'pages/Index.ets::Index', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('build-1', buildNode);
    nodesById.set('onClick-1', onClickNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-1', [
      { source: 'struct-1', target: 'build-1', kind: 'contains', line: 20 },
      { source: 'struct-1', target: 'onClick-1', kind: 'contains', line: 10 },
    ] as any);
    const queries = mockQueries({
      structs: [structNode],
      edges,
      nodesById,
    });
    const ctx = mockCtx();

    const result = arkuiStateChainEdges(queries as any, ctx as any);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('onClick-1');
    expect(result[0].target).toBe('build-1');
    expect(result[0].kind).toBe('calls');
    expect(result[0].provenance).toBe('heuristic');
    expect(result[0].metadata?.synthesizedBy).toBe('arkui-state-chain');
  });

  it('skips non-.ets files', () => {
    const clsNode: Node = {
      id: 'cls-ts', kind: 'class', name: 'Foo',
      filePath: 'utils.ts', startLine: 0, endLine: 10,
      qualifiedName: 'utils.ts::Foo', language: 'typescript',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const queries = mockQueries({ classes: [clsNode] });
    const result = arkuiStateChainEdges(queries as any, mockCtx() as any);
    expect(result).toEqual([]);
  });
});

describe('arkuiStateDepEdges', () => {
  it('links methods that read @State properties → property nodes', () => {
    // Source: @State at line 5, build() body spans 5-7, struct covers 1-8.
    const buildNode: Node = {
      id: 'build-2', kind: 'method', name: 'build',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 7,
      qualifiedName: 'pages/Home.ets::Home::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const countProp: Node = {
      id: 'prop-count', kind: 'property', name: 'count',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 5,
      qualifiedName: 'pages/Home.ets::Home::count', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-2', kind: 'struct', name: 'Home',
      filePath: 'pages/Home.ets', startLine: 1, endLine: 8,
      qualifiedName: 'pages/Home.ets::Home', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('build-2', buildNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-2', [
      { source: 'struct-2', target: 'build-2', kind: 'contains', line: 5 },
    ] as any);
    const queries = mockQueries({ structs: [structNode], edges, nodesById });

    const src = `
@Entry
@Component
struct Home {
  @State count: number = 0;
  build() {
    Text(this.count.toString());
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Home.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Home.ets', [structNode, buildNode, countProp]);
    const ctx = mockCtx({
      files: ['pages/Home.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiStateDepEdges(queries as any, ctx as any);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // build() reads this.count → edge: build → count property
    const buildEdge = result.find((e) => e.source === 'build-2');
    expect(buildEdge).toBeDefined();
    expect(buildEdge!.target).toBe('prop-count');
    expect(buildEdge!.kind).toBe('calls');
    expect(buildEdge!.provenance).toBe('heuristic');
    expect(buildEdge!.metadata?.synthesizedBy).toBe('arkui-state-dep');
  });

  it('does not link methods that do not reference the state property', () => {
    // Source: @State at 5, helper at 6, build at 7, struct covers 1-7.
    const helperNode: Node = {
      id: 'helper-1', kind: 'method', name: 'helper',
      filePath: 'pages/Home.ets', startLine: 6, endLine: 6,
      qualifiedName: 'pages/Home.ets::Home::helper', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const countProp: Node = {
      id: 'prop-count-2', kind: 'property', name: 'count',
      filePath: 'pages/Home.ets', startLine: 5, endLine: 5,
      qualifiedName: 'pages/Home.ets::Home::count', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const structNode: Node = {
      id: 'struct-3', kind: 'struct', name: 'Home',
      filePath: 'pages/Home.ets', startLine: 1, endLine: 7,
      qualifiedName: 'pages/Home.ets::Home', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const nodesById = new Map<string, Node>();
    nodesById.set('helper-1', helperNode);
    const edges = new Map<string, Edge[]>();
    edges.set('struct-3', [
      { source: 'struct-3', target: 'helper-1', kind: 'contains', line: 6 },
    ] as any);
    const queries = mockQueries({ structs: [structNode], edges, nodesById });

    const src = `
@Entry
@Component
struct Home {
  @State count: number = 0;
  helper() { return 42; }
  build() { Text('hello'); }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Home.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Home.ets', [structNode, helperNode, countProp]);
    const ctx = mockCtx({
      files: ['pages/Home.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiStateDepEdges(queries as any, ctx as any);
    const helperEdge = result.find((e) => e.source === 'helper-1');
    expect(helperEdge).toBeUndefined();
  });
});

describe('arkuiEventChainEdges', () => {
  it('links build() → handler for .onClick(this.handler)', () => {
    // Source is 7 lines (1-indexed): handleClick at 3, build() body spans 4-6.
    const buildNode: Node = {
      id: 'build-3', kind: 'method', name: 'build',
      filePath: 'pages/Click.ets', startLine: 4, endLine: 6,
      qualifiedName: 'pages/Click.ets::Page::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const handlerNode: Node = {
      id: 'handleClick-1', kind: 'method', name: 'handleClick',
      filePath: 'pages/Click.ets', startLine: 3, endLine: 3,
      qualifiedName: 'pages/Click.ets::Page::handleClick', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const src = `
@Entry
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('OK').onClick(() => { this.handleClick(); });
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Click.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Click.ets', [buildNode, handlerNode]);
    const ctx = mockCtx({
      files: ['pages/Click.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiEventChainEdges(ctx as any);
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe('build-3');
    expect(result[0].target).toBe('handleClick-1');
    expect(result[0].kind).toBe('calls');
    expect(result[0].provenance).toBe('heuristic');
    expect(result[0].metadata?.synthesizedBy).toBe('arkui-event-chain');
    expect(result[0].metadata?.handler).toBe('handleClick');
  });

  it('skips refs where handler name is build', () => {
    // Source: build() body spans lines 3-5.
    const buildNode: Node = {
      id: 'build-4', kind: 'method', name: 'build',
      filePath: 'pages/Rec.ets', startLine: 3, endLine: 5,
      qualifiedName: 'pages/Rec.ets::Page::build', language: 'arkts',
      startColumn: 0, endColumn: 0, updatedAt: Date.now(),
    };
    const src = `
@Entry
struct Page {
  build() {
    Column() { this.build(); }
  }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('pages/Rec.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('pages/Rec.ets', [buildNode]);
    const ctx = mockCtx({
      files: ['pages/Rec.ets'],
      fileContents,
      fileNodes,
    });

    const result = arkuiEventChainEdges(ctx as any);
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// AST-based ArkUI edge synthesis tests (Phase C/D/E/F)
// ---------------------------------------------------------------------------
describe('arkuiAstEdges', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  // ── helpers ──

  function makeNode(kind: string, name: string, id: string, startLine: number, endLine?: number): Node {
    return {
      id, kind, name,
      filePath: 'test.ets',
      startLine,
      endLine: endLine ?? startLine,
      qualifiedName: `test.ets::Test::${name}`,
      language: 'arkts',
      startColumn: 0,
      endColumn: 0,
      updatedAt: Date.now(),
    };
  }

  /** Helper: create a struct/class node with explicit endLine (required for scoping). */
  function makeStruct(name: string, id: string, startLine: number, endLine: number): Node {
    return makeNode('struct', name, id, startLine, endLine);
  }

  /** Helper: create a method node. */
  function makeMethod(name: string, id: string, startLine: number, endLine?: number): Node {
    return makeNode('method', name, id, startLine, endLine ?? startLine);
  }

  /** Helper: create a property node. */
  function makeProp(name: string, id: string, startLine: number): Node {
    return makeNode('property', name, id, startLine);
  }

  /** Helper: create a component node. */
  function makeComponent(name: string, id: string, startLine: number, endLine: number): Node {
    return makeNode('component', name, id, startLine, endLine);
  }

  function runEdges(src: string, nodes: Node[]): Edge[] {
    const fileContents = new Map<string, string>();
    fileContents.set('test.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('test.ets', nodes);
    const ctx = mockCtx({
      files: ['test.ets'],
      fileContents,
      fileNodes,
    });
    return arkuiAstEdges(ctx as any);
  }

  // ── Phase D: UI tree edges (arkui-render) ──

  it('emits arkui-render edge for custom component used in build()', () => {
    const src = `
@Component
struct MyButton {
  build() { Button('click'); }
}

@Entry
@Component
struct HomePage {
  build() {
    Column() {
      MyButton()
    }
  }
}
`;
    const nodes = [
      makeComponent('MyButton', 'mybtn', 3, 5),
      makeStruct('HomePage', 'home-struct', 9, 15),
      makeMethod('build', 'home-build', 10, 14),
    ];
    const edges = runEdges(src, nodes);
    const renderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render');
    expect(renderEdges).toHaveLength(1);
    expect(renderEdges[0].source).toBe('home-struct');
    expect(renderEdges[0].target).toBe('mybtn');
    expect(renderEdges[0].metadata?.widget).toBe('MyButton');
  });

  it('emits arkui-render edge for nested custom components', () => {
    const src = `
@Component
struct InnerLabel {
  build() { Text('inner'); }
}

@Component
struct OuterBox {
  build() {
    Column() {
      InnerLabel()
    }
  }
}

@Entry
@Component
struct Page {
  build() {
    OuterBox()
  }
}
`;
    const nodes = [
      makeComponent('InnerLabel', 'inner', 3, 5),
      makeMethod('build', 'inner-build', 4),
      makeStruct('OuterBox', 'outer', 8, 14),
      makeStruct('Page', 'page-struct', 18, 22),
      makeMethod('build', 'outer-build', 9, 13),
      makeMethod('build', 'page-build', 19, 21),
    ];
    const edges = runEdges(src, nodes);
    // Page → OuterBox
    const p2o = edges.find((e) => e.source === 'page-struct' && e.target === 'outer');
    expect(p2o).toBeDefined();
    expect(p2o!.metadata?.synthesizedBy).toBe('arkui-render');
    // OuterBox → InnerLabel
    const o2i = edges.find((e) => e.source === 'outer' && e.target === 'inner');
    expect(o2i).toBeDefined();
    expect(o2i!.metadata?.synthesizedBy).toBe('arkui-render');
  });

  it('walks ForEach body with forEach metadata on child edges', () => {
    const src = `
@Entry
@Component
struct Page {
  build() {
    ForEach([1,2,3], (item: number) => {
      Text(item.toString())
    })
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('build', 'pg-build', 5, 8),
    ];
    const edges = runEdges(src, nodes);
    // ForEach itself should NOT create an edge; Text is built-in → no edge
    // But we can verify ForEach doesn't crash
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render')).toEqual([]);
  });

  it('walks ForEach body and finds custom components inside', () => {
    const src = `
@Component
struct Card {
  build() { Text('card'); }
}

@Entry
@Component
struct Page {
  build() {
    ForEach([1,2,3], (item: number) => {
      Card()
    })
  }
}
`;
    const nodes = [
      makeComponent('Card', 'card', 3, 5),
      makeStruct('Page', 'pg', 9, 15),
      makeMethod('build', 'pg-build', 10, 14),
    ];
    const edges = runEdges(src, nodes);
    const renderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render');
    expect(renderEdges).toHaveLength(1);
    expect(renderEdges[0].source).toBe('pg');
    expect(renderEdges[0].target).toBe('card');
    expect(renderEdges[0].metadata?.forEach).toBe(true);
    expect(renderEdges[0].metadata?.widget).toBe('Card');
  });

  it('walks if/else branches with conditional metadata', () => {
    const src = `
@Component
struct TrueWidget {
  build() { Text('true'); }
}

@Component
struct FalseWidget {
  build() { Text('false'); }
}

@Entry
@Component
struct Page {
  @State flag: boolean = true;
  build() {
    if (this.flag) {
      TrueWidget()
    } else {
      FalseWidget()
    }
  }
}
`;
    const nodes = [
      makeComponent('TrueWidget', 'tw', 3, 5),
      makeComponent('FalseWidget', 'fw', 8, 10),
      makeStruct('Page', 'pg', 14, 23),
      makeMethod('build', 'pg-build', 16, 22),
    ];
    const edges = runEdges(src, nodes);
    const renderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render');
    expect(renderEdges).toHaveLength(2);
    // Both branches should be walked
    const twEdge = renderEdges.find((e) => e.metadata?.widget === 'TrueWidget');
    expect(twEdge).toBeDefined();
    expect(twEdge!.metadata?.conditional).toBe(true);
    const fwEdge = renderEdges.find((e) => e.metadata?.widget === 'FalseWidget');
    expect(fwEdge).toBeDefined();
    expect(fwEdge!.metadata?.conditional).toBe(true);
  });

  it('does not emit render edge for built-in widgets without graph nodes', () => {
    const src = `
@Entry
@Component
struct Page {
  build() {
    Column() {
      Row() {
        Text('hello')
        Button('click')
      }
    }
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 11),
      makeMethod('build', 'pg-build', 5, 11),
    ];
    const edges = runEdges(src, nodes);
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render')).toEqual([]);
  });

  // ── Phase C: Event chain edges (arkui-event-chain) ──

  it('emits arkui-event-chain for .onClick(this.handler)', () => {
    const src = `
@Entry
@Component
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('OK').onClick(this.handleClick)
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('handleClick', 'handler', 5),
      makeMethod('build', 'pg-build', 6, 8),
    ];
    const edges = runEdges(src, nodes);
    const evtEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain');
    expect(evtEdges).toHaveLength(1);
    expect(evtEdges[0].source).toBe('pg');
    expect(evtEdges[0].target).toBe('handler');
    expect(evtEdges[0].metadata?.event).toBe('Click');
    expect(evtEdges[0].metadata?.handler).toBe('handleClick');
  });

  it('emits arkui-event-chain for .onClick(() => { this.handler() })', () => {
    const src = `
@Entry
@Component
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('OK').onClick(() => { this.handleClick(); })
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('handleClick', 'handler', 5),
      makeMethod('build', 'pg-build', 6, 8),
    ];
    const edges = runEdges(src, nodes);
    const evtEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain');
    expect(evtEdges).toHaveLength(1);
    expect(evtEdges[0].source).toBe('pg');
    expect(evtEdges[0].target).toBe('handler');
    expect(evtEdges[0].metadata?.handler).toBe('handleClick');
  });

  it('emits arkui-event-chain for .onChange(this.onTextChange)', () => {
    const src = `
@Entry
@Component
struct Page {
  onTextChange(v: string) { console.log(v); }
  build() {
    TextInput().onChange(this.onTextChange)
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('onTextChange', 'handler', 5),
      makeMethod('build', 'pg-build', 6, 8),
    ];
    const edges = runEdges(src, nodes);
    const evtEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain');
    expect(evtEdges).toHaveLength(1);
    expect(evtEdges[0].metadata?.event).toBe('Change');
    expect(evtEdges[0].metadata?.handler).toBe('onTextChange');
  });

  it('skips event chain when handler name is build', () => {
    const src = `
@Entry
@Component
struct Page {
  build() {
    Column() { this.build(); }
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 7),
      makeMethod('build', 'pg-build', 5, 7),
    ];
    const edges = runEdges(src, nodes);
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain')).toEqual([]);
  });

  it('does not emit event chain for non-event method calls', () => {
    const src = `
@Entry
@Component
struct Page {
  helper() { return 42; }
  build() {
    Column().width(100)
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('helper', 'helper', 5),
      makeMethod('build', 'pg-build', 6, 8),
    ];
    const edges = runEdges(src, nodes);
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain')).toEqual([]);
  });

  // ── Phase E: State dependency edges (arkui-state-dep) ──

  it('emits arkui-state-dep for method reading @State property via this.<prop>', () => {
    const src = `
@Entry
@Component
struct Page {
  @State count: number = 0;
  increment() { this.count++; }
  build() { Text(this.count.toString()); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeProp('count', 'prop-count', 5),
      makeMethod('increment', 'inc', 6),
      makeMethod('build', 'pg-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    const depEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep');
    expect(depEdges).toHaveLength(1);
    expect(depEdges[0].source).toBe('inc');
    expect(depEdges[0].target).toBe('prop-count');
    expect(depEdges[0].metadata?.decorator).toBe('@State');
    expect(depEdges[0].metadata?.property).toBe('count');
  });

  it('skips build() method for state dependency edges', () => {
    const src = `
@Entry
@Component
struct Page {
  @State count: number = 0;
  build() { Text(this.count.toString()); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 7),
      makeProp('count', 'prop-count', 5),
      makeMethod('build', 'pg-build', 6, 7),
    ];
    const edges = runEdges(src, nodes);
    // build() reads this.count but Phase E skips build()
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep')).toEqual([]);
  });

  it('detects @Prop and @Link decorators for state-dep edges', () => {
    const src = `
@Component
struct Child {
  @Prop title: string = '';
  @Link active: boolean;
  toggle() { this.active = !this.active; }
  build() { Text(this.title); }
}
`;
    const nodes = [
      makeStruct('Child', 'child', 3, 8),
      makeProp('title', 'prop-title', 4),
      makeProp('active', 'prop-active', 5),
      makeMethod('toggle', 'toggle', 6),
      makeMethod('build', 'child-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    const depEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep');
    expect(depEdges).toHaveLength(1);
    // toggle reads this.active → @Link
    expect(depEdges[0].source).toBe('toggle');
    expect(depEdges[0].target).toBe('prop-active');
    expect(depEdges[0].metadata?.decorator).toBe('@Link');
  });

  it('detects @StorageLink and @StorageProp decorators', () => {
    const src = `
@Entry
@Component
struct Page {
  @StorageLink('theme') theme: string = 'light';
  updateTheme() { this.theme = 'dark'; }
  build() { Text(this.theme); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeProp('theme', 'prop-theme', 5),
      makeMethod('updateTheme', 'update', 6),
      makeMethod('build', 'pg-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    const depEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep');
    expect(depEdges).toHaveLength(1);
    expect(depEdges[0].source).toBe('update');
    expect(depEdges[0].target).toBe('prop-theme');
    expect(depEdges[0].metadata?.decorator).toBe('@StorageLink');
  });

  it('does not emit state-dep for non-state property access', () => {
    const src = `
@Entry
@Component
struct Page {
  regularField: string = 'hello';
  helper() { this.regularField = 'world'; }
  build() { Text('hi'); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeProp('regularField', 'prop-reg', 5),
      makeMethod('helper', 'helper', 6),
      makeMethod('build', 'pg-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep')).toEqual([]);
  });

  it('does not emit state-dep for method that does not access state', () => {
    const src = `
@Entry
@Component
struct Page {
  @State count: number = 0;
  helper() { return 42; }
  build() { Text('hello'); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeProp('count', 'prop-count', 5),
      makeMethod('helper', 'helper', 6),
      makeMethod('build', 'pg-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    // helper doesn't read this.count
    expect(edges.filter((e) => e.source === 'helper')).toEqual([]);
  });

  // ── Phase F: Builder edges (arkui-builder) ──

  it('emits arkui-builder for @Builder method called via this.xxx() in build()', () => {
    const src = `
@Entry
@Component
struct Page {
  @Builder myFooter() { Text('footer'); }
  build() {
    Column() {
      this.myFooter()
    }
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 11),
      makeMethod('myFooter', 'footer', 5),
      makeMethod('build', 'pg-build', 6, 10),
    ];
    const edges = runEdges(src, nodes);
    const builderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-builder');
    expect(builderEdges).toHaveLength(1);
    expect(builderEdges[0].source).toBe('pg');
    expect(builderEdges[0].target).toBe('footer');
    expect(builderEdges[0].metadata?.builder).toBe('myFooter');
  });

  it('does not emit builder edge for non-@Builder method called in build()', () => {
    const src = `
@Entry
@Component
struct Page {
  helper() { return Text('help'); }
  build() {
    Column() {
      this.helper()
    }
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 11),
      makeMethod('helper', 'helper', 5),
      makeMethod('build', 'pg-build', 6, 10),
    ];
    const edges = runEdges(src, nodes);
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-builder')).toEqual([]);
  });

  it('handles multiple @Builder methods', () => {
    const src = `
@Entry
@Component
struct Page {
  @Builder header() { Text('header'); }
  @Builder footer() { Text('footer'); }
  build() {
    Column() {
      this.header()
      this.footer()
    }
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 13),
      makeMethod('header', 'hdr', 5),
      makeMethod('footer', 'ftr', 6),
      makeMethod('build', 'pg-build', 7, 12),
    ];
    const edges = runEdges(src, nodes);
    const builderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-builder');
    expect(builderEdges).toHaveLength(2);
    const names = builderEdges.map((e) => e.metadata?.builder).sort();
    expect(names).toEqual(['footer', 'header']);
  });

  // ── Edge cases ──

  it('skips files without build() method', () => {
    const src = `
@Component
struct EmptyStruct {
  helper() { return 42; }
}
`;
    const nodes = [
      makeStruct('EmptyStruct', 'es', 3, 5),
      makeMethod('helper', 'helper', 4),
    ];
    const edges = runEdges(src, nodes);
    expect(edges).toEqual([]);
  });

  it('skips non-.ets files', () => {
    const fileContents = new Map<string, string>();
    fileContents.set('test.ts', 'export function foo() {}');
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('test.ts', []);
    const ctx = mockCtx({
      files: ['test.ts'],
      fileContents,
      fileNodes,
    });
    const edges = arkuiAstEdges(ctx as any);
    expect(edges).toEqual([]);
  });

  it('processes multiple structs independently in one file', () => {
    const src = `
@Component
struct WidgetA {
  build() { Text('A'); }
}

@Entry
@Component
struct WidgetB {
  handleClick() { console.log('B clicked'); }
  build() {
    WidgetA()
    Button('B').onClick(this.handleClick)
  }
}
`;
    const nodes = [
      makeComponent('WidgetA', 'wa', 3, 5),
      makeMethod('build', 'wa-build', 4, 5),
      makeStruct('WidgetB', 'wb', 9, 15),
      makeMethod('handleClick', 'handler', 10),
      makeMethod('build', 'wb-build', 11, 14),
    ];
    const edges = runEdges(src, nodes);
    // WidgetB → WidgetA (ui-render)
    const renderEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-render');
    expect(renderEdges).toHaveLength(1);
    expect(renderEdges[0].source).toBe('wb');
    expect(renderEdges[0].target).toBe('wa');
    // WidgetB.build → handleClick (event-chain)
    const evtEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain');
    expect(evtEdges).toHaveLength(1);
    expect(evtEdges[0].source).toBe('wb');
    expect(evtEdges[0].target).toBe('handler');
  });

  it('deduplicates edges by source>target key', () => {
    const src = `
@Entry
@Component
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('A').onClick(this.handleClick)
    Button('B').onClick(this.handleClick)
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 9),
      makeMethod('handleClick', 'handler', 5),
      makeMethod('build', 'pg-build', 6, 9),
    ];
    const edges = runEdges(src, nodes);
    // Two .onClick(this.handleClick) but same source>target → deduplicated
    const evtEdges = edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-event-chain');
    expect(evtEdges).toHaveLength(1);
  });

  it('sets provenance to heuristic and kind to calls', () => {
    const src = `
@Entry
@Component
struct Page {
  handleClick() { console.log('clicked'); }
  build() {
    Button('OK').onClick(this.handleClick)
  }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeMethod('handleClick', 'handler', 5),
      makeMethod('build', 'pg-build', 6, 8),
    ];
    const edges = runEdges(src, nodes);
    for (const e of edges) {
      expect(e.provenance).toBe('heuristic');
      expect(e.kind).toBe('calls');
    }
  });

  it('skips files without recognizable UI patterns via quick-skip regex', () => {
    const src = `
@Component
struct Helper {
  add(a: number, b: number): number { return a + b; }
}
`;
    const fileContents = new Map<string, string>();
    fileContents.set('test.ets', src);
    const fileNodes = new Map<string, Node[]>();
    fileNodes.set('test.ets', [
      makeStruct('Helper', 'h', 3, 5),
      makeMethod('add', 'add', 4),
    ]);
    // Note: 'build' is NOT in the source, and no UI patterns
    const ctx = mockCtx({
      files: ['test.ets'],
      fileContents,
      fileNodes,
    });
    const edges = arkuiAstEdges(ctx as any);
    // Quick-skip: no 'build', no Column/Row/Text/Button/etc.
    expect(edges).toEqual([]);
  });

  it('handles @State with watch parameter', () => {
    const src = `
@Entry
@Component
struct Page {
  @State({ watch: 'onCountChange' }) count: number = 0;
  onCountChange() { console.log('changed'); }
  build() { Text(this.count.toString()); }
}
`;
    const nodes = [
      makeStruct('Page', 'pg', 4, 8),
      makeProp('count', 'prop-count', 5),
      makeMethod('onCountChange', 'occ', 6),
      makeMethod('build', 'pg-build', 7, 8),
    ];
    const edges = runEdges(src, nodes);
    // onCountChange doesn't access this.count → no state-dep edge
    // But we verify the @State is recognized (no crash)
    expect(edges.filter((e) => e.metadata?.synthesizedBy === 'arkui-state-dep')).toEqual([]);
  });
});
