/**
 * `codegraph.json` `modifiedAfter` / `modifiedBefore` — the file last-modified
 * window (#1304).
 *
 * Two layers under test:
 *   1. Loader: parse / validate / cache, mirroring the `exclude` loader.
 *   2. Behavior: `scanDirectory` drops out-of-window files BEFORE parsing, on
 *      BOTH the git (`git ls-files`) and non-git (filesystem walk) paths, and a
 *      project with no window behaves exactly as it always did.
 *
 * Invariant: every loader failure mode degrades to "no window", never a throw.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { CodeGraph } from "../src";
import { clearProjectConfigCache, loadExcludePatterns, loadModifiedDateRange } from "../src/project-config";
import { scanDirectory } from "../src/extraction";

const JAN_2026 = Date.parse("2026-01-01T00:00:00Z");
const JUN_2026 = Date.parse("2026-06-01T00:00:00Z");

describe("loadModifiedDateRange (codegraph.json)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-modified-"));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, "codegraph.json"), typeof obj === "string" ? obj : JSON.stringify(obj));

  it("is unbounded when there is no codegraph.json (the default)", () => {
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });

  it("loads a two-sided window", () => {
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z", modifiedBefore: "2026-06-01T00:00:00Z" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: JAN_2026, before: JUN_2026 });
  });

  it("allows a one-sided window", () => {
    writeConfig({ modifiedBefore: "2026-06-01T00:00:00Z" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: JUN_2026 });
  });

  it("trims the value before parsing it", () => {
    writeConfig({ modifiedAfter: "  2026-01-01T00:00:00Z  " });
    expect(loadModifiedDateRange(dir)).toEqual({ after: JAN_2026, before: null });
  });

  it("drops an unparseable bound instead of throwing", () => {
    writeConfig({ modifiedAfter: "not a date" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });

  it("ignores a non-string bound without throwing", () => {
    writeConfig({ modifiedBefore: 1735689600000 });
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });

  it("drops the whole window when after is later than before", () => {
    writeConfig({ modifiedAfter: "2026-06-01T00:00:00Z", modifiedBefore: "2026-01-01T00:00:00Z" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });

  it("ignores malformed JSON without throwing", () => {
    writeConfig("{ not: valid json ");
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });

  it("coexists with exclude in one file (shared single parse)", () => {
    writeConfig({ exclude: ["static/"], modifiedAfter: "2026-01-01T00:00:00Z" });
    expect(loadExcludePatterns(dir)).toEqual(["static/"]);
    expect(loadModifiedDateRange(dir)).toEqual({ after: JAN_2026, before: null });
  });

  it("picks up a changed window (mtime-invalidated cache)", () => {
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: JAN_2026, before: null });
    writeConfig({ modifiedBefore: "2026-06-01T00:00:00Z" });
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, "codegraph.json"), future, future);
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: JUN_2026 });
  });

  it("drops the window again when the config file is removed", () => {
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    expect(loadModifiedDateRange(dir)).toEqual({ after: JAN_2026, before: null });
    fs.rmSync(path.join(dir, "codegraph.json"));
    expect(loadModifiedDateRange(dir)).toEqual({ after: null, before: null });
  });
});

describe("scanDirectory honors the window on both enumeration paths (#1304)", () => {
  let dir: string;
  const mk = (rel: string, mtime?: number) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "export const x = 1;\n");
    if (mtime !== undefined) fs.utimesSync(p, new Date(mtime), new Date(mtime));
  };
  const writeConfig = (obj: unknown) =>
    fs.writeFileSync(path.join(dir, "codegraph.json"), JSON.stringify(obj));
  const names = (files: string[]) => files.map((f) => f.split(path.sep).join("/")).sort();

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-modified-scan-"));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("keeps only in-window files on the non-git filesystem walk", () => {
    mk("old/a.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("new/b.ts", Date.parse("2026-03-01T00:00:00Z"));
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    expect(names(scanDirectory(dir))).toEqual(["new/b.ts"]);
  });

  it("keeps files at either bound (both bounds are inclusive)", () => {
    mk("on-after.ts", JAN_2026);
    mk("on-before.ts", JUN_2026);
    mk("outside.ts", JUN_2026 + 86400000);
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z", modifiedBefore: "2026-06-01T00:00:00Z" });
    expect(names(scanDirectory(dir))).toEqual(["on-after.ts", "on-before.ts"]);
  });

  it("keeps only in-window files on the git enumeration path too", () => {
    mk("old/a.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("new/b.ts", Date.parse("2026-03-01T00:00:00Z"));
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    clearProjectConfigCache();
    expect(names(scanDirectory(dir))).toEqual(["new/b.ts"]);
  });

  it("indexes everything when no window is configured (behavior unchanged)", () => {
    mk("old/a.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("new/b.ts", Date.parse("2026-03-01T00:00:00Z"));
    expect(names(scanDirectory(dir))).toEqual(["new/b.ts", "old/a.ts"]);
  });

  it("tallies the files the window dropped", () => {
    mk("old/a.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("old/c.ts", Date.parse("2020-02-01T00:00:00Z"));
    mk("new/b.ts", Date.parse("2026-03-01T00:00:00Z"));
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    const stats = { unsupportedByExtension: new Map<string, number>() };
    expect(names(scanDirectory(dir, undefined, stats))).toEqual(["new/b.ts"]);
    expect(stats.modifiedDateSkipped).toBe(2);
  });

  it("lets an explicit range argument override the project file", () => {
    mk("old/a.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("new/b.ts", Date.parse("2026-03-01T00:00:00Z"));
    writeConfig({ modifiedAfter: "2026-01-01T00:00:00Z" });
    expect(names(scanDirectory(dir, undefined, undefined, { after: null, before: null })))
      .toEqual(["new/b.ts", "old/a.ts"]);
  });
});

describe("CodeGraph.indexAll records the window it was built with (#1304)", () => {
  let dir: string;
  const mk = (rel: string, mtime: number) => {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, `export function ${rel.replace(/[^a-z0-9]/gi, "_")}() { return 1; }\n`);
    fs.utimesSync(p, new Date(mtime), new Date(mtime));
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "cg-modified-e2e-"));
    clearProjectConfigCache();
  });
  afterEach(() => {
    clearProjectConfigCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("indexes only the in-window files and reports the filter", async () => {
    mk("old.ts", Date.parse("2020-01-01T00:00:00Z"));
    mk("new.ts", Date.parse("2026-03-01T00:00:00Z"));
    fs.writeFileSync(path.join(dir, "codegraph.json"), JSON.stringify({ modifiedAfter: "2026-01-01T00:00:00Z" }));
    const cg = CodeGraph.initSync(dir);
    const result = await cg.indexAll();
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkippedByModifiedDate).toBe(1);
    const filter = cg.getIndexModifiedDateFilter();
    expect(filter.after).toBe(JAN_2026);
    expect(filter.before).toBeNull();
    expect(filter.filesSkipped).toBe(1);
    cg.close();
  });

  it("records no window when none is configured (the default)", async () => {
    mk("a.ts", Date.parse("2020-01-01T00:00:00Z"));
    const cg = CodeGraph.initSync(dir);
    const result = await cg.indexAll();
    expect(result.filesIndexed).toBe(1);
    expect(result.filesSkippedByModifiedDate).toBeUndefined();
    const filter = cg.getIndexModifiedDateFilter();
    expect(filter.after).toBeNull();
    expect(filter.before).toBeNull();
    expect(filter.filesSkipped).toBe(0);
    cg.close();
  });
});
