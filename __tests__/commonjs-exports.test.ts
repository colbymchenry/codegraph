/**
 * CommonJS export assignments name the function they hold (#1675).
 *
 * `exports.getItems = async (req, res) => {…}` and `module.exports.x =
 * function () {…}` are how Express controllers are commonly written. The
 * arrow is anonymous only syntactically — the export property is the name
 * every `router.get('/items', getItems)` resolves — so it gets the same
 * treatment `const getItems = () => {}` already has: a function node, exported,
 * with its calls attributed to it rather than to the file.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const refsFrom = (result: ReturnType<typeof extractFromSource>, id: string) =>
  result.unresolvedReferences.filter((r) => r.fromNodeId === id).map((r) => r.referenceName);

describe('CommonJS export assignments', () => {
  it('indexes exports.X / module.exports.X functions as exported function nodes', () => {
    const code = `
const { findItems, removeItem } = require('./db');

exports.getItems = async (req, res) => {
  res.json(await findItems());
};

module.exports.deleteItem = function (req, res) {
  removeItem(req.params.id);
  res.end();
};

exports.plain = 42;
module.exports = { legacy: 1 };
`;
    const result = extractFromSource('src/controller.js', code);
    const fns = result.nodes.filter((n) => n.kind === 'function');
    expect(fns.map((n) => n.name).sort()).toEqual(['deleteItem', 'getItems']);

    const getItems = fns.find((n) => n.name === 'getItems')!;
    const deleteItem = fns.find((n) => n.name === 'deleteItem')!;
    expect(getItems.startLine).toBe(4);
    expect(getItems.isExported).toBe(true);
    expect(deleteItem.isExported).toBe(true);
    expect(getItems.isAsync).toBe(true);

    // The handlers' calls are their own, not the file's.
    expect(refsFrom(result, getItems.id)).toContain('findItems');
    expect(refsFrom(result, deleteItem.id)).toContain('removeItem');
    const file = result.nodes.find((n) => n.kind === 'file')!;
    expect(refsFrom(result, file.id)).not.toContain('findItems');
    expect(refsFrom(result, file.id)).not.toContain('removeItem');

    // A non-function export is not a function, and nothing is left anonymous.
    expect(result.nodes.map((n) => n.name)).not.toContain('<anonymous>');
  });

  it('leaves other member assignments alone', () => {
    const code = `
const handlers = {};
handlers.onSave = () => { persist(); };
app.locals.format = function () { return 1; };
`;
    const result = extractFromSource('src/other.js', code);
    expect(result.nodes.filter((n) => n.kind === 'function')).toEqual([]);
  });
});
