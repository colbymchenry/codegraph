# Mixed iOS + React Native Bridging — Coverage Design

**Audience:** a Claude agent (or human) continuing this work after #165 landed
pure-Objective-C support.
**Mission:** make codegraph's `trace` / `callers` / `callees` / `impact` /
flow-context calls connect end-to-end across **cross-language runtime
dispatch boundaries** that today silently break flows: **Swift ↔ Objective-C**
in mixed iOS codebases, and **JavaScript ↔ native** in React Native / Expo
apps.

> This doc is the **plan**, not the implementation. No code lands on this
> branch — only the design, the validation corpus, and the success bar.
> Coding starts on a follow-up branch per phase.

This work is the next item on the
[dynamic-dispatch coverage playbook](./dynamic-dispatch-coverage-playbook.md) §6
matrix: row "Swift × Objective-C bridging" and a new "React Native bridge"
row. Both are **resolver** patterns (named refs exist on both sides — the
bridging rule is deterministic) — not synthesizer patterns. See §3a of the
playbook for the reference Django ORM resolver.

---

## 1. Why this matters (the gap today)

After #165, codegraph indexes Swift, Objective-C, and JavaScript/TypeScript
each correctly **in isolation**. But the value is in cross-language flows —
exactly where iOS apps and React Native apps live:

- **Mixed iOS app:** `MyViewController.swift` calls `imageDownloader.download(url:completion:)`,
  which is `-[ImageDownloader downloadURL:completion:]` in `ImageDownloader.m`.
  Today: a `trace("MyViewController.viewDidLoad", "downloadURL:completion:")`
  call returns no path. The Swift callsite parses as a `call_expression` whose
  selector goes nowhere; the ObjC method exists as a node with no incoming
  edge. The agent reads both files to reconstruct the bridge.
- **React Native app:** `useEffect(() => NativeModules.Geolocation.getCurrentPosition(cb))`
  in `App.js` reaches `RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb)`
  in `RNCGeolocation.m`. Today: the JS callsite has no outgoing edge to
  the ObjC implementation; the ObjC handler has no incoming edge from JS.
  `impact(getCurrentPosition)` (ObjC side) shows no JS callers.
- **Expo module:** `await ExpoCamera.takePictureAsync(options)` (JS) reaches
  `AsyncFunction("takePictureAsync") { ... }` in `ExpoCamera.swift` (Expo
  Modules API). Same break.

In every case **a name exists on both sides** that an agent or a name-matcher
can correlate — Swift's auto-bridged ObjC selector, `RCT_EXPORT_METHOD`'s
literal first argument, an Expo `Function("name")` literal. The fix is a
**resolver** that knows the bridging rules per channel and emits
`references` edges with `provenance:'heuristic'` and `metadata.synthesizedBy:'<channel>'`.

The playbook's load-bearing warning applies here harder than usual:

> **Partial coverage is WORSE than none.** Bridging one boundary but not the
> next reveals a hop the agent then drills + reads to finish. Always close
> the flow end-to-end and re-measure — never ship a half-bridged flow.

For mixed iOS, this means **both directions** (Swift→ObjC and ObjC→Swift) and
**all bridged kinds** (methods, properties, init/initializers, protocols)
must close before measuring. For React Native, JS→native AND
native→JS (`RCTEventEmitter`, `sendEvent`) must both close, AND on **both
the legacy bridge and TurboModules**, or apps that mix them will half-bridge.

---

## 2. The bridging mechanisms to model

Each row is a separate **dispatch channel** in the playbook's vocabulary —
each gets its own resolver (or synthesizer if no static ref exists), its own
validation, its own row in the §6 matrix.

