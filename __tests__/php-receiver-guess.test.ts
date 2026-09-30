/**
 * A PHP call through a receiver nothing typed takes the one project method of
 * that name only when the receiver is named after its class — or after a
 * class that inherits it (`$page->save()` → Page extends Entity). Guzzle's
 * tests' PSR-7 `$response->getHeaderLine()` went to a test double's method,
 * symfony/console's `$e->getMessage()` to a progress bar's.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

let root = '';
let cg: CodeGraph;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-receiver-'));
  const files: Record<string, string> = {
    'src/Models/Entity.php': `<?php
namespace App\\Models;

abstract class Entity
{
    public function save(): bool { return true; }
}
`,
    'src/Models/Page.php': `<?php
namespace App\\Models;

class Page extends Entity
{
}
`,
    'src/Helper/ProgressBar.php': `<?php
namespace App\\Helper;

class ProgressBar
{
    public function getMessage(): string { return ''; }
}
`,
    'src/Uploads/UserAvatars.php': `<?php
namespace App\\Uploads;

class UserAvatars
{
    public function assignToUser($user): void {}
}
`,
    'src/Controller.php': `<?php
namespace App;

function handle($page, $avatars, $user)
{
    try {
        $page->save();
        $avatars->assignToUser($user);
    } catch (\\Exception $e) {
        return $e->getMessage();
    }
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

describe('PHP calls through an untyped receiver', () => {
  it('keep a receiver named after the class or one that inherits the method; drop the rest', () => {
    const ids = cg.getNodesInFile('src/Controller.php').map((n) => n.id);
    const targets = cg
      .getOutgoingEdgesFrom(ids)
      .filter((e) => e.kind === 'calls')
      .map((e) => cg.getNode(e.target)!.qualifiedName)
      .sort();
    expect(targets).toContain('App\\Models::Entity::save');
    expect(targets).toContain('App\\Uploads::UserAvatars::assignToUser');
    expect(targets).not.toContain('App\\Helper::ProgressBar::getMessage');
  });
});
