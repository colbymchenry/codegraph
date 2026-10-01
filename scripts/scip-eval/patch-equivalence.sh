#!/usr/bin/env bash
#
# Does a patch end where a full rebuild does? Run it after editing a corpus that
# already has a codegraph index and an installed SCIP index for <lang>:
#
#   scripts/scip-eval/patch-equivalence.sh <repo> <lang>
#
# It syncs codegraph, patches the index (scip index --changed) and dumps every
# edge, then rebuilds in full and dumps again. Exit 0 when the two graphs are
# identical, 1 with the first differences otherwise. Uses this checkout's build
# (npx tsc -p .). The CI form of the check is the fixture test "merges only what
# a patch can change, and ends where a full rebuild does" (__tests__/scip/tsgo.test.ts).
set -euo pipefail

REPO="$(cd "${1:?usage: patch-equivalence.sh <repo> <lang>}" && pwd)"
LANG_="${2:?usage: patch-equivalence.sh <repo> <lang>}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CG=(node "$ROOT/dist/bin/codegraph.js")
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# Every edge as one line (both ends by file and qualified name, kind, line,
# provenance, metadata), sorted; streamed, since a large repo has millions.
dump() {
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    const { writeSync } = require("node:fs");
    const db = new DatabaseSync(process.argv[1], { readOnly: true });
    const q = db.prepare(`SELECT s.file_path || char(58, 58) || s.qualified_name AS s, t.file_path || char(58, 58) || t.qualified_name AS t,
      e.kind, e.line, IFNULL(e.provenance, char()) AS p, IFNULL(e.metadata, char()) AS m
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target`);
    let buf = [];
    for (const r of q.iterate()) {
      buf.push(`${r.s}\t${r.t}\t${r.kind}\t${r.line}\t${r.p}\t${r.m}`);
      if (buf.length >= 10000) { writeSync(1, buf.join("\n") + "\n"); buf = []; }
    }
    if (buf.length) writeSync(1, buf.join("\n") + "\n");
  ' "$REPO/.codegraph/codegraph.db" | LC_ALL=C sort -S 1G > "$1"
}

cd "$REPO"
"${CG[@]}" sync . >/dev/null
start=$(date +%s)
"${CG[@]}" scip index . --lang "$LANG_" --changed 2>&1 | grep -E "re-indexing|patched|up to date|documents merged|rejected|failed" || true
echo "patch: $(( $(date +%s) - start )) s"
dump "$WORK/patch.txt"

start=$(date +%s)
"${CG[@]}" scip index . --lang "$LANG_" 2>&1 | grep -E "resolved calls|documents merged|rejected|failed" || true
echo "full: $(( $(date +%s) - start )) s"
dump "$WORK/full.txt"

differ=$(diff "$WORK/patch.txt" "$WORK/full.txt" | grep -c '^[<>]' || true)
echo "edges: $(wc -l < "$WORK/full.txt"), differing lines: $differ"
if [ "$differ" -ne 0 ]; then
  diff "$WORK/patch.txt" "$WORK/full.txt" | head -20
  exit 1
fi
