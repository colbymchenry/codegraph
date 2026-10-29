/**
 * A Go struct can hold a function in a field and call it through the field.
 * Prometheus' service discovery runs every provider that way:
 *
 *   type Discovery struct { refreshf func(ctx context.Context) ([]*targetgroup.Group, error) }
 *   func NewDiscovery(opts Options) *Discovery { return &Discovery{refreshf: opts.RefreshF} }
 *   func (d *Discovery) refresh(ctx context.Context) (…) { … d.refreshf(ctx) … }
 *
 * and each provider wires its own method in, `refresh.NewDiscovery(refresh.Options{…,
 * RefreshF: d.refresh})`. Static extraction sees a call to `d.refreshf`, which no method
 * answers, so a flow from `Discovery.Run` stopped at `refresh` and never reached a
 * provider. The go-func-field pass links the call to every function the field is given,
 * with the wiring site as `registeredAt`.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';
import { ToolHandler } from '../src/mcp/tools';
import type { Edge, Node } from '../src/types';

const FILES: Record<string, string> = {
  'go.mod': 'module example.com/app\n\ngo 1.22\n',
  'discovery/refresh/refresh.go': `package refresh

import "context"

type Group struct{ Source string }

// Options are the options for a refreshing discovery.
type Options struct {
	Mech     string
	Interval int
	RefreshF func(ctx context.Context) ([]*Group, error)
}

// Discovery runs a refresh function on an interval.
type Discovery struct {
	interval int
	refreshf func(ctx context.Context) ([]*Group, error)
}

func NewDiscovery(opts Options) *Discovery {
	return &Discovery{
		interval: opts.Interval,
		refreshf: opts.RefreshF,
	}
}

func (d *Discovery) Run(ctx context.Context) {
	d.refresh(ctx)
}

func (d *Discovery) refresh(ctx context.Context) ([]*Group, error) {
	tgs, err := d.refreshf(ctx)
	return tgs, err
}
`,
  // A provider puts its own method in, through Options.
  'discovery/aws/ec2.go': `package aws

import (
	"context"

	"example.com/app/discovery/refresh"
)

type EC2Discovery struct {
	*refresh.Discovery
	region string
}

func NewEC2Discovery(region string) *EC2Discovery {
	d := &EC2Discovery{region: region}
	d.Discovery = refresh.NewDiscovery(refresh.Options{
		Mech:     "ec2",
		RefreshF: d.refresh,
	})
	return d
}

func (d *EC2Discovery) refresh(ctx context.Context) ([]*refresh.Group, error) {
	return []*refresh.Group{{Source: d.region}}, nil
}
`,
  // A provider puts in an interface value's method: what a call returned.
  'discovery/hetzner/hetzner.go': `package hetzner

import (
	"context"

	"example.com/app/discovery/refresh"
)

type refresher interface {
	refresh(ctx context.Context) ([]*refresh.Group, error)
}

type robotDiscovery struct{ endpoint string }

func (d *robotDiscovery) refresh(ctx context.Context) ([]*refresh.Group, error) {
	return nil, nil
}

type Discovery struct {
	*refresh.Discovery
}

func newRefresher(endpoint string) (refresher, error) {
	return &robotDiscovery{endpoint: endpoint}, nil
}

func NewDiscovery(endpoint string) (*Discovery, error) {
	r, err := newRefresher(endpoint)
	if err != nil {
		return nil, err
	}
	return &Discovery{
		Discovery: refresh.NewDiscovery(refresh.Options{
			Mech:     "hetzner",
			RefreshF: r.refresh,
		}),
	}, nil
}
`,
  // The same field name in two unrelated structs.
  'jobs/jobs.go': `package jobs

type Job struct {
	name string
	fn   func() error
}

func cleanup() error { return nil }

func NewCleanupJob() *Job {
	return &Job{name: "cleanup", fn: cleanup}
}

// What a parameter holds, or a function literal, is no function the project declares.
func NewJob(name string, fn func() error) *Job {
	return &Job{name: name, fn: fn}
}

func NewInlineJob() *Job {
	return &Job{name: "inline", fn: func() error { return nil }}
}

func (j *Job) Run() error {
	return j.fn()
}
`,
  'hooks/hooks.go': `package hooks

type Hook struct {
	fn func() error
}

func notify() error { return nil }

func NewHook() *Hook {
	h := &Hook{}
	h.fn = notify
	return h
}

func (h *Hook) Fire() error {
	return h.fn()
}
`,
  // A positional literal, as etcd's printers are built.
  'printer/printer.go': `package printer

type printerRPC struct {
	prefix string
	p      func(v any)
}

func printJSON(v any) {}

func NewJSONPrinter() *printerRPC {
	return &printerRPC{"json", printJSON}
}

func (p *printerRPC) Put(v any) { p.p(v) }
`,
  // A field its own package fills in production and in a test, and another package's test.
  'client/client.go': `package client

type Client struct {
	Hook func()
}

func defaultHook() {}

func (c *Client) Do() { c.Hook() }
`,
  'client/wire.go': `package client

func New() *Client {
	return &Client{Hook: defaultHook}
}
`,
  'client/a_test.go': `package client

import "testing"

func newTestClient() *Client {
	return &Client{Hook: defaultHook}
}

func TestDo(t *testing.T) {
	c := newTestClient()
	c.Hook()
}
`,
  'other/other_test.go': `package other

import (
	"testing"

	"example.com/app/client"
)

func otherHook() {}

func TestOther(t *testing.T) {
	c := client.New()
	c.Hook = otherHook
	c.Do()
}
`,
  // A field of a named func type, given a method value through a conversion.
  'server/server.go': `package server

type HandlerFunc func(path string) error

type Server struct {
	handler HandlerFunc
}

func (s *Server) serveStatic(path string) error { return nil }

func New() *Server {
	s := &Server{}
	s.handler = HandlerFunc(s.serveStatic)
	return s
}

func (s *Server) Handle(path string) error {
	return s.handler(path)
}
`,
};

let root = '';
let cg: CodeGraph;
let prevOffloadDisable: string | undefined;

beforeAll(async () => {
  // Assertions read RAW codegraph_explore output; managed offload would replace it.
  prevOffloadDisable = process.env.CODEGRAPH_OFFLOAD_DISABLE;
  process.env.CODEGRAPH_OFFLOAD_DISABLE = '1';
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-func-field-'));
  for (const [rel, content] of Object.entries(FILES)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
}, 120_000);

afterAll(() => {
  cg?.destroy();
  if (root) fs.rmSync(root, { recursive: true, force: true });
  if (prevOffloadDisable === undefined) delete process.env.CODEGRAPH_OFFLOAD_DISABLE;
  else process.env.CODEGRAPH_OFFLOAD_DISABLE = prevOffloadDisable;
});

const meta = (e: Edge): Record<string, unknown> => (e.metadata ?? {}) as Record<string, unknown>;

/** The line of `fixture` holding `text`, as `file:line`. */
function siteOf(file: string, text: string): string {
  const index = FILES[file]!.split('\n').findIndex((l) => l.includes(text));
  expect(index, `${text} in ${file}`).toBeGreaterThanOrEqual(0);
  return `${file}:${index + 1}`;
}

