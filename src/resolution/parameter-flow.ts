/**
 * A parameter's class from its call sites.
 *
 * `table.foreign_key` in rails' `def add_to(table)` says nothing of `table`,
 * and a guess by the receiver's word takes whatever class is called `Table`.
 * But `add_to` has one caller, and that caller passes `self`. A call on a
 * parameter of the calling method, when every call site in the project passes
 * a value of one known class, is a call on that class.
 *
 * The pass runs after the resolver's own, on what they left: it reads the
 * calls edges and the failed references, works out the flows, and moves only
 * the calls a flow answers. Nothing else in the graph is touched, so a method
 * no flow types stays exactly as resolution left it, and resolving stays in
 * the pool. A deferred reference would be missing from the callers of its
 * method while it waited, and would resolve on the main thread: rails has
 * about 10,000 calls on parameters, of which a flow answers under 100.
 *
 * Exact or nothing. Any call site that can't be typed, two that disagree, or
 * anything in the project that could be a call the graph never linked gives no
 * answer. What is language-specific sits behind `ParameterFlowAdapter`: what a
 * parameter is, how to read an argument at a call site and how to type it.
 *
 * What a pass decides is a function of the graph without its own edges: a call
 * a flow answered counts as the unknown it was, so a pass over the graph as it
 * stands comes to a full index's answer, and an edge whose flow is gone goes
 * back through normal resolution. It runs after synthesis, which no Ruby call
 * feeds: a language whose calls a synthesizer reads has to look at that.
 *
 * A sync looks only at what it changed, from a record the last pass left: what
 * every flow came to, the names it reads, and how often each file writes the
 * names the flows that move a call rest on. It takes again the methods of any
 * name a changed file declares or calls, and the flows that read such a name.
 * That's enough while they come out as recorded: nothing gives a method a type
 * unless what it declares, or a call of it, changes. A change to a class, a
 * constant or an ancestor, or a flow that isn't on record, starts over from a
 * pass over the project.
 */

import type { CallSiteRow, FlowFacts, NodeOutline, ParameterFlowQueries } from '../db/parameter-flow-queries';
import type { QueryBuilder } from '../db/queries';
import type { Language, UnresolvedReference } from '../types';
import type { ResolutionContext, ResolvedRef } from './types';
import { detectLanguage } from '../extraction/grammars';
import { createYielder, type MaybeYield } from './cooperative-yield';
import { rubyParameterFlow } from './ruby-parameter-flow';

/** A value whose class is known exactly. */
export interface FlowValue {
  /** The class's qualified name, or the name as written when the project doesn't declare it. */
  type: string;
  /** The class itself rather than an instance of it. */
  isClass: boolean;
  /** Declared nowhere in the project, so it has no project method. */
  outside: boolean;
}

/** One parameter a value can flow into. */
export interface FlowParameter {
  name: string;
  /** Its place among the positional parameters; -1 for a keyword. */
  position: number;
}

/** What a method declares, as far as its callers go. */
export interface FlowSignature {
  /** The parameters a call passes one value to. */
  parameters: FlowParameter[];
}

/** A call the project makes. */
export type FlowSite = CallSiteRow & { method: string; receiver: string | null };

/** A method or function, as far as the pass reads it. */
export type FlowMethod = NodeOutline;

/** What a pass reads of a language's declarations. */
export interface FlowMethods {
  /** A method or a function; a pass reads no others. */
  get(id: string): FlowMethod | undefined;
  /** Whether a method or a function has the name. */
  isName(name: string): boolean;
  /** The classes and modules a file declares. */
  scopesIn(file: string): FlowMethod[];
}

/** How often each file writes a name, by name. */
export type FlowWritten = Map<string, Map<string, number>>;

/** Why a parameter got no type, or a value none. */
export type Abstention = string;

/** Follow a value back through a parameter of the method passing it. */
export type FollowParameter = (method: FlowMethod, parameter: FlowParameter) => FlowValue | Abstention;

