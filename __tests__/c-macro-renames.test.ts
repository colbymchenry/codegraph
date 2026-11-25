/**
 * An object-like macro can rename a type. hiredis's sdscompat.h has `#define
 * sds hisds`, so an `sds` member in redis-cli.c, which includes it, is a
 * `hisds`, and src/sds.h's namesake typedef is one that file never compiles.
 * The parser sees `sds`, and macros with no parameters get no node, so a
 * member's type went to whatever else bears the name.
 *
 * The rename counts as the preprocessor applies it: from where a translation
 * unit has certainly defined the macro. Not above the `#include` or the
 * `#define`, not under a flag no file sets, and not when the new name is no
 * type of the project.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import CodeGraph from '../src/index';

describe('a C or C++ type a macro renames', () => {
  let root = '';
  let cg: CodeGraph | undefined;

  afterEach(() => {
    cg?.destroy();
    cg = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = '';
  });

  /** Index `files` and return what a type references, as `kind name @file`. */
  async function index(files: Record<string, string>): Promise<(holder: string) => string[]> {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-c-renames-'));
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const graph = (cg = await CodeGraph.init(root, { index: true }));
    return (holder) => {
      const node = graph.getNodesByName(holder).find((n) => n.kind === 'struct' || n.kind === 'type_alias' || n.kind === 'class');
      expect(node, holder).toBeDefined();
      return graph
        .getOutgoingEdges(node!.id)
        .filter((e) => e.kind === 'references')
        .map((e) => graph.getNode(e.target)!)
        .map((n) => `${n.kind} ${n.name} @${n.filePath}`)
        .sort();
    };
  }

  const library = {
    'deps/lib/str.h': 'typedef char *histr;\n',
    'deps/lib/compat.h': [
      '#ifndef COMPAT_H',
      '#define COMPAT_H',
      '#define str histr /* the library\'s */',
      '#endif',
      '',
    ].join('\n'),
    'src/str.h': 'typedef char *str;\n',
  };
  const HISTR = 'type_alias histr @deps/lib/str.h';
  const STR = 'type_alias str @src/str.h';

  it('links what the macro names, in a file that includes it', async () => {
    const referenced = await index({
      ...library,
      'src/client.c': [
        '#include <compat.h>',
        '#include <str.h>',
        'struct client {',
        '    str name;',
        '    str *names;',
        '};',
        'typedef str client_name;',
        '',
      ].join('\n'),
      'src/server.c': '#include "str.h"\nstruct server { str name; };\n',
    });
    expect(referenced('client')).toEqual([HISTR, HISTR]);
    expect(referenced('client_name')).toEqual([HISTR]);
    expect(referenced('server')).toEqual([STR]);
  });

  it('reaches through an include, and holds for C++', async () => {
    const referenced = await index({
      ...library,
      'src/indirect.h': '#include <compat.h>\n',
      'src/third.c': '#include "indirect.h"\nstruct third { str name; };\n',
      'src/fourth.cpp': '#include "indirect.h"\nclass fourth { str name; };\n',
    });
    expect(referenced('third')).toEqual([HISTR]);
    expect(referenced('fourth')).toEqual([HISTR]);
  });

  it('a file can rename a type for itself, from its `#define` on', async () => {
    const referenced = await index({
      ...library,
      'src/own.c': [
        '#include "str.h"',
        'struct before { str name; };',
        '#define str histr',
        'struct after { str name; };',
        '',
      ].join('\n'),
    });
    expect(referenced('before')).toEqual([STR]);
    expect(referenced('after')).toEqual([HISTR]);
  });

  it('starts at the `#include`, as the preprocessor does', async () => {
    const referenced = await index({
      ...library,
      'src/later.c': [
        '#include "str.h"',
        'struct before { str name; };',
        '#include <compat.h>',
        'struct after { str name; };',
        '',
      ].join('\n'),
    });
    expect(referenced('before')).toEqual([STR]);
    expect(referenced('after')).toEqual([HISTR]);
  });

  it('holds only where the flag around it is set', async () => {
    // redis's redismodule.h: `#define RedisModuleString robj` under REDISMODULE_CORE,
    // which server.h sets and a module does not.
    const referenced = await index({
      'src/object.h': 'typedef struct redisObject { int x; } robj;\n',
      'src/redismodule.h': [
        'typedef struct RedisModuleString RedisModuleString;',
        '#if defined REDISMODULE_CORE',
        '#include "object.h"',
        '#define RedisModuleString robj',
        '#endif',
        'struct header_holder { RedisModuleString *s; };',
        '',
      ].join('\n'),
      'src/server.h': '#define REDISMODULE_CORE 1\n#include "redismodule.h"\n',
      'src/core.c': '#include "server.h"\nstruct core_holder { RedisModuleString *s; };\n',
      'modules/module.c': '#include "../src/redismodule.h"\nstruct module_holder { RedisModuleString *s; };\n',
    });
    expect(referenced('core_holder')).toEqual(['struct robj @src/object.h']);
    expect(referenced('module_holder')).toEqual(['type_alias RedisModuleString @src/redismodule.h']);
    expect(referenced('header_holder')).toEqual(['type_alias RedisModuleString @src/redismodule.h']);
  });

  it('leaves the name as written when the macro names no type of the project, or two', async () => {
    const referenced = await index({
      ...library,
      'src/outside.c': '#include "str.h"\n#define str outside_type\nstruct outside { str name; };\n',
      'src/both.h': [
        '#ifdef ONE',
        '#define str histr',
        '#else',
        '#define str histr_other',
        '#endif',
        '',
      ].join('\n'),
      'deps/lib/other.h': 'typedef char *histr_other;\n',
      'src/both.c': '#define ONE\n#include "both.h"\n#include "str.h"\nstruct both { str name; };\n',
    });
    expect(referenced('outside')).toEqual([STR]);
    expect(referenced('both')).toEqual([STR]);
  });

  it('never reads a macro in a block comment', async () => {
    const referenced = await index({
      ...library,
      'src/commented.h': '/*\n#define str histr\n*/\n',
      'src/commented.c': '#include "commented.h"\n#include "str.h"\nstruct commented { str name; };\n',
    });
    expect(referenced('commented')).toEqual([STR]);
  });
});
