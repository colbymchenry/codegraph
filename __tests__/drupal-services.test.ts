/**
 * Drupal's dependency injection, plugin definitions and OOP hooks: what Drupal
 * wires by id, attribute and folder rather than by a call the parser can see.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CodeGraph } from '../src';
import { drupalResolver } from '../src/resolution/frameworks/drupal';

const extract = (file: string, source: string) => drupalResolver.extract!(file, source);

describe('a services file', () => {
  const file = 'modules/shop/shop.services.yml';
  const refs = (source: string, service: string): string[] => {
    const { nodes, references } = extract(file, source);
    const node = nodes.find((n) => n.name === `service:${service}`)!;
    return references.filter((r) => r.fromNodeId === node.id).map((r) => r.referenceName);
  };

  it('makes a node per service, named by its id, with its class', () => {
    const { nodes } = extract(file, `services:
  shop.cart:
    class: Drupal\\shop\\Cart
  shop.quoted:
    class: '\\Drupal\\shop\\Quoted'
`);
    expect(nodes.map((n) => [n.kind, n.name, n.qualifiedName, n.signature, n.startLine])).toEqual([
      ['component', 'service:shop.cart', `${file}::service:shop.cart`, 'Drupal\\shop\\Cart', 2],
      ['component', 'service:shop.quoted', `${file}::service:shop.quoted`, 'Drupal\\shop\\Quoted', 4],
    ]);
  });

  it('links the class and every service a definition is given, wherever it is given', () => {
    expect(refs(`services:
  shop.cart:
    class: Drupal\\shop\\Cart
    parent: shop.base
    decorates: shop.old_cart
    arguments: ['@database', '@?logger.channel.shop', '%shop.setting%', '@@literal']
    factory: ['@shop.factory', create]
    calls:
      - [setLogger, ['@logger.factory']]
    tags:
      - { name: event_subscriber }
`, 'shop.cart')).toEqual([
      'drupal:fqcn:Drupal\\shop\\:Cart',
      'drupal:service:shop.base',
      'drupal:service:shop.old_cart',
      'drupal:service:database',
      'drupal:service:logger.channel.shop',
      'drupal:service:shop.factory',
      'drupal:service:logger.factory',
    ]);
  });

  it('reads a block list of arguments, and leaves a comment out', () => {
    expect(refs(`services:
  shop.cart:
    class: Drupal\\shop\\Cart
    arguments:
      - '@database' # not '@logger.factory'
      # - '@cache.default'
      - "@current_user"
`, 'shop.cart')).toEqual(['drupal:fqcn:Drupal\\shop\\:Cart', 'drupal:service:database', 'drupal:service:current_user']);
  });

  it('reads an alias, in both forms, and a class-named service as its own class', () => {
    const source = `services:
  shop.alias: '@shop.cart'
  shop.long_alias:
    alias: shop.cart
  Drupal\\shop\\Autowired: ~
  Drupal\\shop\\CartInterface: '@shop.cart'
  shop.inline: { class: Drupal\\shop\\Inline, arguments: ['@database'] }
`;
    expect(refs(source, 'shop.alias')).toEqual(['drupal:service:shop.cart']);
    expect(refs(source, 'shop.long_alias')).toEqual(['drupal:service:shop.cart']);
    expect(refs(source, 'Drupal\\shop\\Autowired')).toEqual(['drupal:fqcn:Drupal\\shop\\:Autowired']);
    expect(refs(source, 'Drupal\\shop\\CartInterface')).toEqual(['drupal:service:shop.cart']);
    expect(refs(source, 'shop.inline')).toEqual(['drupal:fqcn:Drupal\\shop\\:Inline', 'drupal:service:database']);
  });

  it('skips what isn\'t a service', () => {
    const { nodes } = extract(file, `parameters:
  shop.setting: true
services:
  _defaults:
    autowire: true
  _instanceof:
    Drupal\\shop\\Thing:
      tags: [thing]
  shop.cart:
    class: Drupal\\shop\\Cart
`);
    expect(nodes.map((n) => n.name)).toEqual(['service:shop.cart']);
    expect(extract(file, '').nodes).toEqual([]);
  });
});

describe('a plugin definition', () => {
  const plugins = (file: string, source: string): [string, string][] =>
    extract(file, source).nodes.map((n) => [n.name, n.qualifiedName.replace(`${file}::`, '')]);

  it('is read from an attribute, multi-line or not, with the id named or first', () => {
    expect(plugins('src/Plugin/Block/A.php', `<?php
namespace Drupal\\shop\\Plugin\\Block;

#[Block(
  admin_label: new TranslatableMarkup("Don't"),
  id: 'shop_a',
)]
class A extends BlockBase {}
`)).toEqual([['Block:shop_a', 'plugin:Block:shop_a']]);
    expect(plugins('src/Plugin/views/field/B.php', '<?php\n#[ViewsField("shop_b")]\nclass B extends FieldPluginBase {}\n')).toEqual([['ViewsField:shop_b', 'plugin:ViewsField:shop_b']]);
    expect(plugins('src/Element/C.php', "<?php\n#[\\Drupal\\Core\\Render\\Attribute\\RenderElement('shop_c')]\nclass C {}\n")).toEqual([['RenderElement:shop_c', 'plugin:RenderElement:shop_c']]);
  });

  it('is read from a docblock, with the id after a nested annotation', () => {
    expect(plugins('src/Plugin/Block/D.php', `<?php
/**
 * The block.
 *
 * @Block(
 *   admin_label = @Translation("D (legacy)"),
 *   id = "shop_d",
 * )
 */