/**
 * What the pass asks of a language, for one pass over one state of the graph.
 * A reader answers null, or an abstention, for what it can't read exactly.
 */
export interface ParameterFlowAdapter<S extends FlowSignature = FlowSignature> {
  /** The method a reference calls, and its receiver as written (null for none). */
  readCall(referenceName: string): { method: string; receiver: string | null } | null;
  /** The names the body of `method` calls something on, with the names of those calls. */
  receivers(method: FlowMethod): Map<string, Set<string>>;
  /** Whether the site's edge says what the call reaches, rather than a guess at it. */
  isKnown(site: FlowSite): boolean;
  /** Whether a site whose receiver is unknown can't be a call of a method of this signature. */
  cannotCall(site: FlowSite, signature: S): boolean;
  /** The method's parameters and arity, read from its declaration. */
  signature(method: FlowMethod): S | null;
  /** The methods a call of `method` may dispatch to: overrides up and down its class's ancestry, itself included. */
  family(method: FlowMethod): Set<string>;
  /** Whether a method of this name hands its call on to a method the graph can't name (`super`). */
  handsOn(name: string): boolean;
  /** Whether anything inside `method` binds `name` over the parameter. */
  rebinds(name: string, method: FlowMethod): boolean;
  /** Whether defining or undefining a method of this name changes what other files read of its class. */
  shapesClass(name: string): boolean;
  /** Whether `method` uses its parameter `name` some way other than to call something on it. */
  passesOn(name: string, method: FlowMethod): boolean;
  /** Whether the site passes an argument that could be a parameter of the method it's in. */
  passesWord(site: FlowSite): boolean;
  /** The value of the argument the site passes to `parameter`. */
  argumentValue(site: FlowSite, parameter: FlowParameter, follow: FollowParameter): FlowValue | Abstention;
  /** The method `name` a value answers; null when the project declares none. */
  methodOn(value: FlowValue, name: string): FlowMethod | null;
  /** Whether a value that has no method `name` answers it some way that calls no method of the project. */
  answersItself(value: FlowValue, name: string): boolean;
  /** How many methods of the name the project declares. */
  declared(name: string): number;
  /**
   * How often each of `files` writes each of `names`, whatever for: a symbol, a
   * string, an alias, or a call the graph doesn't record.
   */
  written(names: Set<string>, files: readonly string[]): Promise<FlowWritten>;
}

/** A language's side of the pass. */
export interface ParameterFlowLanguage {
  language: Language;
  /** The adapter for one pass. */
  adapter(context: ResolutionContext, methods: FlowMethods): ParameterFlowAdapter<any>;
}

const LANGUAGES: readonly ParameterFlowLanguage[] = [rubyParameterFlow];

/** A value followed through parameters goes this many calls back. */
const MAX_FLOW_DEPTH = 4;

/** A name with more calls than this on unknown receivers isn't worth reading them all to rule them out. */
const MAX_UNKNOWN_CALLS = 256;

/** Past this many changed files a sync reaches most of a project, and a pass over it is the cheaper way. */
const MAX_CHANGED_FILES = 64;

const NO_CALLER = 'no-caller';
const UNTYPED_CALL = 'untyped-call';
const TOO_MANY_CALLS = 'too-many-calls';
const HANDED_ON = 'super';
const REBOUND = 'rebound';
const WRITTEN_ELSEWHERE = 'written-elsewhere';
const TOO_DEEP = 'too-deep';
const DISAGREE = 'sites-disagree';
const UNREAD_DECLARATION = 'unread-declaration';
/** Not an abstention: the argument is a parameter already being followed. */
const CYCLE = 'cycle';

export interface ParameterFlowStats {
  /** Parameters a flow typed, and the calls on them. */
  typed: number;
  calls: number;
  /** Calls moved to the method of the flow's class, of which `added` had no edge before. */
  moved: number;
  added: number;
  /** Calls whose answer the flow confirmed. */
  confirmed: number;
  /** Calls the class has no method for, of which `dropped` lost a guess. */
  noMethod: number;
  dropped: number;
  /** Calls that went back to normal resolution, the flow behind them gone. */
  restored: number;
  /** Candidates that got no type, by why. A sync counts only those it looked at. */
  abstained: Record<string, number>;
  /** How many methods a sync looked at; undefined for every method. */
  looked?: number;
}

