import Foundation
import UIKit.UIView

/// Class doc line one
/// Class doc line two
public final class Session: NSObject, RequestDelegate {
  let rootQueue: DispatchQueue = DispatchQueue(label: "root")
  var mutable = 0
  static let SHARED_MAX: Int = 5
  static var counter = 0
  lazy var expensive: Cache = Cache.build()
  @Published private var wrapped: Bool = false
  weak var delegate: SessionDelegate?
  var observed: Int = 0 {
    willSet { prepare(newValue) }
    didSet { react(oldValue) }
  }
  var isCloudProxy: Bool { return check(SHARED_MAX) }
  open class func classFunc() {}

  /// method doc
  public func request(_ convertible: URLConvertible, method: HTTPMethod) -> DataRequest {
    let req = DataRequest.make().validate()
    let m = HTTPMethod.get
    let g = Session.SHARED_MAX
    self.own()
    super.retain()
    rootQueue.async { self.perform(req) }
    return req
  }
  init(raw: String) {
    self.raw = raw
    setupMonitor()
  }
  deinit { cleanup() }
  subscript(index: Int) -> Foo { get { store[index] } set { store[index] = newValue } }
}

struct HTTPMethod: RawRepresentable, Equatable {
  let rawValue: String
  static let get = HTTPMethod(rawValue: "GET")
}

enum AFError: Error, CustomStringConvertible {
  case invalidURL(url: URLConvertible)
  case explicitlyCancelled, sessionDeinitialized
  indirect case wrapped(AFError)
  var description: String { renderDescription() }
  static func make() -> AFError { .explicitlyCancelled }
}

protocol RequestDelegate: AnyObject {
  var sessionState: Int { get }
  func didFinish(_ request: Request)
  static func build() -> Self
}

extension Session: EventMonitor {
  func heard(event: Event) { record(event) }
}

extension KF.Builder {
  func done() -> KF.Builder { self }
}

extension Array where Element: Equatable {
  func dedup() -> [Element] { self }
}

actor Counter {
  var n = 0
  func bump() { n += 1 }
}

typealias Handler = (Data) -> Void
typealias BuilderAlias = KF.Builder

let TOP_LEVEL_MAX = 3
var topVar: Int = compute()

func freeFn(a: Int, cb: @escaping (Int) -> Void) -> Session? {
  helper()
  Foo()
  obj.method(1)
  a.b.deep()
  x?.optCall()
  y!.forced()
  Foo.make().draw()
  foo.bar().baz()
  "lit".upper()
  arr.map { $0.name }
  let tbl = [cbA, cbB]
  o.cb = handler
  reg2(onFire)
  forward(value: value)
  let sel = #selector(Holder.fire)
  defer { cleanup() }
  let d = dict["k"]
  return nil
}

func onFire() {}
func handler() {}
func cbA() {}
func cbB() {}

// ---- extension rows (checklist inventory) ----
// non-ASCII line before a symbol: café ünïcode 😀
@objc enum Suit: Int {
  case hearts = 1
  case spades
}

@main struct MainApp {
  var body: some View { VStack { Text(label) } }
}

/** block doc is IGNORED and breaks the chain */
func blockDoc() {}

/// kept over attribute
@objc func attributed() {}

func <+> (lhs: Session, rhs: Session) -> Session { lhs }

public class Visi {
  public private(set) var setterGated = 1
  static let A_B: Int = 2
  let (tup, tup2) = makePair()
  @Siblings(through: Pivot.self, from: \.$left) var siblings: [Tag]
}

protocol Inherited: AnyObject, Identifiable {
  var reqComputed: String { get set }
  static var reqStatic: Int { get }
}

extension [ServerTrustEvaluating] {
  func sugarExt() {}
}

func voidParamProof(cb: (Void) -> Void) -> Result<Foo, Err> {
  callMe()
  return .success(Foo())
}

func nestedGenericRet() -> Result<Array<Foo>, Err> { fail() }
func voidRet() -> Void { noop() }
func tupleRet() -> (Int, Foo) { (1, Foo()) }
func fnRet() -> (Int) -> Foo { { _ in Foo() } }
func optRet() -> Session? { nil }
func builderRet() -> KF.Builder { KF.Builder() }

func callZooExtra(m: [[Int]], arr: [Int], f: () -> Void) {
  Foo.init(raw: "x")
  """
  multi
  """.trimmed()
  ["k": 1].lookup()
  (f)()
  arr[0]
  m[1][2]
  .make()
  try? thrower()
  Task { await asyncFn() }
  let msg = "count \(counter.next())"
  #warning("torture warning")
}

func staticReads(u: User) {
  let c = Color.red
  let r = Suit.hearts.rawValue
  let s = UserModel.self
  let d = Deep.Nested.leaf
  let i = lowercase.field
  let k = \Foo.bar
}

#if os(iOS)
func insideDirective() { directiveCall() }
#endif

// declared-then-assigned: the assignment-prune case (kernel-sweep-caught) —
// laterAssigned MUST be pruned as a value-ref target.
let laterAssigned: Int
if TOP_LEVEL_MAX > 2 {
  laterAssigned = 1
} else {
  laterAssigned = 2
}
let readsLater = laterAssigned + TOP_LEVEL_MAX

func guardNoPrune() {
  guard let TOP_LEVEL_MAX = optSource() else { return }
  use(TOP_LEVEL_MAX)
}

func fnRefExtras() {
  reg(cb: onFire)
  let sel1 = #selector(fire)
  let sel2 = #selector(onNote(_:))
  self.x = x
}

import class Darwin.FILE
@testable import TortureKit