class D extends BlockBase {}
`)).toEqual([['Block:shop_d', 'plugin:Block:shop_d']]);
  });

  it('is read from a docblock with the id first', () => {
    expect(plugins('src/Element/E.php', '<?php\n/**\n * @FormElement("shop_e")\n */\nclass E {}\n')).toEqual([['FormElement:shop_e', 'plugin:FormElement:shop_e']]);
  });

  it('takes a contrib module\'s own type, by the folder it sits in', () => {
    expect(plugins('modules/log/src/Plugin/Log/LogType/Harvest.php', "<?php\n#[LogType(id: 'harvest', label: new TranslatableMarkup('Harvest'))]\nfinal class Harvest extends FarmLogType {}\n"))
      .toEqual([['LogType:harvest', 'plugin:LogType:harvest']]);
    expect(plugins('src/Entity/Order.php', "<?php\n#[ContentEntityType(id: 'shop_order')]\nclass Order extends ContentEntityBase {}\n"))
      .toEqual([['ContentEntityType:shop_order', 'plugin:ContentEntityType:shop_order']]);
  });

  it('links the node to the class it marks, in that file', () => {
    const { nodes, references } = extract('src/Plugin/Block/A.php', "<?php\n#[Block(id: 'a')]\nclass A {}\n");
    expect(references).toEqual([expect.objectContaining({
      fromNodeId: nodes[0]!.id,
      referenceName: 'drupal:class:src/Plugin/Block/A.php#A',
      referenceKind: 'references',
    })]);
  });

  it('is not an attribute outside those folders, a test\'s, or one with nothing to go by', () => {
    expect(plugins('src/Service/A.php', "<?php\n#[Block(id: 'a')]\nclass A {}\n")).toEqual([]);
    expect(plugins('tests/src/Plugin/ATest.php', "<?php\n#[Group('shop')]\nclass ATest extends TestCase {}\n")).toEqual([]);
    expect(plugins('src/Plugin/Base.php', '<?php\n#[\\AllowDynamicProperties]\nclass Base {}\n')).toEqual([]);
    expect(plugins('src/Plugin/Marker.php', "<?php\n#[\\Attribute(\\Attribute::TARGET_CLASS)]\nclass Marker {}\n")).toEqual([]);
    expect(plugins('src/Plugin/Old.php', "<?php\n#[Deprecated('use New')]\nclass Old {}\n")).toEqual([]);
    expect(plugins('src/Plugin/Doc.php', '<?php\n/**\n * @see Foo(id = "x")\n * @param string $x\n */\nclass Doc {}\n')).toEqual([]);
  });
});

describe('a #[Hook] attribute', () => {
  const hooks = (source: string): string[] =>
    extract('src/Hook/ShopHooks.php', source).references.map((r) => `${r.referenceName}@${r.line}`);

  it('links the method it marks, from the line the attribute starts on, where the method\'s node starts', () => {
    expect(hooks(`<?php
class ShopHooks {
  /**
   * Implements hook_cron().
   */
  #[Hook('cron')]
  public function cron(): void {}
}
`)).toEqual(['hook_cron@6']);
  });

  it('reads stacked attributes, and others among them', () => {
    expect(hooks(`<?php