| # | Direction | Channel | Mapping rule | Where it lives | Difficulty |
|---|---|---|---|---|---|
| 1 | Swift → ObjC | direct call, ObjC class imported via `-Bridging-Header.h` | Swift call `obj.x(y:z:)` ↔ ObjC selector `-x:z:` (literal mapping, see §3a) | resolver in `frameworks/swift-objc.ts` | medium |
| 2 | ObjC → Swift | `@objc` exposure | Swift `@objc func foo(bar:)` ↔ ObjC `-fooWithBar:` (auto-name); `@objc(custom:)` overrides | resolver in `frameworks/swift-objc.ts` | medium |
| 3 | Swift ↔ ObjC | property/getter/setter bridging | Swift `var name: String` ↔ ObjC `-name` / `-setName:` | resolver in `frameworks/swift-objc.ts` | low |
| 4 | Swift ↔ ObjC | initializer bridging | Swift `init(name:age:)` ↔ ObjC `-initWithName:age:` | resolver in `frameworks/swift-objc.ts` | low |
| 5 | Swift ↔ ObjC | protocol bridging (`@objc protocol`) | conformance edges across language | resolver in `frameworks/swift-objc.ts` | medium |
| 6 | JS → ObjC (RN legacy bridge) | `NativeModules.<Mod>.<fn>` ↔ `RCT_EXPORT_METHOD(<fn>:...)` or `RCT_REMAP_METHOD(<jsName>, <selector>:...)` | name match keyed by `RCT_EXPORT_MODULE()` literal on the ObjC side | resolver in `frameworks/react-native.ts` | medium |
| 7 | JS → Java/Kotlin (RN legacy bridge, Android) | `NativeModules.<Mod>.<fn>` ↔ `@ReactMethod` annotated method on a `ReactContextBaseJavaModule` subclass with `getName()` returning `<Mod>` | resolver — same shape as #6, JVM side | medium |
| 8 | JS ↔ native (RN TurboModules / Codegen) | `TurboModuleRegistry.get('Mod')` ↔ generated spec interface (`NativeMod` TS type) ↔ ObjC++/Kotlin impl matching the spec | resolver that reads the spec file as ground truth | hard |
| 9 | Native → JS (events) | ObjC `[self sendEventWithName:@"x" body:b]` (extending `RCTEventEmitter`) ↔ JS `new NativeEventEmitter(NativeModules.Mod).addListener('x', cb)` | EventEmitter-style synthesizer (matches existing `callback-synthesizer.ts` for in-language EventEmitter) | medium |
| 10 | JS → native (Expo modules) | JS `ExpoX.fn(args)` ↔ Swift `Function("fn") { ... }` or `AsyncFunction("fn") { ... }` inside a `Module` subclass with `Name("ExpoX")` | resolver in `frameworks/expo-modules.ts` | medium |
| 11 | JS → native (Fabric view components) | JS `<MyView prop={v}/>` ↔ ObjC/Swift `RCT_EXPORT_VIEW_PROPERTY(prop, ...)` or Codegen view spec | resolver + JSX hop (compose with existing JSX synthesizer) | hard (defer) |

The **Difficulty** column drives phasing — see §6.

### 2a. Why these are resolvers, not synthesizers

In every row, **the bridging rule is deterministic from a name**:
- Swift's `@objc` exposure is a documented automatic mapping; `@objc(custom:)`
  is an explicit override; both are statically extractable.
- `RCT_EXPORT_METHOD` takes a literal selector; `RCT_EXPORT_MODULE()` takes
  an optional literal module name (default: class name minus `RCT` prefix);
  `NativeModules.Mod.fn` is a literal-property access on a known global.
- Expo Modules `Function("name") { ... }` and `Module { Name("ExpoX"); ... }`
  are literal strings inside `Module` definitions.
- TurboModules spec interfaces are literal `Native<Name>` exports with
  `TurboModuleRegistry.get<...>('<Name>')`.

So the work is: **extract the bridging-side names → make the resolver match
them**. Same shape as `djangoResolver` resolving `_iterable_class` to
`ModelIterable` — no whole-graph correlation pass needed.

The one exception is **#9 native→JS events**, where the registration sites
look very much like the in-language EventEmitter pattern the existing
callback synthesizer already handles. Extending that synthesizer with a
cross-language channel is the natural fit.

---

## 3. Concrete bridging rules (the reference table)

### 3a. Swift → ObjC selector mapping (auto)

Swift uses standard rules to derive an ObjC selector from a Swift method:

| Swift declaration | ObjC selector |
|---|---|
| `func greet()` | `greet` |
| `func say(_ msg: String)` | `say:` |
| `func set(name: String)` | `setWithName:` |
| `func setName(_ name: String)` | `setName:` |
| `func move(to point: CGPoint)` | `moveTo:` |
| `func move(from a: CGPoint, to b: CGPoint)` | `moveFrom:to:` |
| `init(name: String)` | `initWithName:` |
| `init(name: String, age: Int)` | `initWithName:age:` |
| `var name: String` (getter) | `name` |
| `var name: String` (setter) | `setName:` |
| `@objc(customSel:) func f(...)` | `customSel:` (explicit override) |

