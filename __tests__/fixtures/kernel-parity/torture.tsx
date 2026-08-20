/**
 * Torture fixture — exercises every TS/TSX extraction path the kernel ports.
 */
import React, { forwardRef, memo, useState as useStateAlias } from 'react';
import * as NS from './namespace-module';
import DefaultThing from './default-module';
import './side-effect';
import { helperFn, CONFIG_TABLE } from './helpers';

export { reExported, orig as aliased } from './barrel-source';
export * from './star-source';

// A documented constant table (value-ref target).
const RETRY_LIMITS = { a: 1, b: 2 };
export const API_BASE = 'https://example.test';
let plainLet = 42;
var oldVar = 'x';

/** Class docs.
 * Multi-line.
 */
@Injectable()
@scoped.Registry<Config>('name')
export abstract class BaseService extends EventTarget implements Disposable, Serializable {
  static instances = 0;
  private readonly cache: Map<string, Config> = new Map();
  public fonts: FontConfig;
  count = 0;
  onScroll = throttle((e: Event) => {
    this.handleScroll(e);
  }, 100);
  handleClick = (ev: MouseEvent): void => {
    emitTelemetry(ev);
    new AbortController();
  };

  @Get('/list')
  async list(query: QueryOpts): Promise<Result<Item>> {
    const local: ItemMapper = makeMapper();
    const limit = RETRY_LIMITS;
    return this.cache.get(query.key) ?? helperFn(query);
  }

  private static compute(n: number): number {
    return n * RETRY_LIMITS.a;
  }

  get size(): number {
    return this.count;
  }

  protected dispose(): void {
    listeners.forEach((l) => unregister(l));
  }
}

class Plain {
  constructor(private svc: BaseService) {
    register(this.onEvent);
    btn.on('click', this.handleClick);
  }
  onEvent() {}
  handleClick() {}
}

export interface Shape extends Named, Sized {
  area: number;
  resize(f: number): Shape;
  onchange: (s: Shape) => void;
}

export enum Direction {
  Up,
  Down = 2,
  Left,
}

export type Handle = {
  stop: () => void;
  id: string;
  refresh(force: boolean): Promise<void>;
};

export type ServiceList = [
  Service<'query_apply_record', Req, Resp>,
  Service<'apply_confirm', Req, Resp>,
];

export type MaybeShape = Shape | null;

export function topLevel(a: ShapeConfig): Shape {
  const inner = () => reallyDeep();
  function namedInner(): void {
    chained(a).value;
  }
  namedInner();
  return makeShape(a);
}

async function* generatorFn(items: Item[]) {
  yield* items.map((i) => transform(i));
}

export const arrowConst = async (x: number) => {
  return x + plainLet;
};

const AnonClassHolder = class {
  method() {}
};

// React components (#841).
export const Button = forwardRef((props: ButtonProps, ref) => {
  const [state, setState] = useStateAlias(0);
  useEffect(() => {
    trackRender();
  });
  return <BaseButton ref={ref} onClick={() => setState(state + 1)} {...props} />;
});

export const MemoRow = memo(function Row(props: RowProps) {
  return <tr className={props.cls}>{props.children}</tr>;
});

export const Wrapped = React.memo(ImportedComponent);
export const Styled = styled.button`
  color: red;
`;
const memoCache = memo(computeThing); // lowercase — stays a constant

export function App() {
  const nodes: GraphNode[] = [];
  return (
    <div>
      <Button label={CONFIG_TABLE.label} />
      <NS.Panel />
      {nodes.map((n) => (
        <MemoRow key={n.id} cls={n.cls} />
      ))}
    </div>
  );
}

// Object-of-functions (SvelteKit-style actions map).
export const actionsMap = {
  create: async (input: CreateInput) => {
    return persistNew(input);
  },
  update(input: UpdateInput) {
    return persistExisting(input);
  },
};

// Zustand-style store through middleware wrappers.
export const useStore = create(
  persist(
    (set, get) => ({
      fetchUser: async (id: string) => {
        const user = await api.load(id);
        set({ user });
      },
      reset: () => set({ user: null }),
    }),
    { name: 'store' }
  )
);

// RTK Query.
export const widgetApi = createApi({
  reducerPath: 'widgets',
  endpoints: (build) => ({
    getWidget: build.query({
      query: (id: string) => fetchWidget(id),
    }),
    updateWidget: build.mutation({
      queryFn: async (patch) => {
        return applyPatch(patch);
      },
    }),
    prebuilt: build.query(makeEndpointConfig()),
  }),
});

export const { useGetWidgetQuery, useUpdateWidgetMutation } = widgetApi;
const { notAHook } = widgetApi;

// Value-ref shadowing: SHADOWED_LIMIT re-bound locally must be pruned.
const SHADOWED_LIMIT = 10;
export function readsShadowed() {
  const SHADOWED_LIMIT = 20;
  return SHADOWED_LIMIT;
}
export function readsTable() {
  return RETRY_LIMITS.b + API_BASE.length;
}

// Fn-ref registrations.
registerHandler(helperFn);
queueMicrotask(topLevel);
const routeTable = { home: topLevel, missing: notDefinedAnywhere };
const handlerList = [helperFn, DefaultThing];
target.cb = topLevel;
const aliasFn = topLevel;

// Calls with interesting callees.
;(topLevel)(cfg);
NS.helper.deep(1);
"literal".includes('x');
[1, 2].map(String);
obj?.optMethod?.(3);
import('./dynamic-module');
new NS.Widget(makeArg());
new Map<string, number>();
super_weird?.();