/** What a pass wants done to the graph. */
export interface ParameterFlowPlan {
  /** New answers. Each replaces the edge or the failed row its site holds. */
  retarget: Array<{ resolved: ResolvedRef; edgeId?: number; rowId?: number }>;
  /** Guesses a flow rules out. Each edge becomes a failed row marked as the flow's. */
  drop: Array<{ edgeId: number; reference: UnresolvedReference }>;
  /** What a flow did that no flow answers now: edges it made, and failed rows it marked. */
  restore: Array<{ edgeId?: number; rowId?: number; reference: UnresolvedReference }>;
  stats: ParameterFlowStats;
  language: Language;
  /** What to keep for the next sync, once the rest is done. */
  record: string;
}

function isFlowValue(v: FlowValue | Abstention): v is FlowValue {
  return typeof v !== 'string';
}

/** A candidate a flow typed, with the names of the methods the flow went through. */
interface TypedFlow {
  method: FlowMethod;
  parameter: FlowParameter;
  sites: FlowSite[];
  value: FlowValue;
  through: Set<string>;
}

/**
 * One language's flows over one state of the graph. The graph is read as a
 * flow gets that far: most end at the first call of their method, and of
 * 200,000 calls rails records, a flow needs those of a few dozen names.
 */
class FlowPass<S extends FlowSignature> {
  private readonly incoming = new Map<string, FlowSite[]>();
  private readonly named = new Map<string, { known: FlowSite[]; unknown: FlowSite[]; failed: FlowSite[] }>();
  private readonly families = new Map<string, Set<string>>();
  private readonly handedOn = new Map<string, boolean>();
  /** Names the project writes somewhere no call site accounts for. */
  writtenElsewhere: Set<string> = new Set();
  /** Parameters called on that no flow typed, by why. */
  readonly abstained: Record<string, number> = {};

  constructor(
    private readonly adapter: ParameterFlowAdapter<S>,
    private readonly methods: FlowMethods,
    private readonly queries: ParameterFlowQueries,
    private readonly language: Language,
  ) {}

  private sites(rows: CallSiteRow[]): FlowSite[] {
    const sites: FlowSite[] = [];
    for (const row of rows) {
      const call = this.adapter.readCall(row.refName);
      if (!call) continue;
      const site = row as FlowSite;
      site.method = call.method;
      site.receiver = call.receiver;
      sites.push(site);
    }
    return sites;
  }

  /** The resolved calls that landed on `method`. */
  private callsInto(method: FlowMethod): FlowSite[] {
    let calls = this.incoming.get(method.id);
    if (!calls) this.incoming.set(method.id, (calls = this.sites(this.queries.getCallEdges({ target: method.id }, this.methods))));
    return calls;
  }

  /** Every call of a name, by what the graph knows of it. A failed call it never does. */
  private callsNamed(name: string): { known: FlowSite[]; unknown: FlowSite[]; failed: FlowSite[] } {
    let calls = this.named.get(name);
    if (!calls) {
      calls = { known: [], unknown: [], failed: this.sites(this.queries.getFailedCallSites(this.language, { tail: name })) };
      for (const site of this.sites(this.queries.getCallEdges({ targetName: name }, this.methods))) {
        (this.adapter.isKnown(site) ? calls.known : calls.unknown).push(site);
      }
      this.named.set(name, calls);
    }
    return calls;
  }

  /** How many calls of the name the graph holds, failed ones included. */
  sitesOf(name: string): number {
    const { known, unknown, failed } = this.callsNamed(name);
    return known.length + unknown.length + failed.length;
  }

  /** The methods with a call of the name in them. */
  callersOf(name: string): FlowMethod[] {
    const { known, unknown, failed } = this.callsNamed(name);
    return [...known, ...unknown, ...failed].flatMap((site) => this.methods.get(site.callerId) ?? []);
  }


