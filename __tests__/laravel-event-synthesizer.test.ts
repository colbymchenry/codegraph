/**
 * Laravel event-dispatch bridge (PHP).
 *
 * Laravel decouples an event dispatch from its listener(s), linked by the event class:
 * `event(new SongLiked($id))` has no static edge to the `handle(SongLiked $e)` that runs it
 * (usually a separate `app/Listeners/` file). This bridges each `event(new X(...))` site to every
 * listener's `handle` for X, via TWO registration mechanisms: (A) a typed `handle(EventType $e)`
 * (auto-discovery, union-split for `A|B`) and (B) the `protected $listen` map in an
 * EventServiceProvider (which also covers a listener whose `handle()` is untyped). Queued JOBS
 * dispatch via `::dispatch()`/`dispatch()` and their `handle()` takes a service — so only
 * `event(new X)` is matched and jobs are excluded.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';

describe('laravel-event synthesizer', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'laravel-event-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  const write = (rel: string, body: string) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  };

  it('bridges event(new X) to listener handles via typed handles, the $listen map, unions, and fan-out; excludes jobs', async () => {
    for (const [name, body] of [
      ['SongLiked', 'public int $id; public function __construct(int $id) { $this->id = $id; }'],
      ['LibraryChanged', ''],
      ['ScanDone', ''],
      ['OwnerTest', ''],
      ['UserTest', ''],
    ] as const) {
      write(`app/Events/${name}.php`, `<?php\nnamespace App\\Events;\nclass ${name} {\n  ${body}\n}\n`);
    }
    // (A) typed-handle listener — auto-discovery, no $listen entry needed.
    write('app/Listeners/LoveTrack.php', `<?php
namespace App\\Listeners;
use App\\Events\\SongLiked;
class LoveTrack {
    public function handle(SongLiked $event): void {}
}
`);
    // (B) UNTYPED handle — linkable only through the $listen map.
    write('app/Listeners/PruneLibrary.php', `<?php
namespace App\\Listeners;
class PruneLibrary {
    public function handle(): void {}
}
`);
    // Fan-out: two listeners for ScanDone.
    write('app/Listeners/WriteScanLog.php', `<?php
namespace App\\Listeners;
use App\\Events\\ScanDone;
class WriteScanLog {
    public function handle(ScanDone $event): void {}
}
`);
    write('app/Listeners/DeleteStale.php', `<?php
namespace App\\Listeners;
use App\\Events\\ScanDone;
class DeleteStale {
    public function handle(ScanDone $event): void {}
}
`);
    // Union-typed handle — one listener, two events.
    write('app/Listeners/SendsTestNotification.php', `<?php
namespace App\\Listeners;
use App\\Events\\OwnerTest;
use App\\Events\\UserTest;
class SendsTestNotification {
    public function handle(OwnerTest|UserTest $event): void {}
}
`);
    // A queued JOB — handle takes a service, dispatched via ::dispatch()/dispatch(). Never an edge.
    write('app/Jobs/ProcessAudio.php', `<?php
namespace App\\Jobs;
use App\\Services\\AudioService;
class ProcessAudio implements ShouldQueue {
    public function handle(AudioService $svc): void {}
}
`);
    // The $listen map — registers the untyped PruneLibrary for LibraryChanged.
    write('app/Providers/EventServiceProvider.php', `<?php
namespace App\\Providers;
use App\\Events\\LibraryChanged;
use App\\Listeners\\PruneLibrary;
class EventServiceProvider {
    protected $listen = [
        LibraryChanged::class => [
            PruneLibrary::class,
        ],
    ];
}
`);
    write('app/Services/SongService.php', `<?php
namespace App\\Services;
use App\\Events\\SongLiked;
use App\\Events\\LibraryChanged;
use App\\Events\\ScanDone;
use App\\Events\\OwnerTest;
use App\\Events\\UserTest;
use App\\Jobs\\ProcessAudio;
class SongService {
    public function like(int $id): void { event(new SongLiked($id)); }
    public function deleteSongs(): void { event(new LibraryChanged()); }
    public function scan(): void { event(new ScanDone()); }
    public function ownerTest(): void { event(new OwnerTest()); }
    public function userTest(): void { event(new UserTest()); }
    public function process(): void {
        ProcessAudio::dispatch();
        dispatch(new ProcessAudio());
    }
}
`);

    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;

    const edges = db
      .prepare(
        `SELECT s.name source, t.name target, t.file_path tf, json_extract(e.metadata,'$.via') via
         FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
         WHERE json_extract(e.metadata,'$.synthesizedBy') = 'laravel-event'`
      )
      .all();
    const bySrc = (s: string) => edges.filter((r: any) => r.source === s);
    const file = (r: any) => /(\w+)\.php$/.exec(r.tf)![1];

    expect(edges.length).toBe(6);
    expect(edges.every((r: any) => r.target === 'handle')).toBe(true);
    // (A) typed handle.
    expect(bySrc('like').map((r: any) => [r.via, file(r)])).toEqual([['SongLiked', 'LoveTrack']]);
    // (B) untyped handle via the $listen map.
    expect(bySrc('deleteSongs').map((r: any) => [r.via, file(r)])).toEqual([['LibraryChanged', 'PruneLibrary']]);
    // Fan-out: ScanDone → both listeners.
    expect(new Set(bySrc('scan').map(file))).toEqual(new Set(['WriteScanLog', 'DeleteStale']));
    // Union split: OwnerTest and UserTest each reach the one listener (separate dispatchers,
    // so they aren't deduped to a single source→target edge).
    expect(bySrc('ownerTest').map((r: any) => [r.via, file(r)])).toEqual([['OwnerTest', 'SendsTestNotification']]);
    expect(bySrc('userTest').map((r: any) => [r.via, file(r)])).toEqual([['UserTest', 'SendsTestNotification']]);
    // PRECISION: a queued job (::dispatch / dispatch()) produces nothing.
    expect(edges.some((r: any) => r.source === 'process')).toBe(false);

    cg.close?.();
  });

  it('produces no edges in a PHP project with no Laravel events (clean control)', async () => {
    write('src/Client.php', `<?php
namespace Acme;
class Client {
    public function send(string $url): string { return $url; }
}
`);
    const cg = await CodeGraph.init(dir, { silent: true });
    await cg.indexAll();
    const db = (cg as any).db.db;
    const count = db
      .prepare(`SELECT count(*) c FROM edges WHERE json_extract(metadata,'$.synthesizedBy') = 'laravel-event'`)
      .get();
    expect(count.c).toBe(0);
    cg.close?.();
  });
});