class ShopHooks {
  #[Hook('node_insert')]
  #[Hook('node_update', order: new OrderBefore(['entity']))]
  #[LegacyHook]
  public function save(): void {}
}
`)).toEqual(['hook_node_insert@3', 'hook_node_update@3']);
  });

  it('reads one on a class: the method it names, or __invoke', () => {
    expect(hooks(`<?php
#[Hook('form_alter', method: 'alter')]
#[Hook('cron')]
class ShopHooks {
  public function alter(): void {}
  public function __invoke(): void {}
}
`)).toEqual(['hook_form_alter@5', 'hook_cron@6']);
  });

  it('skips one in a comment, and one with no method after it', () => {
    expect(hooks(`<?php
class ShopHooks {
  // #[Hook('old')]
  /* #[Hook('older')] */
  public function kept(): void {}
}
`)).toEqual([]);
    expect(hooks("<?php\nclass ShopHooks {\n  #[Hook('alone')]\n}\n")).toEqual([]);
  });
});

describe('a Drupal module, indexed', () => {
  let dir: string;
  let cg: CodeGraph;

  const write = (rel: string, content: string): void => {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };
  const outgoing = (name: string, kind: string): string[] => {
    const node = cg.getNodesByName(name).find((n) => n.kind === kind);
    if (!node) throw new Error(`no ${kind} ${name}`);
    return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.name).sort();
  };

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-services-'));
    write('composer.json', JSON.stringify({ name: 'drupal/shop', type: 'drupal-module' }));
    write('shop.info.yml', 'name: Shop\ntype: module\n');
    write('shop.services.yml', `services:
  shop.cart:
    class: Drupal\\shop\\Cart
    arguments: ['@shop.prices', '@database']
  shop.prices:
    class: Drupal\\shop\\Prices
  shop.subscriber:
    class: Drupal\\shop\\EventSubscriber\\CartSubscriber
    tags:
      - { name: event_subscriber }
  Drupal\\shop\\Autowired: ~
  shop.elsewhere:
    class: Drupal\\elsewhere\\Prices
`);
    write('src/Cart.php', `<?php
namespace Drupal\\shop;
class Cart extends CartBase {
  public function total() { return 1; }
}
`);
    write('src/CartBase.php', '<?php\nnamespace Drupal\\shop;\nclass CartBase {\n  public function clear() {}\n}\n');
    write('src/Prices.php', '<?php\nnamespace Drupal\\shop;\nclass Prices {\n  public function total() { return 2; }\n}\n');
    write('src/Autowired.php', '<?php\nnamespace Drupal\\shop;\nclass Autowired {}\n');
    // A class of the same name in another namespace: the id's namespace decides.
    write('src/Other/Prices.php', '<?php\nnamespace Drupal\\shop\\Other;\nclass Prices {}\n');
    write('src/EventSubscriber/CartSubscriber.php', '<?php\nnamespace Drupal\\shop\\EventSubscriber;\nclass CartSubscriber {}\n');
    write('src/Checkout.php', `<?php
namespace Drupal\\shop;
class Checkout {
  public function run($container) {
    \\Drupal::service('shop.cart')->total();
    \\Drupal::service('shop.cart')->clear();
    $container->get('shop.prices')->total();
    \\Drupal::service('no.such.service')->total();
    \\Drupal::service('shop.cart')->missing();
  }
}
`);
    write('src/Plugin/Block/CartBlock.php', `<?php
namespace Drupal\\shop\\Plugin\\Block;
#[Block(id: 'shop_cart', admin_label: new TranslatableMarkup('Cart'))]
class CartBlock extends BlockBase {
  public function build() { return []; }
}
`);
    write('src/Plugin/Block/OldBlock.php', `<?php
namespace Drupal\\shop\\Plugin\\Block;
/**
 * @Block(id = "shop_old", admin_label = @Translation("Old"))
 */
class OldBlock extends BlockBase {}
`);
    write('src/Hook/ShopHooks.php', `<?php
namespace Drupal\\shop\\Hook;
class ShopHooks {
  /**
   * Implements hook_shop_ready().
   */
  #[Hook('shop_ready')]
  public function ready(): void {}

  #[Hook('form_alter')]
  public function formAlter(): void {}
}
`);
    // A plugin whose id is a class the project uses, and a service whose id is a class.
    write('src/Plugin/Validation/Constraint/CurrencyConstraint.php', "<?php\nnamespace Drupal\\shop\\Plugin\\Validation\\Constraint;\n#[Constraint(id: 'Currency')]\nclass CurrencyConstraint {}\n");
    write('src/Rates.php', `<?php
