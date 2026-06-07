# Scope: Salesforce stack (Apex + LWC + Aura + Visualforce)

Index the full Salesforce stack as one connected graph: the Apex back end, and
the three UI layers that reach into it. The novel value is **cross-layer edges**
— editing an Apex method surfaces every LWC, Aura, and Visualforce file that
depends on it.

## Layers and how each is wired

| Layer | Files | Mechanism | Why |
|---|---|---|---|
| Apex | `.cls`, `.trigger` | tree-sitter grammar + declarative `LanguageExtractor` (`languages/apex.ts`) | sfapex grammar exists (ABI 15), node types mirror Java |
| Visualforce | `.page`, `.component` | custom `VisualforceExtractor` | no grammar; `{!expr}` / `<c:>` are the semantics, not text |
| Aura | `.cmp`, `.app`, `.evt`, `.intf` | custom `AuraExtractor` + Aura-JS handler path | markup + bare `({...})` controller objects |
| LWC | `.js` (already indexed) + `.html` | `LwcTemplateExtractor` (template only) | the `.js` is plain ES modules; only the template + the Apex-import link are missing |

The markup extractors follow the existing standalone pattern (`svelte-extractor.ts`,
`razor-extractor.ts`): a class taking `(filePath, source)`, dispatched in
`tree-sitter.ts`'s `extractFromSource`. Exactly **one `component` node per file**;
child/handler/controller links are `references`/`calls` EDGES, never per-tag nodes.

## Cross-layer edges (the point)

| From | To | EdgeKind | How |
|---|---|---|---|
| LWC `.js` `import x from '@salesforce/apex/C.m'` | Apex method `C::m` | `imports` + `calls` | `salesforce.ts` resolver maps the `@salesforce/apex/...` specifier to the Apex method's qualifiedName |
| Visualforce `controller=`/`extensions=` | Apex class | `references` | resolver, by class name |
| Visualforce / Aura `<c:child>` | child component | `references` | resolver, by component name |
| LWC `.html` `<c-child>` | child LWC class | `references` | resolver, kebab→PascalCase |
| Aura `cmp.get("c.x")` | Apex method | `calls` | extractor emits the bare method name; the generic name-matcher resolves it cross-language (`calls` aren't language-gated) |

**Family-gate note (important):** Apex is deliberately left out of
`LANGUAGE_FAMILY` (`name-matcher.ts`). The framework gate (`gateFrameworkLanguage`)
only drops a `references`/`imports` edge between two *known* families; with Apex
unknown, every cross-layer edge survives the framework-resolver path. This is why
no LANGUAGE_FAMILY change was needed (unlike Razor, which shares `dotnet` with C#).

## Invariants / risk mitigations

- **`standardController="Account"` is skipped** — it names an SObject, not an
  Apex class; linking it would mis-resolve to a same-named class.
- **`.html` is path-gated** to `lwc/<bundle>/*.html` (`isLwcTemplate`) so generic
  HTML elsewhere stays unindexed (no HTML hijack).
- **Aura JS handler extraction is path-gated** to `aura/*Controller|Helper|Renderer.js`
  — a new branch for the bare `({...})` object, not a change to the existing
  `export const x = {...}` object-method gate (zero effect on other JS).
- Only the custom `c:`/`c-` namespace is captured; standard namespaces (`apex:`,
  `lightning:`, `aura:`, `ui:`, `force:`) are framework built-ins → skipped.

## Validation (deterministic, real repos)

`scripts/add-lang/check-grammar.mjs apex` → ABI 15, PASS. `verify-extraction.mjs`
PASS on real repos with all four languages detected:

| Repo | Tier | Files | Cross-layer edges observed |
|---|---|---|---|
| trailheadapps/ebikes-lwc | Small | 182 | 16 LWC.js→Apex `imports`, 1 VF→Apex, 17 LWC.html→child |
| trailheadapps/dreamhouse-lwc | Small | 176 | LWC→Apex + LWC.html→child |
| trailheadapps/apex-recipes | Medium | 432 | 10 LWC.js→Apex `imports` + 5 `calls`, 7 LWC.html→child |

Apex fair coverage on ebikes-lwc is 55.6%; the residual is Salesforce's mandatory
`*Test` classes (the platform requires a test class per class; nothing in code
depends on a test) plus one metadata-referenced class — every non-test business
class with a dependent is covered. Unit/integration coverage lives in
`__tests__/extraction.test.ts` (Apex / Visualforce / LWC template / Aura blocks).

**Agent A/B** (headless `claude -p`, Opus 4.8, `--strict-mcp-config`, codegraph
the only variable — `scripts/agent-eval/run-all.sh`):

| Repo | n | Arm | Read | Grep/Bash | explore | duration | cost |
|---|---|---|---|---|---|---|---|
| ebikes-lwc | 2 | WITH | 0 | 0 | 1–2 | 27–30s | $0.34–0.53 |
| ebikes-lwc | 2 | WITHOUT | 5–9 | 10–16 | — | 61–90s | $0.22–0.28 |
| apex-recipes | 1 | WITH | 0 | 0 | 1 | 33s | $0.31 |
| apex-recipes | 1 | WITHOUT | 4 | 6 | — | 47s | $0.36 |

Question per repo is the LWC→Apex flow (e.g. "how does orderBuilder reach the
Apex OrderController"). In every run a **single `codegraph_explore` answers with
zero file reads** and ~30–50% less wall-clock — the agent rides the cross-layer
edges this feature adds. Cost is mixed: higher on the small repo (Opus 4.8's
native Read/Grep baseline is lean there), lower on the medium repo (the
without-arm thrashes more). Corpus entries for `/agent-eval` are in
`.claude/skills/agent-eval/corpus.json` under "Salesforce".

## Out of scope (follow-ups)

- `@salesforce/schema/Object.Field` → SObject (no SObject nodes exist yet).
- Apex `@AuraEnabled` not queryable from the persisted graph (no `extractModifiers`
  on the Apex extractor; annotations exist only as dangling `decorates` refs).
- Managed-package namespaces (`ns__Class`, `ns:comp`) — default `c` namespace only.
- Visualforce `<apex:include>`/`<apex:composition template=>` page-to-page,
  `{!ctrl.method}` merge-field bindings; Aura `<aura:attribute>` nodes.
