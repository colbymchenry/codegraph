import type {WireNodeRef,WireScreen,WireScreenLink,WireScreenOrigin,WireScreensPayload} from '../src/lib/wire';
function ref(name: string): WireNodeRef {
  return {
    id: `function:${name}`,
    kind: 'function',
    name,
    qualifiedName: name,
    file: `src/${name}.tsx`,
    line: 1,
    endLine: 20,
    language: 'tsx',
    test: false,
  };
}

const R = (path: string): string => `route:${path}`;

function screen(path: string): WireScreen {
  return {
    id: R(path),
    path,
    file: `src/app${path === '/' ? '/index' : path}.tsx`,
    line: 1,
    component: ref(path === '/' ? 'Index' : path.replace(/[^a-z0-9]/gi, '')),
    incoming: 0,
    outgoing: 0,
  };
}

function origin(name: string, sharedBy?: number): WireScreenOrigin {
  return { id: `function:${name}`, node: ref(name), outgoing: 1, ...(sharedBy ? { sharedBy } : {}) };
}

let seq = 0;
/** `from`/`to` are screen paths, or a `function:` id for an origin. */
function link(from: string, to: string, when = '', over: Partial<WireScreenLink> = {}): WireScreenLink {
  const id = (s: string): string => (s.startsWith('function:') ? s : R(s));
  return {
    id: `l${seq++}`,
    from: id(from),
    to: id(to),
    fromOrigin: from.startsWith('function:'),
    via: [],
    when,
    sites: [],
    synthesized: false,
    ...over,
  };
}

function payload(
  screens: WireScreen[],
  links: WireScreenLink[],
  origins: WireScreenOrigin[] = [],
  entry: string | null = R('/')
): WireScreensPayload {
  return {
    routed: true,
    entry,
    screens,
    origins,
    links,
    dropped: 0,
    index: { lastIndexedAt: null, edges: 0, files: 0 },
    timing: { elapsedMs: 0 },
  };
}

export {screen,link,payload};