namespace Drupal\\shop;
use Drupal\\shop\\Autowired;
use Vendor\\Money\\Currency;
class Rates {
  public function make() {
    return new Currency();
  }
}
`);
    write('shop.api.php', '<?php\nfunction hook_shop_ready() {}\n');
    write('shop.module', '<?php\nfunction shop_form_alter() {}\n');
    cg = CodeGraph.initSync(dir);
    await cg.indexAll();
  });

  afterAll(() => {
    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links a service to its class, by namespace, and to the services it is given', () => {
    expect(outgoing('service:shop.cart', 'component')).toEqual(['Cart', 'service:shop.prices']);
    const prices = cg.getNodesByName('service:shop.prices').find((n) => n.kind === 'component')!;
    const target = cg.getOutgoingEdges(prices.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!)[0]!;
    expect(target.filePath).toBe('src/Prices.php');
  });

  it('leaves a service alone whose class isn\'t indexed, whatever shares its short name', () => {
    expect(outgoing('service:shop.elsewhere', 'component')).toEqual([]);
  });

  it('links a class-named service and an event subscriber to their classes', () => {
    expect(outgoing('service:Drupal\\shop\\Autowired', 'component')).toEqual(['Autowired']);
    expect(outgoing('service:shop.subscriber', 'component')).toEqual(['CartSubscriber']);
  });

  it('follows a call through the container to the method on the service\'s class', () => {
    const run = cg.getNodesByName('run').find((n) => n.kind === 'method')!;
    expect(cg.getCallees(run.id).map((c) => c.node.qualifiedName).sort()).toEqual([
      'Drupal\\shop::Cart::total',
      'Drupal\\shop::CartBase::clear',
      'Drupal\\shop::Prices::total',
    ]);
  });

  it('keeps a service or plugin id from answering for the class of that name', () => {
    const rates = cg.getNodesByName('Rates').find((n) => n.kind === 'class')!;
    const make = cg.getNodesByName('make').find((n) => n.kind === 'method')!;
    expect(cg.getOutgoingEdges(make.id).filter((e) => e.kind === 'instantiates')).toEqual([]);
    const imported = cg.getNodesInFile('src/Rates.php').map((n) => n.id)
      .flatMap((id) => cg.getOutgoingEdges(id)).filter((e) => e.kind === 'imports').map((e) => cg.getNode(e.target)!);
    expect(imported.map((n) => n.kind)).not.toContain('component');
    expect(imported.map((n) => n.name)).toContain('Autowired');
    expect(rates).toBeDefined();
  });

  it('finds a service and a plugin by the id written in the project', () => {
    expect(cg.searchNodes('shop.prices').map((r) => r.node.name)).toContain('service:shop.prices');
    expect(cg.searchNodes('shop_cart').map((r) => r.node.name)).toContain('Block:shop_cart');
  });

  it('links a plugin to its class, from an attribute and from an annotation', () => {
    expect(outgoing('Block:shop_cart', 'component')).toEqual(['CartBlock']);
    expect(outgoing('Block:shop_old', 'component')).toEqual(['OldBlock']);
  });

  it('links a #[Hook] method to the hook, when the index defines it', () => {
    expect(outgoing('ready', 'method')).toEqual(['hook_shop_ready']);
  });

  it('does not take another module\'s function for a hook the index doesn\'t define', () => {
    expect(outgoing('formAlter', 'method')).toEqual([]);
  });
});

describe('a sync of a Drupal module', () => {
  it('links a service when its class arrives', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-sync-'));
    const write = (rel: string, content: string): void => {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    };
    write('composer.json', JSON.stringify({ name: 'drupal/shop', type: 'drupal-module' }));
    write('shop.services.yml', 'services:\n  shop.cart:\n    class: Drupal\\shop\\Cart\n');
    const cg = CodeGraph.initSync(dir);
    await cg.indexAll();
    const service = (): string[] => {
      const node = cg.getNodesByName('service:shop.cart').find((n) => n.kind === 'component')!;
      return cg.getOutgoingEdges(node.id).filter((e) => e.kind === 'references').map((e) => cg.getNode(e.target)!.name);
    };
    expect(service()).toEqual([]);

    write('src/Cart.php', '<?php\nnamespace Drupal\\shop;\nclass Cart {}\n');
    await cg.sync();
    expect(service()).toEqual(['Cart']);

    cg.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
