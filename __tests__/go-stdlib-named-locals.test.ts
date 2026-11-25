/**
 * A dotted Go reference whose receiver is named like a standard-library
 * package (`context`, `url`, `user`, `scanner`, `printer`, `log`, …) is taken
 * for a call into that package and dropped before resolution. A parameter or
 * local can carry the name too, and a call through it is a method call on
 * that variable: gin's `router.Use(func(context *Context) { context.Next() })`,
 * harbor's `context := NewSecurityContext(…)` then
 * `context.IsAuthenticated()`, etcd's `printer.DBHashKV(…)`.
 *
 * Such a call resolves by what the variable's declaration says, never by its
 * name, which fits many of a big tree's types: the type it is written as, the
 * package of the project function its value comes from, or a method name no
 * other type declares. A variable holding a value of a package from outside
 * the project (`scanner := bufio.NewScanner(r)`, `url, err := url.Parse(raw)`,
 * a `context *gin.Context` parameter) calls none of the project's methods.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const files: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  // gin's own Context, called from its tests through a parameter named `context`.
  'gin/context.go': `package gin

type Context struct{}

func (c *Context) AbortWithError(code int, err error) error { return err }

func (c *Context) Next() {}

type Engine struct{}

func New() *Engine { return &Engine{} }

func (engine *Engine) Use(middleware func(*Context)) {}
`,
  'gin/middleware_test.go': `package gin

import (
	"errors"
	"net/http"
	"testing"
)

func TestMiddlewareFailHandlersChain(t *testing.T) {
	router := New()
	router.Use(func(context *Context) {
		context.AbortWithError(http.StatusInternalServerError, errors.New("foo"))
	})
	router.Use(func(context *Context) {
		context.Next()
	})
}
`,
  // harbor's security contexts: an interface, and two packages' implementations.
  'security/context.go': `package security

type Context interface {
	IsAuthenticated() bool
}
`,
  'secret/context.go': `package secret

type SecurityContext struct{ secret string }

func NewSecurityContext(secret string, store any) *SecurityContext {
	return &SecurityContext{secret: secret}
}

func (s *SecurityContext) IsAuthenticated() bool { return s.secret != "" }
`,
  'local/context.go': `package local

type SecurityContext struct{ user string }

func (s *SecurityContext) IsAuthenticated() bool { return s.user != "" }
`,
  'secret/context_test.go': `package secret

import "testing"

func TestIsAuthenticated(t *testing.T) {
	context := NewSecurityContext("", nil)
	if context.IsAuthenticated() {
		t.Fail()
	}
}
`,
  // Project types with the method names of the standard library's and gin's
  // types: a call on one of those values must not land here.
  'textutil/types.go': `package textutil

type Scanner struct{}

func (s *Scanner) Scan() bool { return false }

func (s *Scanner) Text() string { return "" }

type URL struct{}

func (u *URL) Hostname() string { return "" }

type Context struct{}

func (c *Context) JSON(code int, obj any) {}
`,
  'textutil/read.go': `package textutil

import (
	"bufio"
	"io"
	"net/url"

	"github.com/gin-gonic/gin"
)

func FirstLine(r io.Reader) string {
	scanner := bufio.NewScanner(r)
	if scanner.Scan() {
		return scanner.Text()
	}
	return ""
}

func Host(raw string) string {
	url, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	return url.Hostname()
}

func Handle(context *gin.Context) {
	context.JSON(200, nil)
}
`,
  // A parameter declared as a project package's type, which another package
  // shares the name of.
  'models/user.go': `package models

type User struct{ Name string }

func (u *User) Validate() error { return nil }
`,
  'legacy/user.go': `package legacy

type User struct{}

func (u *User) Validate() error { return nil }

func (u *User) Name() string { return "" }
`,
  'api/users.go': `package api

import (
	"context"
	"strings"

	"example.com/app/models"
)

func Save(user *models.User) error {
	return user.Validate()
}

func Label(user *models.User) string {
	name := user.Name
	return name
}

// Named like the standard library's functions.
func Background() {}

func TrimSpace(s string) string { return s }

func Run() string {
	ctx := context.Background()
	_ = ctx
	return strings.TrimSpace(" x ")
}
`,
  // harbor's lib/log: a project package named like the standard library's,
  // whose logger a local takes the name of.
  'lib/log/log.go': `package log

type Logger struct{}

func G(ctx any) *Logger { return &Logger{} }

func (l *Logger) Errorf(format string, v ...any) {}

func Errorf(format string, v ...any) {}
`,
  'quota/util.go': `package quota

import (
	"context"

	"example.com/app/lib/log"
)

func Refresh(ctx context.Context) {
	log := log.G(ctx)
	log.Errorf("refresh quota: %v", ctx)
}
`,
  // kubernetes' post-start hooks: the hook context gets Done from the
  // standard library's context it embeds, not from a project type.
  'wait/wait.go': `package wait

type channelContext struct{ stopCh <-chan struct{} }

func (c channelContext) Done() <-chan struct{} { return c.stopCh }
`,
  'apiserver/hooks.go': `package apiserver

import "context"

type PostStartHookContext struct {
	context.Context
	LoopbackClientConfig string
}

func AddPostStartHook(name string, hook func(context PostStartHookContext) error) {}

func register() {
	AddPostStartHook("start-informers", func(context PostStartHookContext) error {
		<-context.Done()
		return nil
	})
}
`,
  // kubernetes' cli-runtime printers, and kubeadm's unrelated Printer.
  'printers/printers.go': `package printers

type ResourcePrinter interface {
	PrintObj(obj any) error
}

type HumanReadablePrinter struct{}

func (h *HumanReadablePrinter) PrintObj(obj any) error { return nil }

type JSONPrinter struct{}

func (p *JSONPrinter) PrintObj(obj any) error { return nil }

func NewTablePrinter() ResourcePrinter { return &HumanReadablePrinter{} }
`,
  'printers/tableprinter_test.go': `package printers

import "testing"

func TestPrintTable(t *testing.T) {
	printer := NewTablePrinter()
	_ = printer.PrintObj(nil)
}
`,
  'kubeadm/output/output.go': `package output

type Printer interface {
	PrintObj(obj any) error
}
`,
  // etcd's etcdutl printers: the variable is the interface its type is named.
  'etcdutl/printer.go': `package etcdutl

type printer interface {
	DBHashKV(hash uint32)
}

type simplePrinter struct{}

func (s *simplePrinter) DBHashKV(hash uint32) {}

type jsonPrinter struct{}

func (j *jsonPrinter) DBHashKV(hash uint32) {}

func initPrinterFromCmd(format string) printer {
	if format == "json" {
		return &jsonPrinter{}
	}
	return &simplePrinter{}
}

func hashKVCommandFunc(format string) {
	printer := initPrinterFromCmd(format)
	printer.DBHashKV(1)
}
`,
  // etcd's traceutil, and a namesake Trace in another package.
  'traceutil/trace.go': `package traceutil

type Trace struct{}

func Get(ctx any) *Trace { return &Trace{} }

func (t *Trace) Step(msg string) {}
`,
  'otherutil/trace.go': `package otherutil

type Trace struct{}

func (t *Trace) Step(msg string) {}
`,
  'txn/range.go': `package txn

import "example.com/app/traceutil"

func executeRange(ctx any) {
	trace := traceutil.Get(ctx)
	trace.Step("range")
}
`,
  // etcd's grpc proxy: a function of its own package hands out another
  // package's TLSInfo.
  'transport/tls.go': `package transport

type TLSInfo struct{ CAFile string }

func (info TLSInfo) ClientConfig() string { return info.CAFile }
`,
  'etcdmain/grpc_proxy.go': `package etcdmain

import "example.com/app/transport"

func newTLS(ca string) *transport.TLSInfo { return &transport.TLSInfo{CAFile: ca} }

func newClientCfg(ca string) string {
	tls := newTLS(ca)
	return tls.ClientConfig()
}
`,
  // Range variables: nothing says what they hold.
  'plugins/plugins.go': `package plugins

type Plugin interface {
	Name() string
}

type volumePlugin struct{}

func (v *volumePlugin) Name() string { return "volume" }

func (v *volumePlugin) CanSupportAttach() bool { return true }

func names(all []Plugin) []string {
	var out []string
	for _, plugin := range all {
		out = append(out, plugin.Name())
	}
	return out
}

func attachable(all []*volumePlugin) int {
	n := 0
	for _, plugin := range all {
		if plugin.CanSupportAttach() {
			n++
		}
	}
	return n
}
`,
};

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-stdlib-locals-'));
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 60_000);

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

/** The line of `file` that holds `snippet`. */
const lineOf = (file: string, snippet: string): number => {
  const at = files[file]!.split('\n').findIndex((l) => l.includes(snippet));
  if (at < 0) throw new Error(`no ${snippet} in ${file}`);
  return at + 1;
};

