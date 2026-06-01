/**
 * Unit tests for src/extraction/odoo-extractor.ts
 * Covers: menuitem attrs, label for, field text content, filter nodes,
 * field groups attr, embedded Python, act_window, function tag, xpath refs.
 */

import { describe, it, expect } from 'vitest';
import { OdooExtractor } from '../src/extraction/odoo-extractor';

function extract(source: string, filePath = 'data/test.xml') {
  return new OdooExtractor(filePath, source).extract();
}

function refNames(source: string, filePath = 'data/test.xml'): string[] {
  return extract(source, filePath).unresolvedReferences.map((r) => r.referenceName);
}

function nodeQNames(source: string, filePath = 'data/test.xml'): string[] {
  return extract(source, filePath).nodes.map((n) => n.qualifiedName ?? n.name);
}

// ---------------------------------------------------------------------------
// Spec 2.1 — menuitem attribute refs
// ---------------------------------------------------------------------------

describe('OdooExtractor — menuitem attribute refs (spec 2.1)', () => {
  it('emits action, parent, and groups refs', () => {
    const src = `<odoo>
  <menuitem id="menu_tipo_detraccion"
            action="tipo_detraccion_action"
            parent="account.menu_finance"
            groups="account.group_account_user"/>
</odoo>`;
    const r = refNames(src);
    expect(r).toContain('tipo_detraccion_action');
    expect(r).toContain('account.menu_finance');
    expect(r).toContain('account.group_account_user');
  });

  it('uses parent attribute (not parent_id)', () => {
    const src = `<odoo>
  <menuitem id="menu_test" parent="account.root_menu" parent_id="should.not.emit"/>
</odoo>`;
    const r = refNames(src);
    expect(r).toContain('account.root_menu');
    // parent_id is NOT a recognized refAttr — must not appear
    expect(r).not.toContain('should.not.emit');
  });

  it('menuitem with only action → emits action ref', () => {
    const src = `<odoo>
  <menuitem id="menu_simple" action="my_action"/>
</odoo>`;
    expect(refNames(src)).toContain('my_action');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.2 — <label for="X"> arch field ref
// ---------------------------------------------------------------------------

describe('OdooExtractor — label for field ref (spec 2.2)', () => {
  it('<label for="field_name"/> emits field ref', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_form">
    <field name="arch" type="xml">
      <form>
        <label for="is_detraction"/>
        <field name="is_detraction"/>
      </form>
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('is_detraction');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.4 — <field name="res_model">model.name</field> text content
// ---------------------------------------------------------------------------

describe('OdooExtractor — field text content model ref (spec 2.4)', () => {
  it('<field name="res_model"> text → model ref', () => {
    const src = `<odoo>
  <record model="ir.actions.act_window" id="action_detraccion">
    <field name="res_model">account.detraction</field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('account.detraction');
  });

  it('<field name="model"> text → model ref', () => {
    const src = `<odoo>
  <record model="ir.actions.report" id="report_inv">
    <field name="model">account.move</field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('account.move');
  });

  it('<field name="model_name"> text → model ref', () => {
    const src = `<odoo>
  <record model="ir.sequence" id="seq_detraccion">
    <field name="model_name">account.detraction</field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('account.detraction');
  });

  it('plain text without dots does NOT emit ref', () => {
    const src = `<odoo>
  <record model="ir.actions.act_window" id="action_test">
    <field name="res_model">nodot</field>
  </record>
</odoo>`;
    expect(refNames(src)).not.toContain('nodot');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.5 — <filter> nodes in search arch
// ---------------------------------------------------------------------------

describe('OdooExtractor — filter nodes (spec 2.5)', () => {
  it('<filter name="X"> emits ir.filters::X node', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_search">
    <field name="arch" type="xml">
      <search>
        <filter name="group_by_anexo" string="By Annex"/>
      </search>
    </field>
  </record>
</odoo>`;
    expect(nodeQNames(src).some((n) => n.includes('ir.filters::group_by_anexo'))).toBe(true);
  });

  it('<filter context group_by> emits field ref for the grouped field', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_search">
    <field name="arch" type="xml">
      <search>
        <filter name="by_anexo" context="{'group_by': 'anexo'}"/>
      </search>
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('anexo');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.6 — <field groups="X"/> arch ref
// ---------------------------------------------------------------------------

describe('OdooExtractor — arch field groups attr (spec 2.6)', () => {
  it('<field groups="X"/> emits group ref', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_form">
    <field name="arch" type="xml">
      <form>
        <field name="amount" groups="account.group_account_user"/>
      </form>
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('account.group_account_user');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.7 — embedded Python in <field name="code">
// ---------------------------------------------------------------------------

describe('OdooExtractor — embedded Python in code field (spec 2.7)', () => {
  it('env.ref(...) inside server action code field → xml_id ref', () => {
    const src = `<odoo>
  <record model="ir.actions.server" id="server_action_detraccion">
    <field name="code">
env.ref('l10n_pe.action_template').write({})
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('l10n_pe.action_template');
  });

  it("self.env['model'] inside cron code field → model ref", () => {
    const src = `<odoo>
  <record model="ir.cron" id="cron_detraccion">
    <field name="code">
records = self.env['account.detraction'].search([])
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('account.detraction');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.8 — act_window src_model + report model/file
// ---------------------------------------------------------------------------

describe('OdooExtractor — act_window src_model ref (spec 2.8)', () => {
  it('<act_window src_model="M"/> emits model ref', () => {
    const src = `<odoo>
  <act_window id="action_from_partner"
              src_model="res.partner"
              res_model="account.detraction"/>
</odoo>`;
    expect(refNames(src)).toContain('res.partner');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.9 — <function model="M" name="N">
// ---------------------------------------------------------------------------

describe('OdooExtractor — function tag refs (spec 2.9)', () => {
  it('<function model="M" name="N"> emits model ref and method ref', () => {
    const src = `<odoo>
  <function model="res.partner" name="write">
    <value eval="{}"/>
  </function>
</odoo>`;
    const r = refNames(src);
    expect(r).toContain('res.partner');
    expect(r).toContain('write');
  });
});

// ---------------------------------------------------------------------------
// Spec 2.10 — <xpath expr="//field[@name='X']"> refs
// ---------------------------------------------------------------------------

describe('OdooExtractor — xpath attr refs (spec 2.10)', () => {
  it('//field[@name=\'X\'] in xpath expr → field ref', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_inherit">
    <field name="arch" type="xml">
      <xpath expr="//field[@name='partner_id']" position="after">
        <field name="is_detraction"/>
      </xpath>
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('partner_id');
  });

  it('//button[@name=\'X\'] in xpath expr → method ref', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_inherit">
    <field name="arch" type="xml">
      <xpath expr="//button[@name='action_post']" position="before">
        <button name="action_draft"/>
      </xpath>
    </field>
  </record>
</odoo>`;
    expect(refNames(src)).toContain('action_post');
  });

  it('[@id=\'X\'] in xpath expr does NOT emit ref', () => {
    const src = `<odoo>
  <record model="ir.ui.view" id="view_inherit">
    <field name="arch" type="xml">
      <xpath expr="//group[@id='group_partner']" position="inside">
        <field name="name"/>
      </xpath>
    </field>
  </record>
</odoo>`;
    // @id patterns must not emit refs (spec 2.10)
    expect(refNames(src)).not.toContain('group_partner');
  });
});
