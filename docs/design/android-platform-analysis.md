# Android platform analysis

CodeGraph provides tools for inspecting Android interface implementations, native
bindings, platform services, and IPC usage. They combine evidence from an existing
code index with targeted reads of AIDL, HIDL, and manifest files.

These tools return evidence reports. They do not generate Binder bindings, execute
Android code, or establish a complete runtime IPC path. AIDL and HIDL declarations
are read on demand; they are not indexed as graph nodes.

## Tools

| CLI command | Purpose |
|-------------|---------|
| `codegraph aidl-impl <interface>` | Find implementation candidates and registration sites for an AIDL interface |
| `codegraph jni-bridge <class>` | Match native method declarations to JNI functions and registration evidence |
| `codegraph hal-interface <name>` | Find AIDL or HIDL HAL declarations and implementation candidates under `hardware/interfaces/` |
| `codegraph system-service <name>` | Inspect a service class, registration, startup references, and client usage |
| `codegraph trace-permission <permission>` | Search for a permission literal in XML and permission-check or enforcement calls |
| `codegraph trace-broadcast <action>` | Search for an action literal in broadcast send and receive patterns |
| `codegraph messenger-ipc <name>` | Inspect provider and client class candidates for Android Messenger references |
| `codegraph content-provider <class>` | Inspect ContentProvider inheritance, manifest authorities, and client references |
| `codegraph local-socket-ipc <class>` | Inspect LocalSocket and LocalServerSocket construction in a class |

## Reading results

`found` means the tool's evidence rule is satisfied. It does not mean every method,
client, registration, or runtime connection has been verified.

`convention_derived_candidate` identifies a possible match with insufficient
corroboration. A naming convention, a manifest entry, or a nearby text match can
help locate code without proving that it implements the requested service.

Negative results describe what the tool found in the available source and index.
They are not proof that an implementation does not exist elsewhere.
In particular, `aidl-impl` requires a discoverable `.aidl` declaration.
`declaration_not_found` can occur even when a generated `IFoo.Stub` Java class
is indexed, as in vendor or decompiled source trees.

| Tool | Negative result names |
|------|-----------------------|
| `aidl-impl`, `hal-interface` | `declaration_not_found`, `no_implementation_found` |
| `jni-bridge` | `class_not_found`, `no_bridge_found` |
| `system-service` | `no_service_found` |
| `messenger-ipc` | `no_messenger_ipc_found` |
| `content-provider` | `no_content_provider_found` |
| `local-socket-ipc` | `no_local_socket_ipc_found` |

Permission and broadcast searches return matched candidates without a
found/not-found classification. Results may also include warnings about indexing
in progress, search limits, and evidence from test directories.

### Confidence policy: what promotes a candidate to `found`

- **`aidl-impl` / `hal-interface`**: An indexed unresolved inheritance or
  implementation reference must match the requested interface. A `verified`
  package match can promote the candidate, and an `unverifiable` package can
  also promote it; only a confirmed `mismatch` blocks promotion. Package
  uncertainty remains visible in the result. Naming matches alone stay at
  `convention_derived_candidate`. The HAL tool's AIDL-specific C++ `Bn{Name}`
  check also stays at candidate level with an `unverifiable` package, because
  the stub name alone does not establish package identity. This check accepts
  qualified names and uses the AIDL convention of dropping a leading `I` only
  when followed by an uppercase letter. It does not run for HIDL queries.

- **`jni-bridge`**: At least one declared native method must have an indexed
  implementation and corroborating registration evidence. Implementations are
  matched through JNI function names or entries in a `JNINativeMethod` table.
  Table searches are restricted to the files and tables identified by the
  class's registration search. A nearby `FindClass` can provide package
  evidence; same-file registration can also corroborate a match. The result is
  per class, so `found` does not confirm every declared method. A method name
  merely appearing near a registration call is advisory evidence.

- **`system-service`**: An exact service-class candidate needs registration
  evidence in its file or a startup call that names the exact class. Recognized
  registration patterns include `ServiceManager.addService` with an exact
  literal service name and `publishBinderService` within the matched class.
  Client usage alone does not promote a candidate. In particular,
  `getSystemService` shows that code requests a service, not that the candidate
  class provides it.