/** What the references on the line of `file` holding `snippet` reach, as `file:qualifiedName`. */
const reachedAt = (file: string, snippet: string): string[] => {
  const line = lineOf(file, snippet);
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids)
    .filter((e) => e.kind !== 'contains' && e.line === line)
    .map((e) => {
      const target = cg.getNode(e.target)!;
      return `${target.filePath}:${target.qualifiedName}`;
    });
};

describe('a Go parameter or local named like a standard-library package', () => {
  it('calls the methods of the project type it is declared as', () => {
    expect(reachedAt('gin/middleware_test.go', 'context.AbortWithError(')).toEqual(['gin/context.go:Context::AbortWithError']);
    expect(reachedAt('gin/middleware_test.go', 'context.Next()')).toEqual(['gin/context.go:Context::Next']);
    // Not legacy's `User`, which shares the name.
    expect(reachedAt('api/users.go', 'user.Validate()')).toEqual(['models/user.go:User::Validate']);
  });

  it("calls nothing the project declares when its type gets the method from outside", () => {
    // `Done` comes from the `context.Context` the hook context embeds: not
    // the project's `channelContext`, which a receiver word would name.
    expect(reachedAt('apiserver/hooks.go', 'context.Done()')).toEqual([]);
  });

  it('calls a method of the package of the project function its value comes from', () => {
    // harbor: secret's own, not local's namesake or the security.Context interface.
    expect(reachedAt('secret/context_test.go', 'context.IsAuthenticated()')).toEqual(['secret/context.go:SecurityContext::IsAuthenticated']);
    // etcd: traceutil's Trace, not another package's.
    expect(reachedAt('txn/range.go', 'trace.Step(')).toEqual(['traceutil/trace.go:Trace::Step']);
    // A logger a project package named like the standard library's hands out:
    // the Logger's method, not the package's function.
    expect(reachedAt('quota/util.go', 'log.Errorf(')).toEqual(['lib/log/log.go:Logger::Errorf']);
    // A package that declares no method of the name: one no other type declares.
    expect(reachedAt('etcdmain/grpc_proxy.go', 'tls.ClientConfig()')).toEqual(['transport/tls.go:TLSInfo::ClientConfig']);
  });

  it('takes the type named like the variable among that package\'s', () => {
    expect(reachedAt('etcdutl/printer.go', 'printer.DBHashKV(1)')).toEqual(['etcdutl/printer.go:printer::DBHashKV']);
  });

  it('guesses no type by its name', () => {
    // Two `PrintObj`s in printers, neither a `printer`, and kubeadm's unrelated `Printer`.
    expect(reachedAt('printers/tableprinter_test.go', 'printer.PrintObj(nil)')).toEqual([]);
    // A range variable calls only a method no other type declares.
    expect(reachedAt('plugins/plugins.go', 'plugin.Name()')).toEqual([]);
    expect(reachedAt('plugins/plugins.go', 'plugin.CanSupportAttach()')).toEqual(['plugins/plugins.go:volumePlugin::CanSupportAttach']);
  });

  it('holds no project method when its value comes from outside the project', () => {
    expect(reachedAt('textutil/read.go', 'if scanner.Scan()')).toEqual([]);
    expect(reachedAt('textutil/read.go', 'return scanner.Text()')).toEqual([]);
    expect(reachedAt('textutil/read.go', 'url.Hostname()')).toEqual([]);
    expect(reachedAt('textutil/read.go', 'context.JSON(')).toEqual([]);
  });

  it('is read as a value, not a method, where it is not called', () => {
    // `user.Name` is the field, not legacy's `Name` method.
    expect(reachedAt('api/users.go', 'name := user.Name')).toEqual([]);
  });

  it('leaves the package what its name names where nothing shadows it', () => {
    expect(reachedAt('api/users.go', 'context.Background()')).toEqual([]);
    expect(reachedAt('api/users.go', 'strings.TrimSpace(')).toEqual([]);
    expect(reachedAt('textutil/read.go', 'url.Parse(raw)')).toEqual([]);
  });

  it('is read from the file as a sync leaves it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-stdlib-locals-sync-'));
    const write = (rel: string, content: string): void => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    write('go.mod', 'module example.com/app\n\ngo 1.22\n');
    write('gin/context.go', files['gin/context.go']!);
    // The call keeps its line and column: a stale reading would still see the parameter.
    const handler = (param: string) => `package gin

func handler(${param} *Context) {
	context.Next()
}
`;
    write('gin/handler.go', handler('context'));
    const synced = await CodeGraph.init(dir, { index: true });
    try {
      const nexts = (): string[] => {
        const ids = synced.getNodesInFile('gin/handler.go').map((n) => n.id);
        return synced.getOutgoingEdgesFrom(ids).filter((e) => e.line === 4).map((e) => synced.getNode(e.target)!.qualifiedName);
      };
      expect(nexts()).toEqual(['Context::Next']);
      write('gin/handler.go', handler('c'));
      await synced.sync();
      expect(nexts()).toEqual([]);
    } finally {
      synced.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
