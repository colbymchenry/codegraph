// Calls written after `try!`, `try?` and `try`. `try!` is the shape the
// Windows (MSVC) build of the kernel's grammar used to misparse: its scanner
// read the `!` as a logical not, so `try! Message2(data: data)` came out as a
// call of `!Message2` (a reference named `! Message2`, at the `!`).
import Foundation

let globalStore = try! Store(path: "global")
let globalLoader = try? Loader.make()

final class Repository {
    static let shared = try! Repository(path: "shared")
    let decoder = try! JSONDecoder.make(strategy: .iso8601)
    lazy var cache: Cache = try! Cache.open(named: "repo")
    var current: Message2? = try? Message2(data: Data())

    init(path: String) throws {}

    func load(data: Data?) throws -> Message2 {
        let msg2 = try! Message2(data: data!)
        let msg3 = try? Message2(data: data!)
        let msg4 = try Message2(data: data!)
        let user = try! JSONDecoder().decode(User.self, from: data!)
        let parsed = try! parser.parse(data!)
        let settings = try! Settings.Defaults.load(from: "defaults")
        let realm = try! Realm()
        _ = (msg3, msg4, user, parsed, settings, realm)
        try! FileManager.default.removeItem(atPath: "/tmp/x")
        try! self.flush()
        try! validate(msg2)
        try !isReady()
        use(try! Foo(), try? Bar.make(), try Baz.build())
        if let cached = try? Cache.open(named: "x") {
            cached.touch()
        }
        guard let fresh = try? decodeFresh(data) else {
            return try! Message2(data: Data())
        }
        _ = fresh
        return try! Message2(data: data!)
    }

    func refresh() async throws {
        let page = try! await client.fetch(page: 1)
        let next = try? await Client.shared.fetch(page: 2)
        try await store.save(page, next)
        let items = try! items(in: page).map { try! Item(raw: $0) }
        _ = items
    }

    func flush() throws {}
    func validate(_ m: Message2) throws {}
    func isReady() throws -> Bool { true }
    func use(_ a: Any?, _ b: Any?, _ c: Any?) {}
    func decodeFresh(_ d: Data?) throws -> Message2 { try Message2(data: d!) }
    func items(in page: Page) throws -> [String] { [] }
}