/** The one function or method `qualifiedName` in `file`. */
function fn(qualifiedName: string, file: string): Node {
  const name = qualifiedName.split('::').pop()!;
  const found = cg
    .getNodesByName(name)
    .filter((n) => n.filePath === file && n.qualifiedName === qualifiedName && (n.kind === 'function' || n.kind === 'method'));
  expect(found, `${qualifiedName} in ${file}`).toHaveLength(1);
  return found[0]!;
}

/** The go-func-field edges out of a function, as `target @registeredAt [field via]`. */
function funcFieldCalls(from: Node): string[] {
  return cg
    .getOutgoingEdgesFrom([from.id], ['calls'])
    .filter((e) => meta(e).synthesizedBy === 'go-func-field')
    .map((e) => {
      const t = cg.getNode(e.target)!;
      const m = meta(e);
      return `${t.qualifiedName} (${t.filePath}) @${String(m.registeredAt)} [${String(m.field)}${m.via ? ` via ${String(m.via)}` : ''}]`;
    })
    .sort();
}

describe('a call through a Go func field reaches the functions put in it', () => {
  it("links prometheus' refresh to each provider's method, through the Options field it is copied from", () => {
    const refresh = fn('Discovery::refresh', 'discovery/refresh/refresh.go');
    expect(funcFieldCalls(refresh)).toEqual([
      `EC2Discovery::refresh (discovery/aws/ec2.go) @${siteOf('discovery/aws/ec2.go', 'RefreshF: d.refresh')} [Discovery.refreshf via Options.RefreshF]`,
      // `r refresher`, from newRefresher's result: the interface method, which its implementations answer.
      `refresher::refresh (discovery/hetzner/hetzner.go) @${siteOf('discovery/hetzner/hetzner.go', 'RefreshF: r.refresh')} [Discovery.refreshf via Options.RefreshF]`,
    ]);
    // The edge sits on the call through the field.
    const lines = cg
      .getOutgoingEdgesFrom([refresh.id], ['calls'])
      .filter((e) => meta(e).synthesizedBy === 'go-func-field')
      .map((e) => `${e.line}:${e.provenance}`);
    const call = siteOf('discovery/refresh/refresh.go', 'd.refreshf(ctx)').split(':').pop();
    expect(new Set(lines)).toEqual(new Set([`${call}:heuristic`]));
  });

  it('keeps a field name two unrelated structs share apart', () => {
    expect(funcFieldCalls(fn('Job::Run', 'jobs/jobs.go'))).toEqual([
      `cleanup (jobs/jobs.go) @${siteOf('jobs/jobs.go', 'fn: cleanup')} [Job.fn]`,
    ]);
    expect(funcFieldCalls(fn('Hook::Fire', 'hooks/hooks.go'))).toEqual([
      `notify (hooks/hooks.go) @${siteOf('hooks/hooks.go', 'h.fn = notify')} [Hook.fn]`,
    ]);
  });

  it('reads a positional literal and a conversion to a func type', () => {
    expect(funcFieldCalls(fn('printerRPC::Put', 'printer/printer.go'))).toEqual([
      `printJSON (printer/printer.go) @${siteOf('printer/printer.go', '"json", printJSON')} [printerRPC.p]`,
    ]);
    expect(funcFieldCalls(fn('Server::Handle', 'server/server.go'))).toEqual([
      `Server::serveStatic (server/server.go) @${siteOf('server/server.go', 'HandlerFunc(s.serveStatic)')} [Server.handler]`,
    ]);
  });

  it("cites a function's production wiring, and keeps one package's test wiring out of another's tests", () => {
    const wired = `defaultHook (client/client.go) @${siteOf('client/wire.go', 'Hook: defaultHook')} [Client.Hook]`;
    expect(funcFieldCalls(fn('Client::Do', 'client/client.go'))).toEqual([
      wired,
      // What another package's test puts in the field reaches the production call it makes.
      `otherHook (other/other_test.go) @${siteOf('other/other_test.go', 'c.Hook = otherHook')} [Client.Hook]`,
    ]);
    // client's own test binary never holds other's test.
    expect(funcFieldCalls(fn('TestDo', 'client/a_test.go'))).toEqual([wired]);
  });

  it('puts no edge on a function that only wires a field', () => {
    for (const [name, file] of [
      ['NewDiscovery', 'discovery/refresh/refresh.go'],
      ['NewEC2Discovery', 'discovery/aws/ec2.go'],
      ['NewCleanupJob', 'jobs/jobs.go'],
      ['NewHook', 'hooks/hooks.go'],
    ] as const) {
      expect(funcFieldCalls(fn(name, file)), name).toEqual([]);
    }
  });

  it('codegraph_explore follows the flow from Run to the provider, with the wiring site', async () => {
    const res = await new ToolHandler(cg).execute('codegraph_explore', { query: 'Discovery.Run EC2Discovery.refresh' });
    const text = res.content?.[0]?.text ?? '';
    const flow = text.slice(0, text.indexOf('**Exploration'));
    expect(flow).toContain('**Flow');
    expect(flow).toContain(
      `↓ dynamic: func field \`Discovery.refreshf\` (set from \`Options.RefreshF\`) @${siteOf('discovery/aws/ec2.go', 'RefreshF: d.refresh')}`
    );
    expect(flow).toMatch(/refresh \(discovery\/aws\/ec2\.go:\d+\)/);
  });
});

