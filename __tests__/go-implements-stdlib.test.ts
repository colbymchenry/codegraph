/**
 * Go's implicit interface satisfaction (#584) compares method sets, following
 * the embeddings that resolve (#2402). An embedding of a type outside the
 * index resolves to nothing, so it added nothing:
 *
 *   type TBRun interface {     // prometheus's promql/promqltest
 *     testing.TB               // two dozen methods, one of them unexported
 *     Run(string, func(*testing.T)) bool
 *   }
 *
 * asked only for `Run`, and 40 service discoverers "implemented" it. The
 * embedded `error` was not even recorded.
 *
 * The methods of the standard-library types projects embed are known now,
 * with their parameter and result counts, and `error` is recorded as the
 * embedding it is. Such a method counts like any other, at its counts: an
 * embedded `sync.Mutex` makes a struct hugo's `Locker`, but not etcd's gRPC
 * `LockClient`, whose `Lock` takes a context and a request, and a `Write` that
 * takes a record is no `io.Writer`'s.
 * An unexported one is its own package's, as Go has it: `testing.TB`'s
 * `private`, which no project type can declare. Embedding any other outside
 * type (`zapcore.Core`, `grpc.ClientStream`) asks for methods nothing names:
 * a struct embedding the same type has them, and otherwise only the one struct
 * with every method the interface does name is taken to implement it.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { buildTypeHierarchy } from '../src/graph/type-hierarchy';
import { goStdlibMethods } from '../src/resolution/go-stdlib-methods';
import type { Edge, Node } from '../src/types';

/**
 * A project struct declaring every method `testing.TB` has, at its counts,
 * its unexported `private` included, and a TBRun's `Run`: in a package whose
 * directory is itself named `testing`, its `private` is still not testing's.
 */
