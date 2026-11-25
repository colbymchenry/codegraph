/**
 * A Swift local initialized through `try`, `try!`, `try?` or `await`, or with
 * a generic type's constructor, has that type: a call on it is a method of
 * the type constructed.
 *
 * `let x = try! Storage(path: p)` read as no type at all — the declaration
 * patterns wanted `= Type(` — and so did `let v = Disk.Backend<Int>(…)`, so
 * `x.store(1)` fell to name matching among every `store` in the project
 * (Kingfisher's `let storage = try! DiskStorage.Backend<String>(config:)`
 * then `storage.store(…)`). Every target here has a namesake declared before
 * it on another type, and no local is named like its type, so neither a
 * first-declared nor a receiver-name guess can pass.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

const FILES: Record<string, string> = {
  'Sources/App/Decoys.swift': `final class Archive {
    func store(_ v: Int) {}
}
final class Reloader {
    func load() {}
}
final class Lookup {
    func value(forKey k: String) -> Int? { nil }
}
final class Outbox {
    func send() {}
}
`,
  'Sources/App/Types.swift': `final class Storage {
    init(path: String) throws {}
    func store(_ v: Int) {}
}
final class Loader {
    init() async {}
    func load() {}
}
enum Disk {
    final class Backend<T> {
        init(config: Int) throws {}
        func value(forKey k: String) throws -> T? { nil }
    }
}
final class Pool<T> {
    init(capacity: Int) {}
    func value(forKey k: String) -> T? { nil }
}
final class Connection {
    func send() {}
}
final class Vault {
    init() throws {}
    func write<T>(_ block: () -> T) -> T { block() }
    func freeze() -> Vault { self }
}
final class Note {
    func freeze() -> Note { self }
}
final class Builder {
    init(host: String) throws {}
    func connect() -> Connection { Connection() }
}
`,
  'Sources/App/Screen.swift': `final class Screen {
    func a() { let x = try! Storage(path: "x"); x.store(1) }
    func b() throws { let y = try Storage(path: "y"); y.store(2) }
    func c() { let z = try? Storage(path: "z"); z?.store(3) }
    func d() async { let w = await Loader(); w.load() }
    func e() async throws { let r = try await Loader(); r.load() }
    func f() throws { let v = try Disk.Backend<Int>(config: 1); _ = try v.value(forKey: "k") }
    func g() { let t = Pool<String>(capacity: 1); _ = t.value(forKey: "k") }
    func h() { let u = Archive(); u.store(4) }
    func i() throws {
        var conn: Connection? = nil
        conn = try Builder(host: "i")
            .connect()
        conn?.send()
    }
    func j() {
        let obj = try! Vault().write { Note() }
        _ = obj.freeze()
    }
}
`,
};

describe('Swift: a local initialized through try, await or a generic constructor', () => {
  it('has the type constructed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-try-local-'));
    roots.push(root);
    for (const [rel, content] of Object.entries(FILES)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      // The methods each function calls (constructions aside).
      const methods = (caller: string): string[] => {
        const from = cg.getNodesByName(caller).find((n) => n.kind === 'method');
        expect(from, caller).toBeDefined();
        return cg
          .getOutgoingEdgesFrom([from!.id], ['calls'])
          .map((e) => cg.getNode(e.target))
          .filter((n) => n && n.kind === 'method')
          .map((n) => n!.qualifiedName)
          .sort();
      };
      expect(methods('a')).toEqual(['Storage::store']);
      expect(methods('b')).toEqual(['Storage::store']);
      expect(methods('c')).toEqual(['Storage::store']);
      expect(methods('d')).toEqual(['Loader::load']);
      expect(methods('e')).toEqual(['Loader::load']);
      expect(methods('f')).toEqual(['Disk::Backend::value']);
      expect(methods('g')).toEqual(['Pool::value']);
      // Already typed before: a plain constructor.
      expect(methods('h')).toEqual(['Archive::store']);
      // An assignment through `try` that goes on into a chain (`.connect()` on
      // the next line) is no declaration of the chain head's type: the local
      // keeps the type it was declared with.
      expect(methods('i')).toEqual(['Builder::connect', 'Connection::send']);
      // A member after the call makes the local a value of what it returns
      // (realm-swift's `let obj = try! Realm().write { … }`): not a Vault.
      expect(methods('j')).toContain('Vault::write');
      expect(methods('j')).not.toContain('Vault::freeze');
    } finally {
      cg.close();
    }
  });
});
