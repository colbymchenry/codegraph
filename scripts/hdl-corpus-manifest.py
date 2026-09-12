#!/usr/bin/env python3
"""Создать/проверить переносимый manifest HDL-корпусов без копирования исходников.

Пример: generate --corpus-root /data/corpora --origin dual-uart=/repo/uart
--origin card-reader=/repo/reader --output docs/hdl-corpus-manifest.json
Проверка: check --corpus-root /data/corpora --manifest docs/hdl-corpus-manifest.json
Требуется только Python stdlib и локальный Git для доказательства revision.
Ни HDL, ни build recipes не исполняются; check не меняет corpus/index.
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

IDS = ('dual-uart', 'card-reader', 'axi')
EXTENSIONS = {'.v', '.sv', '.vh', '.svh'}
EXCLUDE = {'.git', '.jj', '.codegraph', '.scratch', 'node_modules', 'target'}
BUILD_FILES = ('build.tcl', 'fpga_primer.gprj', 'card_reader.gprj', 'tb/Makefile',
               'sim/Makefile', 'Bender.yml', 'Bender.lock', 'Makefile', 'src_files.yml', 'axi.core')


def digest(data):
    return hashlib.sha256(data).hexdigest()


def stable(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()


def inventory(root):
    result = []
    candidates = []
    for directory, subdirectories, filenames in os.walk(root):
        subdirectories[:] = sorted(d for d in subdirectories if d not in EXCLUDE and not d.startswith('.codegraph-'))
        candidates.extend(Path(directory) / name for name in filenames if Path(name).suffix.lower() in EXTENSIONS)
    for file in sorted(candidates):
        relative = file.relative_to(root)
        if not file.is_file():
            continue
        if not file.resolve().is_relative_to(root.resolve()):
            raise ValueError('HDL symlink выходит из corpus: ' + relative.as_posix())
        data = file.read_bytes()
        result.append({'path': relative.as_posix(), 'sha256': digest(data), 'bytes': len(data)})
    return result


def git(root, *args, binary=False):
    result = subprocess.run(['git', '-C', str(root), *args], capture_output=True, check=False)
    return result.stdout if binary and result.returncode == 0 else (
        result.stdout.decode().strip() if result.returncode == 0 else None)


def portable_remote(value):
    if not value:
        return None
    match = re.fullmatch(r'git@github\.com:(.+)', value)
    if match:
        return 'https://github.com/' + match[1]
    parsed = urlsplit(value)
    if parsed.scheme and parsed.hostname:
        host = parsed.hostname + (':' + str(parsed.port) if parsed.port else '')
        return urlunsplit((parsed.scheme, host, parsed.path, '', ''))
    return value if not value.startswith(('/', '.', '~')) else None


def evidence(root, file):
    data = (root / file).read_bytes()
    return {'path': file, 'sha256': digest(data), 'bytes': len(data)}


def uncomment(text):
    # Только для поиска literal evidence. Это не препроцессор и не elaboration.
    return re.sub(r'/\*[\s\S]*?\*/|//[^\n]*', lambda m: '\n' * m[0].count('\n'), text)


def location(text, match):
    return text.count('\n', 0, match.start()) + 1


def analyze_sources(root, records):
    modules, includes, imports = [], [], []
    for record in records:
        file = record['path']
        text = uncomment((root / file).read_text(errors='replace'))
        for match in re.finditer(r'\b(module|package)\s+(?:automatic\s+)?([A-Za-z_$][\w$]*)', text):
            modules.append({'kind': match[1], 'name': match[2], 'path': file, 'line': location(text, match)})
        for match in re.finditer(r'^\s*`include\s+"([^"\n]+)"', text, re.M):
            request = match[1]
            candidates = [Path(file).parent / request, Path('include') / request, Path(request)]
            resolved = [p.as_posix() for p in candidates if (root / p).is_file()]
            includes.append({'path': file, 'line': location(text, match), 'request': request,
                             'resolved_candidates': sorted(set(resolved))})
        for match in re.finditer(r'\bimport\s+([A-Za-z_$][\w$]*)::', text):
            imports.append({'package': match[1], 'path': file, 'line': location(text, match)})
    packages = {m['name'] for m in modules if m['kind'] == 'package'}
    return modules, includes, [i for i in imports if i['package'] not in packages]


def profile(name, files, tops, modules, includes=(), defines=None):
    declarations = [m for m in modules if m['kind'] == 'module' and m['name'] in tops and m['path'] in files]
    if {m['name'] for m in declarations} != set(tops):
        raise ValueError('Нет точного source evidence для top: ' + name)
    return {'name': name, 'purpose': 'source-graph validation; не compiler/elaboration closure',
            'files': files, 'top_modules': tops, 'top_evidence': declarations,
            'include_dirs': list(includes), 'defines': defines or {}}


def corpus_manifest(identifier, root, origin):
    records = inventory(root)
    if not records:
        raise ValueError('Пустой HDL corpus: ' + identifier)
    revision = git(origin, 'rev-parse', 'HEAD')
    remote = portable_remote(git(origin, 'remote', 'get-url', 'origin'))
    mismatched = []
    for record in records:
        data = git(origin, 'show', revision + ':' + record['path'], binary=True) if revision else None
        if data is None or digest(data) != record['sha256']:
            mismatched.append(record['path'])
    working_tree_mismatches = [r['path'] for r in records if not (origin / r['path']).is_file()
                               or digest((origin / r['path']).read_bytes()) != r['sha256']]
    license_files = sorted(p.name for p in origin.iterdir() if p.is_file() and p.name.upper().startswith(('LICENSE', 'COPYING', 'UNLICENSE')))
    licenses = [{**evidence(origin, file), 'first_line': (origin / file).read_text(errors='replace').splitlines()[0]}
                for file in license_files]
    builds = []
    for file in BUILD_FILES:
        if not (origin / file).is_file():
            continue
        text = (origin / file).read_text(errors='replace')
        item = evidence(origin, file)
        item['command_evidence'] = [{'line': i, 'text': line.strip()} for i, line in enumerate(text.splitlines(), 1)
                                    if re.search(r'add_file|top_module|\$\((?:IV|IVERILOG)\)|(?:^|\s)-[DIgs](?:\s|\w)', line)
                                    and not line.lstrip().startswith('#')]
        if file.endswith('.tcl'):
            item['declared_files'] = re.findall(r'^\s*add_file\s+[^\n]*?"([^"]+)"', text, re.M)
        if file.endswith('.gprj'):
            item['declared_files'] = [n.attrib['path'] for n in ET.fromstring(text).iter('File') if 'path' in n.attrib]
        builds.append(item)
    for entry in builds + licenses:
        blob = git(origin, 'show', revision + ':' + entry['path'], binary=True) if revision else None
        entry['matches_revision'] = bool(blob is not None and digest(blob) == entry['sha256']) if revision else None
    source_spdx = []
    for record in records:
        for line, text in enumerate((root / record['path']).read_text(errors='replace').splitlines(), 1):
            if 'SPDX-License-Identifier:' in text:
                source_spdx.append({'path':record['path'],'line':line,'identifier':text.split('SPDX-License-Identifier:',1)[1].strip(' /*\t')})
    modules, include_refs, missing_packages = analyze_sources(root, records)
    names = [r['path'] for r in records]
    if identifier == 'dual-uart':
        profiles = [profile('synth-source', [f for f in names if f.startswith('src/')], ['top'], modules),
                    profile('sim-source', names, ['tb_top'], modules)]
    elif identifier == 'card-reader':
        profiles = [profile('synth-source', [f for f in names if f.startswith('src/')], ['top'], modules),
                    profile('sim-integration-source', names, ['tb_top_integration'], modules, ['src'])]
    else:
        selected = ['src/axi_pkg.sv', 'src/axi_interleaved_xbar.sv']
        profiles = [profile('normal-source', selected, ['axi_interleaved_xbar'], modules, ['include']),
                    profile('vcs-source', selected, ['axi_interleaved_xbar'], modules, ['include'], {'VCS': '1'})]
    locked = []
    lock = origin / 'Bender.lock'
    if lock.is_file():
        # Ограниченный reader реальной flat Bender lock структуры; версии не вычисляются.
        chunks = re.split(r'^  ([\w-]+):\s*$', lock.read_text(), flags=re.M)
        for i in range(1, len(chunks), 2):
            body = chunks[i + 1]
            rev = re.search(r'^    revision: (\w+)$', body, re.M)
            url = re.search(r'^      Git: (\S+)$', body, re.M)
            if rev and url:
                locked.append({'name': chunks[i], 'revision': rev[1], 'remote': url[1],
                               'status': 'external; не включён в source inventory', 'evidence': 'Bender.lock'})
    missing_build_files = [{'path':file, 'evidence':build['path']} for build in builds
                           for file in build.get('declared_files', []) if not (root / file).is_file()]
    missing_symbols = []
    if identifier == 'card-reader' and not any(m['name'] == 'rPLL' for m in modules):
        text = uncomment((root / 'src/pll.v').read_text())
        match = re.search(r'\brPLL\s*#\s*\(', text)
        if match:
            missing_symbols.append({'name': 'rPLL', 'kind': 'vendor primitive', 'path': 'src/pll.v',
                                    'line': location(text, match), 'evidence': 'rPLL #( ... ); declaration отсутствует в corpus'})
    return {'id': identifier, 'provenance': {'remote': remote, 'revision': revision,
             'revision_matches_all_captured_sources': bool(revision) and not mismatched,
             'sources_not_matching_revision': mismatched,
             'working_tree_matches_all_captured_sources': not working_tree_mismatches,
             'sources_not_matching_origin_working_tree': working_tree_mismatches,
             'note': 'revision — доказательство только совпавших blobs; остальные файлы закреплены отдельными SHA-256'},
            'license': {'status': 'evidence-found' if licenses else 'unknown; license file отсутствует в исходном repo root', 'evidence': licenses, 'source_spdx': source_spdx},
            'source_files': records, 'source_inventory_sha256': digest(stable(records)),
            'build_evidence': builds, 'validation_profiles': profiles,
            'literal_include_references': include_refs,
            'missing_dependencies': {'literal_includes': [i for i in include_refs if not i['resolved_candidates']],
                'imported_packages_without_declaration': missing_packages, 'symbols': missing_symbols, 'locked_external_packages': locked,
                'build_recipe_files_not_in_corpus': missing_build_files,
                'scope': 'Только наблюдаемые literal includes/imports и перечисленные primitives; conditional branches не вычисляются. Не доказательство полной build closure.'}}


def parse_origins(values):
    result = {}
    for value in values:
        key, separator, folder = value.partition('=')
        if not separator or key not in IDS:
            raise ValueError('--origin ожидает CORPUS_ID=PATH')
        result[key] = Path(folder)
    return result


def check(manifest, base, origins):
    failures = []
    for corpus in manifest['corpora']:
        identifier = corpus['id']
        actual = inventory(base / identifier)
        expected_by_path = {r['path']: r for r in corpus['source_files']}
        actual_by_path = {r['path']: r for r in actual}
        changed = sorted(p for p in expected_by_path.keys() & actual_by_path.keys() if expected_by_path[p] != actual_by_path[p])
        added = sorted(actual_by_path.keys() - expected_by_path.keys())
        missing = sorted(expected_by_path.keys() - actual_by_path.keys())
        if changed or added or missing:
            failures.append({'corpus': identifier, 'changed': changed, 'added': added, 'missing': missing})
        if identifier in origins:
            origin = origins[identifier]
            for entry in corpus['build_evidence'] + corpus['license']['evidence']:
                file = origin / entry['path']
                if not file.resolve().is_relative_to(origin.resolve()) or not file.is_file() or digest(file.read_bytes()) != entry['sha256']:
                    failures.append({'corpus': identifier, 'origin_evidence_changed': entry['path']})
    print(json.dumps({'ok': not failures, 'checked_corpora': len(manifest['corpora']), 'failures': failures}, ensure_ascii=False, indent=2))
    return 1 if failures else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('generate', 'check'))
    parser.add_argument('--corpus-root', required=True, type=Path)
    parser.add_argument('--origin', action='append', default=[], help='CORPUS_ID=local provenance repo; never stored as absolute path')
    parser.add_argument('--output', type=Path, default=Path('docs/hdl-corpus-manifest.json'))
    parser.add_argument('--manifest', type=Path, default=Path('docs/hdl-corpus-manifest.json'))
    args = parser.parse_args()
    origins = parse_origins(args.origin)
    if args.command == 'check':
        return check(json.loads(args.manifest.read_text()), args.corpus_root, origins)
    result = {'schema_version': 1, 'purpose': 'Воспроизводимые source snapshots для проверки CodeGraph HDL; исходники не распространяются.',
              'hash_algorithm': 'sha256', 'corpora': [corpus_manifest(i, args.corpus_root / i, origins.get(i, args.corpus_root / i)) for i in IDS]}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps({'ok': True, 'corpora': len(IDS), 'output': str(args.output)}, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (OSError, ValueError, KeyError, ET.ParseError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
