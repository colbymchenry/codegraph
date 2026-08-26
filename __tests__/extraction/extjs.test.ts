import { extjsResolver } from '../../src/resolution/frameworks/extjs';
import { expect, test } from 'vitest';

test('extjs extract: Ext.define + alias + requires + Ext.create + Ext.application', () => {
  const filePath = 'app/view/Main.js';
  const content = `
    Ext.define('MyApp.view.Main', {
      extend: 'Ext.panel.Panel',
      alias: 'widget.mainview',
      requires: ['MyApp.store.Users'],
      items: [
        { xtype: 'grid', title: 'Users' }
      ]
    });

    Ext.create('MyApp.view.Foo');

    Ext.application({
      name: 'MyApp',
      controllers: ['MyApp.controller.Main'],
      views: ['MyApp.view.Main']
    });
  `;

  const { nodes, references } = extjsResolver.extract!(filePath, content);
  // expect a class node for MyApp.view.Main
  const classNode = nodes.find((n) => n.qualifiedName === 'MyApp.view.Main');
  expect(classNode).toBeDefined();

  // expect a component node for widget.mainview
  const comp = nodes.find((n) => n.kind === 'component' && n.name === 'widget.mainview');
  expect(comp).toBeDefined();

  // expects references to MyApp.store.Users and Ext.create target
  const hasRequires = references.some((r) => r.referenceName === 'MyApp.store.Users');
  expect(hasRequires).toBe(true);

  const hasCreateRef = references.some((r) => r.referenceName === 'MyApp.view.Foo');
  expect(hasCreateRef).toBe(true);

  // expect xtype extracted
  const hasXtype = nodes.some((n) => n.kind === 'component' && n.name === 'grid');
  expect(hasXtype).toBe(true);
});
