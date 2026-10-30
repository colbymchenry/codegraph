/**
 * Three things a SwiftUI app showed in the viewer that were not so.
 *
 * - Steps labelled `rawValue.data(using: .utf8)` a network call, Foundation's
 *   `Timer` telemetry, the project's own `Notifications` endpoint enum a
 *   device call, and `viewModel.votes.firstIndex(of:)` a database read.
 * - "Files that run something" listed every view with a `#Preview` — Xcode's
 *   canvas code sits at a file's top level.
 * - Every `struct X: View` had a one-line `component` twin with no edges, a
 *   dead end in search and the symbol view (and `@main` apps, view
 *   controllers and UIView subclasses a `class` twin).
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { classifyEffect } from '../src/ui-server/api/effects';
import { buildEntryPoints, resetEntryPointsCache, swiftPreviewSpans } from '../src/ui-server/api/entrypoints';
import { buildSteps } from '../src/ui-server/api/steps';

const swift = (text: string, extra: Partial<Parameters<typeof classifyEffect>[0]> = {}) =>
  classifyEffect({ text, kind: 'calls', language: 'swift', project: 'app', ...extra })?.category ?? null;

describe('Swift effects', () => {
  it('reads network off a session, not any `.data(…)`', () => {
    expect(swift('urlSession.data(for: request)')).toBe('network');
    expect(swift('URLSession.shared.data(from: url)')).toBe('network');
    expect(swift('session.upload(for: request, from: body)')).toBe('network');
    expect(swift('urlSession.webSocketTask(with: url)')).toBe('network');
    expect(swift('rawValue.data(using: .utf8)')).toBeNull();
    expect(swift('string.data(using: .utf8)')).toBeNull();
    expect(swift('mediaUploadService.upload(container)')).toBeNull();
  });

  it("does not read Foundation's Timer and Calendar, or a SiriKit intent, as another stack's", () => {
    expect(swift('Timer.scheduledTimer(withTimeInterval: 0.05, repeats: false)')).toBeNull();
    expect(swift('Calendar(identifier: .gregorian)')).toBeNull();
    expect(swift('intent.setImage(avatar, forParameterNamed: \\.speakableName)')).toBeNull();
    // The same names elsewhere keep their rows.
    expect(classifyEffect({ text: 'Timer.builder', kind: 'calls', language: 'java', project: 'api' })?.category).toBe('telemetry');
  });

  it('keeps a view model out of the database, and a keychain in storage', () => {
    expect(swift('viewModel.votes.firstIndex(of: option)')).toBeNull();
    expect(swift('keychain.delete(key)')).toBe('storage');
    expect(swift('appKeychain.set(token, forKey: key)')).toBe('storage');
    expect(swift('keychainAccounts.first(where: { $0.id == id })')).toBeNull();
    expect(classifyEffect({ text: 'catModel.find', kind: 'calls', language: 'typescript', project: 'api' })?.category).toBe('database');
  });

  it("lets a project type shadow a library name, but not a model's or a reply's row", () => {
    expect(swift('Notifications.notificationsV2(sinceId: id)')).toBe('device');
    expect(swift('Notifications.notificationsV2(sinceId: id)', { projectType: true })).toBeNull();
    expect(swift('Todo.query', { projectType: true })).toBe('database');
    expect(classifyEffect({ text: 'Abort', kind: 'calls', language: 'swift', project: 'api', projectType: true })?.category).toBe('response');
  });
});

describe('swiftPreviewSpans', () => {
  it("finds a file's top-level previews, a widget's timeline closure included", () => {
    const text = [
      'struct Row: View {', //                           1
      '  var body: some View { Text("x") }', //          2
      '}', //                                            3
      '', //                                             4
      '#Preview {', //                                   5
      '  Row()', //                                      6
      '}', //                                            7
      '', //                                             8
      '#Preview(as: .systemSmall) {', //                 9
      '  AccountWidget()', //                           10
      '} timeline: {', //                               11
      '  Entry(date: Date())', //                       12
      '}', //                                           13
      'let later = Row()', //                           14
    ].join('\n');
    expect(swiftPreviewSpans(text)).toEqual([
      [5, 7],
      [9, 13],
    ]);
  });
});

const projects: string[] = [];
afterAll(() => {
  for (const p of projects.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function project(files: Record<string, string>): Promise<{ cg: CodeGraph; root: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swiftui-noise-'));
  projects.push(root);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  return { cg: await CodeGraph.init(root, { index: true }), root };
}

describe('a SwiftUI app in the viewer', () => {
  it('lists no preview as a file that runs something, and indexes each view once', async () => {
    const { cg } = await project({
      'App/HomeView.swift': `import SwiftUI
struct HomeView: View {
    var body: some View { Text("Home") }
}

#Preview {
    HomeView()
}
`,
      'App/main.swift': `import Foundation
let server = Server()
server.start()
`,
      'App/Server.swift': `final class Server {
    func start() {}
}
`,
      'App/App.swift': `import SwiftUI
@main
struct HomeApp: App {
    var body: some Scene { WindowGroup { HomeView() } }
}
`,
    });
    try {
      resetEntryPointsCache();
      const files = buildEntryPoints(cg, new URLSearchParams()).files.items.map((f) => f.name);
      expect(files).toContain('main.swift');
      expect(files).not.toContain('HomeView.swift');
      expect(cg.getNodesByName('HomeView').map((n) => n.kind)).toEqual(['struct']);
      expect(cg.getNodesByName('HomeApp').map((n) => n.kind)).toEqual(['struct']);
    } finally {
      cg.close();
    }
  });

  it("draws a call through the project's own `Notifications` type as no device call", async () => {
    const { cg, root } = await project({
      'App/Endpoints.swift': `enum Notifications {
    case notificationsV2(sinceId: String?)
}
`,
      'App/NotificationsViewModel.swift': `final class NotificationsViewModel {
    func refresh(client: Client) async {
        _ = try? await client.get(endpoint: Notifications.notificationsV2(sinceId: nil))
    }
}
`,
    });
    try {
      const refresh = cg.getNodesByName('refresh')[0]!;
      const payload = await buildSteps(cg, root, new URLSearchParams({ anchor: refresh.id }));
      expect(payload.steps.filter((s) => s.effect?.category === 'device')).toEqual([]);
    } finally {
      cg.close();
    }
  });
});
