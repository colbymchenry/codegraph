#!/usr/bin/env bash
# Try the Steps / Screens / Entry-points pictures on a real project with the
# CURRENT build: clone (shallow) a preset or any git URL, index it with
# dist/bin/codegraph.js (a full rebuild, so new synthesizers and resolvers
# apply), print what the index holds — routes, cross-tier edges, navigations —
# and open the viewer on it.
#
#   npm run build
#   scripts/try-repo.sh                      # list the presets and what each shows
#   scripts/try-repo.sh proshop              # clone + index + open the viewer
#   scripts/try-repo.sh proshop 4750         # on a fixed port
#   scripts/try-repo.sh https://github.com/x/y.git
#   scripts/try-repo.sh ~/code/my-app        # a local project (re-indexed with this build)
#
# Env:  CODEGRAPH_TRY_DIR   where clones live (default ~/.cache/codegraph-try)
#       CODEGRAPH_TRY_NO_OPEN=1   print the URL instead of opening a browser
#       CODEGRAPH_TRY_REINDEX=0   reuse an existing index instead of rebuilding
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
CLI="$HERE/dist/bin/codegraph.js"
DIR="${CODEGRAPH_TRY_DIR:-$HOME/.cache/codegraph-try}"
export CODEGRAPH_TELEMETRY=0 DO_NOT_TRACK=1

# name|url|what to look at (hash URLs relative to the viewer)
PRESETS='
proshop|https://github.com/bradtraversy/proshop_mern.git|Express + React Router (MERN). Steps: #/steps?symbol=login&through=1 — login → ⇢ POST /api/users/login → User.findOne → 401 rows; #/steps?symbol=/payment — the bounce to /shipping WHEN !shippingAddress.address, the push to /placeorder, and the checkout nav tabs, each under the prop that enables it. Screens: #/screens — 19 pages wired by history.push and <LinkContainer to>. Entry points: 30 endpoints + 19 pages; the project reads as a web app.
express-realworld|https://github.com/gothinkster/node-express-realworld-example-app.git|Express + Prisma (TypeScript). Steps: #/steps?symbol=POST%20/api/users/login — request → handler → prisma → response rows with their status codes.
nest-samples|https://github.com/nestjs/nest.git|NestJS samples. Steps: #/steps?symbol=POST%20/audio/transcode (sample/26-queues: the job lands on @Process("transcode") as ⇠ transcode); the event emitter sample (30) pairs emit("order.created") with its @OnEvent listener; sample/02-gateways for @SubscribeMessage.
nest-boilerplate|https://github.com/brocoders/nestjs-boilerplate.git|NestJS + TypeORM. Steps: #/steps?symbol=POST%20/api/v1/auth/email/login — guards on the class and method (FIRES FROM … after UseGuards), DI followed by declared type into the service, repository saves as data calls, thrown exceptions as response rows.
tanstack|https://github.com/TanStack/router.git|TanStack Router: 477 example and e2e apps in ONE index — the app-root gating under load, where a link resolves within its own app and never into another. Look at examples/react/kitchen-sink-file-based (file-based: /profile from _auth.profile.tsx, /route-group from a (group) folder) and examples/react/basic (code-based: /posts/:postId composed through getParentRoute).
next-saas-starter|https://github.com/leerob/next-saas-starter.git|Next.js App Router + server actions. Screens: #/screens — /sign-in → /dashboard via Login > signIn WHEN …, <Link>s, redirect(), NextResponse.redirect; Steps: #/steps?symbol=/dashboard&through=1 — FIRES FROM page load, handlers, useSWR("/api/team") → ⇢ GET /api/team.
spring-petclinic|https://github.com/spring-projects/spring-petclinic.git|Spring (Java). Steps: #/steps?symbol=POST%20/owners/new — PreAuthorize-style guards, OwnerRepository owners → owners.save as the database, ResponseEntity / view replies with WHEN rows. Kotlin twin: spring-petclinic-kotlin.
spring-petclinic-kotlin|https://github.com/spring-petclinic/spring-petclinic-kotlin.git|Spring (Kotlin). Same picture as spring-petclinic with Kotlin guards (if expressions, when).
fastapi-template|https://github.com/fastapi/full-stack-fastapi-template.git|FastAPI + a TanStack Router frontend. Screens: #/screens — 8 frontend pages with their guards (/login and /signup bounce to / WHEN isLoggedIn(), /admin WHEN NOT user.is_superuser). Entry points: 23 routes named by path (APIRouter prefixes composed); Steps: #/steps?symbol=POST%20/items — Depends(...) as the chain, session.add/commit as the database, HTTPException rows with status_code. (settings.API_V1_STR is a computed prefix and is left off, on purpose.)
dispatch|https://github.com/Netflix/dispatch.git|FastAPI, large. Steps on any router endpoint; expect guards and arguments for Python.
clean-architecture|https://github.com/jasontaylordev/CleanArchitecture.git|ASP.NET Minimal API endpoint groups (C#). Entry points: 10 routes (POST /api/TodoItems, PUT /api/TodoItems/{id} …); Steps: #/steps?symbol=PUT%20/api/TodoItems/{id} — TypedResults replies as 204 · 400 rows with WHEN.
eshoponweb|https://github.com/dotnet-architecture/eShopOnWeb.git|ASP.NET MVC + Minimal API (C#). Steps on a controller action or a MapGet endpoint; C# guards and arguments.
bookstack|https://github.com/BookStackApp/BookStack.git|Laravel (PHP). Entry points: routes/web.php → controller methods; Steps draws handlers and effects (Eloquent, responses) but PHP has no WHEN / arguments / trigger rules yet — expect boxes without conditions.
sveltekit-realworld|https://github.com/sveltejs/realworld.git|SvelteKit. Screens: #/screens — 10 pages wired by <a href>, goto() and redirect(status, path); /settings and /editor guard themselves in their +page.server.js loaders, drawn WHEN !locals.user. Entry points: file routes with load() edges; Steps on a load or an action.
vue-realworld|https://github.com/gothinkster/vue-realworld-example-app.git|Vue Router. Screens: #/screens — 10 routes read from src/router/index.js, wired by router.push({ name }) and <router-link :to>, which navigate by route NAME rather than by path. Steps on a handler: template @click bindings, Pinia/Vuex channels.
icecubes|https://github.com/Dimillian/IceCubesApp.git|SwiftUI (Swift). Steps on a view model method: Swift guards, network / storage effects; SwiftUI navigation is not a Screens picture yet.
nowinandroid|https://github.com/android/nowinandroid.git|Jetpack Compose (Kotlin). Steps on a ViewModel method: Kotlin guards, DataStore / network effects; Compose navigation is not a Screens picture yet.
'