function fakeTestingTB(): string {
  const lines = ['package testing', '', 'type fakeTB struct{}', ''];
  for (const [name, arity] of [...goStdlibMethods('testing', 'TB')!, ['Run', '2/1'] as const]) {
    const [params, results] = arity.split('/').map(Number) as [number, number];
    const list = Array.from({ length: params }, (_, i) => `a${i} int`).join(', ');
    const result = results === 0 ? '' : results === 1 ? ' int' : ` (${Array(results).fill('int').join(', ')})`;
    lines.push(`func (f *fakeTB) ${name}(${list})${result} { panic(0) }`);
  }
  return `${lines.join('\n')}\n`;
}

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // prometheus.
  'promql/promql.go': `package promql

import (
	"context"
	"io"
	"log/slog"
	"os"
	"testing"
)

// All of testing.TB, which only an embedding can have, and Run.
type TBRun interface {
	testing.TB
	Run(string, func(*testing.T)) bool
}

// A Run, and nothing of testing.TB.
type Discovery struct{}

func (d *Discovery) Run(name string, f func(*testing.T)) bool { return false }

// testing.TB through *testing.T, and a Run of its own.
type tRunner struct{ *testing.T }

func (r tRunner) Run(name string, f func(*testing.T)) bool { return r.T.Run(name, f) }

// discovery/file's test helper: all of TBRun through *testing.T, Run included.
type testRunner struct {
	*testing.T
	dir string
}

type syncWriter interface {
	io.Writer
	Sync() error
}

// Sync, and no Write.
type scrapePool struct{}

func (sp *scrapePool) Sync() error { return nil }

type queryLogFile struct{}

func (f *queryLogFile) Write(p []byte) (int, error) { return len(p), nil }
func (f *queryLogFile) Sync() error                 { return nil }

// Its Write takes a record and returns only an error: no io.Writer's.
type walLog struct{}

func (w *walLog) Write(rec *Record) error { return nil }
func (w *walLog) Sync() error             { return nil }

type SegmentFile interface {
	Stat() (os.FileInfo, error)
	Sync() error
	io.Writer
	io.Reader
	io.Closer
}

// Write through the SegmentFile it embeds, which has it from io.Writer.
type Segment struct {
	SegmentFile
	dir string
}

// No method of its own: what slog.Handler and io.Closer ask for.
type QueryLogger interface {
	slog.Handler
	io.Closer
}

type JSONFileLogger struct{}

func (l *JSONFileLogger) Enabled(ctx context.Context, level slog.Level) bool { return true }
func (l *JSONFileLogger) Handle(ctx context.Context, r slog.Record) error  { return nil }
func (l *JSONFileLogger) WithAttrs(attrs []slog.Attr) slog.Handler          { return l }
func (l *JSONFileLogger) WithGroup(name string) slog.Handler                { return l }
func (l *JSONFileLogger) Close() error                                      { return nil }
`,
  // etcd.
  'fileutil/fileutil.go': `package fileutil

import (
	"bufio"
	"context"
	"io"
	"io/fs"
	"os"
	"sync"
)

type FileReader interface {
	io.Reader
	FileInfo() (fs.FileInfo, error)
}

// Read is promoted from *os.File.
type fileReader struct{ *os.File }

func (fr *fileReader) FileInfo() (fs.FileInfo, error) { return fr.Stat() }

// Read is promoted from *bufio.Reader.
type FileBufReader struct {
	*bufio.Reader
	fi fs.FileInfo
}

func (fb *FileBufReader) FileInfo() (fs.FileInfo, error) { return fb.fi, nil }

// FileInfo, and nothing to Read with.
type fileStat struct{}

func (s *fileStat) FileInfo() (fs.FileInfo, error) { return nil, nil }

// v3lockpb's client: Lock and Unlock are gRPC calls.
type LockClient interface {
	Lock(ctx context.Context, name string) error
	Unlock(ctx context.Context, key string) error
}

// hugo's: what a mutex has.
type Locker interface {
	Lock()
	Unlock()
}

// A mutex's Lock and Unlock: a Locker's, not a LockClient's.
type waitRecorder struct {
	sync.Mutex
	actions []string
}

type lockProxy struct{}

func (p *lockProxy) Lock(ctx context.Context, name string) error  { return nil }
func (p *lockProxy) Unlock(ctx context.Context, key string) error { return nil }
`,
  // gin.
  'gin/response_writer.go': `package gin

import (
	"bufio"
	"net"
	"net/http"
)

type ResponseWriter interface {
	http.ResponseWriter
	http.Hijacker
	http.Flusher
	http.CloseNotifier
	Status() int
	Size() int
	WriteString(string) (int, error)
	Written() bool
	WriteHeaderNow()
	Pusher() http.Pusher
}

// Header is promoted from the http.ResponseWriter it wraps.
type responseWriter struct {
	http.ResponseWriter
	size   int
	status int
}

func (w *responseWriter) WriteHeader(code int)                          {}
func (w *responseWriter) WriteHeaderNow()                               {}
func (w *responseWriter) Write(data []byte) (int, error)                { return len(data), nil }
func (w *responseWriter) WriteString(s string) (int, error)             { return len(s), nil }
func (w *responseWriter) Status() int                                   { return w.status }
func (w *responseWriter) Size() int                                     { return w.size }
func (w *responseWriter) Written() bool                                 { return w.size >= 0 }
func (w *responseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error)  { return nil, nil, nil }
func (w *responseWriter) CloseNotify() <-chan bool                      { return nil }
func (w *responseWriter) Flush()                                        {}
func (w *responseWriter) Pusher() http.Pusher                           { return nil }

// The methods ResponseWriter declares, none that http asks for.
type sizeTracker struct{ size, status int }

func (t *sizeTracker) Status() int                       { return t.status }
func (t *sizeTracker) Size() int                         { return t.size }
func (t *sizeTracker) WriteString(s string) (int, error) { return len(s), nil }
func (t *sizeTracker) Written() bool                     { return t.size >= 0 }
func (t *sizeTracker) WriteHeaderNow()                   {}
func (t *sizeTracker) Pusher() http.Pusher               { return nil }
`,
  'errs/errs.go': `package errs

type coded interface {
	error
	Code() int
}

// Error is promoted from the error it wraps.
type statusErr struct {
	error
	code int
}

func (e statusErr) Code() int { return e.code }

// A Code, and no Error.
type counter struct{ n int }

func (c *counter) Code() int { return c.n }
`,
  // Interfaces embedding types nothing here describes.
  'diag/diag.go': `package diag

import (
	"github.com/libdns/libdns"
	plog "github.com/prometheus/common/log"
	"go.uber.org/zap"
	"go.uber.org/zap/zapcore"
	"google.golang.org/grpc"
)

// kapacitor's scraper.Diagnostic: Log, and a Logger.
type Diagnostic interface {
	plog.Logger
	Log(keyvals ...interface{}) error
}

type ScraperHandler struct{}

func (h *ScraperHandler) Debug(args ...interface{})          {}
func (h *ScraperHandler) Log(keyvals ...interface{}) error { return nil }

type AlertNode struct{}

func (n *AlertNode) Log(keyvals ...interface{}) error { return nil }

// caddy's: nothing else has a FlushTo.
type LogBufferCoreInterface interface {
	zapcore.Core
	FlushTo(*zap.Logger)
}

type LogBufferCore struct{}

func (c *LogBufferCore) FlushTo(l *zap.Logger) {}

type ClientStream interface {
	grpc.ClientStream
	Send(m any) error
	Recv(m any) error
}

// Has the gRPC stream's methods by embedding it.
type wrappedStream struct{ grpc.ClientStream }

func (s *wrappedStream) Send(m any) error { return nil }
func (s *wrappedStream) Recv(m any) error { return nil }

// Sends and receives, as a server stream.
type serverStream struct{}

func (s *serverStream) Send(m any) error { return nil }
func (s *serverStream) Recv(m any) error { return nil }

// Nothing it asks for has a name here.
type DNSProvider interface {
	libdns.RecordGetter
	libdns.RecordSetter
}
`,
  'testing/fake.go': fakeTestingTB(),
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-implements-stdlib-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