  /**
   * The calls of `receiver` in `method` that resolution guessed at or failed
   * on. A confident edge on a parameter's name is a local's: its own pass typed
   * it.
   */
  private sitesOn(method: FlowMethod, receiver: string): FlowSite[] {
    return [
      ...this.sites(this.queries.getCallEdges({ source: method.id }, this.methods)).filter((site) => site.viaFlow || site.confidence < 0.85),
      ...this.sites(this.queries.getFailedCallSites(this.language, { callerId: method.id })),
    ].filter((site) => site.receiver === receiver);
  }

  private family(method: FlowMethod): Set<string> {
    const key = `${method.qualifiedName}\0${method.isStatic}`;
    let family = this.families.get(key);
    if (!family) this.families.set(key, (family = this.adapter.family(method)));
    return family;
  }

  private handsOn(name: string): boolean {
    let handsOn = this.handedOn.get(name);
    if (handsOn === undefined) this.handedOn.set(name, (handsOn = this.adapter.handsOn(name)));
    return handsOn;
  }

  /**
   * The value every call of `method` passes `parameter`, or why there is none.
   * `path` holds the parameters being followed: a call passing one of them on
   * adds nothing, as a walk over a tree passes its own `context` to itself, so
   * only the calls from outside the cycle decide. `through` collects the method
   * names the answer rests on.
   */
  private flow(method: FlowMethod, parameter: FlowParameter, path: string[], through: Set<string>): FlowValue | Abstention {
    const name = method.name;
    if (this.writtenElsewhere.has(name)) return WRITTEN_ELSEWHERE;
    const signature = this.adapter.signature(method);
    if (!signature) return UNREAD_DECLARATION;
    if (this.adapter.rebinds(parameter.name, method)) return REBOUND;
    const here = [...path, `${method.id}\0${parameter.name}`];
    let value: FlowValue | null = null;
    const passedBy = (site: FlowSite): Abstention | null => {
      const passed = this.adapter.argumentValue(site, parameter, (m, p) => {
        if (here.includes(`${m.id}\0${p.name}`)) return CYCLE;
        if (here.length >= MAX_FLOW_DEPTH) return TOO_DEEP;
        return this.flow(m, p, here, through);
      });
      if (passed === CYCLE) return null;
      if (!isFlowValue(passed)) return passed;
      if (value && (value.type !== passed.type || value.isClass !== passed.isClass)) return DISAGREE;
      value = passed;
      return null;
    };
    // The calls of this very method first: most flows end at their first argument.
    for (const site of this.callsInto(method)) {
      if (!this.adapter.isKnown(site)) continue;
      const stop = passedBy(site);
      if (stop !== null) return stop;
    }
    if (!value) return NO_CALLER;
    // Counted together: an answer a flow gave, which a sync finds as an edge,
    // is a failed call in a fresh index, and the two have to agree.
    const { known, unknown, failed } = this.callsNamed(name);
    if (unknown.length + failed.length > MAX_UNKNOWN_CALLS) return TOO_MANY_CALLS;
    for (const site of unknown) {
      if (!this.adapter.cannotCall(site, signature)) return UNTYPED_CALL;
    }
    for (const site of failed) {
      if (!this.adapter.cannotCall(site, signature)) return UNTYPED_CALL;
    }
    if (this.handsOn(name)) return HANDED_ON;
    const others = known.filter((site) => site.targetId !== method.id);
    if (others.length > 0) {
      const family = this.family(method);
      for (const site of others) {
        if (!family.has(site.targetId!)) continue;
        const stop = passedBy(site);
        if (stop !== null) return stop;
      }
    }
    through.add(name);
    return value;
  }

  /** The names of the calls `method` makes that may pass a parameter of its on. */
  private callsPassingOn(method: FlowMethod): string[] {
    return [...this.sites(this.queries.getCallEdges({ source: method.id }, this.methods)), ...this.sites(this.queries.getFailedCallSites(this.language, { callerId: method.id }))]
      .filter((site) => this.adapter.passesWord(site))
      .map((site) => site.method);
  }

