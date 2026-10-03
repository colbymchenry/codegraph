#!/usr/bin/env python3
"""Compiler-backed, bounded pyslang export; no textual macro-position recovery.

macroExpansion contains a set of provenance frames reached through BOTH original
and expansion parent relations. It is not an ordered invocation stack. Points
are physical UTF-8 byte positions in root-confined source files. A pasted token's
spelling point can identify its prefix argument; it is never a name range.
Expression origins describe only macro tokens in the selected direct syntax,
not transitive value/type dependencies. 'checked' plus truncated=true is a
bounded partial scan; command-line initializers remain separate from defaults.
"""
import hashlib
import json
from pathlib import Path
import shlex
import sys

MAX_FACTS = 100_000
MAX_DEPTH = 128
MAX_BYTES = 64 * 1024 * 1024
MAX_DIAGNOSTICS = 256 * 1024
MAX_EXPRESSION_ORIGINS = 32
MAX_PROVENANCE_FRAMES = 100_000
MAX_SYNTAX_VISITS = 1_000_000


def native_version(pyslang):
    if pyslang.__version__ != '11.0.0':
        raise RuntimeError('This exporter requires explicitly installed pyslang 11.0.0')
    native = Path(pyslang.pyslang.__file__).resolve(strict=True)
    with native.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    return f'codegraph pyslang 11.0.0 exporter 1 native {digest}'


