/**
 * An unqualified PHP class name is the current namespace's class or the one
 * a `use` imports — PHP never falls back to another namespace for classes.
 * koel's `extends Request` (in `App\Http\Requests\API`, under `use
 * App\Http\Requests\API\Request;`, or under `use Saloon\Http\Request;`) all
 * went to the first `Request` indexed, and BookStack's controllers'
 * `Request $request` (`use Illuminate\Http\Request;`) to its own subclass.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-ns-'));
  const files: Record<string, string> = {
    'app/Http/Requests/API/Interaction/Request.php': `<?php

namespace App\\Http\\Requests\\API\\Interaction;

abstract class Request {}
`,
    'app/Http/Requests/API/Request.php': `<?php

namespace App\\Http\\Requests\\API;

abstract class Request {}
`,
    'app/Http/Requests/API/DeleteSongsRequest.php': `<?php

namespace App\\Http\\Requests\\API;

class DeleteSongsRequest extends Request {}
`,
    'app/Http/Requests/API/Playlist/PlaylistSongUpdateRequest.php': `<?php

namespace App\\Http\\Requests\\API\\Playlist;

use App\\Http\\Requests\\API\\Request;

class PlaylistSongUpdateRequest extends Request {}
`,
    'app/Http/Integrations/SearchRequest.php': `<?php

namespace App\\Http\\Integrations;

use Saloon\\Http\\Request;

class SearchRequest extends Request {}
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

const supertypesOf = (file: string) => {
  const ids = cg.getNodesInFile(file).map((n) => n.id);
  return cg.getOutgoingEdgesFrom(ids).filter((e) => e.kind === 'extends').map((e) => cg.getNode(e.target)!.qualifiedName);
};

describe('bare PHP class names', () => {
  it('are the namespace’s own class', () => {
    expect(supertypesOf('app/Http/Requests/API/DeleteSongsRequest.php')).toEqual(['App\\Http\\Requests\\API::Request']);
  });

  it('or the one a use imports', () => {
    expect(supertypesOf('app/Http/Requests/API/Playlist/PlaylistSongUpdateRequest.php')).toEqual(['App\\Http\\Requests\\API::Request']);
  });

  it('and nothing in the project when the import is a library’s', () => {
    expect(supertypesOf('app/Http/Integrations/SearchRequest.php')).toEqual([]);
  });
});