- **`messenger-ipc`**: Provider and client names locate candidate classes. The
  provider must have an Android `Messenger` construction or an indexed type
  reference owned by that class to reach `found`. Java construction and Kotlin
  constructor-call forms are recognized. Evidence from an unrelated package,
  sibling class, or nested class does not establish the provider's role. A
  provider/client name pair does not prove that the two communicate at runtime.

- **`content-provider`**: The requested class needs inheritance evidence for
  `android.content.ContentProvider`. Bare names with imports and fully qualified
  inheritance are recognized. Manifest declarations and client references are
  supporting candidates, not substitutes for inheritance. Manifest matching
  reads the opening `<provider>` tag, handles package-relative names, and splits
  multiple authorities separated by semicolons.

- **`local-socket-ipc`**: The named class must construct an Android `LocalSocket`
  or `LocalServerSocket` within its own body. The reported role may be client,
  server, or both. `found` does not require a peer to exist in the same repository.

Messenger, ContentProvider, and local-socket analysis consult both unresolved
references and resolved graph edges to the Android framework types. They still
depend on the extractor producing the relevant reference.

## Exposure

### CLI commands

All commands are available directly. Use `-p, --path <path>` to select an indexed
project and `-j, --json` for JSON output. The HAL tool accepts
`-t, --type aidl|hidl`, with `aidl` as the default.

```bash
codegraph aidl-impl IPowerManager --path /path/to/android-source
codegraph jni-bridge Process --path /path/to/android-source --json
codegraph system-service power --path /path/to/android-source
codegraph hal-interface ICamera --type aidl --path /path/to/android-source
```

The project must already be indexed with `codegraph init`. Point the HAL tool at
a project containing a real `hardware/interfaces/` directory; renaming an
unrelated directory to that path does not supply the missing declarations.

### MCP configuration

Android platform tools are unlisted by default. Set `CODEGRAPH_MCP_TOOLS` in the
MCP server environment to expose the tools needed for the project. For example:

```text
CODEGRAPH_MCP_TOOLS=explore,aidl_impl,jni_bridge
```

| MCP tool | Configuration entry |
|----------|---------------------|
| `codegraph_aidl_impl` | `aidl_impl` |
| `codegraph_jni_bridge` | `jni_bridge` |
| `codegraph_hal_interface` | `hal_interface` |
| `codegraph_system_service` | `system_service` |
| `codegraph_trace_permission` | `trace_permission` |
| `codegraph_trace_broadcast` | `trace_broadcast` |
| `codegraph_messenger_ipc` | `messenger_ipc` |
| `codegraph_content_provider` | `content_provider` |
| `codegraph_local_socket_ipc` | `local_socket_ipc` |

The initialization instructions identify the enabled tools. This setting controls
MCP exposure; it is not required for CLI use. These reports complement the source
and call paths returned by `codegraph_explore`.

## Limitations

- **`aidl-impl` / `hal-interface`**: Generated bindings and some anonymous-class
  forms may not produce a usable inheritance reference. Kotlin aliases,
  typealiases, and some fully qualified Stub expressions can be missed. Native
  and portable extraction can differ, so validate the backend used by the target
  installation. Naming searches are capped at 20 results per pattern and report
  a warning at the limit.

- **`hal-interface`**: Declaration discovery is restricted to
  `hardware/interfaces/` and skips symlinked discovery directories. The tool
  can report indexed native inheritance candidates, but it does not reconstruct
  all generated HIDL bindings. The AIDL `Bn{Name}` check relies on unresolved
  references and may not apply when generated headers are also indexed. VINTF
  manifests, compatibility matrices, instances, and partition placement are
  outside the result's scope.

- **`jni-bridge`**: Registration-table entries must fit on one line. Wrapped
  signatures or function-pointer expressions can be missed. A class-level
  `found` result should not be used as method-by-method binding verification.

- **`messenger-ipc`**: A Kotlin field declared as `Messenger? = null` without
  construction in the same class may lack an indexed type reference. Adding SDK
  source to the index does not recover a reference the extractor never emitted.