class Exporter:
    def __init__(self, manager, root):
        self.manager = manager
        self.root = root.resolve(strict=True)
        self.sources = {}
        self.source_bytes = 0
        self.origins = {}
        self.facts = []
        self.identities = set()
        self.visits = 0
        self.output_bytes = 0
        self.syntax_cache = {}
        self.syntax_visits = 0
        self.provenance_frames = 0

    def point(self, location):
        try:
            if not location.buffer.id or not self.manager.isFileLoc(location):
                return None
            file = Path(self.manager.getFullPath(location.buffer)).resolve(strict=True)
            relative = file.relative_to(self.root).as_posix()
            if file not in self.sources:
                if not file.is_file() or file.stat().st_size > 8 * 1024 * 1024:
                    return None
                data = file.read_bytes()
                self.source_bytes += len(data)
                if self.source_bytes > MAX_BYTES:
                    raise RuntimeError('Source mapping byte limit exceeded')
                self.sources[file] = data
            data = self.sources[file]
            offset = location.offset
            if offset < 0 or offset > len(data):
                return None
            # Do not use logical `line remappings or display/Unicode columns.
            line = data.count(b'\n', 0, offset) + 1
            column = offset - data.rfind(b'\n', 0, offset)
            return {'file': relative, 'line': line, 'column': column, 'byteOffset': offset}
        except (OSError, ValueError):
            return None

    def provenance(self, location):
        key = (location.buffer.id, location.offset)
        if key in self.origins:
            return self.origins[key]
        sm = self.manager
        macro = bool(location.buffer.id and sm.isMacroLoc(location))
        result = {'sourceOrigin': 'macro' if macro else 'direct'}
        source = self.point(sm.getFullyOriginalLoc(location)) if location.buffer.id else None
        if source is None and location.buffer.id:
            source = self.point(sm.getFullyExpandedLoc(location))
        if source:
            result['source'] = {k: source[k] for k in ['file', 'line', 'column']}
        if macro:
            pending, visited, frames = [location], set(), []
            complete = True
            while pending:
                current = pending.pop()
                current_key = (current.buffer.id, current.offset)
                if current_key in visited or not sm.isMacroLoc(current):
                    continue
                if len(visited) >= MAX_DEPTH:
                    complete = False
                    break
                visited.add(current_key)
                original = sm.getOriginalLoc(current)
                expanded = sm.getExpansionLoc(current)
                expansion = sm.getExpansionRange(current)
                frame = {'name': sm.getMacroName(current) or None, 'argument': sm.isMacroArgLoc(current)}
                spelling = self.point(sm.getFullyOriginalLoc(original))
                if spelling:
                    frame['spelling'] = spelling
                start = self.point(sm.getFullyExpandedLoc(expansion.start))
                end = self.point(sm.getFullyExpandedLoc(expansion.end))
                if start and end and start['file'] == end['file'] and end['byteOffset'] >= start['byteOffset']:
                    frame['invocation'] = {'start': start, 'end': end}
                if not spelling or 'invocation' not in frame or start['byteOffset'] == end['byteOffset']:
                    complete = False
                frames.append(frame)
                # Original links preserve argument provenance; expansion links
                # preserve nested replacement provenance. Neither alone is full.
                for parent in [original, expanded]:
                    if parent.buffer.id and sm.isMacroLoc(parent):
                        pending.append(parent)
            result['macroExpansion'] = frames
            result['macroExpansionComplete'] = complete
        self.origins[key] = result
        return result

    def bounded_origin(self, origin):
        result = dict(origin)
        frames = origin.get('macroExpansion', [])
        remaining = max(0, MAX_PROVENANCE_FRAMES - self.provenance_frames)
        truncated = len(frames) > remaining
        if 'macroExpansion' in origin:
            result['macroExpansion'] = frames[:remaining]
            self.provenance_frames += len(result['macroExpansion'])
            if truncated:
                result['macroExpansionComplete'] = False
        return result, truncated

    @staticmethod
    def syntax_key(syntax):
        if syntax is None:
            return None
        span = syntax.sourceRange
        return (syntax.kind.name, span.start.buffer.id, span.start.offset,
                span.end.buffer.id, span.end.offset)

    def command_line_syntax(self, syntax):
        if syntax is None:
            return False
        location = self.manager.getFullyExpandedLoc(syntax.getFirstToken().location)
        if not location.buffer.id:
            return False
        # Driver's override buffer has an explicit command-line line mapping
        # and an unnamed synthetic path, unlike a physical `line spoof.
        return (self.manager.getFileName(location) == '<command-line>'
                and self.manager.getRawFileName(location.buffer).startswith('<unnamed_buffer')
                and str(self.manager.getFullPath(location.buffer)).startswith('<unnamed_buffer'))

    def scan_macro_tokens(self, syntax, role):
        from pyslang.ast import VisitAction
        from pyslang.parsing import Token
        key = (id(syntax), role)
        cached = self.syntax_cache.get(key)
        if cached is not None:
            return cached[1], cached[2]
        locations, seen = [], set()
        visited, truncated = 0, False

        def visit(item):
            nonlocal visited, truncated
            visited += 1
            self.syntax_visits += 1
            if visited > 20_000 or self.syntax_visits > MAX_SYNTAX_VISITS:
                truncated = True
                return VisitAction.Interrupt
            if isinstance(item, Token) and item.location.buffer.id and self.manager.isMacroLoc(item.location):
                token_key = (item.location.buffer.id, item.location.offset)
                if token_key not in seen:
                    if len(locations) >= MAX_EXPRESSION_ORIGINS:
                        truncated = True
                        return VisitAction.Interrupt
                    seen.add(token_key)
                    locations.append(item.location)
            return VisitAction.Advance

        syntax.visit(visit)
        # Retain the syntax wrapper: a bare Python id could otherwise be reused
        # after collection, yielding origins for an unrelated syntax node.
        self.syntax_cache[key] = (syntax, locations, truncated)
        return locations, truncated

    def expression_origins(self, symbol):
        coverage = {'initializer': 'not-applicable', 'declaredInitializer': 'not-applicable',
                    'type': 'unavailable', 'truncated': False}
        plans = []
        declared_type = getattr(symbol, 'declaredType', None)
        declaration = symbol.syntax
        type_declarations = [declaration] if declaration is not None else []
        if symbol.kind.name == 'Port':
            internal = symbol.internalSymbol
            if declared_type is None:
                declared_type = getattr(internal, 'declaredType', None) if internal else None
            # A non-ANSI PortReference is just the header name. The actual
            # declarator (including unpacked dimensions) belongs to its net/var.
            internal_syntax = getattr(internal, 'syntax', None) if internal else None
            if internal_syntax is not None:
                type_declarations.insert(0, internal_syntax)
        if symbol.kind.name == 'Parameter':
            expression = symbol.initializer
            effective = expression.syntax if expression is not None else None
            if effective is None and expression is not None and declared_type is not None:
                effective = declared_type.initializerSyntax
            clause = getattr(declaration, 'initializer', None) if declaration is not None else None
            default = getattr(clause, 'expr', None) if clause is not None else None
            if effective is None:
                coverage['initializer'] = 'unavailable'
            else:
                coverage['initializer'] = 'command-line' if self.command_line_syntax(effective) else 'checked'
                plans.append(('initializer', effective))
            # isOverridden alone is insufficient: Driver -G overrides currently
            # leave it false, but their effective syntax is a distinct buffer.
            overridden = symbol.isOverridden or (effective is not None and default is not None
                                                 and self.syntax_key(effective) != self.syntax_key(default))
            if overridden and default is not None:
                coverage['declaredInitializer'] = 'checked'
                plans.append(('declared-initializer', default))
        type_syntax = declared_type.typeSyntax if declared_type is not None else None
        dimensions = []
        dimensions_known = symbol.kind.name != 'Port'
        for candidate in type_declarations:
            declared_dimensions = getattr(candidate, 'dimensions', None)
            if declared_dimensions is not None:
                dimensions_known = True
                dimensions.extend(declared_dimensions)
        type_inputs = ([type_syntax] if type_syntax is not None else []) + dimensions
        if type_inputs and dimensions_known:
            coverage['type'] = 'checked'
            seen_types = set()
            for node in type_inputs:
                key = self.syntax_key(node)
                if key not in seen_types:
                    seen_types.add(key)
                    plans.append(('type', node))
        origins, seen, normalized_seen = [], set(), set()
        for role, syntax in plans:
            locations, truncated = self.scan_macro_tokens(syntax, role)
            coverage['truncated'] |= truncated
            for location in locations:
                key = (role, location.buffer.id, location.offset)
                if key in seen:
                    continue
                seen.add(key)
                if len(origins) >= MAX_EXPRESSION_ORIGINS:
                    coverage['truncated'] = True
                    break
                origin, limited = self.bounded_origin(self.provenance(location))
                coverage['truncated'] |= limited
                entry = {'role': role, **origin}
                normalized = json.dumps(entry, sort_keys=True, ensure_ascii=False, separators=(',', ':'))
                if normalized in normalized_seen:
                    continue
                normalized_seen.add(normalized)
                origins.append(entry)
        return {'expressionOrigins': origins, 'expressionOriginCoverage': coverage}

    @staticmethod
    def segment(name):
        import re
        if not name or len(name) > 4096:
            raise RuntimeError('Unsupported empty/oversized hierarchy name')
        return name if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_$]*', name) else '\\' + name + ' '

    def append(self, symbol, instance_path):
        kind = symbol.kind.name
        semantic_type = symbol.canonicalType if kind == 'TypeAlias' else symbol.type
        origin, _ = self.bounded_origin(self.provenance(symbol.location))
        fact = {'kind': {'Parameter': 'parameter', 'Port': 'port', 'TypeAlias': 'type'}[kind],
                'name': symbol.name, 'instancePath': instance_path,
                'type': str(semantic_type), **origin, **self.expression_origins(symbol)}
        if semantic_type.isIntegral:
            width = semantic_type.bitWidth
            if 0 < width <= 2**53 - 1:
                fact['width'] = width
        if kind == 'Parameter':
            value = symbol.value
            if bool(value) and not value.isContainer():
                fact['value'] = str(value)  # Preserve SV width/base and X/Z text.
        elif kind == 'Port':
            fact['direction'] = symbol.direction.name
        identity = (fact['kind'], instance_path, symbol.name)
        if identity in self.identities:
            raise RuntimeError('Duplicate semantic fact identity')
        self.identities.add(identity)
        self.output_bytes += len(json.dumps(fact, ensure_ascii=False).encode('utf8'))
        if len(self.facts) >= MAX_FACTS or self.output_bytes > MAX_BYTES:
            raise RuntimeError('Semantic fact output limit exceeded')
        self.facts.append(fact)

    def scope(self, scope, instance_path, depth=0, active=None):
        if depth > MAX_DEPTH or len(instance_path) > 16384:
            raise RuntimeError('Semantic hierarchy depth/path limit exceeded')
        active = set() if active is None else active
        key = id(scope)
        if key in active:
            raise RuntimeError('Cyclic instance hierarchy')
        active = active | {key}
        for symbol in scope:
            self.visits += 1
            if self.visits > 1_000_000:
                raise RuntimeError('Semantic traversal size limit exceeded')
            kind = symbol.kind.name
            if kind in ['Parameter', 'Port', 'TypeAlias']:
                self.append(symbol, instance_path)
            elif kind == 'Instance':
                self.scope(symbol.body, instance_path + '.' + self.segment(symbol.name), depth + 1, active)
            elif kind == 'GenerateBlock':
                if not symbol.isUninstantiated:
                    self.scope(symbol, instance_path + '.' + self.segment(symbol.externalName), depth + 1, active)
            elif kind == 'GenerateBlockArray':
                name = instance_path + '.' + self.segment(symbol.externalName)
                for block in symbol.entries:
                    if block.isUninstantiated:
                        continue
                    index = block.arrayIndex
                    if index is None or index.hasUnknown:
                        raise RuntimeError('Unknown generate iteration index')
                    self.scope(block, name + '[' + str(int(index)) + ']', depth + 1, active)
            elif kind == 'InstanceArray':
                self.array(symbol, instance_path + '.' + self.segment(symbol.name), depth + 1, active)

    def array(self, array, array_path, depth, active):
        if depth > MAX_DEPTH:
            raise RuntimeError('Instance array depth limit exceeded')
        for entry in array.elements:
            if entry.kind.name == 'InstanceArray':
                self.array(entry, array_path, depth + 1, active)
            elif entry.kind.name == 'Instance':
                indices = ''.join('[' + str(index) + ']' for index in entry.arrayPath)
                self.scope(entry.body, array_path + indices, depth + 1, active)
            else:
                raise RuntimeError('Unsupported instance array member')


