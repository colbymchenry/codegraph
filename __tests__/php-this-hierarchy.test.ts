/**
 * `$this->m()`, `self::m()`, `static::m()` and `parent::m()` name a method of
 * the class the call is written in, a class it extends, or a trait any of them
 * uses — never another class's method that shares the name.
 *
 * Drupal core's tests call PHPUnit's `$this->assertEquals()` (a vendor base
 * class), which went to the one in-repo `assertEquals`, a comparator's, 8,832
 * times; `$this->t()` from StringTranslationTrait went to `Views::t`.
 */
import { describe, it, expect, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';

const roots: string[] = [];
afterAll(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});

describe('PHP calls on $this, self and parent', () => {
  it('reach the class hierarchy and its traits, and nothing outside it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-php-this-'));
    roots.push(root);
    const files: Record<string, string> = {
      'core/lib/StringTranslationTrait.php': `<?php
namespace Drupal\\Core\\StringTranslation;
trait StringTranslationTrait {
  protected function t($string) { return $string; }
}
`,
      'core/lib/Views.php': `<?php
namespace Drupal\\views;
class Views {
  public static function t($s) { return $s; }
}
`,
      'core/lib/MarkupComparator.php': `<?php
namespace Drupal\\TestTools\\Comparator;
class MarkupInterfaceComparator {
  public function assertEquals($expected, $actual) {}
}
`,
      'core/lib/FormBase.php': `<?php
namespace Drupal\\Core\\Form;
use Drupal\\Core\\StringTranslation\\StringTranslationTrait;
abstract class FormBase {
  use StringTranslationTrait;
  public function setUp() {}
  protected function helper() {}
}
`,
      'core/modules/my/MyForm.php': `<?php
namespace Drupal\\my\\Form;
use Drupal\\Core\\Form\\FormBase;
class MyForm extends FormBase {
  public function setUp() {
    parent::setUp();
    $this->helper();
    return $this->t('Hi');
  }
}
`,
      'core/tests/NodeTest.php': `<?php
namespace Drupal\\Tests\\node;
use PHPUnit\\Framework\\TestCase;
class NodeTest extends TestCase {
  public function testTitle() {
    $this->assertEquals(1, 1);
  }
}
`,
      // Laravel's own tests extend Orchestra's TestCase, which isn't in the
      // repository but composes the repository's testing traits.
      'src/Testing/InteractsWithTime.php': `<?php
namespace Illuminate\\Foundation\\Testing\\Concerns;
trait InteractsWithTime {
  public function travelTo($date) {}
}
`,
      // Inside a trait, \$this is the class that uses it.
      'src/Validation/ValidatesAttributes.php': `<?php
namespace Illuminate\\Validation\\Concerns;
trait ValidatesAttributes {
  public function validateSame($attribute) { return $this->getValue($attribute); }
}
`,
      'src/Validation/Validator.php': `<?php
namespace Illuminate\\Validation;
use Illuminate\\Validation\\Concerns\\ValidatesAttributes;
class Validator {
  use ValidatesAttributes;
  public function getValue($attribute) { return null; }
}
`,
      // A base class calling what its subclass defines.
      'app/Entity.php': `<?php
namespace BookStack\\Entities;
abstract class Entity {
  public function parentBook() { return $this->book(); }
}
`,
      'app/Page.php': `<?php
namespace BookStack\\Entities;
class Page extends Entity {
  public function book() { return null; }
}
`,
      'tests/QueueTest.php': `<?php
namespace Illuminate\\Tests\\Integration;
use Orchestra\\Testbench\\TestCase;
class QueueTest extends TestCase {
  public function testDelay() {
    $this->travelTo('2000-01-02');
  }
}
`,
    };
    for (const [rel, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), content);
    }
    const cg = await CodeGraph.init(root, { index: true });
    try {
      const callees = (file: string, method: string) => {
        const from = cg.getNodesInFile(file).find((n) => n.kind === 'method' && n.name === method)!;
        return cg
          .getOutgoingEdges(from.id)
          .filter((e) => e.kind === 'calls')
          .map((e) => cg.getNode(e.target)!.qualifiedName)
          .sort();
      };
      expect(callees('core/modules/my/MyForm.php', 'setUp')).toEqual([
        'Drupal\\Core\\Form::FormBase::helper',
        'Drupal\\Core\\Form::FormBase::setUp',
        'Drupal\\Core\\StringTranslation::StringTranslationTrait::t',
      ]);
      // PHPUnit's TestCase is not in the repository, and a comparator's
      // `assertEquals` is no method of it.
      expect(callees('core/tests/NodeTest.php', 'testTitle')).toEqual([]);
      expect(callees('src/Validation/ValidatesAttributes.php', 'validateSame')).toEqual(['Illuminate\\Validation::Validator::getValue']);
      expect(callees('app/Entity.php', 'parentBook')).toEqual(['BookStack\\Entities::Page::book']);
      // Past an ancestor this cannot see, the repository's traits still count.
      expect(callees('tests/QueueTest.php', 'testDelay')).toEqual(['Illuminate\\Foundation\\Testing\\Concerns::InteractsWithTime::travelTo']);
    } finally {
      cg.close();
    }
  });
});
