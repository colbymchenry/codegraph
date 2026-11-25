/**
 * The Steps view's second reading: the anchor's body in the code's order.
 *
 * `buildProgram` is pure over the records the walk makes — no graph, no
 * source — so this suite hands it records by hand and reads the block tree
 * back. The end-to-end reading over real fixtures is in
 * `ui-steps-api-servers.test.ts`; what is pinned here is the FOLD: which sites
 * become arms of one decision, what ends an arm, and where a helper is drawn.
 */

import { describe, it, expect } from 'vitest';
import type { BranchGuard, SiteLoop } from '../src/graph/branch-guards';
import { buildProgram, type ProgramInput, type ProgramSite, type WireBlock, type WireItem } from '../src/ui-server/api/program';

/* ------------------------------------------------------------ material -- */

let nextLine = 1;

/** A guard, with the fields the fold reads: which decision, which arm, how the arm leaves. */
function g(text: string, opts: Partial<BranchGuard> = {}): BranchGuard {
  return { text, negated: false, form: 'if', line: 1, branch: `b:${text}`, ...opts };
}

/** A site at the next line, reaching a step. */
function at(step: string, guards: BranchGuard[] = [], extra: Partial<ProgramSite> = {}): ProgramSite {
  const line = nextLine++;
  return { step, link: `l:${step}`, at: { line, column: 0, end: { line, column: 40 } }, guards, ...extra };
}

/** A loop the site is written inside. */
function loop(text: string, kind: SiteLoop['kind'] = 'each', branch = `l:${text}`): SiteLoop {
  return { text, kind, branch };
}

/** A site that folds into a helper. */
function into(fn: string, guards: BranchGuard[] = [], extra: Partial<ProgramSite> = {}): ProgramSite {
  const line = nextLine++;
  return { into: fn, at: { line, column: 0, end: { line, column: 40 } }, guards, ...extra };
}

function program(sites: Record<string, ProgramSite[]>, replies: string[] = [], into: Record<string, string> = {}) {
  nextLine = 1;
  const input: ProgramInput = {
    sites: new Map(Object.entries(sites)),
    root: 'root',
    node: (id) => ({ id, kind: 'function', name: id, qualifiedName: id, file: 'a.ts', line: 1, endLine: 2, language: 'typescript', test: false }),
    step: (id) => ({ reply: replies.includes(id), into: into[id] ?? null }),
  };
  return buildProgram(input);
}

/** The shape of a block, one line per item, indented — what a reader would see. */
function shape(block: WireBlock, indent = ''): string[] {
  const out: string[] = [];
  for (const item of block) {
    if (item.kind === 'step') {
      out.push(`${indent}${item.step}${item.again ? ' (again)' : ''}${item.within ? ` inside ${item.within}` : ''}`);
      if (item.body) out.push(...shape(item.body, `${indent}  `));
    } else if (item.kind === 'fork') {
      out.push(`${indent}${item.form} ${item.on}`);
      for (const arm of item.arms) {
        out.push(`${indent}  arm ${arm.when}${arm.ends ? ` ends:${arm.ends}` : ''}`);
        out.push(...shape(arm.body, `${indent}    `));
      }
    } else if (item.kind === 'block') {
      out.push(`${indent}${item.block}${item.via ? ` via ${item.via.name}` : item.by ? ` ${item.by}` : ''}${item.again ? ' (again)' : ''}`);
      out.push(...shape(item.body, `${indent}  `));
    } else out.push(`${indent}cut ${item.why}`);
  }
  return out;
}

/* --------------------------------------------------------------- tests -- */