def main(argv):
    import pyslang
    from pyslang.driver import Driver, CommandLineOptions
    version = native_version(pyslang)
    if argv == ['--version']:
        print(version)
        return 0
    output = None
    compiler_argv = []
    index = 0
    while index < len(argv):
        arg = argv[index]
        if arg == '--':
            compiler_argv.extend(argv[index:])
            break
        if arg == '--ast-json':
            if index + 1 >= len(argv) or output is not None:
                raise RuntimeError('Expected one --ast-json output path')
            output = Path(argv[index + 1])
            index += 2
            continue
        if arg.startswith('--ast-json='):
            if output is not None:
                raise RuntimeError('Expected one --ast-json output path')
            output = Path(arg.split('=', 1)[1])
        elif arg not in ['--ast-json-source-info', '--ast-json-detailed-types']:
            compiler_argv.append(arg)
        index += 1
    if output is None or str(output) == '-':
        raise RuntimeError('A file --ast-json output path is required')
    driver = Driver()
    driver.addStandardArgs()
    options = CommandLineOptions()
    options.ignoreProgramName = True
    options.expandEnvVars = False
    # Binding accepts one command-line string; shlex.join quotes every original
    # argv atom. No shell is invoked, no environment interpolation is enabled.
    if not driver.parseCommandLine(shlex.join(compiler_argv), options) or not driver.processOptions() or not driver.parseAllSources():
        driver.reportDiagnostics(True)
        return 1
    compilation = driver.createCompilation()
    driver.reportCompilation(compilation, True)
    analysis = driver.runAnalysis(compilation)  # Keep native analysis alive through export.
    diagnostics = driver.textDiagClient.getString()
    if diagnostics:
        sys.stderr.write(diagnostics[:MAX_DIAGNOSTICS])
        if len(diagnostics) > MAX_DIAGNOSTICS:
            sys.stderr.write('\nAdditional compiler diagnostics truncated.\n')
    if driver.diagEngine.numErrors or compilation.hasFatalErrors or compilation.hasIssuedErrors:
        return 1
    exporter = Exporter(driver.sourceManager, Path.cwd())
    for instance in compilation.getRoot().topInstances:
        exporter.scope(instance.body, exporter.segment(instance.name))
    payload = {'codegraphSemanticVersion': 1, 'facts': exporter.facts}
    encoded = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf8')
    if len(encoded) > MAX_BYTES:
        raise RuntimeError('Semantic JSON size limit exceeded')
    output.write_bytes(encoded)
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv[1:]))
    except (Exception, ImportError) as error:
        print('CodeGraph pyslang exporter: ' + str(error), file=sys.stderr)
        sys.exit(2)