  /**
   * Every flow of `candidates` into a parameter something is called on: the
   * typed ones, and the abstentions counted. A sync can type a method's
   * parameter that it only passes on, which no flow of its own shows, so it
   * hands `onward` the calls such a method makes, for the methods to go on to.
   */
  async run(candidates: FlowMethod[], maybeYield: MaybeYield, onward?: (names: string[]) => FlowMethod[]): Promise<TypedFlow[]> {
    const typed: TypedFlow[] = [];
    const queue = [...candidates];
    for (let i = 0; i < queue.length; i++) {
      const method = queue[i]!;
      if (method.kind !== 'method' && !onward) continue;
      const pause = maybeYield();
      if (pause) await pause;
      const signature = this.adapter.signature(method);
      if (!signature || signature.parameters.length === 0) continue;
      const receivers = this.adapter.receivers(method);
      for (const parameter of signature.parameters) {
        // A call no project method is named for has nothing for a flow to move.
        const called = method.kind === 'method' && [...receivers.get(parameter.name) ?? []].some((name) => this.methods.isName(name));
        if (!called && !(onward && this.adapter.passesOn(parameter.name, method))) continue;
        const through = new Set<string>();
        const value = this.flow(method, parameter, [], through);
        if (!isFlowValue(value)) {
          if (called) this.abstained[value] = (this.abstained[value] ?? 0) + 1;
        } else if (called) {
          typed.push({ method, parameter, sites: this.sitesOn(method, parameter.name), value, through });
        } else {
          queue.push(...onward!(this.callsPassingOn(method)));
        }
      }
    }
    return typed;
  }

  /** Whether a typed flow still stands now that `writtenElsewhere` is known. */
  stands(flow: TypedFlow): boolean {
    const answer = this.flow(flow.method, flow.parameter, [], new Set());
    if (isFlowValue(answer)) return true;
    this.abstained[answer] = (this.abstained[answer] ?? 0) + 1;
    return false;
  }
}

const isMethodKind = (kind: string): boolean => kind === 'method' || kind === 'function';

/** A language's declarations, each read as a pass comes to it: most never are. */
class MethodsRead implements FlowMethods {
  private readonly read = new Map<string, FlowMethod | undefined>();
  private readonly names = new Map<string, boolean>();
  private readonly scopes = new Map<string, FlowMethod[]>();

  constructor(private readonly queries: ParameterFlowQueries, private readonly language: Language) {}

  /** Methods already read. */
  know(methods: FlowMethod[]): void {
    for (const method of methods) this.read.set(method.id, method);
  }

  get(id: string): FlowMethod | undefined {
    if (this.read.has(id)) return this.read.get(id);
    const node = this.queries.getNodeOutline(id);
    const method = node && node.language === this.language && isMethodKind(node.kind) ? node : undefined;
    this.read.set(id, method);
    return method;
  }

  isName(name: string): boolean {
    let is = this.names.get(name);
    if (is === undefined) this.names.set(name, (is = this.queries.hasMethodNamed(name, this.language)));
    return is;
  }

  scopesIn(file: string): FlowMethod[] {
    let scopes = this.scopes.get(file);
    if (!scopes) this.scopes.set(file, (scopes = this.queries.getScopesInFile(file)));
    return scopes;
  }
}

/** One flow as a record keeps it. */
interface RecordedFlow {
  /** What it came to, by `flowKey`. */
  key: string;
  /** The names whose calls and declarations it reads; null when no name shows what it reads, and every sync looks again. */
  names: string[] | null;
}

/** What a pass leaves for the next sync. */
interface FlowRecord {
  /** Every flow there is. A sync that finds anything else starts over. */
  flows: RecordedFlow[];
  /** How often each file writes the names the flows that move a call rest on. */
  written: FlowWritten;
}

/** One flow's answer, opening with the method's name. */
const flowKey = (flow: TypedFlow): string =>
  [flow.method.name, flow.method.qualifiedName, flow.method.isStatic, flow.parameter.name, flow.value.type, flow.value.isClass].join('\0');

