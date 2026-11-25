/**
 * Regression test for adaptive `codegraph_explore` sizing — sibling
 * skeletonization (branch `feat/adaptive-explore-sizing`, commit d6d059f).
 *
 * Feature: when a file is BOTH (1) off the synthesized flow spine AND (2) a
 * polymorphic sibling — its class implements/extends a supertype shared by
 * >= MIN_SIBLINGS (3) implementers — `codegraph_explore` renders it as a
 * class + member *signature* skeleton (bodies elided) instead of full source,
 * keeping the on-spine exemplar and the mechanism full. This sizes the
 * response to the answer rather than the budget cap on sibling-heavy flows
 * (OkHttp's interceptor chain) without starving diffuse ones (distinct
 * pipeline steps stay full). Default ON; CODEGRAPH_ADAPTIVE_EXPLORE=0 disables.
 *
 * The fixture is OkHttp's interceptor chain in miniature:
 *   - `Interceptor` interface with FOUR implementers (>= 3 => a sibling family)
 *   - a 3-hop call spine `dispatch -> proceed -> handleLogging` that passes
 *     THROUGH LoggingInterceptor — so that file is the on-spine exemplar
 *   - Bridge/Cache/RetryInterceptor: off-spine members of the sibling family
 *     => skeletonize
 *   - ResponseFormatter implements `Formatter`, which has only ONE impl (< 3)
 *     => a distinct step: off-spine but NOT a sibling => stays full
 *
 * Guards the two ways the feature can silently regress: skeletonizing too much
 * (a distinct step or the on-spine exemplar) or too little (the off-spine
 * siblings), plus the escape hatch.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolHandler } from '../src/mcp/tools';
import CodeGraph from '../src/index';

// Stable marker — assert the `· skeleton` tag, not its exact trailing wording
// (the steer-to-explore phrasing changed when the Read invitation was removed).
const SKELETON_MARK = '· skeleton (signatures only';

/** Return the ``**`<path>`** ...`` section for a file basename, header through the
 *  line before the next bold header (or end of output). Headers are bold labels,
 *  not ATX headings (issue #778); file sections start with ``**` ``. */
function sectionFor(text: string, basename: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('**`') && l.includes(basename));
  if (start < 0) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('**')) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n');
}

