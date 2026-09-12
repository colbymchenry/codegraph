#!/usr/bin/env python3
"""Сравнить JSON export slang/Verilator на pinned HDL controls (Linux GNU time)."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time


def walk(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from walk(item)
    elif isinstance(value, list):
        for item in value:
            yield from walk(item)



def verify_semantic_control(tool, name, nodes, meta, cwd):
    """Узкие assertions по реальному исходнику; не универсальный AST adapter."""
    by_addr = {str(n['addr']): n for n in nodes if 'addr' in n}
    if name.startswith('axi'):
        symbol, expected = 'NoSlvMst', int(name[-1])
    elif name == 'crc16':
        symbol, expected = 'crc_out', 16
    else:
        symbol, expected = 'CLK_FREQ', 50000000
    if tool == 'slang':
        candidates = [n for n in nodes if n.get('name') == symbol and n.get('kind') in ('Port', 'Parameter')]
        if symbol == 'CLK_FREQ':
            candidates = [n for n in candidates if n.get('source_file', '').endswith('/top.v')]
        node = candidates[0]
        if symbol == 'crc_out':
            assert node['type']['range'] == '[15:0]'
            value = 16
        else:
            raw = node['value']
            value = int(raw.split("'d")[-1])
        file, line = node['source_file'], node['source_line']
    else:
        candidates = [n for n in nodes if n.get('name') == symbol and n.get('type') == 'VAR']
        files = json.loads(meta.read_text())['files']
        if symbol == 'CLK_FREQ':
            candidates = [n for n in candidates if files[n['loc'].split(',')[0]]['filename'].endswith('/top.v')]
        node = candidates[0]
        if symbol == 'crc_out':
            assert by_addr[node['dtypep']]['range'] == '15:0'
            value = 16
        else:
            raw = node['valuep'][0]['name']
            value = int(raw.split('h')[-1], 16)
        location = node['loc'].split(',')
        file, line = files[location[0]]['filename'], int(location[1].split(':')[0])
    assert value == expected, (symbol, value, expected)
    source = (cwd / file).resolve()
    assert symbol in source.read_text().splitlines()[line - 1]
    if name.startswith('uart'):
        kind_key, kind = ('kind', 'Instance') if tool == 'slang' else ('type', 'CELL')
        assert {'u_rx1', 'u_rx2'} <= {n.get('name') for n in nodes if n.get(kind_key) == kind}
    return {'symbol': symbol, 'valueOrWidth': value, 'source': str(source), 'line': line,
            'sourceLineVerified': True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus-root', type=Path, required=True)
    parser.add_argument('--axi', type=Path, required=True)
    parser.add_argument('--filelist', type=Path, required=True, help='A2 Bender Verilator filelist')
    parser.add_argument('--slang', required=True)
    parser.add_argument('--verilator', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--runs', type=int, default=2)
    args = parser.parse_args()
    if not 1 <= args.runs <= 5:
        parser.error('--runs must be 1..5')
    repo = Path(__file__).resolve().parent.parent
    base, axi, out = args.corpus_root.resolve(), args.axi.resolve(), args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if any(out.iterdir()):
        parser.error('--output must be empty to prevent stale artifact reuse')
    subprocess.run([sys.executable, str(repo / 'scripts/hdl-corpus-manifest.py'), 'check',
                    '--corpus-root', str(base), '--manifest', str(repo / 'docs/hdl-corpus-manifest.json')], check=True)
    manifest = json.loads((repo / 'docs/hdl-corpus-manifest.json').read_text())
    def sources(identifier):
        c = next(c for c in manifest['corpora'] if c['id'] == identifier)
        return [str(base / identifier / f) for f in c['validation_profiles'][0]['files']]
    shared = [line.strip() for line in args.filelist.read_text().splitlines() if line.strip()]
    for line in shared:
        if line.startswith('+define+'):
            continue
        file = Path(line.removeprefix('+incdir+'))
        if not file.is_absolute() or not file.resolve().is_relative_to(axi):
            raise ValueError('Filelist must use confined absolute AXI paths')
    revision = subprocess.check_output(['git', '-C', str(axi), 'rev-parse', 'HEAD'], text=True).strip()
    expected = json.loads((repo / 'docs/hdl-axi-build-validation.json').read_text())
    if revision != expected['axiRevision']:
        raise ValueError('Wrong AXI revision')
    portable_filelist = args.filelist.read_text().replace(str(axi), '${AXI}')
    if hashlib.sha256(portable_filelist.encode()).hexdigest() != expected['profile']['filelistSha256']:
        raise ValueError('Filelist differs from verified A2 input')
    roots = [axi]
    for info in expected['dependencies'].values():
        root = axi / info['path']
        if subprocess.check_output(['git', '-C', str(root), 'rev-parse', 'HEAD'], text=True).strip() != info['revision']:
            raise ValueError('Dependency revision differs')
        roots.append(root)
    def snapshot():
        data = {}
        for root in roots:
            if subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=no'], text=True).strip():
                raise ValueError('Modified AXI/dependency tracked sources')
            for name in subprocess.check_output(['git', '-C', str(root), 'ls-files'], text=True).splitlines():
                file = root / name
                if file.is_file():
                    data[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
        for line in shared:
            if line.startswith('+define+'):
                continue
            file = Path(line.removeprefix('+incdir+'))
            candidates = file.rglob('*') if line.startswith('+incdir+') else [file]
            for candidate in candidates:
                if candidate.is_symlink():
                    raise ValueError('Symlink input is outside this pinned benchmark')
                if candidate.is_file() and str(candidate) not in data:
                    raise ValueError('Untracked compiler input: ' + str(candidate))
        for c in manifest['corpora']:
            for entry in c['source_files']:
                file = base / c['id'] / entry['path']
                data[str(file)] = hashlib.sha256(file.read_bytes()).hexdigest()
        return data
    before = snapshot()
    cases = [('uart-strict', 'top', sources('dual-uart'), None, True),
             ('uart-compatible', 'top', sources('dual-uart'), None, True),
             ('crc16', 'emmc_crc16', [str(base / 'card-reader/src/emmc_crc16.v')], None, True),
             ('axi2', 'synth_axi_lite_xbar', shared, 'NoSlvMst=2', True),
             ('axi4', 'synth_axi_lite_xbar', shared, 'NoSlvMst=4', True),
             ('board-missing-pll', 'top', sources('card-reader'), None, False)]
    versions = {tool: subprocess.check_output([getattr(args, tool), '--version'], text=True).strip()
                for tool in ['slang', 'verilator']}
    rows = []
    def portable(value):
        return str(value).replace(str(out), '${OUTPUT}').replace(str(base), '${CORPORA}').replace(str(axi), '${AXI}')
    for name, top, files, parameter, success in cases:
        for tool in ['slang', 'verilator']:
            for iteration in range(args.runs):
                dest = out / (name + '-' + tool + '-' + str(iteration))
                dest.mkdir(exist_ok=True)
                ast = dest / 'ast.json'
                meta = dest / 'meta.json'
                if tool == 'slang':
                    command = [args.slang, '--std', '1800-2023', '--single-unit', '--top', top,
                               '--ast-json', str(ast), '--ast-json-source-info', '--ast-json-detailed-types',
                               '--diag-json', str(dest / 'diagnostics.json')]
                else:
                    command = [args.verilator, '--language', '1800-2023', '--json-only', '-Wno-fatal',
                               '--top-module', top, '--json-only-output', str(ast),
                               '--json-only-meta-output', str(meta), '--Mdir', str(dest / 'obj')]
                if tool == 'slang' and name == 'uart-compatible':
                    command.append('--allow-use-before-declare')
                if parameter:
                    command.append('-G' + parameter)
                command += files
                measurement = dest / 'time.txt'
                timed = ['/usr/bin/time', '-f', '%e %M', '-o', str(measurement), *command]
                start = time.monotonic()
                with (dest / 'stdout').open('w') as stdout, (dest / 'stderr').open('w') as stderr:
                    process = subprocess.Popen(timed, cwd=axi, stdout=stdout, stderr=stderr, start_new_session=True)
                    try:
                        code = process.wait(timeout=120)
                    except subprocess.TimeoutExpired:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                        code = -9
                    except BaseException:
                        try:
                            os.killpg(process.pid, signal.SIGKILL)
                        except ProcessLookupError:
                            pass
                        process.wait()
                        raise
                elapsed = round(time.monotonic() - start, 3)
                metrics = measurement.read_text().splitlines()[-1].split() if measurement.exists() else []
                peak = int(metrics[1]) if len(metrics) == 2 and metrics[1].isdigit() else None
                stderr_text = (dest / 'stderr').read_text()
                stdout_text = (dest / 'stdout').read_text()
                row = {'case': name, 'tool': tool, 'iteration': iteration, 'exit': code,
                       'expectedSuccess': success and not (name == 'uart-strict' and tool == 'slang'), 'seconds': float(metrics[0]) if len(metrics) == 2 else None, 'wrapperSeconds': elapsed, 'peakRssKiB': peak,
                       'argv': ['${' + tool.upper() + '}', *[portable(v) for v in command[1:]]],
                       'stderrBytes': len(stderr_text.encode()), 'astBytes': ast.stat().st_size if ast.exists() else 0}
                if code == 0 and ast.exists():
                    nodes = list(walk(json.loads(ast.read_text())))
                    key = 'kind' if tool == 'slang' else 'type'
                    kinds = {}
                    for node in nodes:
                        kind = node.get(key)
                        if isinstance(kind, str):
                            kinds[kind] = kinds.get(kind, 0) + 1
                    row['nodeKinds'] = kinds
                    evidence = verify_semantic_control(tool, name, nodes, meta, axi)
                    evidence['source'] = portable(evidence['source'])
                    row['semanticControl'] = evidence
                if name == 'uart-strict' and tool == 'slang':
                    row['expectedOutcome'] = code not in (0, -9) and 'used before its declaration' in stderr_text
                else:
                    row['expectedOutcome'] = (code == 0 and ast.exists()) if success else (code not in (0, -9) and 'rPLL' in stderr_text + stdout_text)
                row['errorLines'] = len(re.findall(r'(?:^%Error|: error:)', stderr_text, re.M))
                row['warningLines'] = len(re.findall(r'(?:^%Warning|: warning:)', stderr_text, re.M))
                rows.append(row)
                (out / 'report.json').write_text(json.dumps({'tools': versions, 'cases': rows}, indent=2) + '\n')
                print(name, tool, iteration, code, elapsed, peak, flush=True)
    if snapshot() != before:
        raise RuntimeError('Inputs changed during benchmark')
    report = {'tools': versions, 'cases': rows, 'inputsUnchanged': True,
              'inputSnapshotSha256': hashlib.sha256(json.dumps({portable(k): v for k, v in before.items()}, sort_keys=True).encode()).hexdigest(),
              'measurement': 'Linux GNU time peak RSS; sequential export runs, not cold-cache benchmark; repetitions not independent machines',
              'profile': 'Explicit arguments identical per case; tools retain their own implicit predefines and language semantics',
              'allExpectedOutcomes': all(r['expectedOutcome'] for r in rows)}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    return 0 if report['allExpectedOutcomes'] else 1


if __name__ == '__main__':
    sys.exit(main())