The full rule set is at
[Apple — Importing Swift into Objective-C](https://developer.apple.com/documentation/swift/importing-swift-into-objective-c)
— specifically the "method name translation" and "initializer name translation"
sections. The resolver implements this mapping in **one direction at extract
time** (Swift declarations produce the bridged ObjC name, attached as an
alias on the Swift method node), so name resolution on the ObjC side finds
the Swift method through normal name-matching.

### 3b. React Native legacy bridge — name resolution

```objc
// Native side (ObjC)
@implementation RCTGeolocation
RCT_EXPORT_MODULE();                                    // module name: "Geolocation" (RCT prefix stripped)
RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb) { ... }
@end
```
```js
// JS side
import { NativeModules } from 'react-native';
NativeModules.Geolocation.getCurrentPosition(cb);       // resolves to the ObjC method above
```

Rule:
1. On the native side, extract a synthetic `module` node per class containing
   `RCT_EXPORT_MODULE()`. Name = explicit string argument if present, else
   class name with `RCT` prefix stripped.
2. Each `RCT_EXPORT_METHOD(<sel>)` and `RCT_REMAP_METHOD(<jsName>, <sel>)`
   becomes a method node attached to that module node, with the JS-visible
   name (`<sel>`'s first keyword for `RCT_EXPORT_METHOD`, or `<jsName>` for
   `RCT_REMAP_METHOD`).
3. On the JS side, the resolver matches the literal property chain
   `NativeModules.<Mod>.<fn>` against `(module, jsName)` pairs from the
   native side.
4. Resolver emits `references` (`provenance:'heuristic'`, `synthesizedBy:'rn-bridge'`)
   from the JS callsite to the native method.

### 3c. React Native TurboModule — name resolution

```ts
// Spec (TS) — codegen ground truth
export interface Spec extends TurboModule {
  getCurrentPosition(cb: (loc: Location) => void): void;
}
export default TurboModuleRegistry.getEnforcing<Spec>('Geolocation');
```
```objc
// ObjC++ impl
@implementation RCTGeolocation
- (void)getCurrentPosition:(RCTResponseSenderBlock)cb { ... }
@end
```
```js
import Geolocation from './NativeGeolocation';
Geolocation.getCurrentPosition(cb);  // resolves to the ObjC method via the spec
```

Rule:
1. The spec file is the source of truth: parse `TurboModuleRegistry.get*<Spec>('<Name>')`
   to find the module name, then read the `Spec` interface methods.
2. Match each spec method to the native impl's same-named method (by selector
   first-keyword, in the class identified by name convention or by reading
   any `JSI_EXPORT_MODULE` macro if present).
3. JS imports of the spec file get name resolution through the spec.
4. Emits the same `references` edges as #3b, with `synthesizedBy:'rn-turbomodule'`.

### 3d. Expo Modules — name resolution

```swift
// Native (Swift, expo-modules-core API)
public class ExpoCameraModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ExpoCamera")
    AsyncFunction("takePictureAsync") { (options: CameraOptions) in /* ... */ }
    View(ExpoCameraView.self) {
      Prop("type") { (view: ExpoCameraView, type: String) in /* ... */ }
    }
  }
}
```
```js
import { requireNativeModule } from 'expo-modules-core';
const ExpoCamera = requireNativeModule('ExpoCamera');
await ExpoCamera.takePictureAsync({ quality: 1 });
```

Rule:
1. On the native side: a class extending `Module` whose `definition()` (or
   `init { /* DSL */ }` for newer API) contains a `Name("X")` call defines
   the module. Each `Function("y")` / `AsyncFunction("y")` literal defines a
   method. The trailing closure is the implementation body — extract as a
   method node named `y`, attached to module `X`.
2. On the JS side: `requireNativeModule('X')` produces a binding; resolve
   property accesses on it to the named methods.
3. `Prop("name")` for view modules behaves like RN's `RCT_EXPORT_VIEW_PROPERTY` —
   defer with the rest of the view-component frontier.

---

## 4. What edges need to exist

For each channel, the closed flow is:

- **JS callsite → bridged-method-node** (`references`, heuristic, `synthesizedBy:'<channel>'`)
- **Bridged-method-node → native-impl-method** (already extracted; for #6/#7
  the bridged-method IS the native impl; for #10 the closure body IS the
  impl)