const flowKeyName = (key: string): string => key.slice(0, key.indexOf('\0'));

function serializeRecord(record: FlowRecord): string {
  return JSON.stringify({ flows: record.flows, written: [...record.written].map(([name, files]) => [name, [...files]]) });
}

/** The record `raw` holds; null for none, or for one this can't read. */
function parseRecord(raw: string | null): FlowRecord | null {
  if (!raw) return null;
  try {
    const { flows, written } = JSON.parse(raw) as { flows: RecordedFlow[]; written: Array<[string, Array<[string, number]>]> };
    if (!flows.every((flow) => flow.key.includes('\0') && (flow.names === null || Array.isArray(flow.names)))) return null;
    return { flows, written: new Map(written.map(([name, files]) => [name, new Map(files)])) };
  } catch {
    return null;
  }
}

/** A language's files as a sync found them. */
interface ChangedLanguage {
  record: FlowRecord | null;
  /** What each file held, before the sync changed it. */
  before: Map<string, FlowFacts>;
}

/** What a sync saw of the files it changed, before it changed them. */
export class FlowChange {
  readonly languages = new Map<Language, ChangedLanguage>();
  /**
   * Whether the index stands where the last pass left it. A run that stopped
   * short leaves references pending, or a state that says so, and whatever it
   * left on record says nothing of the graph.
   */
  readonly settled: boolean;

  constructor(private readonly queries: QueryBuilder) {
    const state = queries.getMetadata('index_state');
    this.settled = state !== 'indexing' && state !== 'failed' && queries.getUnresolvedReferencesCount() === 0;
  }

  /** Call with each file a sync is about to change or remove, while its rows are there to read. */
  before(file: string): void {
    const language = detectLanguage(file);
    if (!LANGUAGES.some((l) => l.language === language)) return;
    const flows = this.queries.parameterFlows;
    let changed = this.languages.get(language);
    if (!changed) {
      // Taken rather than read: a sync that stops short of its pass leaves no
      // record, and the next one starts over rather than trust a stale count.
      changed = { record: this.settled ? parseRecord(flows.getRecord(language)) : null, before: new Map() };
      flows.setRecord(language, '');
      this.languages.set(language, changed);
    }
    if (changed.before.size >= MAX_CHANGED_FILES) changed.record = null;
    if (changed.record && !changed.before.has(file)) changed.before.set(file, flows.getFlowFacts(file));
  }
}

function referenceOf(site: CallSiteRow, language: Language): UnresolvedReference & { filePath: string; language: Language } {
  return {
    fromNodeId: site.callerId,
    referenceName: site.refName,
    referenceKind: 'calls',
    line: site.line,
    column: site.column,
    filePath: site.filePath,
    language,
  };
}

/** A language's part of a sync, with a record to go on. */
type FlowSync = ChangedLanguage & { record: FlowRecord };

/**
 * The names a sync has to look at the methods of: any a changed file declares or
 * calls, then or now; those of the methods calling a name it defined or
 * undefined; and those of the flows on record that read one, or that rest on a
 * name a file now writes a different number of times, which it counts here. Null
 * when a file changed what a flow reads from other files: a class, a constant,
 * an ancestor, what the adapter says shapes a class.
 */
