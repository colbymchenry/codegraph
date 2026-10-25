/**
 * A character budget for `codegraph_explore` (#1701).
 *
 * `maxFiles` counts FILES, not characters: every admitted file contributes its
 * whole symbol bodies plus its share of the blast-radius and relationships
 * sections, so a small `maxFiles` still answered in 5-20k characters on the
 * reporter repo (5.4k at 1, 8.1k at 3, 20.5k at 6). These tests pin the
 * `maxChars` contract: it lowers the envelope the allocator splits, it is
 * clamped to a usable range, and the response honours the number asked for.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import CodeGraph from "../src/index";
import {
  ToolHandler,
  applyMaxCharsBudget,
  getExploreOutputBudget,
  EXPLORE_MAX_CHARS_MAX,
  EXPLORE_MAX_CHARS_MIN,
  tools,
} from "../src/mcp/tools";

const ALLOCATOR = "src/mcp/allocator.ts";
const QUERY = "allocateExploreBudget splitBudget envelope";

/**
 * The final cut appends a short note when it drops a trailing section, so a
 * response may overrun its budget by that note and no more. Without the
 * tolerance a budget assertion would fail on the note instead of on the budget.
 */
const CUT_NOTE_TOLERANCE = 120;

/** Filler bodies, so the allocator file is big enough to be worth trimming. */
function filler(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    out += `
/** Budget helper ${i}: splits the explore envelope by weight. */
export function splitBudgetPart${i}(pool: number, weight: number, total: number): number {
  if (total <= 0) return 0;
  const share = Math.floor((pool * weight) / total);
  return share > pool ? pool : share;
}
`;
  }
  return out;
}

const ALLOCATOR_SOURCE = `
import { clampOutputBudget } from "./budget-math";

/** Split the explore output budget across the ranked files. */
export function allocateExploreBudget(pool: number, weights: number[], maxFiles: number): number[] {
  const total = weights.reduce((sum, w) => sum + w, 0);
  const admitted = weights.slice(0, maxFiles);
  return admitted.map((w) => clampOutputBudget((pool * w) / total));
}
${filler(14)}
`;

interface Project {
  dir: string;
  cg: CodeGraph;
  handler: ToolHandler;
}

async function buildProject(prefix: string, files: Record<string, string>): Promise<Project> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body.trimStart());
  }
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();
  return { dir, cg, handler: new ToolHandler(cg) };
}

describe("applyMaxCharsBudget", () => {
  it("lowers the envelope the allocator splits and keeps the rest of the tier", () => {
    const adaptive = getExploreOutputBudget(1000);
    const tuned = applyMaxCharsBudget(adaptive, 4000);
    expect(tuned.maxOutputChars).toBe(4000);
    expect(tuned.maxCharsExplicit).toBe(true);
    // The tier still owns everything else: the budget is a ceiling on the TOTAL,
    // not a rescaling of the per-file cap or the default file count.
    expect(tuned.maxCharsPerFile).toBe(adaptive.maxCharsPerFile);
    expect(tuned.defaultMaxFiles).toBe(adaptive.defaultMaxFiles);
    expect(tuned.includeRelationships).toBe(adaptive.includeRelationships);
    // The adaptive budget object is not mutated in place.
    expect(adaptive.maxOutputChars).not.toBe(4000);
    expect(adaptive.maxCharsExplicit).toBeUndefined();
  });

  it("clamps to the usable range instead of rejecting", () => {
    const adaptive = getExploreOutputBudget(1000);
    expect(applyMaxCharsBudget(adaptive, 10).maxOutputChars).toBe(EXPLORE_MAX_CHARS_MIN);
    expect(applyMaxCharsBudget(adaptive, 999999).maxOutputChars).toBe(EXPLORE_MAX_CHARS_MAX);
    expect(applyMaxCharsBudget(adaptive, EXPLORE_MAX_CHARS_MIN).maxOutputChars).toBe(EXPLORE_MAX_CHARS_MIN);
    expect(applyMaxCharsBudget(adaptive, EXPLORE_MAX_CHARS_MAX).maxOutputChars).toBe(EXPLORE_MAX_CHARS_MAX);
  });

  it("floors a fractional value, so the promise is an integer", () => {
    expect(applyMaxCharsBudget(getExploreOutputBudget(1000), 4000.9).maxOutputChars).toBe(4000);
  });

  it("leaves the adaptive budget alone for a value it cannot use", () => {
    const adaptive = getExploreOutputBudget(1000);
    for (const bad of [undefined, null, "4000", 0, -5, NaN, Infinity]) {
      const out = applyMaxCharsBudget(adaptive, bad);
      expect(out, String(bad)).toBe(adaptive);
      expect(out.maxCharsExplicit, String(bad)).toBeUndefined();
    }
  });

  it("never marks a tier budget as caller-supplied", () => {
    for (const count of [50, 200, 1000, 9000, 30000]) {
      expect(getExploreOutputBudget(count).maxCharsExplicit, String(count)).toBeUndefined();
    }
  });
});

