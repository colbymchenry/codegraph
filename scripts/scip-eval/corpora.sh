#!/usr/bin/env bash
#
# Reproduce docs/scip.md's eval tables: clone each corpus at its pinned commit, index
# it with this checkout (codegraph init, then scip index), and judge "who calls
# X?" over 50 random targets per seed with compare.ts.
#
# Usage:
#   scripts/scip-eval/corpora.sh [corpus...]
#     corpora: codegraph django cobra ripgrep (default), playwright vscode (heavy:
#              vscode needs ~10 GB of RAM and ~15 min)
#
# Environment:
#   SCIP_EVAL_DIR  clones and outputs (default: ~/.cache/codegraph-scip-eval)
#   SEEDS          default "1 2"
#
# Needs: a built checkout (npx tsc -p .) and a Node that runs it (22/24), the
# language's indexer (docs/scip.md "Using it"), and npx for the TypeScript judge.
# TS corpora are judged by scip-typescript's index (an independent compiler,
# run through the fork's own adapter); the others by their own indexer's.
# TS corpora also get references.ts: the precision of every `references` edge,
# before and after the merge, against the same judge.
# Output: $SCIP_EVAL_DIR/out/<corpus>.log, <corpus>-seed<N>.json and <corpus>-references.json.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
EVAL="${SCIP_EVAL_DIR:-$HOME/.cache/codegraph-scip-eval}"
OUT="$EVAL/out"
SEEDS="${SEEDS:-1 2}"
CG=(node "$ROOT/dist/bin/codegraph.js")
JUDGE_TS='{"scip":{"typescript":{"cmd":"npx","args":["-y","@sourcegraph/scip-typescript@0.4.0","{args}"]}}}'

# name | url | commit | language | rg type | target prefix | judge (own|scip-typescript) | setup
CORPORA="
codegraph|https://github.com/colbymchenry/codegraph|f4ddf508516332419ea3c95702810765936cf679|typescript|ts|src/|scip-typescript|npm ci --ignore-scripts
django|https://github.com/django/django|026b005f3dc43a98557ce5a546b5e4938d06fed1|python|py|django/|own|
cobra|https://github.com/spf13/cobra|adbc8813901bba65827259daa8e22ff94ec1f30e|go|go||own|
ripgrep|https://github.com/BurntSushi/ripgrep|3fce3b5bb0236da2df6d99672afb8a719642eca7|rust|rust||own|
playwright|https://github.com/microsoft/playwright|a8c1a59f0afe5bfaccbef3883cfd3399565b8ac9|typescript|ts|packages/|scip-typescript|npm ci --ignore-scripts
vscode|https://github.com/microsoft/vscode|73d5322bb28c1a3c449fcee6c3869af33fad5027|typescript|ts|src/|scip-typescript|
"

[ -f "$ROOT/dist/bin/codegraph.js" ] || { echo "corpora: build first (npx tsc -p .)" >&2; exit 1; }
mkdir -p "$OUT"

# A consistent copy of a codegraph database, WAL included.
snapshot() { rm -f "$2"; node --no-warnings -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1]).exec(`VACUUM INTO '"'"'${process.argv[2]}'"'"'`)' "$1" "$2"; }

run() {
  local name=$1 url=$2 sha=$3 lang=$4 rgt=$5 prefix=$6 judge=$7 setup=$8
  local dir="$EVAL/$name" log="$OUT/$name.log"
  local db="$dir/.codegraph/codegraph.db" heuristic="$OUT/$name-heuristic.db" merged="$OUT/$name-merged.db"
  echo "== $name @ ${sha:0:9}"

  if [ "$(git -C "$dir" rev-parse HEAD 2>/dev/null)" != "$sha" ]; then
    rm -rf "$dir" && git init -q "$dir"
    git -C "$dir" fetch -q --depth 1 "$url" "$sha" && git -C "$dir" checkout -q FETCH_HEAD
    if [ -n "$setup" ]; then (cd "$dir" && $setup >/dev/null 2>&1) || echo "  setup failed: $setup (indexing without it)"; fi
  fi

  rm -rf "$dir/.codegraph" "$dir/codegraph.json"
  "${CG[@]}" init -y "$dir" >"$log" 2>&1
  snapshot "$db" "$heuristic"

  local index="$dir/.codegraph/scip/$lang.scip"
  if [ "$judge" = scip-typescript ]; then
    # Build the judge with the fork's own multi-project adapter, keep its index,
    # then put the graph back to the heuristic-only state.
    echo "$JUDGE_TS" >"$dir/codegraph.json"
    "${CG[@]}" scip index "$dir" --lang typescript >>"$log" 2>&1
    rm -f "$dir/codegraph.json"
    index="$OUT/$name-judge.scip"
    cp -p "$dir/.codegraph/scip/typescript.scip" "$index"
    rm -rf "$dir/.codegraph/scip" "$db-wal" "$db-shm" && cp "$heuristic" "$db"
  fi

  "${CG[@]}" scip index "$dir" --lang "$lang" >>"$log" 2>&1
  grep -E "documents, .* resolved calls|documents merged" "$log" | tail -2 | sed 's/^/  /'
  snapshot "$db" "$merged"

  for s in $SEEDS; do
    (cd "$ROOT" && npx tsx scripts/scip-eval/compare.ts "$dir" "$index" "$heuristic" "$merged" \
      --random 50 --seed "$s" --rg-type "$rgt" ${prefix:+--prefix "$prefix"} --json 2>>"$log") >"$OUT/$name-seed$s.json"
    node -e '
      const j = require(process.argv[1]);
      const f = m => { const x = j.rows.find(r => r.method === m); return `${Math.round(x.recall * 100)}% / ${x.precision === null ? "-" : Math.round(x.precision * 100) + "%"}`; };
      console.log(`  seed ${j.seed}: ${j.rows.map(r => `${r.method} ${f(r.method)}`).join(" | ")}`);' "$OUT/$name-seed$s.json"
  done

  if [ "$judge" = scip-typescript ]; then
    (cd "$ROOT" && npx tsx scripts/scip-eval/references.ts "$dir" "$index" --graph "codegraph=$heuristic" --graph "codegraph+SCIP=$merged" \
      --json 2>>"$log") >"$OUT/$name-references.json"
    node -e '
      const j = require(process.argv[1]);
      console.log(`  references: ${j.rows.map(r => `${r.graph} ${r.precision === null ? "-" : (100 * r.precision).toFixed(1) + "%"} (${r.right + r.wrong} judged)`).join(" | ")}`);' "$OUT/$name-references.json"
  fi
}

want=("$@")
[ ${#want[@]} -gt 0 ] || want=(codegraph django cobra ripgrep)
for w in "${want[@]}"; do
  line=$(printf '%s\n' "$CORPORA" | grep "^$w|") || { echo "corpora: unknown corpus '$w'" >&2; exit 1; }
  IFS='|' read -r name url sha lang rgt prefix judge setup <<<"$line"
  run "$name" "$url" "$sha" "$lang" "$rgt" "$prefix" "$judge" "$setup"
done