describe('buildProgram', () => {
  it('reads a straight line in the code’s order', () => {
    const p = program({ root: [at('a'), at('b'), at('c')] });
    expect(shape(p!.root)).toEqual(['a', 'b', 'c']);
  });

  it('is nothing when the anchor has no body to read', () => {
    expect(program({})).toBeNull();
    expect(buildProgram({ sites: new Map(), root: null, node: () => null, step: () => null })).toBeNull();
  });

  it('makes an if and its else two arms of ONE fork', () => {
    const cond = 'user && ok';
    const p = program({
      root: [at('lookup'), at('sign', [g(cond)]), at('200', [g(cond)]), at('401', [g(cond, { negated: true, form: 'else' })])],
    });
    expect(shape(p!.root)).toEqual([
      'lookup',
      'if user && ok',
      '  arm user && ok',
      '    sign',
      '    200',
      '  arm !(user && ok)',
      '    401',
    ]);
    const fork = p!.root[1] as Extract<WireItem, { kind: 'fork' }>;
    expect(fork.arms).toHaveLength(2);
  });

  it('ends an arm that answers the request', () => {
    const cond = 'user';
    const p = program(
      { root: [at('200', [g(cond)]), at('401', [g(cond, { negated: true, form: 'else' })])] },
      ['200', '401']
    );
    expect(shape(p!.root)).toEqual(['if user', '  arm user ends:reply', '    200', '  arm !user ends:reply', '    401']);
  });

  it('draws an early exit as the fork’s other arm, with how it leaves', () => {
    // `if (!product) { res.status(404); throw }` then the rest — the guard on
    // the code AFTER carries the same branch, negated, and how the exit left.
    const p = program({
      root: [
        at('404', [g('!product', { branch: 'b:1' })]),
        at('save', [g('!product', { negated: true, form: 'guard', branch: 'b:1', exit: 'throw' })]),
      ],
    }, ['404']);
    expect(shape(p!.root)).toEqual(['if !product', '  arm !product ends:reply', '    404', '  arm product', '    save']);
  });

  it('draws an early exit whose arm holds nothing as a terminal', () => {
    const p = program({ root: [at('go', [g('busy', { negated: true, form: 'guard', exit: 'return' })])] });
    expect(shape(p!.root)).toEqual(['if busy', '  arm busy ends:return', '  arm !busy', '    go']);
  });

  it('nests forks the way the code nests them', () => {
    const outer = g('product', { branch: 'b:outer' });
    const inner = g('reviewed', { branch: 'b:inner' });
    const p = program(
      {
        root: [
          at('400', [outer, inner]),
          at('201', [outer, { ...inner, negated: true, form: 'guard', exit: 'throw' }]),
          at('404', [{ ...outer, negated: true, form: 'else' }]),
        ],
      },
      ['400', '201', '404']
    );
    expect(shape(p!.root)).toEqual([
      'if product',
      '  arm product',
      '    if reviewed',
      '      arm reviewed ends:reply',
      '        400',
      '      arm !reviewed ends:reply',
      '        201',
      '  arm !product ends:reply',
      '    404',
    ]);
  });

  it('puts every case of one switch under one fork', () => {
    const branch = 'b:switch';
    const p = program({
      root: [
        at('a', [g("kind === 'a'", { form: 'case', branch })]),
        at('b', [g("kind === 'b'", { form: 'case', branch })]),
        at('d', [g('kind: default', { form: 'case', branch })]),
      ],
    });
    // The head says what is being decided on; each arm its own case.
    expect(shape(p!.root)).toEqual([
      'switch kind',
      "  arm kind === 'a'",
      '    a',
      "  arm kind === 'b'",
      '    b',
      '  arm kind: default',
      '    d',
    ]);
  });

  it('keeps two try/catch blocks apart', () => {
    const p = program({
      root: [
        at('first', [g('on error', { form: 'catch', branch: 'b:try1' })]),
        at('second', [g('on error', { form: 'catch', branch: 'b:try2' })]),
      ],
    });
    expect(shape(p!.root)).toEqual(['try on error', '  arm on error', '    first', 'try on error', '  arm on error', '    second']);
  });

  it('draws a folded helper where it is called, and says what it is inside', () => {
    const p = program({
      root: [into('helper', [], { within: 'res.json' }), at('200')],
      helper: [at('sign')],
    });
    expect(shape(p!.root)).toEqual(['inline via helper', '  sign', '200']);
    const block = p!.root[0] as Extract<WireItem, { kind: 'block' }>;
    expect(block.within).toBe('res.json');
    expect(block.via?.name).toBe('helper');
  });

  it('puts a call written inside another call’s arguments first', () => {
    // `res.json({ token: generateToken(…) })` spans lines 14–21 and the token is
    // signed on line 19: the signing happens BEFORE the reply it is part of.
    const reply: ProgramSite = { step: '200', at: { line: 14, column: 4, end: { line: 21, column: 6 } }, guards: [] };
    const signed: ProgramSite = { step: 'sign', at: { line: 19, column: 13, end: { line: 19, column: 34 } }, guards: [] };
    const p = program({ root: [reply, signed] });
    expect(shape(p!.root)).toEqual(['sign', '200']);
  });

  it('reads a function once, however many times it is called', () => {
    const p = program({
      root: [into('helper'), at('x'), into('helper')],
      helper: [at('work')],
    });
    expect(shape(p!.root)).toEqual(['inline via helper', '  work', 'x', 'inline via helper (again)']);
  });

  it('reads on into a step the walk entered, and stops at one it did not', () => {
    // A step explores from its own function: `store`'s is `storeFn`, whose
    // sites are its body. A boundary — another screen, an effect — has none.
    const entered = program({ root: [at('store')], storeFn: [at('write')] }, [], { store: 'storeFn' });
    expect(shape(entered!.root)).toEqual(['store', '  write']);
    const boundary = program({ root: [at('store')], storeFn: [at('write')] });
    expect(shape(boundary!.root)).toEqual(['store']);
  });

  it('says a helper that calls itself was already read', () => {
    const p = program({ root: [into('a')], a: [at('x'), into('a')] });
    expect(shape(p!.root)).toEqual(['inline via a', '  x', '  inline via a (again)']);
  });

  it('puts work registered to run later in a block of its own', () => {
    const p = program({
      root: [at('now'), at('afterwards', [], { trigger: { kind: 'callback', name: 'then', of: null } })],
    });
    expect(shape(p!.root)).toEqual(['now', 'later then', '  afterwards']);
  });

  it('puts calls started together in one block', () => {
    const p = program({
      root: [at('a', [], { within: 'Promise.all' }), at('b', [], { within: 'Promise.all' }), at('c')],
    });
    expect(shape(p!.root)).toEqual(['together Promise.all', '  a inside Promise.all', '  b inside Promise.all', 'c']);
  });

  it('says a run of calls happens once per item', () => {
    const p = program({
      root: [at('before'), at('each', [], { loops: [loop('item of items')] }), at('after')],
    });
    expect(shape(p!.root)).toEqual(['before', 'loop item of items', '  each', 'after']);
  });

  it('nests a loop and a fork by which one is written outside the other', () => {
    // `for (…) { if (ready) { go() } }` — the loop starts first, so it is
    // outside; the guard's own branch position is what decides, not its order
    // in the chain.
    const inner = g('ready', { branch: '9:4' });
    const p = program({ root: [at('go', [inner], { loops: [loop('item of items', 'each', '8:2')] })] });
    expect(shape(p!.root)).toEqual(['loop item of items', '  if ready', '    arm ready', '      go']);

    // `if (ready) { for (…) { go() } }` — the same two constructs, the other
    // way round, told apart by where each begins.
    const outer = g('ready', { branch: '8:2' });
    const q = program({ root: [at('go', [outer], { loops: [loop('item of items', 'each', '9:4')] })] });
    expect(shape(q!.root)).toEqual(['if ready', '  arm ready', '    loop item of items', '      go']);
  });

  it('closes a fork when the code leaves it', () => {
    const cond = g('ready');
    const p = program({ root: [at('inside', [cond]), at('after')] });
    expect(shape(p!.root)).toEqual(['if ready', '  arm ready', '    inside', 'after']);
  });
});
