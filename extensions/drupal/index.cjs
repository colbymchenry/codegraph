// Official reference extension. Uses only the public context and graph shapes.
// YAML is bundled into dist/index.cjs; installation has no npm dependency step.
const YAML = require('yaml');
const pluginId = 'drupal';
const phpFile = file => /\.(php|module|install|theme|inc)$/.test(file);
const simple = name => name.replace(/^\\/, '').split('\\').pop();
const lineAt = (source, offset) => source.slice(0, offset).split('\n').length;
const clean = value => typeof value === 'string' ? value.replace(/^\\/, '') : '';
// Keep offsets stable while distinguishing executable PHP from examples in
// comments/strings. Literal argument text is read from the original source.
function codeMask(source) {
  const chars = source.split('');
  const blank = (from, to) => { for (let n = from; n < to; n++) if (chars[n] !== '\n' && chars[n] !== '\r') chars[n] = ' '; };
  for (let i = 0; i < source.length;) {
    const start = i;
    if (source.startsWith('//', i) || (source[i] === '#' && source[i + 1] !== '[')) {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end;
    } else if (source.startsWith('/*', i)) {
      const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2;
    } else if (['"', "'", '`'].includes(source[i])) {
      const quote = source[i++];
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i++] === quote) break;
      }
      i = Math.min(i, source.length);
    } else if (source.startsWith('<<<', i)) {
      const header = /^<<<[ \t]*(?:['"]([A-Za-z_]\w*)['"]|([A-Za-z_]\w*))[ \t]*\r?\n/.exec(source.slice(i));
      if (!header) { i++; continue; }
      const rest = source.slice(i + header[0].length);
      const end = new RegExp('^[ \\t]*' + (header[1] || header[2]) + '(?=[;\\s]|$)', 'm').exec(rest);
      i = end ? i + header[0].length + end.index + end[0].length : source.length;
    } else { i++; continue; }
    blank(start, i);
  }
  return chars.join('');
}
function yaml(source) {
  const doc = YAML.parseDocument(source, { uniqueKeys: true, maxAliasCount: 50 });
  if (doc.errors.length) return {};
  return doc.toJS({ maxAliasCount: 50 }) || {};
}
function synthetic(file, line, kind, name, key, language) {
  return { id: `plugin:${pluginId}:${file}:${key}`, kind, name, qualifiedName: `${file}::${key}`,
    filePath: file, language, startLine: line, endLine: line, startColumn: 0, endColumn: 0, updatedAt: 0 };
}
function keyLine(source, key) {
  const lines = source.split('\n');
  const i = lines.findIndex(line => line.trim().startsWith(key + ':') || line.trim().startsWith("'" + key + "':"));
  return i < 0 ? 1 : i + 1;
}
function routeNodes(file, source) {
  const routes = yaml(source);
  return Object.entries(routes).flatMap(([id, route]) => {
    if (!route || typeof route !== 'object' || typeof route.path !== 'string' || !route.path) return [];
    const methods = Array.isArray(route.methods) ? ` [${route.methods.join(',')}]` : '';
    return [synthetic(file, keyLine(source, id), 'route', route.path + methods, `route:${id}`, 'yaml')];
  });
}
function serviceNodes(file, source) {
  return Object.entries(yaml(source).services || {}).flatMap(([id, definition]) => {
    if (id.startsWith('_') || (!definition || typeof definition !== 'object')) return [];
    return [synthetic(file, keyLine(source, id), 'variable', `service:${id}`, `service:${id}`, 'yaml')];
  });
}
// Declarations are bounded by the next class. Docblocks/attributes from an
// earlier class never become metadata for a later class.
function pluginDeclarations(file, source) {
  const nodes = [];
  const code = codeMask(source);
  let previous = 0;
  for (const cls of source.matchAll(/\b(?:final\s+|abstract\s+)?class\s+(\w+)/g)) {
    if (code[cls.index] === ' ') continue;
    const prelude = source.slice(previous, cls.index);
    previous = cls.index + cls[0].length;
    const annotation = /@(Block|FieldType|FieldFormatter|FieldWidget|Action|QueueWorker|Condition|Filter|MenuLink|MigrateSource|MigrateProcess|MigrateDestination|Views\w*|SearchPlugin|RenderElement|FormElement)\s*\([\s\S]*?\bid\s*=\s*["']([^"']+)["']/g;
    const attribute = /#\[\s*(?:[\w\\]+\\)?(Block|FieldType|FieldFormatter|FieldWidget|Action|QueueWorker|Condition|Filter|MenuLink|MigrateSource|MigrateProcess|MigrateDestination|Views\w*|SearchPlugin|RenderElement|FormElement)\s*\([\s\S]*?(?:\bid\s*:\s*)?["']([^"']+)["']/g;
    const matches = [...prelude.matchAll(annotation), ...prelude.matchAll(attribute)];
    for (const match of matches) {
      const kind = match[1], id = match[2];
      const node = synthetic(file, lineAt(source, cls.index), 'component', `${kind}:${id}`, `plugin:${kind}:${id}`, 'php');
      node.docstring = `Drupal ${kind} plugin implemented by ${cls[1]}`;
      nodes.push(node);
    }
  }
  return nodes;
}
function detect(ctx) {
  try {
    const c = JSON.parse(ctx.readFile('composer.json') || '{}');
    if (c.name?.startsWith('drupal/') || c.type?.startsWith('drupal-') ||
        Object.keys({ ...c.require, ...c['require-dev'] }).some(n => n.startsWith('drupal/'))) return true;
  } catch { /* file detection below */ }
  return ctx.getAllFiles().some(f => f.endsWith('.info.yml'));
}

module.exports = () => ({
  frameworks: [{ name: 'drupal', languages: ['php', 'yaml'], detect, resolve: () => null,
    extract(file, source) {
      const nodes = file.endsWith('.routing.yml') ? routeNodes(file, source) :
        file.endsWith('.services.yml') ? serviceNodes(file, source) :
        phpFile(file) ? pluginDeclarations(file, source) : [];
      // Whole-graph resolution avoids core name guessing for YAML→PHP edges.
      return { nodes, references: [] };
    }
  }],
  synthPasses: [{ name: 'wiring', languages: ['php'], async run(ctx, yieldToLoop) {
    if (!detect(ctx)) return [];
    const edges = [];
    const files = ctx.getAllFiles().slice().sort();
    const nodesInFile = new Map();
    const sourceCache = new Map();
    const read = f => { if (!sourceCache.has(f)) sourceCache.set(f, ctx.readFile(f) || ''); return sourceCache.get(f); };
    const nodes = f => { if (!nodesInFile.has(f)) nodesInFile.set(f, ctx.getNodesInFile(f)); return nodesInFile.get(f); };
    const classes = new Map();
    const services = new Map();
    const hooks = new Map();
    const subscribers = new Map();
    const pluginClasses = new Map();
    const unique = list => list.length === 1 ? list[0] : null;
    function add(map, name, value) { if (!map.has(name)) map.set(name, []); map.get(name).push(value); }
    function edge(from, to, label, file, line, kind = 'calls') {
      if (!from || !to || from.id === to.id) return;
      edges.push({ source: from.id, target: to.id, kind, line, provenance: 'heuristic',
        metadata: { synthesizedBy: pluginId, label, registeredAt: `${file}:${line}` } });
    }
    function enclosing(file, line) {
      return nodes(file).filter(n => ['function', 'method'].includes(n.kind) && n.startLine <= line && n.endLine >= line)
        .sort((a, b) => (a.endLine-a.startLine)-(b.endLine-b.startLine))[0];
    }
    function fullClass(name, file) {
      if (!name) return '';
      if (name.startsWith('\\')) return clean(name);
      const source = read(file);
      const first = name.split('\\')[0];
      for (const u of source.matchAll(/^\s*use\s+([\w\\]+)(?:\s+as\s+(\w+))?\s*;/gm)) {
        if ((u[2] || simple(u[1])) === first) return clean(u[1]) + name.slice(first.length);
      }
      const ns = /\bnamespace\s+([\w\\]+)\s*[;{]/.exec(source)?.[1];
      return ns ? `${ns}\\${name}` : name;
    }
    function classNode(name, file, absolute = false) {
      return unique(classes.get(absolute ? clean(name) : fullClass(name, file)) || []);
    }
    function method(cls, name) {
      return cls && unique(nodes(cls.filePath).filter(n => n.kind === 'method' && n.name === name && n.startLine >= cls.startLine && n.endLine <= cls.endLine));
    }
    function service(id) {
      const seen = new Set();
      while (id && !seen.has(id)) {
        seen.add(id); const defs = services.get(id) || []; const definition = unique(defs);
        if (!definition) return null;
        if (!definition.alias) return definition;
        id = definition.alias;
      }
      return null;
    }
    function eventName(expression, file) {
      const literal = /^['"]([^'"]+)['"]$/.exec(expression.trim());
      if (literal) return literal[1];
      const constant = /^([\w\\]+)::(\w+)$/.exec(expression.trim());
      if (!constant) return null;
      const name = fullClass(constant[1], file);
      const cls = classNode(name, file, true);
      if (constant[2] === 'class') return name;
      if (cls) {
        const source = read(cls.filePath);
        const value = new RegExp('\\bconst\\s+' + constant[2] + '\\s*=\\s*["\\\']([^"\\\']+)["\\\']').exec(source);
        if (value) return value[1];
      }
      return name + '::' + constant[2];
    }

    for (const file of files.filter(phpFile)) {
      const source = read(file);
      const ns = /\bnamespace\s+([\w\\]+)\s*[;{]/.exec(source)?.[1];
      for (const cls of nodes(file).filter(n => n.kind === 'class')) add(classes, ns ? ns+'\\'+cls.name : cls.name, cls);
      await yieldToLoop();
    }
    for (const file of files.filter(f => f.endsWith('.services.yml'))) {
      const definitions = yaml(read(file)).services || {};
      for (const [id, def] of Object.entries(definitions)) {
        if (id.startsWith('_')) continue;
        if (typeof def === 'string' && def.startsWith('@')) { add(services, id, { alias: def.slice(1) }); continue; }
        if (!def || typeof def !== 'object') continue;
        const cls = typeof def.class === 'string' ? classNode(def.class, file, true) : null;
        add(services, id, { file, def, cls, alias: typeof def.alias === 'string' ? def.alias.replace(/^@/, '') : null,
          node: nodes(file).find(n => n.id === `plugin:drupal:${file}:service:${id}`) });
      }
      await yieldToLoop();
    }
    for (const [id, definitions] of services) {
      if (definitions.length !== 1) continue;
      const def = service(id); if (!def) continue;
      edge(def.node, def.cls, 'Drupal service implementation', def.file, def.node?.startLine || 1, 'references');
      for (const arg of Array.isArray(def.def.arguments) ? def.def.arguments : []) {
        if (typeof arg !== 'string' || !/^@\??[^@]/.test(arg)) continue;
        const dependency = service(arg.replace(/^@\??/, ''));
        edge(def.cls || def.node, dependency?.cls || dependency?.node, 'Drupal service injection', def.file, def.node?.startLine || 1, 'references');
      }
    }
    for (const file of files.filter(f => f.endsWith('.routing.yml'))) {
      for (const [id, route] of Object.entries(yaml(read(file)))) {
        if (!route || typeof route !== 'object') continue;
        const from = nodes(file).find(n => n.id === `plugin:drupal:${file}:route:${id}`);
        for (const key of ['_controller', '_form']) {
          const value = route.defaults?.[key]; if (typeof value !== 'string') continue;
          const [type, member] = value.split(/:{1,2}/);
          const cls = type.includes('\\') ? classNode(type, file, true) : service(type)?.cls;
          const target = member ? method(cls, member) : key === '_form' ? method(cls, 'buildForm') || cls : method(cls, '__invoke') || cls;
          edge(from, target, 'Drupal route handler', file, from?.startLine || 1);
        }
      }
      await yieldToLoop();
    }
    for (const file of files.filter(phpFile)) {
      const source = read(file), lines = source.split('\n');
      for (const n of nodes(file)) {
        if (n.id.startsWith('plugin:drupal:') && n.kind === 'component') {
          const cls = nodes(file).find(c => c.kind === 'class' && c.startLine <= n.startLine && c.endLine >= n.startLine);
          edge(n, cls, 'Drupal plugin implementation', file, n.startLine, 'references');
          const id = n.name.slice(n.name.indexOf(':') + 1); if (cls) add(pluginClasses, id, cls);
        }
        if (!['method', 'function'].includes(n.kind)) continue;
        const priorNodeEnd = Math.max(0, ...nodes(file).filter(p => ['method', 'function'].includes(p.kind) && p.endLine < n.startLine).map(p => p.endLine));
        const prelude = lines.slice(priorNodeEnd, n.startLine).join('\n');
        const hookAttribute = /#\[\s*(?:[\w\\]+\\)?Hook\s*\(\s*['"]([^'"]+)['"]/g;
        for (const h of prelude.matchAll(hookAttribute)) add(hooks, h[1], n);
        if (n.kind === 'function' && /\.(module|install|theme|inc)$/.test(file)) {
          const documented = /Implements\s+hook_(\w+)\s*\(/i.exec(prelude)?.[1];
          if (documented) add(hooks, documented, n);
          else {
            const module = file.split('/').pop().split('.')[0], prefix = module + '_';
            const suffix = n.name.startsWith(prefix) ? n.name.slice(prefix.length) : '';
            if (suffix && ctx.getNodesByName('hook_' + suffix).some(d => d.kind === 'function' && d.filePath.endsWith('.api.php'))) add(hooks, suffix, n);
          }
        }
        if (n.name === 'getSubscribedEvents') {
          const cls = nodes(file).find(c => c.kind === 'class' && n.startLine >= c.startLine && n.endLine <= c.endLine);
          if (!cls || !/EventSubscriberInterface/.test(source.slice(0, source.indexOf('{', source.indexOf('class '+cls.name))))) continue;
          const body = lines.slice(n.startLine - 1, n.endLine).join('\n');
          const registration = /(?:\$events\s*\[([^\]]+)\]\s*(?:\[\])?\s*=|(['"][^'"]+['"]|[\w\\]+::\w+)\s*=>)\s*\[?\s*['"](\w+)['"]/g;
          for (const r of body.matchAll(registration)) {
            const event = eventName(r[1] || r[2], file), handler = method(cls, r[3]);
            if (event && handler) add(subscribers, event, { handler, file, line: n.startLine + lineAt(body, r.index) - 1 });
          }
        }
      }
      await yieldToLoop();
    }
    for (const file of files.filter(phpFile)) {
      const source = read(file);
      const code = codeMask(source);
      const patterns = [
        { re: /(?:->invokeAll|->alter)\s*\(\s*['"]([^'"]+)['"]/g, kind: 'hook' },
        { re: /(?:\\?Drupal::service|\$container->get)\s*\(\s*['"]([^'"]+)['"]/g, kind: 'service' },
        { re: /->createInstance\s*\(\s*['"]([^'"]+)['"]/g, kind: 'plugin' },
        { re: /->dispatch\s*\(\s*[^,\n]+,\s*([^\)\n]+)\)/g, kind: 'event' },
      ];
      for (const { re, kind } of patterns) for (const m of source.matchAll(re)) {
        if (code[m.index] === ' ') continue;
        const line = lineAt(source, m.index), from = enclosing(file, line); if (!from) continue;
        if (kind === 'hook') {
          const hook = m[0].startsWith('->alter') ? m[1] + '_alter' : m[1];
          for (const handler of hooks.get(hook) || []) edge(from, handler, `Drupal hook ${hook}`, file, line);
        } else if (kind === 'service') {
          const target = service(m[1]); edge(from, target?.cls || target?.node, 'Drupal service lookup', file, line, 'references');
        } else if (kind === 'plugin') {
          // Literal id must uniquely identify a declaration across managers.
          edge(from, unique(pluginClasses.get(m[1]) || []), 'Drupal plugin construction', file, line, 'instantiates');
        } else {
          const event = eventName(m[1], file);
          for (const target of subscribers.get(event) || []) edge(from, target.handler, `Drupal event ${event}`, target.file, target.line);
        }
      }
      await yieldToLoop();
    }
    const seen = new Set();
    return edges.filter(e => { const key = `${e.source}:${e.target}:${e.kind}:${e.line}`; if (seen.has(key)) return false; seen.add(key); return true; });
  }}]
});