async function namesToReview(sync: FlowSync, adapter: ParameterFlowAdapter<any>, pass: FlowPass<any>, queries: ParameterFlowQueries): Promise<Set<string> | null> {
  const { before, record } = sync;
  const names = new Set<string>();
  const defined = new Set<string>();
  for (const [file, was] of before) {
    const now = queries.getFlowFacts(file);
    if (was.classes.join('\0') !== now.classes.join('\0')) return null;
    const declared = new Set(now.methods);
    const declaredThen = new Set(was.methods);
    for (const method of declared) {
      names.add(method);
      if (!declaredThen.has(method)) defined.add(method);
    }
    for (const method of declaredThen) {
      names.add(method);
      if (!declared.has(method)) defined.add(method);
    }
    for (const refName of [...was.calls, ...now.calls]) {
      const call = adapter.readCall(refName);
      if (call) names.add(call.method);
    }
  }
  for (const name of defined) {
    if (adapter.shapesClass(name)) return null;
    for (const caller of pass.callersOf(name)) names.add(caller.name);
  }
  // Every name on record stays counted, so the next sync can trust them all.
  const files = [...before.keys()];
  const written = await adapter.written(new Set(record.written.keys()), files);
  const recounted = new Set<string>();
  for (const [name, byFile] of record.written) {
    for (const file of files) {
      const count = written.get(name)?.get(file);
      if (count === byFile.get(file)) continue;
      recounted.add(name);
      if (count === undefined) byFile.delete(file);
      else byFile.set(file, count);
    }
  }
  for (const flow of record.flows) {
    if (flow.names === null || flow.names.some((name) => names.has(name) || recounted.has(name))) names.add(flowKeyName(flow.key));
  }
  return names;
}

/**
 * What the flows want done to the graph, for one language. Handed a sync, null
 * means it can't say from what changed, and a pass over the project has to.
 */
