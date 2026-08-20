#!/usr/bin/env bash
# End-to-end check of the auth gate against a local `wrangler dev`.
#
# Verifies the acceptance criteria for the gate: unauthenticated requests reach
# nothing (pages, API, or static assets), a valid cookie reaches everything, and
# a tampered cookie is rejected. Run it after touching src/auth.ts or the route
# table in src/index.ts.
#
#   ./scripts/smoke-auth.sh
set -uo pipefail

cd "$(dirname "$0")/.."

# Deliberately NOT $PORT: that is commonly already set to some other local dev
# server, and the whole suite would then silently test the wrong app.
DASH_PORT="${DASH_PORT:-8788}"
BASE="http://127.0.0.1:${DASH_PORT}"
PASSWORD="$(grep '^ADMIN_PASSWORD=' .dev.vars | cut -d'"' -f2)"
JAR="$(mktemp -t cg-dash-jar)"
LOG="$(mktemp -t cg-dash-log)"
DEV_VARS_BACKUP="$(mktemp -t cg-dash-vars)"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${DEV_PID:-}" ]] && kill "$DEV_PID" 2>/dev/null
  # The rotation phase rewrites .dev.vars; always put the original back.
  [[ -s "$DEV_VARS_BACKUP" ]] && cp "$DEV_VARS_BACKUP" .dev.vars
  rm -f "$JAR" "$LOG" "$DEV_VARS_BACKUP"
}
trap cleanup EXIT

# `curl -o /dev/null -w '%{http_code}'` plus the headers we care about.
status() { curl -s -o /dev/null -w '%{http_code}' "$@"; }
body() { curl -s "$@"; }