- **Native-impl-method → its own callees** (already extracted in-language)

For Swift↔ObjC specifically, the cleanest model is **alias-name on the
declaration node**: extend Swift method extraction to compute the ObjC
auto-bridged name and store it as an alternate name the resolver
considers. No new edges between Swift and ObjC method nodes are needed
— normal name resolution suffices because both sides agree on the bridged
selector after extraction.

The MCP read tools surface heuristic edges inline already
(see `metadata.synthesizedBy` plumbing from #312/#403); these new edges
ride that path with no additional plumbing.

---

## 5. Validation corpus (the small/medium/large bar)

Following CLAUDE.md's validation methodology — **≥3 flow prompts each on
small / medium / large repos, with deterministic probes + agent A/B,
≥2 runs/arm**. Picks below are candidates to commit to in the
implementation branch; the implementation PR confirms the choices after
verifying each repo still builds an index cleanly.

### 5a. Mixed iOS (Swift+ObjC) — pick 3

| Tier | Repo | Why | Canonical flow |
|---|---|---|---|
| **Small** | [Charts](https://github.com/danielgindi/Charts) (~150 files Swift+ObjC) | Swift-first lib with ObjC compatibility layer; well-known | "How does setting `data` on a `ChartView` reach the renderer?" |
| **Small (alt)** | [Lottie-ios](https://github.com/airbnb/lottie-ios) (~300 files, was mixed; current may be pure-Swift — verify) | Animation engine, well-known mix | "How does `AnimationView.play()` reach the layer compositor?" |
| **Medium** | [Realm-Cocoa](https://github.com/realm/realm-swift) (~500 files) | Heavy Swift-on-top-of-ObjC: Swift API wraps an ObjC core that wraps C++ Realm Core | "How does `Realm.write { realm.add(obj) }` reach the ObjC persistence layer?" |
| **Large** | [Wikipedia-iOS](https://github.com/wikimedia/wikipedia-ios) (~2500 Swift+ObjC files) | Real app, deeply mixed, active development | "How does tapping a search result reach the article-fetch network call?" |
| **Large (alt)** | [WordPress-iOS](https://github.com/wordpress-mobile/WordPress-iOS) | Heavier ObjC legacy + Swift additions | "How does a new-post draft save reach Core Data persistence?" |

Bar per repo:
1. Pure-language probes still pass (Swift-in-Swift trace; ObjC-in-ObjC trace) — no regression vs #165's pure-ObjC baseline.
2. **Cross-language probe passes:** the canonical flow above traces end-to-end with `trace`, no break at the language boundary.
3. **Agent A/B (with vs without codegraph, ≥2 runs/arm):** Read = 0 within the explore-call budget; faster than without-codegraph; no regression on a pure-Swift or pure-ObjC control repo (e.g. Texture).
4. **No node-count explosion** vs pre-bridging baseline (`select count(*) from nodes` before/after).

### 5b. React Native — pick 3

| Tier | Repo | Why | Canonical flow |
|---|---|---|---|
| **Small** | [react-native-svg](https://github.com/software-mansion/react-native-svg) (~100 files JS+ObjC+Java) | Small, well-scoped native module set | "How does setting `<Path d=.../>` reach the iOS Core Graphics call?" |
| **Medium** | [react-native-screens](https://github.com/software-mansion/react-native-screens) (~300 files, JS+native) | Real navigation primitives, both legacy bridge and Fabric | "How does navigating to a new screen reach UINavigationController?" |
| **Medium (alt)** | [react-native-firebase](https://github.com/invertase/react-native-firebase) (~1000 files across packages) | Many native modules, both platforms — stresses module discovery | "How does `firestore().collection('x').get()` reach the iOS Firebase SDK call?" |
| **Large** | [facebook/react-native](https://github.com/facebook/react-native) RNTester subset (~3000 files) | The framework itself + sample app; canonical bridge usage | "How does pressing a button in RNTester's GeolocationExample reach the iOS Core Location call?" |

Bar per repo:
1. Pure-JS probes unchanged (`useState` → re-render flow still resolves — existing react synthesizer not regressed).
2. **JS → ObjC bridge probe passes** for ≥1 known RCT_EXPORT_METHOD on each repo.
3. **JS → TurboModule probe passes** on a repo that uses TurboModules (react-native main has both; pick one of each).
4. **Native → JS event probe passes** for ≥1 emitter (NativeEventEmitter pattern).
5. **Agent A/B** as above. Critical: a question that *crosses the bridge* (e.g. "how does pressing Button X reach the network call") must drop Read to 0 in ≥1 run with codegraph.
6. **No regression** on a pure-JS control repo (existing react-realworld / excalidraw measurements unchanged).

### 5c. Expo — pick 2 (smaller scope, narrower API surface)

| Tier | Repo | Why |
|---|---|---|
| **Small/Medium** | [expo/expo](https://github.com/expo/expo) — one SDK module like `expo-camera` or `expo-location` | The cleanest Expo Modules API examples; live |
| **Large** | full `expo/expo` monorepo (all SDK modules + the JS API) | Stress-test module-name resolution across many packages |

Canonical flow: "How does `await Camera.takePictureAsync()` (JS) reach the
native camera API call (Swift `AVCaptureSession` or Kotlin
`CameraDevice`)?"

---

## 6. Phasing — what comes first

Per the playbook's difficulty gradient and the half-bridge rule, the order
is fixed by what closes a flow end-to-end on the **smallest repo first**.

### Phase 1 — Swift ↔ ObjC bridging (rows 1–5 above)
Smallest scope, deterministic name mapping, no JS involved. Validate on the
Charts/Realm/Wikipedia corpus before moving on. **Don't proceed to Phase 2
until Phase 1 passes the §5a bar on all three repos.**

### Phase 2 — React Native legacy bridge (rows 6–7, ObjC + Java/Kotlin)
Both iOS and Android sides must close in the same PR — half-bridging one
platform reveals the half-coverage hop on the other and the agent reads.
Validate on the §5b corpus.

### Phase 3 — Native → JS events (row 9)
Extends the existing callback synthesizer with a cross-language channel.
Validate on the same §5b corpus (most RN libs use at least one event emitter).

### Phase 4 — Expo Modules (row 10)
Layered on Phase 1's Swift extraction. Smaller corpus (§5c).

### Phase 5 — RN TurboModules / Codegen (row 8)
Requires reading the spec file as cross-language ground truth. Validate on
the §5b corpus's TurboModule users (react-native main, post-0.73 libs).

### Phase 6 — Fabric view components (row 11)
Deferred — composes with the existing JSX synthesizer and the view side of
TurboModules. Address when ≥1 of the §5b corpus repos has its bridge
otherwise closed but a Fabric flow still breaks.

---

## 7. Anti-goals (what we will not try to do)

- **Android Kotlin/Java extraction quality** — out of scope. We use what
  Kotlin/Java extractors already produce. If they miss a `@ReactMethod`
  annotation's literal name we may add a tiny extractor refinement, but we
  do not redesign JVM extraction.
- **Dynamic / computed bridge keys** — `NativeModules[someVar]`,
  `requireNativeModule(name)` where `name` is a parameter, etc. We only
  resolve literal-key access (matches the
  [agent-eval Lua frontier](./dynamic-dispatch-coverage-playbook.md) — anonymous-only patterns deferred).
- **Bridging-header file content parsing** — we *do* index `.h` files
  (already does via #165's content sniff) but we do **not** parse the
  bridging header's `#import` list as a special "what's visible to Swift"
  manifest. Treat it as a normal ObjC header.
- **Runtime dispatch on `performSelector:`** — out of scope; matches the
  same "named-only" anti-goal.
- **JSI (raw, non-TurboModule)** — out of scope. Apps using bare JSI
  call into native through a custom `Host*` interface that has no documented
  declarative spec. Wait for those apps to migrate to TurboModules.
- **Swift-only generics over ObjC protocols / Swift extensions on ObjC
  classes** — extension methods are still callable in ObjC if `@objc`, so
  they go through the same Phase 1 path. Generics are not — we silently
  miss them. Acceptable; matches Java/Kotlin generics frontier.

---

## 8. Coverage-matrix entries — measured

| Language | Framework | Canonical flow | Mechanism | Status |
|---|---|---|---|---|
| Swift × Objective-C | bridging | Swift call → ObjC selector; ObjC call → @objc Swift method | R | ✅ Phase 1 (§8a) |
| JavaScript × Objective-C/Java/Kotlin | React Native legacy bridge | `NativeModules.<M>.<f>` → `RCT_EXPORT_METHOD` / `@ReactMethod` | R | ✅ Phase 2 (§8b) |
| JavaScript × native | React Native TurboModules | spec interface ↔ impl | R (spec as ground truth) | ✅ partial — name-match path lands (§8b) |
| Objective-C/Java/Kotlin → JavaScript | React Native event emitters | `[self sendEventWithName:]` → `addListener` | S (cross-lang channel) | ✅ Phase 3 (§8e) |
| JavaScript × Swift/Kotlin | Expo Modules | `requireNativeModule('X').fn(...)` → `Function("fn") { }` | R (extract synthesizes method nodes) | ✅ Phase 4 (§8f) |
| JavaScript × native | React Native Fabric views | `<MyView p=v/>` → Codegen spec component + NativeProps | R (extract) + S (native-impl) + JSX | ✅ Phase 6 (§8g) |

### 8a. Phase 1 measurements — Swift ↔ ObjC

| Repo | Source files | Bridge edges (framework-resolved) | Sample edges |
|---|---|---|---|
| **Charts** (small) | 269 (205 Swift + 59 ObjC/.h) | 28 objc→swift, 1 swift→objc | `handleOption:forChartView:` → `animate` · `setupPieChartView:` → `setExtraOffsets` · `setDataCount:range:` → `setColor` |
| **realm-swift** (medium) | 369 (151 Swift + 218 ObjC family) | 36 objc→swift, 1185 swift→objc | `valueForUndefinedKey:` → `get` · `setValue:forUndefinedKey:` → `set` · `promote:on:` → `initialize` |
| **wikipedia-ios** (large) | 1734 (1234 Swift + 500 ObjC/.h) | 52 objc→swift, 983 swift→objc | real-iOS-app bridging across many feature modules |

All three: in-language baselines unchanged, no node-count explosion,
`trace` connects canonical flows across the boundary (verified on
Charts: `trace(handleOption:forChartView:, animate)` surfaces the
bridge edge directly).

### 8b. Phase 2 + 5 (partial) measurements — React Native bridge

| Repo | Source files | Bridge edges (framework-resolved) | Notes |
|---|---|---|---|
| **react-native-svg** (small/medium) | ~700 (93 .mm + 115 .java + 6 .kt + 49 js + 92 ts + 154 tsx) | 9 tsx→java via TurboModule spec | RNSvg's iOS uses TurboModule auto-gen (no `RCT_EXPORT_METHOD`); resolutions land on Java. All 9 precise: `isPointInStroke`, `isPointInFill`, `getTotalLength`, `getPointAtLength`, `getCTM`, `getScreenCTM`, `getBBox`, `toDataURL`. |
| **AsyncStorage** (small, pure legacy bridge) | ~60 (28 kt + 2 mm + 16 ts + 14 tsx + …) | **8/8 precise** | The canonical legacy bridge test — Kotlin `@ReactMethod` + ObjC `RCT_EXPORT_METHOD`. JS `setItem` → Kotlin `legacy_multiSet`; `getItem` → `legacy_multiGet`; `clear` → `legacy_clear`; etc. |
| **react-native-firebase** (large) | ~1100 (111 .java + 63 .m + 13 .mm + 239 js + 427 ts + 9 tsx) | 18 after RCTEventEmitter blocklist (was 78 before) | Initial 78 included 60 false positives targeting `addListener:` / `remove:` (every RCTEventEmitter declares them; every JS call to `.addListener(...)` resolved into noise). Blocklist cut to 18, all precise: `httpsCallable:region:emulatorHost:...`, `signInWithProvider`, `configureProvider`, `removeFunctionsStreaming:`. |
| **react-native-screens** (medium) | 1211 | 0 — empty TurboModule spec, no `RCT_EXPORT_METHOD`, all Fabric/Codegen view-side | RNScreens lives entirely in Phase 6 (Fabric, deferred). The bridge declining to over-match here is the right behavior. |

### 8c. Architectural fix discovered during validation

The resolver's `initialize()` runs at CodeGraph construction — before any
files are indexed — so framework resolvers whose `detect()` consults
the indexed file list (UIKit / SwiftUI scanning for imports,
`swift-objc-bridge` looking for both Swift and ObjC files,
`react-native-bridge` looking for RN markers) all returned false on that
initial pass and silently dropped themselves. This affected every
framework resolver in the codebase that read `context.getAllFiles()` /
`context.readFile()` rather than scanning the filesystem directly — a
pre-existing latent bug, not bridge-specific. Fixed: `indexAll()` now
calls `resolver.initialize()` after extraction completes, so detect()
runs against the populated index.

### 8d. Bridge-precision blocklists (lessons learned)

| Bridge | Blocked names | Reason |
|---|---|---|
| swift-objc | `init`, `description`, `hash`, `isEqual`, `copy`, `count`, `value`, `data`, `string`, `object`, `add`, `remove`, `update`, `load`, `save`, `reload`, `cancel`, `start`, `stop`, `pause`, `resume`, `close`, `open`, `show`, `hide`, `dealloc`, `release`, `retain`, `autorelease`, … | Every NSObject subclass implements these; bridging them to arbitrary project-local ObjC methods produces noise. Regular name-matcher handles them on its own. |
| react-native | `addListener`, `removeListeners`, `remove`, `invalidate`, `startObserving`, `stopObserving` | Every `RCTEventEmitter` subclass declares these via `RCT_EXPORT_METHOD`. JS callers of `.addListener(...)` / `.remove(...)` go through `NativeEventEmitter` (JS abstraction), not the native bridge directly. |

### 8e. Phase 3 measurements — RN native → JS event channel

Synthesizer pattern; extends `src/resolution/callback-synthesizer.ts` with a
cross-language event channel keyed by literal event name. Validates on
**RNFirebase** (large):

| Synthesized event channel | Edges | Sample |
|---|---|---|
| `messaging_message_received` | 2 | `application:didReceiveRemoteNotification:fetchCompletionHandler:` → TS `onMessage` (and the `UNUserNotificationCenter` willPresent variant → same `onMessage`) |
| `messaging_notification_opened` | 1 | `userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:` → TS `onNotificationOpenedApp` |

Each edge is `provenance:'heuristic'`,
`metadata.synthesizedBy:'rn-event-channel'`. Same `EVENT_FANOUT_CAP = 6`
as the in-language channel — generic event names with too many handlers
or dispatchers skip rather than over-link.

The synthesizer also handles the **subscribe-wrapper pattern** common in
RN libraries (`messaging().onMessage(listener)` where `listener` is a
parameter that flows up to user code): when the JS handler arg isn't a
named symbol, it attributes the listener to the ENCLOSING JS function
(reachability-correct, attributes to the abstraction layer).

### 8f. Phase 4 measurements — Expo Modules

Framework `extract()` parses Swift / Kotlin source for literal
`Function("X") { … }` / `AsyncFunction("X") { … }` / `Property("X") { … }`
/ `Constants` declarations inside `class X: Module` (or `: Module()` in
Kotlin) and emits a `method` node named `X` per literal. The standard
name-matcher resolves JS callsites like `Foo.takePictureAsync(...)` to
these synthetic nodes via the existing `obj.method` → method-name path.

Validated on real Expo SDK packages:

| Package | Files indexed | Expo method nodes extracted | Cross-language edges |
|---|---|---|---|
| **expo-haptics** | 14 | 6 (3 Swift + 3 Kotlin: `notificationAsync`, `impactAsync`, `selectionAsync` / `performHapticsAsync`) | Module nodes registered; consumer-app callers resolve via name-match |
| **expo-camera** | 72 | 41 (Swift + Kotlin; covers `takePictureAsync`, `record`, `resumePreview`, `getAvailableLenses`, `scanFromURLAsync`, `requestCameraPermissionsAsync`, view-side `width` / `height` properties, …) | 9 swift→expo, 7 kotlin→expo internal edges. JS-side callsites in the package shadow the native names with TS wrappers (`pausePreview()` defined on `CameraView.tsx`); name-match correctly prefers the local TS method. An external consumer app of `Camera.takePictureAsync()` resolves through to the native method directly. |

Five tests cover the extractor + an end-to-end fixture:
`JS callsite of literal AsyncFunction("uniqueExpoHapticCall") resolves
to the native impl node` — confirms the resolver-free bridge path
works when names aren't shadowed.

### 8g. Phase 6 measurements — Fabric / Codegen view components

Two-part design:

1. **Framework extractor** (`src/resolution/frameworks/fabric.ts`) — parses
   TS / TSX spec files for `codegenNativeComponent<Props>('Name', ...)`
   declarations. Emits:
   - One `component` node per declaration (named after the JS-visible
     component name; matches the JSX synthesizer's name+kind filter).
   - One `property` node per declared field of the `NativeProps`
     interface — surfacing JSX-callable props like `onTap`,
     `nativeContainerBackgroundColor` as discoverable graph nodes.

2. **Synthesizer** (`fabricNativeImplEdges` in `callback-synthesizer.ts`) —
   walks every `fabric-component:*` node and looks for a native class
   matching its name with one of RN's convention suffixes (empty / `View`
   / `ViewManager` / `ComponentView` / `Manager`). Emits a `calls` edge
   with `metadata.synthesizedBy:'fabric-native-impl'` from the component
   to each match. The convention is precise enough that there's no name
   collision in well-formed RN libraries.

Combined with the existing `reactJsxChildEdges` JSX synthesizer, this
closes the full JSX → native flow: consumer-app JSX `<MyView prop=v/>`
→ Fabric `component` node `MyView` → native class `MyViewView`
(or `MyViewManager` / `MyViewComponentView` / …).

Re-validated on **react-native-screens** (the corpus repo that was
entirely Fabric and showed 0 bridges in Phase 2):

| Metric | Count |
|---|---|
| `codegenNativeComponent` spec declarations | 54 |
| Fabric component nodes extracted | 27 (one per non-web spec; the `*.web.ts` variants are filtered out by spec validity) |
| Fabric prop nodes extracted | 272 (the full NativeProps interface surface across all components) |
| `fabric-native-impl` bridge edges | 68 |

Sample bridge edges:

| JS component | Native class | Suffix |
|---|---|---|
| `RNSFullWindowOverlay` | `RNSFullWindowOverlay` (ObjC) | (exact) |
| `RNSFullWindowOverlay` | `RNSFullWindowOverlayManager` (ObjC) | `Manager` |
| `RNSModalScreen` | `RNSModalScreenManager` (ObjC) | `Manager` |
| `RNSScreenContainer` | `RNSScreenContainerView` (ObjC) | `View` |

Four tests cover the extractor + a full end-to-end fixture
(`App (TSX) → MyView (fabric-component) → MyViewView (ObjC class)`)
that asserts the JSX→component edge AND the
component→native-class edge both exist after indexing.

---

## 9. Open questions to settle in Phase 1

These are not blocking the start of Phase 1 — they're the first things to
decide *while* writing the Swift↔ObjC resolver:

1. **Alias on declaration vs new bridge edge?** Storing the auto-bridged
   ObjC selector as an alternate name on the Swift method node is cheaper
   and aligns with how name resolution already works. The alternative
   (synthesize a cross-language `references` edge between matching nodes)
   is more explicit in `trace` output but adds N edges per `@objc` symbol.
   **Default: alias.** Verify the alias surfaces in `callers`/`callees`/`trace`
   results.
2. **How does `trace` display a cross-language hop?** The MCP `trace` tool
   inlines each hop's body. A Swift → ObjC hop should make this obvious in
   the rendered output ("Swift `func foo(bar:)` → bridged to ObjC selector
   `-fooWithBar:` → ObjC `-[ImageDownloader fooWithBar:]`"). Will likely
   need a small renderer tweak in `trace.ts` to label the bridge.
3. **Where do the resolver bridging rules live?** Suggest a
   `src/resolution/frameworks/swift-objc.ts` for the auto-name mapping (a
   pure function) imported by both the Swift extractor (to compute the
   alias at extract time) and tests. Keeps the mapping in one place.
4. **What about `@objcMembers`?** Class-level export — applies to all members
   unless `@nonobjc`. Handle by checking the class's modifiers in the Swift
   extractor and defaulting each member's `@objc`-ness from that.

---

## 10. Done-bar (so we know when to stop)

Phase 1 (Swift↔ObjC) is done when:
- All three §5a corpora pass: pure-language probes unchanged; cross-language
  canonical flow probe finds the path end-to-end; agent A/B shows Read = 0
  in ≥1 run with codegraph, faster than without.
- Coverage matrix row in §6 of the playbook is filled in with numbers.
- A CHANGELOG `[Unreleased]` entry exists, written user-side.

Each subsequent Phase has the same shape — its own §5 corpus, its own
matrix row, its own CHANGELOG entry — and **doesn't ship until the
previous one passes**. Half-bridges are not optional to avoid here; they
actively make codegraph worse on these codebases than not having any
bridging at all.
