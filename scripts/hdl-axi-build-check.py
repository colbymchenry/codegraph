#!/usr/bin/env python3
"""Проверить pinned AXI dependencies и compiler controls без изменения RTL."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import time

AXI_REV = 'da8793b0e3f14c9186c94fac9ed6ec06375c254e'
DEPENDENCIES = {
    'common_cells': '03d98106aa19952a10360d2230def85144a0008b',
    'common_verification': 'fb1885f48ea46164a10568aeff51884389f67ae3',
    'tech_cells_generic': '3a3de73632a06826b1bd9c65a0a2e92b32016845',
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--axi', type=Path, required=True, help='Изолированный чистый checkout pinned AXI')
    parser.add_argument('--bender', required=True)
    parser.add_argument('--verilator', required=True)
    parser.add_argument('--output', type=Path, required=True, help='Каталог логов вне source Git')
    args = parser.parse_args()
    root = args.axi.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)

    def run(argv, timeout=180):
        return subprocess.run(argv, cwd=root, capture_output=True, text=True, timeout=timeout)

    def git(*argv):
        result = run(['git', *argv])
        if result.returncode:
            raise RuntimeError(result.stderr)
        return result.stdout.strip()

    if git('rev-parse', 'HEAD') != AXI_REV or git('status', '--porcelain', '--untracked-files=no'):
        raise RuntimeError('Нужен чистый AXI checkout на зафиксированной revision')
    # Hash tracked inputs before/after Bender and all compiler controls.
    def snapshot():
        return {name: hashlib.sha256((root / name).read_bytes()).hexdigest()
                for name in git('ls-files').splitlines() if (root / name).is_file()}

    if (root / 'Bender.local').exists():
        raise RuntimeError('Bender.local overrides are outside this pinned control')
    initial = snapshot()
    versions = {}
    for name, executable in [('bender', args.bender), ('verilator', args.verilator)]:
        result = run([executable, '--version'])
        if result.returncode:
            raise RuntimeError(result.stderr)
        versions[name] = result.stdout.strip()
    checkout = run([args.bender, '--dir', str(root), 'checkout'])
    (out / 'checkout.log').write_text(checkout.stdout + checkout.stderr)
    if checkout.returncode or snapshot() != initial:
        raise RuntimeError('Checkout failed or modified tracked AXI inputs / lockfile')
    deps = {}
    for name, revision in DEPENDENCIES.items():
        candidates = list((root / '.bender/git/checkouts').glob(name + '-*'))
        found = []
        for candidate in candidates:
            result = run(['git', '-C', str(candidate), 'rev-parse', 'HEAD'])
            if result.returncode == 0 and result.stdout.strip() == revision:
                found.append(candidate)
        if len(found) != 1:
            raise RuntimeError(f'Expected one locked checkout for {name}@{revision}')
        candidate = found[0]
        if git('-C', str(candidate), 'status', '--porcelain', '--untracked-files=no'):
            raise RuntimeError(f'Modified dependency: {name}')
        deps[name] = {'revision': revision, 'path': str(candidate.relative_to(root))}

    generated = run([args.bender, '--dir', str(root), 'script', 'verilator', '-t', 'synth_test'])
    if generated.returncode:
        raise RuntimeError(generated.stderr)
    for line in generated.stdout.splitlines():
        line = line.strip()
        if not line or line.startswith('//') or line.startswith('+define+'):
            continue
        candidate = Path(line.removeprefix('+incdir+'))
        if not candidate.is_absolute() or not candidate.resolve().is_relative_to(root):
            raise RuntimeError('Generated filelist escapes the pinned AXI checkout: ' + line)
    filelist = out / 'verilator.f'
    filelist.write_text(generated.stdout)
    portable = generated.stdout.replace(str(root), '${AXI}')
    (out / 'verilator.portable.f').write_text(portable)
    cases = []

    def control(name, argv, expect_success=True):
        start = time.monotonic()
        result = run(argv)
        (out / (name + '.stdout')).write_text(result.stdout)
        (out / (name + '.stderr')).write_text(result.stderr)
        warnings = re.findall(r'^%Warning-([^:]+):', result.stderr, re.M)
        row = {'name': name, 'argv': [a.replace(str(root), '${AXI}').replace(str(out), '${OUTPUT}')
                                     .replace(args.verilator, '${VERILATOR}') for a in argv],
               'exit': result.returncode, 'seconds': round(time.monotonic() - start, 3),
               'warnings': {w: warnings.count(w) for w in sorted(set(warnings))},
               'errors': len(re.findall(r'^%Error', result.stderr, re.M))}
        cases.append(row)
        if (result.returncode == 0) != expect_success:
            raise RuntimeError(f'{name}: unexpected exit {result.returncode}; see logs in {out}')
        return result

    demux = 'src/axi_demux_simple.sv'
    missing = control('demux-missing-include-control', [args.verilator, '-E', '-P', '-Iinclude', demux], False)
    if 'Cannot find include file' not in missing.stderr or 'common_cells/assertions.svh' not in missing.stderr:
        raise RuntimeError('Negative control failed for a reason other than missing dependency')
    cc_include = str(root / deps['common_cells']['path'] / 'include')
    for variant, defines in [('default', []), ('VCS', ['+define+VCS'])]:
        selected = control('demux-preprocess-' + variant,
                           [args.verilator, '-E', '-P', '-Iinclude', '-I' + cc_include, *defines, demux])
        if 'module axi_demux_simple' not in selected.stdout or '`FF' in selected.stdout:
            raise RuntimeError('Expected original module and expanded register macros')
    for count in [1, 2, 4]:
        control('xbar-lint-' + str(count), [args.verilator, '--lint-only', '--assert', '-Wno-fatal',
                '--top-module', 'synth_axi_lite_xbar', '-GNoSlvMst=' + str(count),
                '--Mdir', str(out / ('obj-' + str(count))), '-f', str(filelist)])
    if snapshot() != initial:
        raise RuntimeError('Compiler controls changed tracked AXI files')
    report = {'axiRevision': AXI_REV, 'benderLockSha256': initial['Bender.lock'],
              'tools': versions, 'dependencies': deps,
              'profile': {'target': 'synth_test', 'top': 'synth_axi_lite_xbar',
                          'parameterValues': {'NoSlvMst': [1, 2, 4]},
                          'defines': [line for line in portable.splitlines() if line.startswith('+define+')],
                          'includeDirs': [line for line in portable.splitlines() if line.startswith('+incdir+')],
                          'filelistSha256': hashlib.sha256(portable.encode()).hexdigest()},
              'cases': cases, 'trackedInputCount': len(initial), 'trackedInputsUnchanged': True,
              'limitations': ['Warnings retained with -Wno-fatal; not a warning-free build',
                              'Lint/elaboration controls only, no simulation, synthesis or FPGA validation',
                              'Not the complete axi_synth_bench and not all tops']}
    (out / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'output': str(out), 'cases': len(cases), 'trackedInputsUnchanged': True}))


if __name__ == '__main__':
    main()