describe("the codegraph_explore schema", () => {
  type SchemaLike = { properties?: Record<string, { type?: string; description?: string }> };
  const schema = (): SchemaLike => {
    const tool = tools.find((t) => t.name === "codegraph_explore");
    expect(tool).toBeTruthy();
    return tool!.inputSchema as SchemaLike;
  };

  it("exposes maxChars beside maxFiles, as a number", () => {
    const props = schema().properties ?? {};
    expect(props.maxFiles?.type).toBe("number");
    expect(props.maxChars?.type).toBe("number");
  });

  it("documents what the budget measures, so an agent reads it as an answer cap", () => {
    const description = schema().properties?.maxChars?.description ?? "";
    expect(description).toContain("characters");
    expect(description).toContain("maxFiles counts FILES");
  });
});

describe("codegraph_explore with maxChars, end to end", () => {
  let project: Project;
  let baseline: string;
  let baselineChars: number;

  beforeAll(async () => {
    project = await buildProject("codegraph-maxchars-", {
      [ALLOCATOR]: ALLOCATOR_SOURCE,
      "src/util/budget-math.ts": `
export function clampOutputBudget(value: number): number {
  if (value < 0) return 0;
  return Math.floor(value);
}
`,
    });
    const result = await project.handler.execute("codegraph_explore", { query: QUERY });
    baseline = result.content?.[0]?.text ?? "";
    baselineChars = baseline.length;
  });

  afterAll(() => {
    project.cg.destroy();
    if (fs.existsSync(project.dir)) fs.rmSync(project.dir, { recursive: true, force: true });
  });

  const exploreChars = async (args: Record<string, unknown>): Promise<string> => {
    const result = await project.handler.execute("codegraph_explore", { query: QUERY, ...args });
    expect(result.isError).not.toBe(true);
    return result.content?.[0]?.text ?? "";
  };

  it("answers the query without a budget, so the fixture is worth measuring", () => {
    expect(baseline).toContain(ALLOCATOR);
    expect(baselineChars).toBeGreaterThan(EXPLORE_MAX_CHARS_MIN);
  });

  it("keeps the answer inside maxChars, which maxFiles alone never did", async () => {
    for (const maxChars of [4000, 6000, 8000]) {
      const text = await exploreChars({ maxChars });
      expect(text.length, `maxChars ${maxChars} -> ${text.length}`)
        .toBeLessThanOrEqual(maxChars + CUT_NOTE_TOLERANCE);
    }
  });

  it("shrinks monotonically as the budget tightens", async () => {
    const wide = await exploreChars({ maxChars: 12000 });
    const middle = await exploreChars({ maxChars: 6000 });
    const tight = await exploreChars({ maxChars: 4000 });
    expect(middle.length).toBeLessThanOrEqual(wide.length);
    expect(tight.length).toBeLessThanOrEqual(middle.length);
  });

  it("still cuts a much larger answer down when maxFiles is generous", async () => {
    // The reporter shape: maxFiles is the only size knob, so a generous one asks
    // for far more text than the default budget allows. maxChars has to bind here.
    const unbounded = await exploreChars({ maxFiles: 20 });
    const bounded = await exploreChars({ maxFiles: 20, maxChars: 4000 });
    expect(bounded.length).toBeLessThanOrEqual(4000 + CUT_NOTE_TOLERANCE);
    expect(bounded.length).toBeLessThan(unbounded.length);
  });

  it("leaves the answer shape alone when maxChars cannot be used", async () => {
    const text = await exploreChars({ maxChars: "4000" });
    expect(text.length).toBe(baselineChars);
  });

  it("does not shrink an answer that already fits the budget", async () => {
    const text = await exploreChars({ maxChars: EXPLORE_MAX_CHARS_MAX });
    expect(text.length).toBe(baselineChars);
  });
});