const meta = (e: Edge): Record<string, unknown> => (e.metadata ?? {}) as Record<string, unknown>;
const pkg = (n: Node | null): string => `${path.posix.dirname(n?.filePath ?? '?')}.${n?.name}`;

/** The one non-import node with this name in this file. */
function one(name: string, file: string): Node {
  const found = cg.getNodesByName(name).filter((n) => n.filePath === file && n.kind !== 'import');
  expect(found, `${name} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** Every synthesized struct → interface edge, as `pkg.Struct -> pkg.Interface`. */
function goImplements(): string[] {
  const structs = cg.getNodesByKind('struct').filter((n) => n.language === 'go');
  return cg
    .getOutgoingEdgesFrom(structs.map((n) => n.id), ['implements'])
    .filter((e) => meta(e).synthesizedBy === 'go-implements')
    .map((e) => `${pkg(cg.getNode(e.source))} -> ${pkg(cg.getNode(e.target))}`)
    .sort();
}

describe('Go implicit satisfaction knows what standard-library embeddings bring', () => {
  it('links exactly the structs that have every method, embedded ones included', () => {
    expect(goImplements()).toEqual([
      'diag.LogBufferCore -> diag.LogBufferCoreInterface',
      'diag.wrappedStream -> diag.ClientStream',
      'errs.statusErr -> errs.coded',
      'fileutil.FileBufReader -> fileutil.FileReader',
      'fileutil.fileReader -> fileutil.FileReader',
      // An *os.File is what prometheus's SegmentFile and syncWriter describe.
      'fileutil.fileReader -> promql.SegmentFile',
      'fileutil.fileReader -> promql.syncWriter',
      'fileutil.lockProxy -> fileutil.LockClient',
      'fileutil.waitRecorder -> fileutil.Locker',
      'gin.responseWriter -> gin.ResponseWriter',
      'promql.JSONFileLogger -> promql.QueryLogger',
      'promql.Segment -> promql.syncWriter',
      'promql.queryLogFile -> promql.syncWriter',
      'promql.tRunner -> promql.TBRun',
      'promql.testRunner -> promql.TBRun',
    ]);
  });

  it('asks for every method of testing.TB and io.Writer, testing\'s own private and io\'s counts included', () => {
    const implementers = (name: string, file: string) =>
      (buildTypeHierarchy(cg, one(name, file))?.descendants ?? []).map((d) => `${d.relation} ${pkg(d.node)}`).sort();
    // Not the discoverer with a Run, nor fakeTB, whose private is its own package's.
    expect(implementers('TBRun', 'promql/promql.go')).toEqual(['implements promql.tRunner', 'implements promql.testRunner']);
    // Not walLog, whose Write takes a record and returns only an error.
    expect(implementers('syncWriter', 'promql/promql.go')).toEqual([
      'implements fileutil.fileReader',
      'implements promql.Segment',
      'implements promql.queryLogFile',
    ]);
    // A call through TBRun reaches tRunner's Run, not the discoverer's;
    // testRunner's is testing's, outside the graph.
    const run = cg
      .getOutgoingEdgesFrom([one('TBRun', 'promql/promql.go').id], ['contains'])
      .map((e) => cg.getNode(e.target))
      .find((n) => n?.name === 'Run')!;
    expect(
      cg
        .getOutgoingEdgesFrom([run.id], ['calls'])
        .filter((e) => meta(e).synthesizedBy === 'interface-impl')
        .map((e) => cg.getNode(e.target)?.qualifiedName)
    ).toEqual(['tRunner::Run']);
  });

  it('records an embedded error, which stays outside the graph', () => {
    for (const [name, file] of [['statusErr', 'errs/errs.go'], ['coded', 'errs/errs.go']] as const) {
      const node = one(name, file);
      expect(
        cg.getUnresolvedReferencesFrom(node.id).filter((r) => r.referenceKind === 'extends').map((r) => r.referenceName)
      ).toEqual(['error']);
      expect(cg.getOutgoingEdgesFrom([node.id], ['extends', 'implements']).filter((e) => e.provenance !== 'heuristic')).toEqual([]);
    }
  });

  it('holds a method a standard-library embedding brings to the counts of the one it answers', () => {
    const into = (name: string, file: string) =>
      cg
        .getIncomingEdgesTo([one(name, file).id], ['implements'])
        .filter((e) => meta(e).synthesizedBy === 'go-implements')
        .map((e) => pkg(cg.getNode(e.source)))
        .sort();
    // waitRecorder's Lock and Unlock are sync.Mutex's: they take nothing.
    expect(into('Locker', 'fileutil/fileutil.go')).toEqual(['fileutil.waitRecorder']);
    expect(into('LockClient', 'fileutil/fileutil.go')).toEqual(['fileutil.lockProxy']);
    // responseWriter's Header is http.ResponseWriter's, which ResponseWriter asks for.
    expect(into('ResponseWriter', 'gin/response_writer.go')).toEqual(['gin.responseWriter']);
  });

  it('links an interface embedding an undescribed type to the same embedding, or to its one candidate', () => {
    const into = (name: string) =>
      cg
        .getIncomingEdgesTo([one(name, 'diag/diag.go').id], ['implements'])
        .filter((e) => meta(e).synthesizedBy === 'go-implements')
        .map((e) => pkg(cg.getNode(e.source)))
        .sort();
    // Two structs have a Log: neither is known to be a plog.Logger.
    expect(into('Diagnostic')).toEqual([]);
    expect(into('LogBufferCoreInterface')).toEqual(['diag.LogBufferCore']);
    expect(into('ClientStream')).toEqual(['diag.wrappedStream']);
    expect(into('DNSProvider')).toEqual([]);
  });
});

describe('a sync that changes what an interface embeds', () => {
  let dir = '';
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('re-reads the standard-library type it names', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-implements-stdlib-sync-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    const api = 'package api\n\nimport stdio "io"\n\ntype SyncWriter interface {\n\tstdio.Writer\n\tSync() error\n}\n';
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('api/api.go', api);
    write(
      'log/file.go',
      'package log\n\ntype file struct{}\n\nfunc (f *file) Write(p []byte) (int, error) { return len(p), nil }\nfunc (f *file) Sync() error { return nil }\n'
    );
    graph = await CodeGraph.init(dir, { index: true });
    const g = graph;
    const linked = () =>
      g
        .getOutgoingEdgesFrom(g.getNodesByKind('struct').map((n) => n.id), ['implements'])
        .filter((e) => meta(e).synthesizedBy === 'go-implements')
        .map((e) => `${g.getNode(e.source)?.name} -> ${g.getNode(e.target)?.name}`);

    expect(linked()).toEqual(['file -> SyncWriter']);
    // An io.Reader has to Read, which file can't.
    write('api/api.go', api.replace('stdio.Writer', 'stdio.Reader'));
    await g.sync({ paths: ['api/api.go'] });
    expect(linked()).toEqual([]);
    write('api/api.go', api);
    await g.sync({ paths: ['api/api.go'] });
    expect(linked()).toEqual(['file -> SyncWriter']);
  }, 60_000);
});