describe('a sync that wires a function into a field', () => {
  let dir = '';
  let graph: CodeGraph | undefined;

  afterEach(() => {
    graph?.destroy();
    graph = undefined;
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('links the provider it adds, and unlinks it when the wiring goes', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-func-field-sync-'));
    const write = (rel: string, content: string) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    };
    // A file that only wires: no method, no struct of its own.
    const gce = (options: string) => `package gce

import (
	"context"

	"example.com/app/discovery/refresh"
)

func refreshInstances(ctx context.Context) ([]*refresh.Group, error) { return nil, nil }

func NewDiscovery() *refresh.Discovery {
	return refresh.NewDiscovery(refresh.Options{${options}})
}
`;
    write('go.mod', FILES['go.mod']!);
    write('discovery/refresh/refresh.go', FILES['discovery/refresh/refresh.go']!);
    write('discovery/gce/gce.go', gce('Mech: "gce"'));
    graph = await CodeGraph.init(dir, { index: true });
    const g = graph;
    const linked = (): string[] => {
      const [refresh] = g.getNodesByName('refresh').filter((n) => n.qualifiedName === 'Discovery::refresh');
      return g
        .getOutgoingEdgesFrom([refresh!.id], ['calls'])
        .filter((e) => meta(e).synthesizedBy === 'go-func-field')
        .map((e) => `${g.getNode(e.target)!.name} @${String(meta(e).registeredAt)}`);
    };

    expect(linked()).toEqual([]);
    write('discovery/gce/gce.go', gce('Mech: "gce", RefreshF: refreshInstances'));
    await g.sync({ paths: ['discovery/gce/gce.go'] });
    expect(linked()).toEqual(['refreshInstances @discovery/gce/gce.go:12']);
    write('discovery/gce/gce.go', gce('Mech: "gce"'));
    await g.sync({ paths: ['discovery/gce/gce.go'] });
    expect(linked()).toEqual([]);
  }, 60_000);
});