check() { # check <description> <expected> <actual>
  if [[ "$2" == "$3" ]]; then
    printf '  ok    %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s (expected %s, got %s)\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

contains() { # contains <description> <needle> <haystack>
  if [[ "$3" == *"$2"* ]]; then
    printf '  ok    %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s (missing %q in %.200q…)\n' "$1" "$2" "$3"
    FAIL=$((FAIL + 1))
  fi
}

lacks() { # lacks <description> <needle> <haystack>
  if [[ "$3" != *"$2"* ]]; then
    printf '  ok    %s\n' "$1"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s (found %q)\n' "$1" "$2"
    FAIL=$((FAIL + 1))
  fi
}

echo "Seeding local D1 from the ingest worker's migration…"
npx wrangler d1 execute codegraph-telemetry --local \
  --file=../telemetry-worker/migrations/0001_init.sql >/dev/null 2>&1

echo "Starting wrangler dev on :${DASH_PORT}…"
npx wrangler dev --port "$DASH_PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
READY=""
for _ in $(seq 1 90); do
  if [[ "$(body "$BASE/robots.txt")" == "User-agent: *"* ]]; then READY=1; break; fi
  sleep 1
done
if [[ -z "$READY" ]]; then
  echo "wrangler dev never came up on :${DASH_PORT} — log follows"
  cat "$LOG"
  exit 1
fi

echo
echo "Unauthenticated — nothing but the login page and robots.txt"
check "GET /               → 302 to login"   302 "$(status "$BASE/")"
check "GET /index.html     → 302 to login"   302 "$(status "$BASE/index.html")"
check "GET /styles.css     → 302 to login"   302 "$(status "$BASE/styles.css")"
check "GET /app.js         → 302 to login"   302 "$(status "$BASE/app.js")"
check "GET /vendor/chart   → 302 to login"   302 "$(status "$BASE/vendor/chart.umd.js")"
check "GET /api/health     → 401"            401 "$(status "$BASE/api/health")"
check "GET /api/session    → 401"            401 "$(status "$BASE/api/session")"
check "GET /api/anything   → 401"            401 "$(status "$BASE/api/whatever")"
check "GET /login          → 200"            200 "$(status "$BASE/login")"
check "GET /robots.txt     → 200"            200 "$(status "$BASE/robots.txt")"
contains "no data leaks in the 401 body" '"unauthorized"' "$(body "$BASE/api/health")"

echo
echo "Login page"
LOGIN_HTML="$(body "$BASE/login")"
contains "sentence-case heading"   "codegraph telemetry" "$LOGIN_HTML"
contains "sentence-case label"     ">Password<"          "$LOGIN_HTML"
contains "sentence-case button"    ">Sign in<"           "$LOGIN_HTML"
lacks    "no uppercased labels"    "uppercase"           "$LOGIN_HTML"
lacks    "no tracked-out labels"   "letter-spacing"      "$LOGIN_HTML"
contains "label is normal size"    "font-size: 16px"     "$LOGIN_HTML"
check "open redirect refused" "/" \
  "$(body "$BASE/login?next=%2F%2Fevil.example" | sed -n 's/.*name="next" value="\([^"]*\)".*/\1/p')"
check "same-origin next kept" "/api/health" \
  "$(body "$BASE/login?next=%2Fapi%2Fhealth" | sed -n 's/.*name="next" value="\([^"]*\)".*/\1/p')"

echo
echo "Sign-in"
check "wrong password        → 401" 401 \
  "$(status -X POST "$BASE/login" -d "password=definitely-not-it" -d "next=/")"
check "wrong password sets no cookie" "" \
  "$(curl -s -D - -o /dev/null -X POST "$BASE/login" -d "password=nope" | grep -ci 'set-cookie' | sed 's/^0$//')"
check "empty password        → 400" 400 "$(status -X POST "$BASE/login" -d "password=")"
check "cross-origin post     → 400" 400 \
  "$(status -X POST "$BASE/login" -H 'Origin: https://evil.example' -d "password=${PASSWORD}")"
# One sign-in, then every cookie assertion reads the captured headers. Doing a
# fresh POST per assertion would burn the login rate limit and 429 halfway down.
# The sign-in carries `Origin: null` — what Chromium actually sends on a
# same-origin form submit from a page with our `Referrer-Policy: no-referrer`
# header. Rejecting it locked every Chromium browser out of the login form
# while curl-shaped tests (no Origin at all) kept passing.
SIGNIN="$(curl -s -D - -o /dev/null -c "$JAR" -X POST "$BASE/login" -H 'Origin: null' -d "password=${PASSWORD}" -d "next=/")"
SIGNIN_STATUS="$(printf '%s' "$SIGNIN" | head -1 | awk '{print $2}')"
check    "correct password      → 302" "302" "$SIGNIN_STATUS"
check    "Origin: null (Chromium form post) not rejected" "yes" "$([ "$SIGNIN_STATUS" != "400" ] && echo yes || echo no)"
contains "cookie is HttpOnly"     "HttpOnly"         "$SIGNIN"
contains "cookie is Secure"       "Secure"           "$SIGNIN"
contains "cookie is SameSite=Lax" "SameSite=Lax"     "$SIGNIN"
contains "cookie is ~1 year"      "Max-Age=31536000" "$SIGNIN"
contains "cookie is site-wide"    "Path=/"           "$SIGNIN"

COOKIE="$(grep cg_admin_session "$JAR" | awk '{print $NF}')"
PAYLOAD="${COOKIE%%.*}"
SIG="${COOKIE#*.}"

# A persistent cookie carries a real expiry in the jar; a session cookie (gone
# on browser restart) carries 0. This is the "survives a restart" criterion.
JAR_EXPIRY="$(grep cg_admin_session "$JAR" | awk '{print $5}')"
if [[ "$JAR_EXPIRY" -gt "$(( $(date +%s) + 300 * 86400 ))" ]]; then
  check "cookie persists across browser restarts" "persistent" "persistent"
else
  check "cookie persists across browser restarts" "persistent" "session-only (expiry ${JAR_EXPIRY})"
fi

echo
echo "Authenticated — the whole app"
check "GET /            → 200" 200 "$(status -b "$JAR" "$BASE/")"
check "GET /styles.css  → 200" 200 "$(status -b "$JAR" "$BASE/styles.css")"
check "GET /app.js      → 200" 200 "$(status -b "$JAR" "$BASE/app.js")"
check "GET /vendor/chart→ 200" 200 "$(status -b "$JAR" "$BASE/vendor/chart.umd.js")"
check "GET /api/session → 200" 200 "$(status -b "$JAR" "$BASE/api/session")"
check "GET /api/health  → 200" 200 "$(status -b "$JAR" "$BASE/api/health")"
contains "health reads D1" '"ok":true' "$(body -b "$JAR" "$BASE/api/health")"
check "GET /login while signed in → 302" 302 "$(status -b "$JAR" "$BASE/login")"
check "unknown API route → 404" 404 "$(status -b "$JAR" "$BASE/api/nope")"
check "POST to an API route → 405" 405 "$(status -b "$JAR" -X POST "$BASE/api/health")"

echo
echo "Tampering"
# Mutate the FIRST signature character, not the last: base64url's final
# character of a 32-byte tag carries only 4 significant bits, so flipping it is
# sometimes a no-op on the decoded bytes and the test would pass vacuously.
FLIPPED="${PAYLOAD}.$([[ "${SIG:0:1}" == 'A' ]] && echo B || echo A)${SIG:1}"
check "flipped signature   → 401" 401 "$(status -H "Cookie: cg_admin_session=${FLIPPED}" "$BASE/api/health")"
check "truncated signature → 401" 401 "$(status -H "Cookie: cg_admin_session=${PAYLOAD}.${SIG:0:40}" "$BASE/api/health")"
check "swapped payload     → 401" 401 \
  "$(status -H "Cookie: cg_admin_session=$(printf '%s' '{"v":1,"iat":0,"exp":9999999999,"pw":"x"}' | base64 | tr -d '=' | tr '+/' '-_').${SIG}" "$BASE/api/health")"
check "no signature        → 401" 401 "$(status -H "Cookie: cg_admin_session=${PAYLOAD}" "$BASE/api/health")"
check "garbage cookie      → 401" 401 "$(status -H 'Cookie: cg_admin_session=not-a-token' "$BASE/api/health")"
check "empty cookie        → 401" 401 "$(status -H 'Cookie: cg_admin_session=' "$BASE/api/health")"
check "tampered cookie on a page → 302 to login" 302 \
  "$(status -H "Cookie: cg_admin_session=${FLIPPED}" "$BASE/")"

echo
echo "Sign-out"
check "POST /logout → 302" 302 "$(status -X POST "$BASE/logout" -H 'Origin: null')"
contains "logout clears the cookie" "Max-Age=0" \
  "$(curl -s -D - -o /dev/null -X POST "$BASE/logout")"
check "GET /logout  → 405" 405 "$(status "$BASE/logout")"
check "cross-origin logout → 400" 400 \
  "$(status -X POST "$BASE/logout" -H 'Origin: https://evil.example')"

echo
echo "Rate limiting (6 attempts in a minute; the 6th should be capped)"
LAST=""
for _ in 1 2 3 4 5 6 7; do
  LAST="$(status -X POST "$BASE/login" -d 'password=guess')"
done
check "brute force capped → 429" 429 "$LAST"

echo
echo "Password rotation (restarting with a different ADMIN_PASSWORD)"
cp .dev.vars "$DEV_VARS_BACKUP"
sed 's/^ADMIN_PASSWORD=.*/ADMIN_PASSWORD="rotated-password"/' "$DEV_VARS_BACKUP" >.dev.vars
kill "$DEV_PID" 2>/dev/null
wait "$DEV_PID" 2>/dev/null
npx wrangler dev --port "$DASH_PORT" --ip 127.0.0.1 >"$LOG" 2>&1 &
DEV_PID=$!
for _ in $(seq 1 90); do
  [[ "$(body "$BASE/robots.txt")" == "User-agent: *"* ]] && break
  sleep 1
done
check "cookie from the old password → 401" 401 \
  "$(status -H "Cookie: cg_admin_session=${COOKIE}" "$BASE/api/health")"
check "old password no longer signs in → 401" 401 \
  "$(status -X POST "$BASE/login" -d "password=${PASSWORD}")"
check "new password signs in → 302" 302 \
  "$(status -X POST "$BASE/login" -d "password=rotated-password")"

echo
printf '%s\n' "-----"
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]]