- **`trace-permission`**: XML searches are text-based after well-formed XML comments are stripped.
  They do not distinguish permission declarations, uses, or unrelated attributes.
  The XML matches are candidate locations, not confirmed definitions.
  Check and enforcement matches require the permission literal on the same line
  as the recognized API call. Variables and constants are not resolved.

- **`trace-broadcast`**: Sender and receiver matches require the action literal
  on the same line as `sendBroadcast` or `onReceive`. An action tested elsewhere
  in a receiver body, or supplied only through a constant, can be missed.

- **`content-provider`**: Manifest and client matches are textual evidence.
  Client searches look for supported same-line ContentResolver and authority
  patterns; they do not establish access at runtime.

The tools inspect one indexed project at a time. Missing sibling repositories,
stale indexes, search truncation, and test fixtures can affect the evidence.
Inspect the warnings and candidate locations before interpreting a result.

## Public reference projects

The following sparse checkout was fetched from the official `android17-release`
and `androidx-main` branches on 2026-09-24. It contains selected framework,
SystemUI, Car, HAL, JNI, and RecyclerView paths, not a complete Android checkout.

| Project | Reference revision | Example targets |
|---------|--------------------|-----------------|
| Android framework | [`94b4c163b7df`](https://android.googlesource.com/platform/frameworks/base/+/94b4c163b7dfe5ce3607f7bb8456f9573f7de57d) | `IPowerManager`, `Process`, SystemUI, power service |
| HAL interfaces | [`0162af698935`](https://android.googlesource.com/platform/hardware/interfaces/+/0162af698935100a590b7359581ac8b1b80693e5) | `IVehicle` |
| Android Automotive services | [`9f04df65daa8`](https://android.googlesource.com/platform/packages/services/Car/+/9f04df65daa8b9a65ee05fd4039fe95446874d76) | `CarBugreportManagerService` |
| AndroidX | [`6cdbceb4ce99`](https://android.googlesource.com/platform/frameworks/support/+/6cdbceb4ce99c517b94fb859776bceebc9aae5ff) | RecyclerView |

### Observed results on these revisions

On macOS with Node 24.21.0, CodeGraph 1.6.0, and `CODEGRAPH_KERNEL=0`,
the combined sparse checkout indexed 8,485 source files. The commands below
used the Android tools branch with `codegraph <command> <target> -p <checkout> -j`.
These are observed source and index matches, not runtime Android tests.

| Command and target | Observed result |
|--------------------|-----------------|
| `aidl-impl IPowerManager` | `found`; one `PowerManagerService.BinderService` implementation candidate, package verified |
| `jni-bridge Process` | `found`; 39 native declarations, 35 implementation matches, 3 registration hits |
| `hal-interface IVehicle` | `found`; four candidates, including one package mismatch and three unverified packages |
| `system-service PowerManagerService` | `found`; one `publishBinderService` registration |
| `trace-permission android.permission.CAMERA` | Two SystemUI manifest XML matches; no check or enforcement site in the sparse checkout |
| `trace-broadcast android.intent.action.BOOT_COMPLETED` | No sender or receiver literal match in the sparse checkout |
| `messenger-ipc TakeScreenshot` | `found`; three provider evidence sites, no client site |
| `content-provider PeopleProvider` | `found`; one manifest declaration, no client site |
| `local-socket-ipc CarBugreportManagerService` | `found`; three client evidence sites, no server evidence |
| `messenger-ipc AppCard` / `content-provider BugStorageProvider` | No provider found; those classes were absent from the selected Car paths |

The three Java checks from PR #1872 and the TypeScript control are recorded in
[the source validation note](../benchmarks/android-pr1872-source-validation.md),
including the CodeGraph revisions and observed results.

Record the CodeGraph commit, source revision, extraction backend, query, and
actual result when validating a case. Check the returned file and reference
against the source. Keep a candidate result distinct from a corroborated finding,
and a focused pass distinct from complete platform coverage.

## Development checks

From the CodeGraph checkout, build before running tests that spawn the CLI:

```bash
npm run build
npx vitest run __tests__/aosp-*.test.ts
```

A successful run on one extraction backend does not establish parity with the
other. See the [project guide](../../AGENTS.md) for build commands and the
[validation guide](../AGENTS.md) for real-repository and agent evaluation
requirements.
