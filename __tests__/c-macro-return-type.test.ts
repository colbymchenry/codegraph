/**
 * A C function whose return type is wrapped in a macro — cJSON's
 * `CJSON_PUBLIC(char *) cJSON_Print(const cJSON *item)`, an
 * `EXPORT(int) version(void)` — is a function. The annotation blank took the
 * macro for markup and blanked the return type with it, leaving a declarator
 * that parses as a call: the function had no node and its callers resolved
 * nowhere (#2470). An annotation macro is still blanked: above a declaration
 * that has its own type, or between the type on the line above and the name
 * (jemalloc's `size_t JEMALLOC_NOTHROW\n JEMALLOC_ATTR(pure)\n je_sallocx(…) {`).
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c-macro-return-'));
  const files: Record<string, string> = {
    'lib.c': `#define EXPORT(type) type
#define ATTR_FORMAT(a, b)
#define ATTR(x)

EXPORT(char *) make_name(int id)
{
    return id > 0 ? "named" : "anonymous";
}

EXPORT(int) version(void)
{
    return 3;
}

EXPORT(const char *) describe(int id);

ATTR_FORMAT(1, 2)
void log_line(const char *fmt, ...)
{
}

unsigned long
ATTR(pure)
usable_size(const void *ptr)
{
    return 0;
}

int caller(void)
{
    log_line("%d", version());
    return make_name(1) != 0 && usable_size(0);
}
`,
  };
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), content);
  }
  cg = await CodeGraph.init(root, { index: true });
});

afterAll(() => {
  cg?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('a C function with a macro-wrapped return type', () => {
  it('is indexed as a function, on the line it is defined', () => {
    const functions = cg.getNodesInFile('lib.c').filter((n) => n.kind === 'function').map((n) => `${n.name}@${n.startLine}`);
    expect(functions).toEqual(expect.arrayContaining(['make_name@5', 'version@10', 'log_line@18', 'usable_size@22', 'caller@29']));
  });

  it('is what its callers call', () => {
    const caller = cg.getNodesInFile('lib.c').find((n) => n.name === 'caller')!;
    const callees = cg.getOutgoingEdges(caller.id).filter((e) => e.kind === 'calls').map((e) => cg.getNode(e.target)!.name).sort();
    expect(callees).toEqual(['log_line', 'make_name', 'usable_size', 'version']);
  });
});