async function planFlows(
  language: ParameterFlowLanguage,
  queries: ParameterFlowQueries,
  context: ResolutionContext,
  files: string[],
  sync?: FlowSync,
): Promise<ParameterFlowPlan | null> {
  const maybeYield = createYielder();
  const methods = new MethodsRead(queries, language.language);
  const adapter = language.adapter(context, methods);
  const pass = new FlowPass(adapter, methods, queries, language.language);
  const reviewed = sync ? await namesToReview(sync, adapter, pass, queries) : null;
  if (sync && !reviewed) return null;
  const methodsReached = (names: string[]): FlowMethod[] =>
    queries.getMethodsNamed(names, language.language).filter((method) => queries.hasCallInto(method.id));
  const candidates = reviewed ? methodsReached([...reviewed]) : queries.getReachedMethods(language.language);
  methods.know(candidates);
  await maybeYield();

  // A site whose answer the flow doesn't change needs no more proof. The others
  // rest on the graph holding every call of the methods the flow went through,
  // which only the project's text can show: it is read for those names, and
  // only when there are any.
  const onward = reviewed ? (names: string[]): FlowMethod[] => {
    const fresh = names.filter((name) => !reviewed.has(name));
    for (const name of fresh) reviewed.add(name);
    return methodsReached(fresh);
  } : undefined;
  const answers = (await pass.run(candidates, maybeYield, onward)).map((flow) => ({
    flow,
    targets: flow.sites.map((site) => adapter.methodOn(flow.value, site.method)),
  }));
  const flows: RecordedFlow[] = answers.map(({ flow, targets }) => ({
    key: flowKey(flow),
    // A class with no such method may answer the call itself, which it says
    // somewhere no name of the flow's shows.
    names: flow.sites.some((site, i) => targets[i] === null && (site.edgeId !== undefined || site.viaFlow)) ? null
      : [...new Set([...flow.through, ...flow.sites.map((site) => site.method)])],
  }));
  if (sync) {
    const recorded = sync.record.flows.filter((flow) => reviewed!.has(flowKeyName(flow.key)));
    if (recorded.map((flow) => flow.key).sort().join('\n') !== flows.map((flow) => flow.key).sort().join('\n')) return null;
    flows.push(...sync.record.flows.filter((flow) => !reviewed!.has(flowKeyName(flow.key))));
  }
  const drops = (flow: TypedFlow, site: FlowSite, target: FlowMethod | null): boolean =>
    target === null && site.edgeId !== undefined && !site.viaFlow && adapter.answersItself(flow.value, site.method);
  const changes = (a: (typeof answers)[number]): boolean => a.flow.sites.some((site, i) => {
    const target = a.targets[i]!;
    return site.viaFlow || drops(a.flow, site, target) || (target !== null && target.id !== site.targetId);
  });
  const rests = new Set(answers.filter(changes).flatMap((a) => [...a.flow.through]));
  const written = sync ? sync.record.written : rests.size > 0 ? await adapter.written(rests, files) : new Map() as FlowWritten;
  if ([...rests].some((name) => sync && !written.has(name))) return null;
  pass.writtenElsewhere = new Set([...rests].filter((name) => {
    let count = 0;
    for (const times of written.get(name)?.values() ?? []) count += times;
    return count > adapter.declared(name) + pass.sitesOf(name);
  }));

  const stats: ParameterFlowStats = { typed: 0, calls: 0, moved: 0, added: 0, confirmed: 0, noMethod: 0, dropped: 0, restored: 0, abstained: pass.abstained };
  if (sync) stats.looked = candidates.length;
  const plan: ParameterFlowPlan = { retarget: [], drop: [], restore: [], stats, language: language.language, record: serializeRecord({ flows, written }) };
  // What a pass before this one did, until a flow answers it again. A sync
  // leaves what it didn't look at, so all it can undo is among the sites it did.
  const unanswered = new Map<string, FlowSite | CallSiteRow>();
  const keyOf = (site: CallSiteRow): string => (site.edgeId !== undefined ? `e${site.edgeId}` : `r${site.rowId}`);
  const marked = sync ? answers.flatMap((a) => a.flow.sites.filter((site) => site.viaFlow)) : queries.getFlowCallSites(language.language, methods);
  for (const row of marked) unanswered.set(keyOf(row), row);
  for (const { flow, targets } of answers) {
    if ([...flow.through].some((name) => pass.writtenElsewhere.has(name)) && !pass.stands(flow)) continue;
    stats.typed++;
    stats.calls += flow.sites.length;
    flow.sites.forEach((site, i) => {
      const target = targets[i]!;
      if (!target) {
        stats.noMethod++;
        if (site.viaFlow && site.rowId !== undefined && adapter.answersItself(flow.value, site.method)) unanswered.delete(keyOf(site));
        // The class has no such method. Where it answers the call itself, the
        // guess is wrong; otherwise it may hand the call on, as a delegate does,
        // and the flow says nothing of it.
        if (drops(flow, site, target)) {
          stats.dropped++;
          plan.drop.push({ edgeId: site.edgeId!, reference: referenceOf(site, language.language) });
        }
        return;
      }
      unanswered.delete(keyOf(site));
      if (target.id === site.targetId) {
        stats.confirmed++;
        return;
      }
      if (site.edgeId !== undefined) stats.moved++;
      else stats.added++;
      plan.retarget.push({
        edgeId: site.edgeId,
        rowId: site.rowId,
        resolved: {
          original: referenceOf(site, language.language),
          targetNodeId: target.id,
          confidence: 0.9,
          resolvedBy: 'instance-method',
          metadata: { parameterFlow: flow.parameter.name },
        },
      });
    });
  }
  for (const site of unanswered.values()) {
    stats.restored++;
    plan.restore.push({ edgeId: site.edgeId, rowId: site.rowId, reference: referenceOf(site, language.language) });
  }
  return plan;
}

/**
 * What the parameter flows want done to the graph as it is now, language by
 * language. With `change`, what a sync changed: nothing for a language it didn't
 * touch, and from what changed where the language's record allows.
 */
export async function planParameterFlows(queries: QueryBuilder, context: ResolutionContext, change?: FlowChange): Promise<ParameterFlowPlan[]> {
  const flows = queries.parameterFlows;
  const plans: ParameterFlowPlan[] = [];
  for (const language of LANGUAGES) {
    const changed = change?.languages.get(language.language);
    if (change?.settled && !changed && flows.getRecord(language.language)) continue;
    const files = flows.getFilePathsByLanguage(language.language);
    if (files.length === 0) continue;
    const sync = changed?.record ? { ...changed, record: changed.record } : undefined;
    const plan = (sync ? await planFlows(language, flows, context, files, sync) : null) ?? await planFlows(language, flows, context, files);
    if (plan) plans.push(plan);
  }
  return plans;
}
