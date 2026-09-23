'use strict';
// Audited validation adapter, grounded in extension-sync.test.ts's bindings pass.
// No ambient I/O inside evaluate(). This is NOT a public v1 purity declaration.
function evaluate(view, options) {
  // Enumerate registrations even when absent; predicate membership is observable.
  const registrations = view.getAllFiles().filter(f => f.endsWith('.events.yaml'));
  let target = options.target;
  if (!target) {
    const exists = view.fileExists('binding.txt');
    target = exists ? (view.readFile('binding.txt') || '').trim() : '';
    if (!target && registrations.length === 1) target = (view.readFile(registrations[0]) || '').trim();
  }
  // Fixed validation probes; arbitrary method names cannot be passed as options.
  if (options.probe === 'aliases') view.getProjectAliases();
  if (options.probe === 'caught') { try { view.unknownReviewOperation(); } catch { /* test sticky taint */ } }
  if (target === 'FAIL') throw new Error('audited binding failed');
  if (!target) return [];
  const from = view.getNodesByName('dispatch').filter(n => n.kind === 'function' && n.language === 'python');
  const targets = view.getNodesByName(target).filter(n => n.kind === 'function' && n.language === 'python');
  if (from.length !== 1 || (!options.first && targets.length !== 1) || !targets.length) return [];
  return [{ source: from[0].id, target: targets[0].id, kind: 'calls', line: 1,
    metadata: { label: 'Audited binding', targetSignature: targets[0].signature || '' } }];
}
exports.evaluate = evaluate;
exports.factory = ({ projectRoot, options }) => ({ synthPasses: [{ name: 'binding', languages: ['python'],
  run: ctx => require('./recorder.cjs').invoke(projectRoot, ctx, options) }] });