describe('adaptive codegraph_explore sizing — sibling skeletonization', () => {
  let testDir: string;
  let cg: CodeGraph;
  let handler: ToolHandler;

  // Names the spine (dispatch/proceed/handleLogging), the on-spine exemplar,
  // the three off-spine siblings, and the distinct step — so every file we
  // assert on is gathered as relevant. maxFiles overrides the very-tiny tier's
  // 4-file default so all of them land in one call.
  const QUERY =
    'dispatch proceed handleLogging LoggingInterceptor BridgeInterceptor CacheInterceptor RetryInterceptor ResponseFormatter';

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-adaptive-explore-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    const write = (name: string, body: string) =>
      fs.writeFileSync(path.join(srcDir, name), body.trimStart());

    // The interchangeable contract — 4 implementers below => sibling family.
    write(
      'interceptor.ts',
      `
export interface Interceptor {
  intercept(request: string): string;
}
`
    );

    // The mechanism + the spine: dispatch -> proceed -> (LoggingInterceptor) handleLogging.
    // Unique method names so the call edges resolve unambiguously.
    write(
      'dispatcher.ts',
      `
import { LoggingInterceptor } from './logging-interceptor';

export class RequestDispatcher {
  dispatch(): string {
    const chain = new InterceptorChain();
    return chain.proceed();
  }
}

export class InterceptorChain {
  proceed(): string {
    const exemplar = new LoggingInterceptor();
    return exemplar.handleLogging();
  }
}
`
    );

    // On-spine exemplar: handleLogging is the spine's tail, so this whole file
    // is on-spine and must stay FULL even though it's a sibling (implements Interceptor).
    write(
      'logging-interceptor.ts',
      `
import { Interceptor } from './interceptor';

export class LoggingInterceptor implements Interceptor {
  handleLogging(): string {
    const tag = 'LOGGING_BODY_MARKER';
    return this.intercept(tag);
  }
  intercept(request: string): string {
    return 'logged:' + request;
  }
}
`
    );

    // Off-spine siblings — interchangeable impls of Interceptor => SKELETONIZE.
    // Each body carries a unique marker that must NOT survive skeletonization.
    write(
      'bridge-interceptor.ts',
      `
import { Interceptor } from './interceptor';

export class BridgeInterceptor implements Interceptor {
  intercept(request: string): string {
    const detail = 'BRIDGE_BODY_MARKER';
    return 'bridged:' + request + detail;
  }
}
`
    );
    write(
      'cache-interceptor.ts',
      `
import { Interceptor } from './interceptor';

export class CacheInterceptor implements Interceptor {
  intercept(request: string): string {
    const detail = 'CACHE_BODY_MARKER';
    return 'cached:' + request + detail;
  }
}
`
    );
    write(
      'retry-interceptor.ts',
      `
import { Interceptor } from './interceptor';

export class RetryInterceptor implements Interceptor {
  intercept(request: string): string {
    const detail = 'RETRY_BODY_MARKER';
    return 'retried:' + request + detail;
  }
}
`
    );

    // A 1:1 interface->impl pair: off-spine, implements something, but the
    // supertype has only ONE impl (< MIN_SIBLINGS) => a DISTINCT step => FULL.
    write(
      'formatter.ts',
      `
export interface Formatter {
  format(input: string): string;
}
`
    );
    write(
      'response-formatter.ts',
      `
import { Formatter } from './formatter';
import { JsonCodec } from './codec';

export class ResponseFormatter implements Formatter {
  format(input: string): string {
    const detail = 'FORMATTER_BODY_MARKER';
    // Calls into the Codec family from OFF the dispatch spine, so codec.ts is
    // gathered as relevant but stays off-spine (mirrors Django: compiler.py is
    // referenced by the flow yet off the QuerySet-iteration spine).
    return new JsonCodec().encode(input) + detail;
  }
}
`
    );

    // An off-spine sibling (implements Interceptor) the agent would otherwise
    // skeletonize — BUT it owns a uniquely-named method `authenticate` the agent
    // names in the query. Mirrors OkHttp's RealCall (named getResponseWith-
    // InterceptorChain): a named callable means "show me this", so it stays full.
    write(
      'auth-interceptor.ts',
      `
import { Interceptor } from './interceptor';

export class AuthInterceptor implements Interceptor {
  authenticate(token: string): string {
    const detail = 'AUTH_BODY_MARKER';
    return 'auth:' + token + detail;
  }
  intercept(request: string): string {
    return this.authenticate(request);
  }
}
`
    );

    // A base class that DEFINES a >=3-impl supertype AND co-locates its
    // subclasses in the same file — mirrors Django's compiler.py (SQLCompiler +
    // SQLInsertCompiler/SQLUpdateCompiler/...). The subclasses' `extends` edges
    // make the file look like a sibling, but it's the family's base/mechanism,
    // so it must stay full.
    write(
      'codec.ts',
      `
export class Codec {
  encode(input: string): string {
    const detail = 'CODEC_BASE_MARKER';
    return input + detail;
  }
}
export class JsonCodec extends Codec {
  encode(input: string): string { return '{' + input + '}'; }
}
export class XmlCodec extends Codec {
  encode(input: string): string {
    const detail = 'XML_BODY_MARKER';
    return '<' + input + detail + '>';
  }
}
export class YamlCodec extends Codec {
  encode(input: string): string { return '- ' + input; }
}
`
    );

    cg = CodeGraph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    handler = new ToolHandler(cg);
  });

  afterAll(() => {
    if (cg) cg.destroy();
    if (testDir && fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    // Each test asserts against the default (ON) behaviour unless it opts out.
    delete process.env.CODEGRAPH_ADAPTIVE_EXPLORE;
  });

  it('fixture sanity: Interceptor has >=3 implementers, Formatter has <3', () => {
    const find = (name: string, kind: string) =>
      cg.searchNodes(name).map((r) => r.node).find((n) => n.name === name && n.kind === kind);

    const interceptor = find('Interceptor', 'interface');
    const formatter = find('Formatter', 'interface');
    expect(interceptor).toBeTruthy();
    expect(formatter).toBeTruthy();

    const implementers = (id: string) =>
      cg.getIncomingEdges(id).filter((e) => e.kind === 'implements' || e.kind === 'extends').length;

    // The whole gate hinges on this signal — assert the fixture actually
    // produces the >=3 / <3 split, so a TS-extraction change fails here loudly
    // rather than silently flipping the skeletonization downstream.
    expect(implementers(interceptor!.id)).toBeGreaterThanOrEqual(3);
    expect(implementers(formatter!.id)).toBeLessThan(3);
  });

  it('skeletonizes off-spine polymorphic siblings (bodies elided, signatures kept)', async () => {
    const result = await handler.execute('codegraph_explore', { query: QUERY, maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';

    // Precondition: the spine must have formed, or nothing skeletonizes.
    expect(text).toContain('**Flow (call path among the symbols you queried)');

    for (const [file, marker] of [
      ['bridge-interceptor.ts', 'BRIDGE_BODY_MARKER'],
      ['cache-interceptor.ts', 'CACHE_BODY_MARKER'],
      ['retry-interceptor.ts', 'RETRY_BODY_MARKER'],
    ] as const) {
      const section = sectionFor(text, file);
      expect(section, `${file} should be present in the explore output`).not.toBe('');
      expect(section, `${file} should be skeletonized`).toContain(SKELETON_MARK);
      // The signature line survives; the body (with its marker) is elided.
      expect(section).toContain('intercept(request');
      expect(section, `${file} body marker must NOT survive skeletonization`).not.toContain(marker);
    }
  });

  it('keeps the on-spine exemplar full even though it is a sibling', async () => {
    const result = await handler.execute('codegraph_explore', { query: QUERY, maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';

    const section = sectionFor(text, 'logging-interceptor.ts');
    expect(section, 'logging-interceptor.ts should be present').not.toBe('');
    expect(section, 'on-spine exemplar must NOT be skeletonized').not.toContain(SKELETON_MARK);
    // Full source => the body marker is present.
    expect(section).toContain('LOGGING_BODY_MARKER');
  });

  it('keeps a distinct step full (off-spine but supertype has < 3 implementers)', async () => {
    const result = await handler.execute('codegraph_explore', { query: QUERY, maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';

    const section = sectionFor(text, 'response-formatter.ts');
    expect(section, 'response-formatter.ts should be present').not.toBe('');
    expect(section, 'a 1:1 interface impl is not a sibling and must stay full').not.toContain(SKELETON_MARK);
    expect(section).toContain('FORMATTER_BODY_MARKER');
  });

  it('CODEGRAPH_ADAPTIVE_EXPLORE=0 disables skeletonization (siblings render full)', async () => {
    process.env.CODEGRAPH_ADAPTIVE_EXPLORE = '0';
    try {
      const result = await handler.execute('codegraph_explore', { query: QUERY, maxFiles: 12 });
      const text = result.content?.[0]?.text ?? '';

      expect(text, 'no file should be skeletonized with the flag off').not.toContain(SKELETON_MARK);
      // The previously-skeletonized siblings now render their full bodies.
      const section = sectionFor(text, 'bridge-interceptor.ts');
      expect(section).not.toBe('');
      expect(section).toContain('BRIDGE_BODY_MARKER');
    } finally {
      delete process.env.CODEGRAPH_ADAPTIVE_EXPLORE;
    }
  });

  // Names AuthInterceptor's `authenticate` and Codec's `encode` (both methods),
  // plus the spine tokens so a spine still forms. Same Interceptor family as the
  // skeleton test, plus the Codec base+subclasses family.
  const SPARE_QUERY = `${QUERY} authenticate encode AuthInterceptor Codec JsonCodec`;

  it('spares an off-spine sibling when the agent NAMED a callable in it (RealCall fix)', async () => {
    const result = await handler.execute('codegraph_explore', { query: SPARE_QUERY, maxFiles: 15 });
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('**Flow (call path among the symbols you queried)');

    // auth-interceptor.ts is an off-spine Interceptor sibling — would skeletonize —
    // but the agent named its method `authenticate`, so it stays FULL.
    const auth = sectionFor(text, 'auth-interceptor.ts');
    expect(auth, 'auth-interceptor.ts should be present').not.toBe('');
    expect(auth, 'a file holding an agent-named callable must NOT be skeletonized').not.toContain(SKELETON_MARK);
    expect(auth).toContain('AUTH_BODY_MARKER');

    // Contrast: bridge-interceptor.ts — same family, named only by TYPE — still skeletonizes.
    const bridge = sectionFor(text, 'bridge-interceptor.ts');
    expect(bridge, 'a sibling named only by type still skeletonizes').toContain(SKELETON_MARK);
    expect(bridge).not.toContain('BRIDGE_BODY_MARKER');
  });

  it('collapses a base+subclasses family file to a FOCUSED view — base method body kept, non-named subclasses signature-only (compiler.py)', async () => {
    const result = await handler.execute('codegraph_explore', { query: SPARE_QUERY, maxFiles: 15 });
    const text = result.content?.[0]?.text ?? '';

    // codec.ts defines the base Codec (>=3 subclasses extend it) and co-locates the
    // subclasses — a "family" file (Django's compiler.py). The family-override fires
    // (it is NOT spared into a full clustered render despite the named `encode`), so
    // it COLLAPSES — but per-symbol: the named base method `Codec.encode` keeps its
    // body (so the agent doesn't Read it back — Django's SQLCompiler.execute_sql),
    // while a non-named subclass (XmlCodec) collapses to a signature. That packs the
    // mechanism into budget without the redundant subclass bodies.
    const codec = sectionFor(text, 'codec.ts');
    expect(codec, 'codec.ts should be present').not.toBe('');
    expect(codec, 'a named family file collapses to a focused (not full) view').toContain('· focused');
    expect(codec, 'the named base method body is kept (no Read-back)').toContain('CODEC_BASE_MARKER');
    expect(codec, 'a non-named subclass body is elided to a signature').not.toContain('XML_BODY_MARKER');
  });

  it('naming a SHARED/polymorphic method does not spare the siblings (uniqueness-aware)', async () => {
    // `intercept` is implemented by every interceptor (5 defs) — a polymorphic name,
    // not a unique one. Naming it must NOT keep all five full (that floods the budget
    // — Django's `as_sql`×110). The off-spine siblings still collapse, and since none
    // defines the supertype, `intercept` doesn't even earn a body — pure skeleton.
    const result = await handler.execute('codegraph_explore', { query: `${QUERY} intercept`, maxFiles: 12 });
    const text = result.content?.[0]?.text ?? '';

    const bridge = sectionFor(text, 'bridge-interceptor.ts');
    expect(bridge, 'a sibling named only via a shared method is not spared').toContain(SKELETON_MARK);
    expect(bridge, 'a shared method does not earn a body in a non-supertype leaf').not.toContain('BRIDGE_BODY_MARKER');
  });
});