usage() {
  echo "usage: scripts/try-repo.sh <preset | git-url | local-path> [port]"
  echo
  echo "presets:"
  echo "$PRESETS" | awk -F'|' 'NF>=3 { printf "  %-24s %s\n", $1, $3 }'
}

[ -f "$CLI" ] || { echo "no build at $CLI — run: npm run build"; exit 1; }
[ $# -ge 1 ] || { usage; exit 0; }

TARGET="$1"
PORT="${2:-}"
HINT=""
if [ -d "$TARGET" ]; then
  REPO="$(cd "$TARGET" && pwd)"
  NAME="$(basename "$REPO")"
else
  LINE="$(echo "$PRESETS" | awk -F'|' -v n="$TARGET" '$1==n { print; exit }')"
  if [ -n "$LINE" ]; then
    NAME="$TARGET"
    URL="$(echo "$LINE" | cut -d'|' -f2)"
    HINT="$(echo "$LINE" | cut -d'|' -f3-)"
  else
    URL="$TARGET"
    NAME="$(basename "${URL%.git}")"
  fi
  REPO="$DIR/$NAME"
  if [ ! -d "$REPO/.git" ]; then
    mkdir -p "$DIR"
    echo "cloning $URL → $REPO"
    git clone -q --depth 1 "$URL" "$REPO"
  fi
fi

cd "$REPO"
if [ ! -d .codegraph ]; then
  echo "indexing $REPO (first time)"
  node "$CLI" init . 2>&1 | tail -2
elif [ "${CODEGRAPH_TRY_REINDEX:-1}" != "0" ]; then
  echo "re-indexing $REPO with the current build"
  node "$CLI" index . 2>&1 | tail -2
fi

# What the index holds for the pictures: routes, cross-tier edges, navigations.
node --disable-warning=ExperimentalWarning - <<'JS'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('.codegraph/codegraph.db', { readOnly: true });
const routes = db.prepare("select name from nodes where kind='route' order by name").all().map((r) => r.name);
const verbs = routes.filter((n) => /^[A-Z]+ /.test(n));
const pages = routes.filter((n) => !/^[A-Z]+ /.test(n));
console.log(`routes: ${routes.length} (${verbs.length} endpoints, ${pages.length} pages)`);
if (routes.length) console.log('  ' + routes.slice(0, 24).join(' | ') + (routes.length > 24 ? ' | …' : ''));
const navs = db.prepare("select count(*) as n from edges where kind='navigates'").get().n;
const synth = db.prepare("select json_extract(metadata, '$.synthesizedBy') as by, count(*) as n from edges where provenance='heuristic' group by 1 order by 2 desc").all();
console.log(`navigations: ${navs}${navs ? ' — the Screens tab is on' : ' — no screen navigation: the Screens tab stays hidden, Entry points is the list'}`);
console.log('synthesized edges: ' + (synth.map((s) => `${s.by}=${s.n}`).join(', ') || 'none'));
const tier = db.prepare("select s.name as s, t.name as t, e.metadata as m from edges e join nodes s on s.id=e.source join nodes t on t.id=e.target where json_extract(e.metadata, '$.synthesizedBy') in ('http-client', 'queue-job', 'event-bus') limit 12").all();
for (const r of tier) { const m = JSON.parse(r.m); console.log(`  ${m.synthesizedBy}: ${r.s} → ${r.t}${m.href ? ' (' + m.method + ' ' + m.href + ')' : m.event ? ' (' + m.event + ')' : ''}`); }
JS

echo
[ -n "$HINT" ] && { echo "look at: $HINT"; echo; }
ARGS=(ui)
[ -n "$PORT" ] && ARGS+=(--port "$PORT")
[ "${CODEGRAPH_TRY_NO_OPEN:-0}" = "1" ] && ARGS+=(--no-open)
echo "tabs: #/entry (Entry points)  #/screens  #/steps (chooser)  #/steps?symbol=<route or function name>&through=1"
exec node "$CLI" "${ARGS[@]}" .
